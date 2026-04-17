# PaperLink VS Code Extension — Complete Codebase Map

**Project**: PaperLink  
**Version**: 0.1.0  
**Repository**: paper-link  
**Total Lines of Code**: ~1,560 (all TypeScript source files)  
**Build System**: Webpack + TypeScript  
**Test Framework**: Mocha  

---

## 📋 Executive Summary

PaperLink is a VS Code extension that creates **bidirectional links between PDF annotations and Markdown notes**. The extension integrates a custom PDF viewer with text selection, annotation management, and markdown preview integration. Key innovation: uses **PDFium (via EmbedPDF)** for pixel-perfect text positioning and stable text anchors.

**Core Architecture**:
- **Extension Host** (Node.js): Manages UI, file I/O, sidecar JSON storage
- **Webview** (Browser): PDF rendering, text selection, real-time highlighting
- **Markdown Integration**: Both document link provider and markdown-it plugin for preview links

---

## 📁 Directory Structure

```
paper-link/
├── src/                          # Extension host code (Node.js)
│   ├── extension.ts              # Entry point, registration hub
│   ├── pdfEditorProvider.ts       # Custom editor for PDF webview
│   ├── pdfLinkProvider.ts         # Document link provider for markdown
│   ├── annotationService.ts       # Sidecar file storage & caching
│   ├── pdfOutlineProvider.ts      # Tree view for PDF bookmarks
│   ├── markdownPlugin.ts          # Markdown-it plugin for preview
│   └── shared/
│       └── types.ts              # Shared types (both host & webview)
│
├── webview-src/                  # Webview code (Browser/WASM)
│   ├── pdf-viewer.ts             # Main PDF viewer class
│   ├── markdown-preview.ts        # Markdown preview link handler
│   └── vscode.d.ts               # VS Code API types stub
│
├── test/                         # Test suite
│   ├── suite/
│   │   └── extension.test.ts      # Integration tests (Mocha)
│   ├── runTest.ts                # Test harness
│   └── tsconfig.json             # Test TS config
│
├── webpack.config.js             # Build config (3 entry points)
├── tsconfig.json                 # Main TypeScript config
├── tsconfig.webview.json         # Webview-specific TS config
├── package.json                  # Dependencies & scripts
├── .gitignore                    # Git ignore rules
├── .vscodeignore                 # VSIX package ignore rules
└── dist/                         # Built output (webpack)
    ├── extension.js              # Main extension bundle
    ├── pdf-viewer.js             # Webview PDF viewer
    ├── markdown-preview.js        # Markdown preview plugin
    └── pdfium.wasm               # PDFium WASM binary

```

---

## 🔌 Key Components Detailed

### 1. **extension.ts** — Extension Host Entry Point
**File**: `src/extension.ts` | **Lines**: 84  
**Purpose**: Initialize and register all extension components.

**Key Exports**:
- `activate(context: vscode.ExtensionContext)`: Main activation function
- `deactivate()`: Cleanup function

**Registered Components**:
1. **PDF Outline Tree View** (`paperlink.outline`)
   - Uses `PdfOutlineProvider` to display PDF bookmarks/table of contents
   - Shows collapsible tree of outline items
   
2. **Custom Editor** (`paperlink.pdfViewer`)
   - Handles all `*.pdf` files
   - Uses `PdfEditorProvider` for webview management
   - Supports multi-page PDFs with lazy rendering

3. **Document Link Provider** (Markdown files)
   - Detects `@pdf[[...]]` links in markdown
   - Uses `PdfLinkProvider` for link creation

4. **Commands Registered**:
   - `paperlink.openPdfAtAnchor`: Open PDF at specific text location
   - `paperlink.outlineGoToPage`: Jump to page via outline
   - `paperlink.showAnnotations`: Show all annotations for current PDF
   - Implicit: `paperlink.createAnnotationLink` & `paperlink.insertPdfLink`

5. **Markdown-it Plugin**
   - Returned via `extendMarkdownIt` for markdown preview rendering
   - Renders `@pdf[[...]]` links as styled clickable elements

**Message Flow**:
```
Extension Host
    ↓
AnnotationService (cache & file I/O)
    ↓
PdfEditorProvider (webview lifecycle)
    ↓
Webview <-→ pdf-viewer.ts (rendering & interaction)
```

---

### 2. **pdfEditorProvider.ts** — Custom Editor for PDFs
**File**: `src/pdfEditorProvider.ts` | **Lines**: 429  
**Purpose**: Implement `vscode.CustomReadonlyEditorProvider` to render PDFs in a webview.

**Key Class**: `PdfEditorProvider implements vscode.CustomReadonlyEditorProvider`

**Methods**:
- `openCustomDocument(uri, context, token)`: Creates a custom document object
- `resolveCustomEditor(document, webviewPanel, token)`: Sets up webview HTML & messaging
- `openPdfAtAnchor(pdfPath, anchorStr)`: Navigate to a specific text anchor
- `getActiveWebview()`: Retrieve current active PDF webview
- `loadPdfIntoWebview(webview, pdfUri)`: Read PDF file and send base64-encoded data
- `sendAnnotations(webview, pdfUri)`: Fetch & highlight annotations from sidecar
- `insertLinkAtCursor(link)`: Insert markdown link into active editor
- `openMarkdownAtRef(markdownFile, blockRef)`: Open & scroll to markdown location

**Webview HTML Template**:
- Embeds viewer controls (prev/next, zoom, page info)
- Sets CSP (Content Security Policy) for security
- Loads `pdf-viewer.js` and `pdfium.wasm`
- CSS includes dark/light theme support

**Message Protocol** (Extension ↔ Webview):
```typescript
// Extension → Webview
{ type: 'loadPdf'; data: string }  // base64 PDF
{ type: 'goToAnchor'; anchor: PdfAnchor }  // Navigate to text
{ type: 'highlightAnnotations'; annotations: Annotation[] }  // Show markers
{ type: 'setTheme'; theme: 'light' | 'dark' }  // Theme update

// Webview → Extension
{ type: 'ready' }  // Webview initialized
{ type: 'copyLinkToClipboard'; anchor: PdfAnchor }  // User action
{ type: 'requestInsertLink'; anchor: PdfAnchor }  // User action
{ type: 'annotationClicked'; annotationId: string }  // Jump to note
{ type: 'outline'; items: PdfOutlineItem[] }  // Bookmarks extracted
{ type: 'pageChanged'; page: number }  // Navigation
{ type: 'selectionMade'; anchor: PdfAnchor }  // Text selection
```

**State Management**:
- `webviews: Map<string, ActiveWebviewInfo>`: Track open PDFs
- `activeDocKey: string | undefined`: Currently active PDF
- Maintains webview lifecycle (onDidDispose, onDidChangeViewState)

---

### 3. **annotationService.ts** — Sidecar File Storage
**File**: `src/annotationService.ts` | **Lines**: 120  
**Purpose**: Persistent annotation storage as JSON sidecar files.

**Key Class**: `AnnotationService`

**Storage Model**:
- For `papers/attention.pdf`, annotations stored in `papers/attention.pdf.paperlink.json`
- Sidecar schema:
  ```json
  {
    "version": 1,
    "pdfFile": "attention.pdf",
    "annotations": [
      {
        "id": "uuid",
        "anchor": { page, textItemIndex, charOffset, length, snippet },
        "markdownFile": "notes/research.md",
        "blockRef": "^block-id",
        "color": "rgba(255, 230, 0, 0.35)",
        "createdAt": "2024-04-17T..."
      }
    ]
  }
  ```

**Methods**:
- `getAnnotationsForPdf(pdfUri)`: Fetch annotations (cached)
- `addAnnotation(pdfUri, annotation)`: Add/update annotation
- `removeAnnotation(pdfUri, annotationId)`: Delete annotation
- `findAnnotationsForMarkdown(mdRelativePath)`: Reverse lookup (which PDFs link to this note?)
- `invalidate(pdfUri)`: Clear cache
- `getSidecarUri(pdfUri)`: Compute sidecar filename

**Caching**: 
- In-memory cache (`Map<string, AnnotationStore>`) avoids repeated disk I/O
- Cache invalidated only on explicit call or file I/O failure

---

### 4. **pdfLinkProvider.ts** — Document Links in Markdown
**File**: `src/pdfLinkProvider.ts` | **Lines**: 45  
**Purpose**: Make `@pdf[[...]]` links clickable in markdown editors.

**Key Class**: `PdfLinkProvider implements vscode.DocumentLinkProvider`

**Link Pattern**:
```
@pdf[[papers/paper.pdf#page=5&idx=12&off=5&len=40|"some selected text"]]
        ↑ path              ↑ anchor format              ↑ optional snippet
```

**Regex Pattern** (from `shared/types.ts`):
```typescript
/@pdf\[\[([^\]#]+)#([^\]|]+)(?:\|"([^"]*)")?\]\]/g
```

**Implementation**:
- Regex scans document for pattern matches
- For each match, creates a `vscode.DocumentLink`
- Link URI is a command URI that triggers `paperlink.openPdfAtAnchor`
- Tooltip shows PDF filename & page number

**No UI Changes**: Just provides link data; VS Code renders them as underlined text.

---

### 5. **pdfOutlineProvider.ts** — PDF Bookmarks Tree
**File**: `src/pdfOutlineProvider.ts` | **Lines**: 62  
**Purpose**: Display PDF table of contents in the explorer sidebar.

**Key Class**: `PdfOutlineProvider implements vscode.TreeDataProvider<PdfOutlineItem>`

**Data Structure**:
```typescript
interface PdfOutlineItem {
  title: string;
  page: number;
  children: PdfOutlineItem[];
}
```

**Methods**:
- `setOutline(items, goToPage)`: Update tree with PDF bookmarks
- `clear()`: Empty the tree (e.g., when PDF closes)
- `getTreeItem(element)`: Convert outline item to tree item UI
- `getChildren(element)`: Recursively load child bookmarks
- `getParent(element)`: Parent lookup (returns undefined for simplicity)
- `goToPage(page)`: Callback to navigate PDF to page

**Tree Item Features**:
- Collapsible if has children
- Shows page number as description (`p.5`)
- Uses bookmark icon
- Click triggers `paperlink.outlineGoToPage` command

---

### 6. **markdownPlugin.ts** — Markdown-it Plugin
**File**: `src/markdownPlugin.ts` | **Lines**: 72  
**Purpose**: Render `@pdf[[...]]` links in VS Code's markdown preview.

**Key Export**: `activateMarkdownItPlugin(md: any): any`

**How It Works**:
1. Wraps markdown-it's text renderer
2. On render, checks if text contains PDF link pattern
3. Replaces matches with custom HTML:
   ```html
   <a class="paperlink-pdf-link" 
      href="#"
      data-pdf-path="papers/paper.pdf"
      data-pdf-anchor="page=5&idx=12&off=5&len=40"
      style="display:inline-flex; ... blue styling ...">
     📄 papers/paper.pdf p.5
   </a>
   ```
4. Click handler added by `markdown-preview.ts` (webview script)

**Styling**:
- Blue background (`rgba(0, 122, 204, 0.1)`)
- Blue border & text color
- Document icon emoji
- Inline-flex layout

**Link Click Flow**:
```
User clicks link in markdown preview
  ↓
markdown-preview.ts (injected script) intercepts click
  ↓
Constructs command URI: command:paperlink.openPdfAtAnchor?{...}
  ↓
VS Code executes command
  ↓
Extension host handles via registered command handler
```

---

### 7. **shared/types.ts** — Shared Types
**File**: `src/shared/types.ts` | **Lines**: 92  
**Purpose**: Central type definitions used by both extension host and webview.

**Key Types**:

```typescript
interface PdfAnchor {
  page: number;                 // 1-based page number
  textItemIndex: number;        // Index into page text items
  charOffset: number;           // Character position within text item
  length: number;               // Length of selected text
  snippet: string;              // Actual selected text for fallback
}

interface Annotation {
  id: string;
  anchor: PdfAnchor;
  markdownFile: string;         // Relative path to markdown file
  blockRef?: string;            // Optional block ID or heading
  color: string;                // Highlight color
  createdAt: string;            // ISO timestamp
}

interface AnnotationStore {
  version: 1;
  pdfFile: string;              // PDF filename (for sidecar)
  annotations: Annotation[];
}

interface PdfOutlineItem {
  title: string;
  page: number;
  children: PdfOutlineItem[];
}
```

**Serialization Functions**:
- `anchorToString(anchor)`: Convert anchor to query string format
  ```
  page=5&idx=12&off=5&len=40
  ```
- `stringToAnchor(s)`: Parse query string back to anchor

**Regex Pattern**:
```typescript
const PDF_LINK_REGEX = /@pdf\[\[([^\]#]+)#([^\]|]+)(?:\|"([^"]*)")?\]\]/g;
```

**Format Helper**:
```typescript
formatPdfLink(relativePath, anchor): string
// Returns: @pdf[[path#page=5&idx=12&off=5&len=40|"snippet"]]
```

---

### 8. **pdf-viewer.ts** — Webview PDF Viewer (Browser)
**File**: `webview-src/pdf-viewer.ts` | **Lines**: 524  
**Purpose**: Main PDF rendering engine in the webview iframe.

**Key Class**: `PdfViewer`

**Technology Stack**:
- **PDFium Engine**: `createPdfiumEngine()` from `@embedpdf/engines/pdfium-direct-engine`
- **WASM**: `pdfium.wasm` binary for fast rendering
- **Canvas API**: Render pages as images
- **IntersectionObserver**: Lazy-load off-screen pages

**Core State**:
```typescript
private pages: Map<number, PageState>;  // Rendered pages
private currentPage = 1;
private scale = 1.5;  // 150% zoom default
private annotations: Annotation[] = [];
```

**PageState Structure**:
```typescript
interface PageState {
  pageNum: number;
  canvas: HTMLCanvasElement;          // Rendered image
  textLayer: HTMLDivElement;          // Invisible text for selection
  highlightLayer: HTMLDivElement;     // Annotation overlays
  rendered: boolean;
  textRects: any[] | null;            // PDFium text position data
}
```

**Main Methods**:

1. **`constructor()`**
   - Set up message listener, controls, selection handler
   - Post "ready" message to extension

2. **`loadPdf(base64Data)`**
   - Decode base64 PDF bytes
   - Open via `engine.openDocumentBuffer()`
   - Extract bookmarks → send outline
   - Render all visible pages

3. **`renderAllVisiblePages()`**
   - Create DOM for each page (canvas + text layer + highlight layer)
   - Set up IntersectionObserver for lazy rendering
   - Immediately render first page

4. **`renderPage(pageNum)`**
   - Get page object from PDFium doc
   - Render via `engine.renderPage()` → Blob
   - Draw to canvas
   - Extract text rects via `engine.getPageTextRects()`
   - Build text layer (invisible spans for text selection)
   - Draw annotation highlights

5. **`handleTextSelection()`**
   - On mouseup, check for selected text
   - Find text item index & character offset
   - Create `PdfAnchor` from selection
   - Show toolbar with "Copy Link" & "Insert in Note" buttons

6. **`selectionToAnchor(pageNum, selectedText)`**
   - Match selected text against page text items
   - Find start item and offset
   - Return anchor with all coordinates

7. **`goToAnchor(anchor)`**
   - Scroll page into view
   - Show temporary blue highlight (2 seconds)
   - Render page if not yet rendered

8. **`drawHighlightsForPage(pageNum)`**
   - Iterate annotation rectangles for page
   - Create colored overlay divs over text
   - Add click listener to jump to markdown note

9. **Text Layer Building**:
   - PDFium returns precise text rectangles (device coordinates)
   - Create invisible `<span>` for each character
   - Position via absolute left/top in scaled coordinates
   - Enables accurate text selection without losing highlights

**Zoom & Navigation**:
- `zoom(delta)`: Adjust scale factor (0.5x to 4.0x)
- `zoomFitWidth()`: Auto-fit page width to viewport
- `prevPage()` / `nextPage()`: Page navigation
- Toolbar buttons trigger these

**Message Protocol**:
- **Receives**: loadPdf, goToAnchor, highlightAnnotations, setTheme
- **Sends**: ready, copyLinkToClipboard, requestInsertLink, annotationClicked, pageChanged, outline

**Bootstrap**:
```javascript
// HTML sets window.__pdfiumWasmUrl
(async function boot() {
  const eng = await createPdfiumEngine(wasmUrl);
  new PdfViewer();
})();
```

---

### 9. **markdown-preview.ts** — Markdown Preview Link Handler
**File**: `webview-src/markdown-preview.ts` | **Lines**: 27  
**Purpose**: Injected script that makes PDF links clickable in markdown preview.

**Mechanism**:
- Listen for clicks on `.paperlink-pdf-link` elements
- Prevent default link behavior
- Extract `data-pdf-path` and `data-pdf-anchor`
- Construct command URI and open via `window.open()`

**Command URI Format**:
```
command:paperlink.openPdfAtAnchor?encodeURIComponent(JSON.stringify({
  pdfPath: "papers/paper.pdf",
  anchor: "page=5&idx=12&off=5&len=40"
}))
```

**Why Needed**:
- Markdown-it renders HTML directly in preview
- Need to intercept clicks and route to VS Code command system
- Can't use regular links (wrong protocol, wrong handler)

---

## 🏗 Build Configuration

### **webpack.config.js** — Multi-entry Build
**Lines**: 103

**Three Entry Points** (built separately):

1. **Extension Host** (Node.js target)
   - Entry: `src/extension.ts`
   - Output: `dist/extension.js`
   - Externals: `vscode` (not bundled)
   - CommonJS module format

2. **PDF Viewer** (Browser target)
   - Entry: `webview-src/pdf-viewer.ts`
   - Output: `dist/pdf-viewer.js`
   - Plugins: CopyPlugin (copies `pdfium.wasm`)
   - ES2020 module format

3. **Markdown Preview** (Browser target)
   - Entry: `webview-src/markdown-preview.ts`
   - Output: `dist/markdown-preview.js`
   - No special dependencies

**Common Config**:
- Mode: production
- TS Loader with appropriate tsconfig
- Source maps (nosources-source-map)

---

### **tsconfig.json** — Host TypeScript Config
**Lines**: 19

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "lib": ["ES2021"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "webview-src"]
}
```

**Strict Mode**: Enabled (no `any`, strict null checks, etc.)

---

### **tsconfig.webview.json** — Webview TypeScript Config
**Lines**: 16

```json
{
  "compilerOptions": {
    "module": "ES2020",
    "target": "ES2021",
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "moduleResolution": "bundler"
  },
  "include": ["webview-src/**/*", "src/shared/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Differences**:
- Module: ES2020 (for webpack tree-shaking)
- Includes DOM types
- Bundler module resolution (for webpack)

---

## 📦 package.json — Dependencies & Scripts

**Version**: 0.1.0  
**License**: MIT  
**VS Code Requirement**: ≥ 1.85.0

**Scripts**:
- `npm run compile`: Webpack production build
- `npm run watch`: Webpack in watch mode for development
- `npm run compile-tests`: Compile test files with tsc
- `npm test`: Full test pipeline (compile + compile-tests + run tests)
- `npm run package`: Create `.vsix` extension package
- `npm run lint`: ESLint on src/

**Dependencies** (Production):
- `@embedpdf/engines@^2.14.0`: PDFium rendering engine
- `@embedpdf/models@^2.14.0`: PDFium data models
- `@embedpdf/pdfium@^2.14.0`: PDFium WASM binary

**Dev Dependencies**:
- `@types/vscode@^1.85.0`: VS Code API types
- `@types/node@^20.0.0`: Node.js types
- `@types/mocha@^10.0.10`: Mocha test types
- `typescript@^5.3.0`: TypeScript compiler
- `webpack@^5.89.0` + `webpack-cli@^5.1.4`: Bundler
- `ts-loader@^9.5.1`: TypeScript webpack loader
- `copy-webpack-plugin@^12.0.0`: Copy WASM file
- `mocha@^11.7.5`: Test runner
- `@vscode/test-electron@^2.5.2`: VS Code test environment

---

## 🧪 Test Suite

### **extension.test.ts** — Integration Tests
**File**: `test/suite/extension.test.ts` | **Lines**: 103  
**Framework**: Mocha + Node.js assert

**Test Cases**:

1. **`Extension should be present`**
   - Check extension is listed in VS Code

2. **`Extension should activate on PDF open`**
   - Open sample PDF via `vscode.openWith`
   - Verify extension activates
   - Wait 2 seconds for webview to initialize

3. **`PDF link regex should match valid links`**
   - Test regex matches: `@pdf[[papers/test.pdf#page=5&idx=12&off=5&len=40|"some text"]]`
   - Check all capturing groups

4. **`PDF link regex should match links without snippet`**
   - Test regex matches link without snippet part

5. **`Annotation sidecar file should not exist initially`**
   - Verify no `.paperlink.json` file before annotations created

6. **`Custom editor should be registered for PDF`**
   - Open PDF and verify a tab with `viewType === 'paperlink.pdfViewer'` exists

7. **`Markdown file should be openable alongside PDF`**
   - Open `notes.md` and verify language ID

8. **`Commands should be registered`**
   - Check registered commands list includes all PaperLink commands

**Test Workspace Requirements**:
- `sample.pdf`: Test PDF file
- `notes.md`: Test markdown file

---

## 🔄 Message & Command Flow

### **1. PDF Link Click Flow** (Markdown Editor)
```
User clicks @pdf[[...]] link in markdown editor
  ↓
PdfLinkProvider.provideDocumentLinks() provides link
  ↓
VS Code renders link as underline/blue text
  ↓
User clicks → VS Code executes command URI
  ↓
paperlink.openPdfAtAnchor command triggered
  ↓
PdfEditorProvider.openPdfAtAnchor(pdfPath, anchor)
  ↓
Opens PDF file with custom editor
  ↓
Webview loads → sendMessage({ type: 'goToAnchor', anchor })
  ↓
PdfViewer.goToAnchor() scrolls & highlights location
```

### **2. Text Selection Flow** (PDF Viewer)
```
User selects text in PDF viewer
  ↓
PdfViewer.handleTextSelection() triggered on mouseup
  ↓
selectionToAnchor() maps selection to text item coords
  ↓
showSelectionToolbar() displays "Copy Link" & "Insert in Note"
  ↓
User clicks "Copy Link"
  ↓
Webview: vscode.postMessage({ type: 'copyLinkToClipboard', anchor })
  ↓
Extension: formatPdfLink() creates markdown link
  ↓
vscode.env.clipboard.writeText(link)
  ↓
User pastes into markdown file
```

### **3. Annotation Highlighting Flow**
```
PDF opened
  ↓
PdfEditorProvider.loadPdfIntoWebview()
  ↓
AnnotationService.getAnnotationsForPdf(pdfUri)
  ↓
Load sidecar JSON file (or empty array)
  ↓
sendAnnotations(): postMessage({ type: 'highlightAnnotations', annotations })
  ↓
PdfViewer.annotations = msg.annotations
  ↓
redrawAllHighlights(): draws colored rectangles for each annotation
  ↓
User clicks highlight
  ↓
Webview: postMessage({ type: 'annotationClicked', annotationId })
  ↓
Extension: finds annotation, opens markdown file at blockRef location
```

### **4. Outline/Bookmarks Flow**
```
PDF loaded in webview
  ↓
engine.getBookmarks(doc) → bookmark tree
  ↓
convertBookmarks() recursively converts to PdfOutlineItem[]
  ↓
postMessage({ type: 'outline', items })
  ↓
Extension: PdfOutlineProvider.setOutline(items, goToPage)
  ↓
Tree view refreshes & displays outline in sidebar
  ↓
User clicks outline item
  ↓
paperlink.outlineGoToPage command executes
  ↓
PdfOutlineProvider.goToPage() triggers callback
  ↓
PdfEditorProvider callback: postMessage({ type: 'goToAnchor', ... })
  ↓
PDF scrolls to page
```

### **5. Markdown Preview Link Flow**
```
Markdown file open in preview
  ↓
markdown-preview.ts (injected script) loads
  ↓
Markdown-it renders text with @pdf[[...]] pattern
  ↓
markdownPlugin.ts converts to styled HTML link
  ↓
Link rendered in preview with blue styling
  ↓
User clicks link
  ↓
markdown-preview.ts click handler intercepts
  ↓
Constructs command:paperlink.openPdfAtAnchor?{...} URI
  ↓
window.open(commandUri)
  ↓
VS Code routes to extension command
  ↓
Same flow as "PDF Link Click Flow" above
```

---

## 🔐 Security & Isolation

### **Content Security Policy (CSP)** in Webview HTML
```html
default-src 'none';
script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource};
style-src 'unsafe-inline' ${webview.cspSource};
img-src ${webview.cspSource} blob: data:;
connect-src ${webview.cspSource};
```

- **No default-src**: Everything blocked by default
- **Nonce on script tags**: Prevents inline script injection
- **WASM-unsafe-eval**: Required for PDFium WASM engine
- **Blob & data URLs**: For canvas rendering & images
- **webview.cspSource**: VS Code's trusted source

### **File I/O Isolation**
- `AnnotationService` reads/writes only `.paperlink.json` sidecar files
- No arbitrary file access
- PDF files read via `vscode.workspace.fs` (workspace-bound)

---

## 📊 Data Persistence

### **Sidecar File Format**
```json
{
  "version": 1,
  "pdfFile": "paper.pdf",
  "annotations": [
    {
      "id": "abc123",
      "anchor": {
        "page": 5,
        "textItemIndex": 42,
        "charOffset": 12,
        "length": 47,
        "snippet": "This is the selected text..."
      },
      "markdownFile": "notes/research.md",
      "blockRef": "^section-1",
      "color": "rgba(255, 230, 0, 0.35)",
      "createdAt": "2024-04-17T10:30:00Z"
    }
  ]
}
```

**Storage Location**: Same directory as PDF, named `{pdfname}.paperlink.json`

**Versioning**: Version field allows future schema migrations

**Caching**: In-memory cache in `AnnotationService` prevents repeated disk reads

---

## 🎯 Feature Summary

| Feature | Implementation | Status |
|---------|----------------|--------|
| **PDF Viewing** | PDFium WASM engine via EmbedPDF | ✅ Full |
| **Text Selection** | MouseUp event → text item mapping | ✅ Full |
| **Annotation Highlighting** | Colored overlays via highlight layer | ✅ Full |
| **PDF Outline** | Tree view from bookmarks | ✅ Full |
| **Markdown Integration** | Document link provider + markdown-it | ✅ Full |
| **Link Generation** | Anchor → compact string format | ✅ Full |
| **Bidirectional Links** | Reverse lookup via workspace search | ✅ Partial |
| **Text Anchoring** | Page + text item + char offset | ✅ Full |
| **Zoom Controls** | Scale factor 0.5x–4.0x | ✅ Full |
| **Lazy Rendering** | IntersectionObserver | ✅ Full |
| **Dark Mode** | CSS variables `--bg`, `--text`, etc. | ✅ Full |
| **Multi-PDF Support** | Multiple tabs & webview instances | ✅ Full |
| **Sidecar Storage** | `.paperlink.json` files | ✅ Full |

---

## 🚀 Build & Release

### **Development Build**
```bash
npm install
npm run watch
# Watches src/ and webview-src/, rebuilds on changes
```

### **Production Build**
```bash
npm run compile
# Generates dist/ with all three bundles
```

### **Testing**
```bash
npm test
# Compiles extension, compiles tests, runs Mocha suite in VS Code environment
```

### **Packaging**
```bash
npm run package
# Creates paper-link-0.1.0.vsix file
```

---

## 📋 Ignore Files

### **.gitignore**
```
node_modules/
dist/
out/
*.vsix
.vscode-test/
```

### **.vscodeignore**
```
node_modules/
dist/
*.vsix
.vscode-test/
```

Both prevent bloat in git repo and VSIX package.

---

## 🔗 Extension Manifest (package.json)

### **Activation Events**
- `onLanguage:markdown`: Activate when markdown file opened
- `onCustomEditor:paperlink.pdfViewer`: Activate when PDF opened

### **Contributes**
- **customEditors**: `paperlink.pdfViewer` for `*.pdf`
- **commands**: 4 commands registered
- **views**: PDF Outline tree view in explorer
- **markdown**: Plugin for markdown preview rendering

---

## 📝 Key Insights for Documentation

1. **Architecture Philosophy**: Separation of concerns
   - Host: Management & coordination
   - Webview: Rendering & UX
   - Shared types: Contract between both

2. **PDFium Choice**: Pixel-perfect text positioning
   - Each text item has precise bounding box
   - Enables stable anchors across PDF versions
   - Better than PDF.js for text layout

3. **Lazy Rendering**: Performance optimization
   - Only render visible pages
   - IntersectionObserver + flag pattern
   - Zoom recalculates lazily

4. **Sidecar Storage**: Simple & reliable
   - No database needed
   - Stays with PDF file
   - Easy to backup/share
   - Human-readable JSON

5. **Bidirectional**: Two complementary approaches
   - Forward: Markdown → PDF (document links + markdown preview)
   - Reverse: PDF → Markdown (sidecar annotations + quick open)

6. **Message Protocol**: Async request-response
   - Webview → Host: User actions
   - Host → Webview: State updates
   - No RPC framework, manual message handling

---

## 🎓 Documentation Checklist

For writers covering this codebase:

- [ ] **User Guide**
  - How to select text and create links
  - How to view annotations from markdown
  - How to use the PDF outline

- [ ] **Developer Guide**
  - How to add new annotation properties
  - How to modify highlight rendering
  - How to extend markdown link syntax

- [ ] **Architecture**
  - Message flow diagrams
  - Dataflow for annotations
  - Webview → Host communication

- [ ] **API Reference**
  - All exported types
  - Message protocol schema
  - Command parameters

- [ ] **Troubleshooting**
  - PDF not rendering (WASM loading)
  - Annotations not persisting (sidecar location)
  - Links not working (regex pattern)

