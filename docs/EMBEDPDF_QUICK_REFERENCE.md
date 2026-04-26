# EmbedPDF Quick Reference (Vanilla JS/TS)

## 1-Minute Setup

```typescript
// Install
npm install @embedpdf/core @embedpdf/engines @embedpdf/pdfium

// Initialize
import { createPdfiumDirectEngine, DEFAULT_PDFIUM_WASM_URL } from '@embedpdf/engines/pdfium-direct-engine';
const engine = await createPdfiumDirectEngine(DEFAULT_PDFIUM_WASM_URL);

// Load & render
const doc = await engine.openDocumentUrl('https://example.com/doc.pdf');
const canvas = document.getElementById('canvas');
const result = await engine.renderPage(doc.pages[0], { scale: 1.0, width: 800, height: 600 });
const img = new Image();
img.src = URL.createObjectURL(result.imageData);
canvas.getContext('2d').drawImage(img, 0, 0);
```

## Core APIs

### Load Document
```typescript
// From URL
const doc = await engine.openDocumentUrl(url);

// From file/buffer
const buffer = await file.arrayBuffer();
const doc = await engine.openDocumentBuffer(buffer);
```

### Render Page (= PDF.js renderPage)
```typescript
const result = await engine.renderPage(page, {
  scale: 1.5,              // Zoom (1 = 100%)
  width: 800,              // Canvas width
  height: 600,             // Canvas height
  format: BitmapFormat.Bitmap_BGRA,
  flags: RenderFlag.ANNOT | RenderFlag.LCD_TEXT
});

// Result is a Blob/ImageData — display on canvas
const img = new Image();
img.src = URL.createObjectURL(result.imageData);
```

### Get Text Content (= PDF.js getTextContent)
```typescript
const textRuns = await engine.getPageTextRuns(page);
// textRuns.runs[] = [{ text, bounds, fontName, fontSize }]

textRuns.runs.forEach(run => {
  console.log(run.text, run.bounds);  // Bounds: { left, top, right, bottom }
});
```

### Get Bookmarks/Outline
```typescript
const outline = await engine.getDocumentBookmarks(doc);
// outline[] = [{ title, children?, dest? }]

// Recursive render
function renderOutline(bookmarks, indent = 0) {
  for (const b of bookmarks) {
    console.log('  '.repeat(indent) + b.title);
    if (b.children) renderOutline(b.children, indent + 1);
  }
}
```

### Handle Text Selection
```typescript
// Listen for selection change
engine.on('selection:changed', (selection) => {
  if (!selection) return;
  
  console.log('Text:', selection.text);
  console.log('Bounds:', selection.bounds);  // Array of Rect
  // selection.pageIndex = which page
  
  // Copy to clipboard
  engine.copySelectionToClipboard();
});
```

## Two Engine Modes

### Main Thread (Simpler)
```typescript
import { createPdfiumDirectEngine } from '@embedpdf/engines/pdfium-direct-engine';
const engine = await createPdfiumDirectEngine(wasmUrl);
// ⚠️ Heavy PDFs will block UI
```

### Web Worker (Non-Blocking)
```typescript
import { createPdfiumWorkerEngine } from '@embedpdf/engines/pdfium-worker-engine';
const engine = await createPdfiumWorkerEngine(wasmUrl);
// ✅ UI stays responsive
```

## Text Coordinate Systems

**PDF coords:** Origin = bottom-left, Y increases upward  
**Canvas coords:** Origin = top-left, Y increases downward

```typescript
function pdfToCanvas(pdfRect, pageHeight) {
  return {
    left: pdfRect.left,
    top: pageHeight - pdfRect.bottom,  // Flip Y
    right: pdfRect.right,
    bottom: pageHeight - pdfRect.top
  };
}
```

## Plugins (Optional)

### Register Plugins
```typescript
import { SelectionPlugin } from '@embedpdf/plugin-selection';
import { SearchPlugin } from '@embedpdf/plugin-search';
import { BookmarkPlugin } from '@embedpdf/plugin-bookmark';

const core = new PDFCore(engine);

core.registerPlugin(new SelectionPlugin());
core.registerPlugin(new SearchPlugin());
core.registerPlugin(new BookmarkPlugin());

const registry = await core.registry;
const selection = registry.getPlugin('selection')?.provides()?.forDocument(docId);
```

### Available Plugins
- `RenderPlugin` — Rendering
- `SelectionPlugin` — Text selection
- `SearchPlugin` — Full-text search
- `ZoomPlugin` — Zoom controls
- `ScrollPlugin` — Page scrolling
- `BookmarkPlugin` — TOC
- `AnnotationPlugin` — Annotations
- `FormPlugin` — Forms
- `ExportPlugin` — Export to PDF
- ... and many more

## Comparison with PDF.js

| Feature | PDF.js | EmbedPDF |
|---------|--------|----------|
| Render page | `page.render()` | `engine.renderPage()` |
| Get text | `page.getTextContent()` | `engine.getPageTextRuns()` |
| Get outline | Manual parsing | `engine.getDocumentBookmarks()` |
| Worker setup | Manual + `.worker.js` | Automatic |
| Performance | ~1x (JS) | ~8x faster (PDFium) |
| Bookmarks | Basic | Rich tree structure |
| Plugin system | No | Yes (modular) |

## CSP Headers (VS Code Webview)

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               script-src vscode-webview-resource: https://cdn.jsdelivr.net;
               worker-src vscode-webview-resource: blob:;
               img-src vscode-webview-resource: data: https:;">
```

## Memory Management

```typescript
// Always close documents
await engine.closeDocument(doc);

// For large PDFs, use Worker mode
const engine = await createPdfiumWorkerEngine(wasmUrl);
```

## Render Flags

```typescript
enum RenderFlag {
  ANNOT = 0x01,           // Render annotations
  LCD_TEXT = 0x02,        // Text optimized for LCD
  NO_NATIVETEXT = 0x04,   // Don't use native rendering
  GRAYSCALE = 0x08,       // Grayscale output
  PRINTING = 0x800,       // Optimize for printing
}
```

## WASM File Location

- **CDN:** `https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.14.0/dist/pdfium.wasm`
- **VS Code Webview:** Use `vscode-resource://` or `file://` protocol
- **Local:** Serve with `Content-Type: application/wasm` header

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Text coordinates wrong | Use `pdfToCanvas()` to convert (flip Y) |
| WASM file 404 | Check CDN or local file path + MIME type |
| UI freezes on large PDF | Use `createPdfiumWorkerEngine()` |
| CORS errors | Ensure WASM served with correct headers |
| Memory issues | Call `engine.closeDocument()` + use Worker mode |

## Resources

- Docs: https://www.embedpdf.com/docs
- GitHub: https://github.com/embedpdf/embed-pdf-viewer
- Examples: https://github.com/embedpdf/embed-pdf-viewer/tree/main/examples/vanilla-tailwind
- NPM: @embedpdf/pdfium, @embedpdf/engines, @embedpdf/core

## Key Takeaways

✅ **Framework-agnostic** — Works with vanilla JS, no React needed  
✅ **Simple API** — Load → Render → Extract text  
✅ **Fast** — PDFium WASM ~8x faster than PDF.js  
✅ **Modular** — Use only what you need (tree-shakeable)  
✅ **Text coordinates** — Convert PDF coords (bottom-left) to canvas coords (top-left)  
✅ **Worker support** — Non-blocking UI for large PDFs  
