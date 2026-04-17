# Architecture

## System Overview

PaperLink is a VS Code extension with two execution contexts connected by message passing:

```
VS Code Extension Host (Node.js)          VS Code Webview (Browser sandbox)
┌─────────────────────────────────┐       ┌──────────────────────────────────┐
│ extension.ts                    │       │ pdf-viewer.ts                    │
│  ├─ PdfEditorProvider           │◄─────►│  ├─ PDFium WASM engine           │
│  ├─ AnnotationService           │  post │  ├─ Canvas renderer              │
│  ├─ PdfLinkProvider             │  Msg  │  ├─ Text layer (from textRects)  │
│  ├─ PdfOutlineProvider          │       │  ├─ Highlight layer              │
│  └─ MarkdownPlugin              │       │  └─ Selection toolbar            │
└─────────────────────────────────┘       └──────────────────────────────────┘
```

The extension host handles file I/O, VS Code API integration, and annotation storage. The webview handles PDF rendering, text selection, and user interaction. They communicate exclusively through a typed message protocol.

## File Map

```
paper-link/
├── src/                            Extension host (Node.js, CommonJS)
│   ├── extension.ts                Entry point; registers all providers, commands, views
│   ├── pdfEditorProvider.ts        CustomReadonlyEditorProvider; manages webview lifecycle,
│   │                                 HTML template with CSP, message routing
│   ├── annotationService.ts        CRUD for sidecar .paperlink.json files; in-memory cache
│   ├── pdfLinkProvider.ts          DocumentLinkProvider for @pdf[[...]] syntax in .md files
│   ├── pdfOutlineProvider.ts       TreeDataProvider for PDF Outline panel in Explorer
│   ├── markdownPlugin.ts           markdown-it plugin rendering @pdf[[...]] in preview
│   └── shared/
│       └── types.ts                PdfAnchor, Annotation, message types, link regex
├── webview-src/                    Webview (Browser, ES modules)
│   ├── pdf-viewer.ts               PdfViewer class; PDFium init, render, text layer, selection
│   ├── markdown-preview.ts         Click handler injected into markdown preview
│   └── vscode.d.ts                 Type stubs for acquireVsCodeApi()
├── test/
│   ├── runTest.ts                  Test runner using @vscode/test-electron
│   └── suite/
│       ├── index.ts                Mocha setup
│       └── extension.test.ts       8 integration tests
├── test-workspace/                 Sample PDF and markdown for testing
├── webpack.config.js               3 build targets: extension, webview, markdown-preview
├── tsconfig.json                   Node target (extension host)
├── tsconfig.webview.json           Browser target (webview), moduleResolution: "bundler"
└── package.json                    Extension manifest, contributes, scripts, dependencies
```

**Line counts**: 1,589 lines of TypeScript across 12 source files.

## PDF Rendering Engine

PaperLink uses **PDFium** (Chrome's PDF engine) compiled to WebAssembly via the `@embedpdf/engines` and `@embedpdf/pdfium` packages.

### Why PDFium over PDF.js

PDF.js renders a canvas image then overlays invisible DOM `<span>` elements for text selection. These spans approximate glyph positions using web font metrics, causing drift -- especially noticeable on macOS where Dictionary Lookup (three-finger tap) hits the wrong word.

PDFium avoids this entirely: `getPageTextRects()` returns bounding rectangles computed by the same engine that renders the pixels, so coordinates are exact.

### Rendering Pipeline

```
1. Extension host reads PDF binary from disk
2. Sends base64-encoded data to webview via postMessage
3. Webview decodes and passes to engine.openDocumentBuffer()
4. For each visible page (IntersectionObserver):
   a. engine.renderPage(doc, page, {scaleFactor, dpr})  →  Blob (image)
   b. Draw Blob onto <canvas> via Image → drawImage
   c. engine.getPageTextRects(doc, page)  →  PdfTextRectObject[]
   d. Build <span> elements positioned using rect.origin.x/y * scale
   e. Draw annotation highlight <div>s from stored annotations
```

### Coordinate System

PDFium's `getPageTextRects()` returns coordinates in **device space** (top-left origin, Y increases downward). No coordinate flip is needed -- just multiply by the scale factor.

```typescript
// Each PdfTextRectObject has:
{
  content: string,              // "Attention Is All You Need"
  rect: {
    origin: { x: 72, y: 75 },  // Top-left of text box in PDF points
    size: { width: 285, height: 18 }
  },
  font: { family: "Helvetica", size: 24 }
}

// Position the span:
span.style.left = `${rect.origin.x * scale}px`;
span.style.top  = `${rect.origin.y * scale}px`;
```

## Data Model

### PdfAnchor

A stable reference to a text range within a PDF page:

```typescript
interface PdfAnchor {
  page: number;           // 1-based page number
  textItemIndex: number;  // Index into getPageTextRects() result array
  charOffset: number;     // Character offset within that text item
  length: number;         // Number of characters selected
  snippet: string;        // The actual selected text (for fallback matching)
}
```

Serialized form: `page=5&idx=12&off=5&len=40`

### Annotation

Links a PDF anchor to a markdown location:

```typescript
interface Annotation {
  id: string;
  anchor: PdfAnchor;
  markdownFile: string;   // Relative path from workspace root
  blockRef?: string;      // Optional heading or ^block-id
  color: string;          // CSS color for the highlight
  createdAt: string;      // ISO 8601
}
```

### Storage

Annotations are stored in **sidecar JSON files** next to each PDF:

```
papers/
  attention.pdf
  attention.pdf.paperlink.json    ← sidecar file
```

Schema:

```json
{
  "version": 1,
  "pdfFile": "attention.pdf",
  "annotations": [
    {
      "id": "a1b2c3",
      "anchor": { "page": 1, "textItemIndex": 3, "charOffset": 0, "length": 42, "snippet": "..." },
      "markdownFile": "notes/reading-notes.md",
      "blockRef": "self-attention",
      "color": "rgba(255, 230, 0, 0.3)",
      "createdAt": "2026-04-17T00:00:00.000Z"
    }
  ]
}
```

No database, no cloud service. Files sync naturally with git, Dropbox, WebDAV, etc.

## Message Protocol

Extension host and webview communicate via `postMessage` with typed unions.

### Extension → Webview

| Message | Payload | When |
|---------|---------|------|
| `loadPdf` | `data: string` (base64) | Webview sends `ready`; extension reads PDF and sends data |
| `goToAnchor` | `anchor: PdfAnchor` | User clicks a markdown link or outline item |
| `highlightAnnotations` | `annotations: Annotation[]` | After loading PDF or when annotations change |
| `setTheme` | `theme: 'light' \| 'dark'` | VS Code theme changes |

### Webview → Extension

| Message | Payload | When |
|---------|---------|------|
| `ready` | -- | Webview DOM loaded, PDFium engine initialized |
| `copyLinkToClipboard` | `anchor: PdfAnchor` | User clicks "Copy Link" in selection toolbar |
| `requestInsertLink` | `anchor: PdfAnchor` | User clicks "Insert in Note" |
| `annotationClicked` | `annotationId: string` | User clicks a highlight in the PDF |
| `pageChanged` | `page: number` | User scrolls or navigates to a different page |
| `outline` | `items: PdfOutlineItem[]` | After PDF loads, bookmarks extracted |

## Markdown Integration

### DocumentLinkProvider (`pdfLinkProvider.ts`)

Scans markdown files for `@pdf[[...]]` patterns using the regex:

```
/@pdf\[\[([^\]#]+)#([^\]|]+)(?:\|"([^"]*)")?\]\]/g
```

Converts matches to clickable `command:paperlink.openPdfAtAnchor` URIs.

### Markdown-it Plugin (`markdownPlugin.ts`)

Extends `md.renderer.rules.text` to transform `@pdf[[...]]` into styled `<a>` elements in the markdown preview. The links include `data-pdf-path` and `data-pdf-anchor` attributes.

### Preview Script (`markdown-preview.ts`)

Injected into VS Code's markdown preview webview. Intercepts clicks on `.paperlink-pdf-link` elements and opens the PDF at the target anchor via `command:` URI.

## Build System

Webpack produces three independent bundles:

| Target | Entry | Output | Environment |
|--------|-------|--------|-------------|
| `extension` | `src/extension.ts` | `dist/extension.js` | Node.js (CommonJS) |
| `webview` | `webview-src/pdf-viewer.ts` | `dist/pdf-viewer.js` | Browser |
| `markdown-preview` | `webview-src/markdown-preview.ts` | `dist/markdown-preview.js` | Browser |

Additionally, `CopyPlugin` copies `pdfium.wasm` (4.4 MB) from `@embedpdf/pdfium/dist/` to `dist/`.

### CSP (Content Security Policy)

The webview HTML sets a strict CSP:

```
default-src 'none';
script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource};
style-src 'unsafe-inline' ${webview.cspSource};
img-src ${webview.cspSource} blob: data:;
font-src ${webview.cspSource};
connect-src ${webview.cspSource};
```

Key points:
- `'wasm-unsafe-eval'` is required for PDFium WASM compilation
- `blob:` in `img-src` is needed because `engine.renderPage()` returns a Blob which is displayed via `URL.createObjectURL()`
- `connect-src` is needed for `fetch()` of the WASM file

## Testing

8 integration tests using `@vscode/test-electron` + Mocha:

| Test | What it verifies |
|------|-----------------|
| Extension should be present | Extension is discoverable by ID |
| Extension should activate on PDF open | Activation via `onCustomEditor` event |
| PDF link regex should match valid links | Full `@pdf[[...]]` syntax with snippet |
| PDF link regex should match links without snippet | Minimal syntax without `\|"..."` |
| Annotation sidecar file should not exist initially | Clean state before annotations |
| Custom editor should be registered for PDF | `vscode.openWith` with our viewType works |
| Markdown file should be openable alongside PDF | Side-by-side editor layout |
| Commands should be registered | All 3 commands present in command palette |

Run with:

```bash
npm test
```

This downloads a fresh VS Code instance into `.vscode-test/`, launches it headlessly with the extension, runs the suite, and exits.
