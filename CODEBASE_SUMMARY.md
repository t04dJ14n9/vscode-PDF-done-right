# PaperLink Codebase — Quick Reference

## File Inventory

| File Path | Lines | Purpose | Key Exports/Classes |
|-----------|-------|---------|-------------------|
| **src/extension.ts** | 84 | Extension entry point & component registration | `activate()`, `deactivate()` |
| **src/pdfEditorProvider.ts** | 429 | Custom PDF editor webview manager | `PdfEditorProvider` (CustomReadonlyEditorProvider) |
| **src/annotationService.ts** | 120 | Sidecar JSON file storage & caching | `AnnotationService` |
| **src/pdfLinkProvider.ts** | 45 | Document link provider for markdown | `PdfLinkProvider` (DocumentLinkProvider) |
| **src/pdfOutlineProvider.ts** | 62 | PDF bookmarks tree view | `PdfOutlineProvider` (TreeDataProvider) |
| **src/markdownPlugin.ts** | 72 | Markdown-it plugin for preview rendering | `activateMarkdownItPlugin()` |
| **src/shared/types.ts** | 92 | Shared types & serialization | `PdfAnchor`, `Annotation`, `AnnotationStore`, regex patterns |
| **webview-src/pdf-viewer.ts** | 524 | Main PDF viewer (PDFium + Canvas) | `PdfViewer` class |
| **webview-src/markdown-preview.ts** | 27 | Markdown preview link handler | IIFE click interceptor |
| **webpack.config.js** | 103 | Build configuration (3 entry points) | Multi-target webpack config |
| **tsconfig.json** | 19 | Host TypeScript config | CommonJS, ES2021 |
| **tsconfig.webview.json** | 16 | Webview TypeScript config | ES2020, DOM types |
| **test/suite/extension.test.ts** | 103 | Integration tests (Mocha) | 8 test cases |
| **package.json** | 92 | Dependencies & metadata | Scripts, dependencies, engine requirements |
| **.gitignore** | 6 | Git ignore rules | — |
| **.vscodeignore** | 5 | VSIX ignore rules | — |

**Total**: 1,560+ lines of TypeScript source code

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                   │
│                       (Node.js/V8)                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌────────────────────┐      ┌──────────────────────┐     │
│  │ extension.ts       │      │ AnnotationService    │     │
│  │ (Activation hub)   │─────→│ (Sidecar storage)    │     │
│  └────────────────────┘      └──────────────────────┘     │
│            │                                               │
│  ┌─────────┴──────────────────────────────────────────┐   │
│  ↓                                                    ↓   │
│  PdfEditorProvider          PdfOutlineProvider         │   │
│  (Custom editor)            (Tree view)                │   │
│            │                      ↑                       │
│            └──────────┬───────────┘                       │
│                       ↓                                    │
│              Message Queue (postMessage)                  │
│                                                           │
└─────────────────────────────────────────────────────────────┘
                             ↓ | ↑
                    ┌─────────────────────┐
                    │  Webview Iframe     │
                    │   (Browser/WASM)    │
                    ├─────────────────────┤
                    │  pdf-viewer.ts      │
                    │  (PDFium engine)    │
                    │  (Text selection)   │
                    │  (Highlighting)     │
                    └─────────────────────┘
                             ↓
                    ┌─────────────────────┐
                    │  Markdown Editor    │
                    │  + Markdown Preview │
                    ├─────────────────────┤
                    │ PdfLinkProvider     │
                    │ markdownPlugin.ts   │
                    │ markdown-preview.ts │
                    └─────────────────────┘
```

---

## Data Flow Summary

### **Forward Flow: Markdown → PDF**
1. User clicks `@pdf[[path#anchor|"snippet"]]` in markdown editor
2. `PdfLinkProvider` provides clickable link
3. `paperlink.openPdfAtAnchor` command executes
4. `PdfEditorProvider.openPdfAtAnchor()` navigates PDF
5. Webview receives `{ type: 'goToAnchor', anchor }` message
6. `PdfViewer.goToAnchor()` scrolls to text location

### **Backward Flow: PDF → Markdown**
1. User selects text in PDF viewer
2. `PdfViewer.handleTextSelection()` creates `PdfAnchor`
3. `showSelectionToolbar()` displays "Copy Link" button
4. User clicks → `copyLinkToClipboard` message sent
5. `formatPdfLink()` creates markdown link → copied to clipboard
6. User pastes into markdown file

### **Annotation Display Flow**
1. PDF opens in editor
2. `AnnotationService.getAnnotationsForPdf()` loads sidecar JSON
3. `sendAnnotations()` sends to webview
4. `drawHighlightsForPage()` renders colored overlays
5. User clicks highlight → jumps to markdown note

---

## Key Design Patterns

| Pattern | Where Used | Benefit |
|---------|-----------|---------|
| **Custom Editor Provider** | `PdfEditorProvider` | Custom UI for PDF files |
| **Document Link Provider** | `PdfLinkProvider` | Clickable links in editor |
| **Tree Data Provider** | `PdfOutlineProvider` | Hierarchical outline display |
| **Markdown-it Plugin** | `markdownPlugin.ts` | Custom HTML rendering |
| **Lazy Rendering** | `pdf-viewer.ts` | Performance (IntersectionObserver) |
| **Sidecar Storage** | `annotationService.ts` | Portable annotation storage |
| **Message Protocol** | Extension ↔ Webview | Async communication |
| **In-Memory Cache** | `AnnotationService` | Reduce disk I/O |

---

## Type System

### Core Types
```typescript
PdfAnchor {
  page: number                    // 1-based
  textItemIndex: number           // Into page text items
  charOffset: number              // Character position
  length: number                  // Selection length
  snippet: string                 // Selected text (fallback)
}

Annotation {
  id: string
  anchor: PdfAnchor
  markdownFile: string            // Relative path
  blockRef?: string               // ^block-id or heading
  color: string                   // RGBA
  createdAt: string               // ISO timestamp
}

AnnotationStore {
  version: 1
  pdfFile: string
  annotations: Annotation[]
}

PdfOutlineItem {
  title: string
  page: number
  children: PdfOutlineItem[]
}
```

### Serialization
- **Anchor Format**: `page=5&idx=12&off=5&len=40` (URL query string)
- **Link Format**: `@pdf[[path#anchor|"snippet"]]` (markdown)
- **Sidecar File**: `{pdfname}.paperlink.json` (JSON)

---

## Command Registry

| Command ID | Trigger | Handler | Payload |
|------------|---------|---------|---------|
| `paperlink.openPdfAtAnchor` | Markdown link click | Navigates PDF to anchor | `{ pdfPath, anchor }` |
| `paperlink.outlineGoToPage` | Outline item click | Jump to page | `page: number` |
| `paperlink.showAnnotations` | User invocation | Show quickpick | — |
| `paperlink.createAnnotationLink` | Toolbar button | Copy link to clipboard | — |
| `paperlink.insertPdfLink` | Toolbar button | Insert at cursor | — |

---

## Build System

### Webpack Targets
| Target | Entry | Output | Format | Purpose |
|--------|-------|--------|--------|---------|
| **extension** | src/extension.ts | dist/extension.js | CommonJS | Node.js host |
| **webview** | webview-src/pdf-viewer.ts | dist/pdf-viewer.js | ES2020 | Browser/WASM |
| **markdown-preview** | webview-src/markdown-preview.ts | dist/markdown-preview.js | ES2020 | Browser |

### TypeScript Configs
- **Host** (`tsconfig.json`): CommonJS, strict mode, ES2021
- **Webview** (`tsconfig.webview.json`): ES2020, DOM types, bundler resolution

### NPM Scripts
```bash
npm run compile       # Production webpack build
npm run watch        # Dev watch mode
npm run compile-tests # Compile test files
npm test             # Full test pipeline
npm run package      # Create .vsix extension
npm run lint         # ESLint check
```

---

## Message Protocol

### Extension → Webview
```typescript
{ type: 'loadPdf'; data: string }                      // base64 PDF
{ type: 'goToAnchor'; anchor: PdfAnchor }            // Navigate
{ type: 'highlightAnnotations'; annotations: Annotation[] }  // Show marks
{ type: 'setTheme'; theme: 'light' | 'dark' }        // Theme
```

### Webview → Extension
```typescript
{ type: 'ready' }                                      // Init done
{ type: 'copyLinkToClipboard'; anchor: PdfAnchor }   // User action
{ type: 'requestInsertLink'; anchor: PdfAnchor }      // User action
{ type: 'annotationClicked'; annotationId: string }   // Jump to note
{ type: 'outline'; items: PdfOutlineItem[] }          // Bookmarks
{ type: 'pageChanged'; page: number }                 // Navigation
{ type: 'selectionMade'; anchor: PdfAnchor }          // Text select
```

---

## Dependencies

### Production
- `@embedpdf/engines@^2.14.0` — PDFium rendering
- `@embedpdf/models@^2.14.0` — PDFium data models
- `@embedpdf/pdfium@^2.14.0` — PDFium WASM binary

### Dev
- `webpack@^5.89.0`, `typescript@^5.3.0`, `ts-loader@^9.5.1`
- `@types/vscode@^1.85.0`, `@types/node@^20.0.0`
- `mocha@^11.7.5`, `@vscode/test-electron@^2.5.2`
- `copy-webpack-plugin@^12.0.0` (copies WASM)

---

## File Locations (Important)

| Item | Location |
|------|----------|
| **Extension entry** | `src/extension.ts` (main export: `activate()`) |
| **Webview main** | `webview-src/pdf-viewer.ts` (main class: `PdfViewer`) |
| **Shared types** | `src/shared/types.ts` (used by both host & webview) |
| **Sidecar files** | `{pdfPath}.paperlink.json` (same dir as PDF) |
| **Regex pattern** | `src/shared/types.ts` → `PDF_LINK_REGEX` |
| **Built files** | `dist/extension.js`, `dist/pdf-viewer.js`, `dist/markdown-preview.js` |
| **Tests** | `test/suite/extension.test.ts` |

---

## Activation Events

```json
{
  "activationEvents": [
    "onLanguage:markdown",
    "onCustomEditor:paperlink.pdfViewer"
  ]
}
```

- **Markdown files open** → Activates document link provider & markdown-it plugin
- **PDF files opened** → Activates custom editor provider

---

## VS Code Capabilities Registered

| Capability | ID | Type | Details |
|------------|----|----|---------|
| **Custom Editor** | `paperlink.pdfViewer` | PDF files | Webview-based |
| **Tree View** | `paperlink.outline` | Sidebar | PDF bookmarks |
| **Document Links** | — | Markdown | `@pdf[[...]]` patterns |
| **Markdown Plugin** | — | Preview | Custom HTML rendering |
| **Commands** | 4 items | — | See command registry |

---

## Testing

### Test Framework
- **Runner**: Mocha
- **Environment**: `@vscode/test-electron`
- **Assertion**: Node.js built-in `assert`

### Test Categories
- **Unit**: Regex pattern matching
- **Integration**: Extension activation, editor registration, file operations

### Requirements
- `sample.pdf` in workspace root
- `notes.md` in workspace root

---

## Security Model

### Content Security Policy (CSP)
```
default-src 'none'
script-src 'nonce-*' 'wasm-unsafe-eval'
style-src 'unsafe-inline'
img-src blob: data:
```
- Strict by default, allows only necessary origins
- Nonce on script tags prevents injection
- WASM requires `wasm-unsafe-eval`

### File Access
- Only workspace-bound via `vscode.workspace.fs`
- Sidecar files read/written to PDF directory only
- No arbitrary filesystem access

---

## Performance Considerations

| Aspect | Optimization |
|--------|--------------|
| **PDF Rendering** | Lazy rendering with IntersectionObserver |
| **Text Extraction** | PDFium provides precise rects (pre-calculated) |
| **Annotation Caching** | In-memory cache in `AnnotationService` |
| **Zoom** | Recalculates lazily, rebuilds DOM only on zoom |
| **Text Selection** | Throttled on mouseup (50ms delay) |

---

## Key Files for Common Tasks

| Task | Files to Modify |
|------|-----------------|
| Add new command | `src/extension.ts` + `package.json` |
| Change link format | `src/shared/types.ts` (regex & serialization) |
| Add annotation property | `src/shared/types.ts` + sidecar schema + `annotationService.ts` |
| Modify PDF viewer UI | `webview-src/pdf-viewer.ts` + HTML in `pdfEditorProvider.ts` |
| Change highlight color | `webview-src/pdf-viewer.ts` (drawHighlightsForPage) |
| Add tree view feature | `src/pdfOutlineProvider.ts` |
| Modify markdown rendering | `src/markdownPlugin.ts` |

---

## First Time Setup

```bash
# Clone repo
cd vscode-PDF-done-right

# Install dependencies
npm install

# Watch mode for development
npm run watch

# In another terminal, open VS Code
code .

# Press F5 to launch extension in debug mode
```

---

## Release Checklist

- [ ] Update version in `package.json`
- [ ] Update `CHANGELOG.md` (if exists)
- [ ] Run tests: `npm test`
- [ ] Build: `npm run compile`
- [ ] Package: `npm run package`
- [ ] Upload `.vsix` to VS Code marketplace

---

