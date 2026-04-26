# EmbedPDF PDFium WASM - Vanilla JS/TS Research Guide

**Current Date:** April 2026  
**EmbedPDF Version:** 2.14.0  
**License:** MIT (core) + Apache 2.0 (PDFium WASM)

---

## 1. NPM Packages & Dependency Tree

### Core Packages Needed

For vanilla JS/TS in a VS Code webview, you need these three core packages:

```bash
npm install @embedpdf/core @embedpdf/engines @embedpdf/pdfium
```

#### **@embedpdf/pdfium** (v2.14.0)
- **Purpose:** JavaScript interface to PDFium WebAssembly
- **Exports:** PDFium WASM binary + low-level C function wrappers
- **Key Exports:**
  ```typescript
  export const DEFAULT_PDFIUM_WASM_URL: string;
  export type WrappedPdfiumModule;
  export async function init(options): Promise<WrappedPdfiumModule>;
  ```
- **WASM File:** Embedded as `/dist/pdfium.wasm`
- **Size:** ~10-12 MB (PDFium compiled to WASM)
- **No Runtime Dependencies** (just needs Emscripten runtime)

#### **@embedpdf/engines** (v2.14.0)
- **Purpose:** Pluggable runtime abstraction layer over PDFium
- **Provides:** High-level orchestration, task scheduling, priority queues
- **Key Dependencies:**
  - `@embedpdf/pdfium` (direct dependency)
  - `@embedpdf/models` (type definitions and data structures)
  - Font packages: `@embedpdf/fonts-{latin,jp,kr,sc,tc,hebrew,arabic}`
- **Exports:**
  ```typescript
  export { createPdfiumDirectEngine } from './web/direct-engine';
  export { createPdfiumWorkerEngine } from './web/worker-engine';
  export { PdfEngine };
  ```
- **Two Modes:**
  1. **Direct Engine** — PDFium runs on main thread
  2. **Worker Engine** — PDFium runs in Web Worker (non-blocking UI)

#### **@embedpdf/core** (v2.14.0)
- **Purpose:** Framework-agnostic plugin system and state management
- **Key Exports:**
  ```typescript
  export * from './registry/plugin-registry';
  export * from './store/actions';
  export * from './store/selectors';
  export * from './utils/plugin-helpers';
  export * from './types/plugin';
  ```
- **No Framework Dependencies** (includes React/Vue/Svelte hooks but they're optional)
- **Peer Dependencies:** React, Vue, Svelte, Preact (all optional)

#### Optional Plugin Packages

For additional functionality, individual plugins are available:

```typescript
// Available as separate @embedpdf/plugin-* packages:
@embedpdf/plugin-render      // Core rendering
@embedpdf/plugin-selection   // Text selection + coordinates
@embedpdf/plugin-search      // Full-text search
@embedpdf/plugin-zoom        // Zoom controls
@embedpdf/plugin-scroll      // Scroll management
@embedpdf/plugin-pan         // Pan/move functionality
@embedpdf/plugin-bookmark    // Document outline
@embedpdf/plugin-annotation  // Annotations
@embedpdf/plugin-form        // Form filling
@embedpdf/plugin-print       // Print support
@embedpdf/plugin-export      // Export to PDF
@embedpdf/plugin-fullscreen  // Fullscreen mode
// ... and many more
```

### Dependency Tree Summary

```
@embedpdf/core (2.14.0)
├── @embedpdf/engines (2.14.0)  ← Main rendering
│   ├── @embedpdf/pdfium (2.14.0)  ← WASM binary
│   │   └── [No runtime deps — just Emscripten]
│   ├── @embedpdf/models  ← Type definitions
│   ├── @embedpdf/fonts-* (7 font packages)
│   └── [Dev deps only: Jest, TypeScript, etc.]
└── @embedpdf/models
```

**For vanilla JS minimal setup:**
```bash
npm install @embedpdf/core @embedpdf/engines @embedpdf/pdfium
# Tree-shakeable: only import what you use
```

---

## 2. Core API - Framework-Agnostic Usage

### High-Level: EmbedPDF Snippet API (CDN, Zero Build)

The simplest approach for a webview:

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/npm/@embedpdf/snippet/dist/embedpdf.js"></script>
</head>
<body>
  <div id="pdf-viewer" style="height: 500px;"></div>
  
  <script type="module">
    import EmbedPDF from 'https://cdn.jsdelivr.net/npm/@embedpdf/snippet/dist/embedpdf.js';
    
    const viewer = EmbedPDF.init({
      type: 'container',
      target: document.getElementById('pdf-viewer'),
      documentManager: {
        initialDocuments: [
          { url: 'https://example.com/doc.pdf', documentId: 'doc1' }
        ]
      }
    });
    
    const registry = await viewer.registry;
  </script>
</body>
</html>
```

**Pros:** Works immediately, no build step, handles all plumbing  
**Cons:** Larger bundle, less control

### Low-Level: Core + Engines Direct API (Full Control)

For VS Code webview with full customization:

#### Step 1: Initialize PDFium WASM Engine

```typescript
import { createPdfiumDirectEngine, DEFAULT_PDFIUM_WASM_URL } from '@embedpdf/engines/pdfium-direct-engine';
import { Logger } from '@embedpdf/models';

// Initialize the PDF engine (main thread)
const engine = await createPdfiumDirectEngine(
  DEFAULT_PDFIUM_WASM_URL, // or custom URL: 'file:///path/to/pdfium.wasm'
  {
    logger: new Logger(), // Optional: for debugging
    encoderPoolSize: 2    // Optional: for parallel image encoding
  }
);
```

**Alternative: Use Web Worker (non-blocking UI)**

```typescript
import { createPdfiumWorkerEngine } from '@embedpdf/engines/pdfium-worker-engine';

// PDFium runs in a worker thread — main thread stays responsive
const engine = await createPdfiumWorkerEngine(
  DEFAULT_PDFIUM_WASM_URL,
  { logger: new Logger() }
);
```

#### Step 2: Load a PDF Document

```typescript
// Load from URL
const docHandle = await engine.openDocumentUrl('https://example.com/doc.pdf');

// Or load from ArrayBuffer (local file, blob, etc.)
const buffer = await fetch('file.pdf').then(r => r.arrayBuffer());
const docHandle = await engine.openDocumentBuffer(buffer);
```

Returns a `PdfDocumentObject` handle for the loaded document.

#### Step 3: Render Pages to Canvas

```typescript
import { BitmapFormat, RenderFlag } from '@embedpdf/engines';

const pageHandle = docHandle.pages[0]; // First page

// Render page to ImageData (which you can put on a canvas)
const renderResult = await engine.renderPage(pageHandle, {
  scale: 1.5,           // 150% zoom
  width: 800,
  height: 600,
  format: BitmapFormat.Bitmap_BGRA,
  flags: RenderFlag.ANNOT | RenderFlag.LCD_TEXT
});

// renderResult.imageData is a Blob or ImageData
// To display on canvas:
const canvas = document.getElementById('pdf-canvas');
const ctx = canvas.getContext('2d');
const img = new Image();
img.onload = () => ctx.drawImage(img, 0, 0);
img.src = URL.createObjectURL(renderResult.imageData);
```

**renderPage() Options:**
```typescript
interface PdfRenderPageOptions {
  scale?: number;              // Zoom level (1 = 100%)
  width?: number;              // Canvas width in pixels
  height?: number;             // Canvas height in pixels
  format?: BitmapFormat;       // Output format (BGRA, BGR, Gray, etc.)
  flags?: RenderFlag;          // Render flags (annotations, LCD text, etc.)
  rotation?: Rotation;         // 0, 90, 180, 270
}
```

**RenderFlag Options:**
```typescript
enum RenderFlag {
  ANNOT = 0x01,                // Render annotations
  LCD_TEXT = 0x02,             // Text optimized for LCD
  NO_NATIVETEXT = 0x04,        // Don't use native text rendering
  GRAYSCALE = 0x08,            // Grayscale output
  PRINTING = 0x800,            // Optimize for printing
  // ... and more
}
```

#### Step 4: Extract Text Content (like PDF.js's getTextContent)

```typescript
// Get all text from a page (equivalent to PDF.js's page.getTextContent())
const textRunsResult = await engine.getPageTextRuns(pageHandle);

interface PdfPageTextRuns {
  runs: PdfTextRun[];
  width: number;
  height: number;
}

interface PdfTextRun {
  text: string;
  bounds: Rect;        // { left, top, right, bottom }
  fontName: string;
  fontSize: number;
  fontFlags: number;
}

// Example usage:
textRunsResult.runs.forEach(run => {
  console.log(`Text: "${run.text}" at (${run.bounds.left}, ${run.bounds.top})`);
  console.log(`  Font: ${run.fontName} ${run.fontSize}pt`);
});
```

**Other text extraction methods:**
```typescript
// Get raw page text
const pageText = await engine.getPageText(pageHandle);

// Get glyphs (low-level character info)
const glyphs = await engine.getPageGlyphs(pageHandle);

// Search in document
const searchResults = await engine.searchDocument(docHandle, 'search term', {
  caseSensitive: false,
  wholeWords: true
});
```

#### Step 5: Get Document Outline (Bookmarks/TOC)

```typescript
// Get document outline/bookmarks
const outline = await engine.getDocumentBookmarks(docHandle);

interface PdfBookmarkObject {
  title: string;
  children?: PdfBookmarkObject[];
  dest?: PdfDestinationObject;  // Jump to page/position
}

// Example: render a TOC
function renderOutline(bookmarks, indent = 0) {
  for (const bookmark of bookmarks) {
    console.log('  '.repeat(indent) + bookmark.title);
    if (bookmark.children) {
      renderOutline(bookmark.children, indent + 1);
    }
  }
}

renderOutline(outline);

// Jump to bookmark
if (outline[0].dest) {
  await engine.goToDestination(docHandle, outline[0].dest);
}
```

#### Step 6: Handle Text Selection Coordinates

```typescript
// Attach SelectionPlugin to track text selection
import { SelectionPlugin } from '@embedpdf/plugin-selection';

// With Core + Plugin system:
const core = new PDFCore(engine);
const selectionPlugin = new SelectionPlugin();
core.registerPlugin(selectionPlugin);

// Or directly with the engine:
// Listen for selection change events
engine.on('selection:changed', (selection) => {
  if (!selection) return;
  
  console.log('Selected text:', selection.text);
  
  // Get bounding boxes of selected text
  // (coordinates in PDF coordinate system: origin at bottom-left)
  selection.bounds.forEach(rect => {
    console.log(`  Bbox: left=${rect.left}, top=${rect.top}, right=${rect.right}, bottom=${rect.bottom}`);
  });
});

// Get current selection programmatically
const currentSelection = engine.getCurrentTextSelection();
if (currentSelection) {
  console.log('Selection:', {
    text: currentSelection.text,
    pageIndex: currentSelection.pageIndex,
    bounds: currentSelection.bounds
  });
}

// Copy selected text to clipboard
engine.copySelectionToClipboard();
```

**Important: Text Coordinates**

PDF coordinates differ from screen/canvas coordinates:
- **PDF origin:** Bottom-left corner (0, 0)
- **Canvas/View origin:** Top-left corner (0, 0)
- **Conversion needed** when mapping selections to screen positions

```typescript
// Convert PDF coordinates to canvas coordinates
function pdfToCanvasCoords(pdfRect, pageHeight) {
  return {
    left: pdfRect.left,
    top: pageHeight - pdfRect.bottom,    // Flip Y
    right: pdfRect.right,
    bottom: pageHeight - pdfRect.top     // Flip Y
  };
}
```

---

## 3. PDFium WASM Loading Details

### WASM File Serving

The WASM binary is large (~10-12 MB) and needs special handling:

#### CDN (Recommended)
```typescript
const DEFAULT_PDFIUM_WASM_URL = 
  'https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.14.0/dist/pdfium.wasm';
```

#### Local File (VS Code Webview)
```typescript
// In webview context, use Asset URI
const wasmUrl = 'vscode-resource://path/to/pdfium.wasm';  // VSCode webview
// Or in regular browser:
const wasmUrl = 'file:///path/to/pdfium.wasm';  // File protocol
// Or served by your app:
const wasmUrl = '/assets/pdfium.wasm';
```

### CSP (Content Security Policy) Requirements

For VS Code webview, you may need to update CSP headers:

```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self' https://cdn.jsdelivr.net; 
               worker-src 'self' blob:; 
               script-src 'self' https://cdn.jsdelivr.net">
```

**Key CSP Directives:**
- `script-src`: Allow loading JS modules from CDN
- `worker-src`: Allow Web Workers (needed for background PDF processing)
- `connect-src`: Allow fetching WASM from CDN
- `img-src`: Allow data URLs (for rendered images)

### Initialization Flow

```typescript
// 1. Fetch WASM binary
const response = await fetch(wasmUrl);
const wasmBinary = await response.arrayBuffer();

// 2. Load module with Emscripten
import { init } from '@embedpdf/pdfium';
const pdfiumInstance = await init({ wasmBinary });

// 3. Initialize PDFium extension library
pdfiumInstance.PDFiumExt_Init();

// 4. Create engine wrapper
const engine = new PdfiumNative(pdfiumInstance);
```

**Behind the scenes:** Emscripten automatically:
- Sets up memory
- Initializes function bindings (`cwrap`)
- Starts the runtime

---

## 4. Plugin System (Framework-Agnostic)

### Core Plugin Architecture

EmbedPDF uses a **modular, tree-shakeable plugin system**. Each plugin is independent.

#### Base Plugin Interface

```typescript
interface BasePlugin {
  name: string;
  version: string;
  
  // Lifecycle
  initialize(core: PDFCore): void;
  destroy(): void;
  
  // Events
  on(event: string, handler: Function): void;
  off(event: string, handler: Function): void;
}
```

#### Example: RenderPlugin

```typescript
import { RenderPlugin } from '@embedpdf/plugin-render';

// Vanilla JS registration
const core = new PDFCore(engine);
const renderPlugin = new RenderPlugin({ /* options */ });

core.registerPlugin(renderPlugin);

// Use via registry
const registry = await core.registry;
const renderApi = registry.getPlugin('render')?.provides();

if (renderApi) {
  // Render page 0 to canvas
  const canvas = document.getElementById('my-canvas');
  await renderApi.renderPageToCanvas(pageHandle, canvas, { scale: 1.5 });
}
```

#### Example: SelectionPlugin

```typescript
import { SelectionPlugin } from '@embedpdf/plugin-selection';

const selectionPlugin = new SelectionPlugin({
  enableTextSelection: true,
  enableCopyToClipboard: true
});

core.registerPlugin(selectionPlugin);

// Access selection API
const selectionApi = registry.getPlugin('selection')?.provides()?.forDocument(docId);

// Listen for selections
selectionApi.onSelectionChange((selection) => {
  if (selection) {
    console.log('Text:', selection.text);
    console.log('Bounds:', selection.bounds);  // Array of Rect objects
  }
});

// Programmatic selection
selectionApi.setSelectionRange({
  start: { pageIndex: 0, index: 10 },
  end: { pageIndex: 0, index: 50 }
});

// Copy to clipboard
selectionApi.copyToClipboard();
```

### Plugin Registration Pattern

```typescript
// 1. Create core
const engine = await createPdfiumDirectEngine(wasmUrl);
const core = new PDFCore(engine);

// 2. Create plugins
const renderPlugin = new RenderPlugin();
const selectionPlugin = new SelectionPlugin();
const searchPlugin = new SearchPlugin();

// 3. Register plugins
core.registerPlugin(renderPlugin);
core.registerPlugin(selectionPlugin);
core.registerPlugin(searchPlugin);

// 4. Get registry for access
const registry = await core.registry;

// 5. Use plugins
const render = registry.getPlugin('render')?.provides();
const selection = registry.getPlugin('selection')?.provides()?.forDocument(docId);
const search = registry.getPlugin('search')?.provides()?.forDocument(docId);
```

### Available Plugins

**Rendering & Display:**
- `RenderPlugin` — Page rendering to canvas/image
- `ViewportPlugin` — Viewport management (visible area)
- `ZoomPlugin` — Zoom in/out/fit-to-page
- `ScrollPlugin` — Continuous/single page scrolling
- `PanPlugin` — Pan/move functionality
- `RotatePlugin` — Page rotation

**Content Access:**
- `SelectionPlugin` — Text selection + copy
- `SearchPlugin` — Full-text search with highlighting
- `BookmarkPlugin` — Document outline/TOC
- `ThumbnailPlugin` — Page thumbnails

**Interaction:**
- `AnnotationPlugin` — Add/edit/delete annotations
- `FormPlugin` — Form field management
- `InteractionManagerPlugin` — Link handling

**Advanced:**
- `ExportPlugin` — Export to PDF/image
- `PrintPlugin` — Print functionality
- `FullscreenPlugin` — Fullscreen mode
- `HistoryPlugin` — Undo/redo
- `DocumentManagerPlugin` — Multi-document support

---

## 5. Vanilla JS Example (No React/Framework)

### Complete Webview Setup

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" 
        content="default-src 'self' https://cdn.jsdelivr.net; 
                 worker-src 'self' blob:; 
                 script-src 'self' https://cdn.jsdelivr.net">
  <title>EmbedPDF Vanilla JS</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    #pdf-container { width: 100vw; height: 100vh; position: relative; }
    #canvas { display: block; background: #ddd; }
    #controls { position: absolute; top: 10px; left: 10px; z-index: 10; }
  </style>
</head>
<body>
  <div id="controls">
    <button id="prev-btn">Previous</button>
    <span id="page-info">Page 1 of ?</span>
    <button id="next-btn">Next</button>
  </div>
  <div id="pdf-container">
    <canvas id="canvas"></canvas>
  </div>

  <script type="module">
    import { 
      createPdfiumDirectEngine,
      DEFAULT_PDFIUM_WASM_URL 
    } from 'https://cdn.jsdelivr.net/npm/@embedpdf/engines@2.14.0/+esm';

    class SimplePDFViewer {
      constructor() {
        this.engine = null;
        this.document = null;
        this.currentPage = 0;
        this.totalPages = 0;
      }

      async init(pdfUrl) {
        // Initialize engine
        this.engine = await createPdfiumDirectEngine(DEFAULT_PDFIUM_WASM_URL);

        // Load PDF
        this.document = await this.engine.openDocumentUrl(pdfUrl);
        this.totalPages = this.document.pages.length;

        // Update UI
        document.getElementById('prev-btn').addEventListener('click', 
          () => this.previousPage());
        document.getElementById('next-btn').addEventListener('click',
          () => this.nextPage());

        // Render first page
        await this.renderPage(0);
      }

      async renderPage(pageIndex) {
        if (pageIndex < 0 || pageIndex >= this.totalPages) return;

        this.currentPage = pageIndex;
        const page = this.document.pages[pageIndex];

        // Render to canvas
        const canvas = document.getElementById('canvas');
        const result = await this.engine.renderPage(page, {
          scale: 1.0,
          width: canvas.width,
          height: canvas.height
        });

        // Display on canvas
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(img.src);
        };
        img.src = URL.createObjectURL(result.imageData);

        // Update page info
        document.getElementById('page-info').textContent = 
          `Page ${pageIndex + 1} of ${this.totalPages}`;
      }

      async nextPage() {
        if (this.currentPage < this.totalPages - 1) {
          await this.renderPage(this.currentPage + 1);
        }
      }

      async previousPage() {
        if (this.currentPage > 0) {
          await this.renderPage(this.currentPage - 1);
        }
      }
    }

    // Usage
    const viewer = new SimplePDFViewer();
    await viewer.init('https://example.com/sample.pdf');
  </script>
</body>
</html>
```

---

## 6. Text Selection & Coordinate Handling

### Get Selection with Coordinates

```typescript
// Listen for selection changes
engine.on('selection:changed', (selection) => {
  if (!selection) {
    console.log('Selection cleared');
    return;
  }

  // selection object contains:
  // - text: string (selected text)
  // - pageIndex: number (which page)
  // - bounds: Rect[] (array of bounding boxes)
  // - quads: Quad[] (optional: precise selection quads)

  console.log('Selected:', selection.text);
  console.log('Bounds:', selection.bounds);
  
  // Convert to screen coordinates (for highlighting)
  const canvas = document.getElementById('pdf-canvas');
  selection.bounds.forEach(bbox => {
    const screenRect = pdfToScreen(bbox, canvas);
    console.log('Screen rect:', screenRect);
  });
});

// Utility: PDF coords → Screen coords
function pdfToScreen(pdfRect, canvas, page) {
  const pageHeight = page.height;
  const scale = canvas.width / page.width;

  return {
    left: pdfRect.left * scale,
    top: (pageHeight - pdfRect.bottom) * scale,
    width: (pdfRect.right - pdfRect.left) * scale,
    height: (pdfRect.bottom - pdfRect.top) * scale
  };
}
```

### Text Extraction vs Selection

```typescript
// TEXT EXTRACTION (programmatic)
const textRuns = await engine.getPageTextRuns(page);
textRuns.runs.forEach(run => {
  console.log(run.text, run.bounds);
});

// TEXT SELECTION (user interaction)
engine.on('selection:changed', (sel) => {
  console.log('User selected:', sel.text, sel.bounds);
});
```

---

## 7. Known Limitations & Gotchas

### Memory Management

```typescript
// Always close documents to free memory
await engine.closeDocument(docHandle);

// For large PDFs, consider using Web Worker mode
const engine = await createPdfiumWorkerEngine(wasmUrl);
```

### WASM File Serving

- ❌ Must be served with correct MIME type (`application/wasm`)
- ✅ CDN (jsDelivr) handles this automatically
- ⚠️ Local file:// may have CORS issues — use in dev server with proper headers

### Coordinate Systems

- **PDF:** Origin at bottom-left, Y increases upward
- **Canvas:** Origin at top-left, Y increases downward
- **Always convert** when mapping text selections to screen

### Large Documents

- First time opening a large PDF loads the entire file into memory
- Consider streaming or lazy-loading pages
- Use Worker mode to avoid blocking UI

---

## 8. VS Code Webview Specific Setup

```typescript
// In VS Code webview context, use vscode-resource protocol
const wasmUrl = vscode.Uri.joinPath(
  extensionUri,
  'node_modules',
  '@embedpdf',
  'pdfium',
  'dist',
  'pdfium.wasm'
).with({ scheme: 'vscode-resource' }).toString();

const engine = await createPdfiumDirectEngine(wasmUrl);
```

### webview.html Meta CSP

```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'none'; 
               script-src vscode-webview-resource: https://cdn.jsdelivr.net; 
               style-src vscode-webview-resource:; 
               img-src vscode-webview-resource: data: https:; 
               worker-src vscode-webview-resource: blob:">
```

---

## 9. Key Resources

- **Official Docs:** https://www.embedpdf.com/docs
- **GitHub Repo:** https://github.com/embedpdf/embed-pdf-viewer
- **npm @embedpdf/pdfium:** https://www.npmjs.com/package/@embedpdf/pdfium
- **npm @embedpdf/core:** https://www.npmjs.com/package/@embedpdf/core
- **npm @embedpdf/engines:** https://www.npmjs.com/package/@embedpdf/engines
- **Live Examples:** https://github.com/embedpdf/embed-pdf-viewer/tree/main/examples/vanilla-tailwind

---

## Summary

For a vanilla JS/TS VS Code webview:

1. **Install:** `npm install @embedpdf/core @embedpdf/engines @embedpdf/pdfium`
2. **Load WASM:** Point to CDN or bundled `pdfium.wasm`
3. **Init Engine:** `createPdfiumDirectEngine()` or `createPdfiumWorkerEngine()`
4. **Load PDF:** `engine.openDocumentUrl()` or `engine.openDocumentBuffer()`
5. **Render:** `engine.renderPage()` → Canvas or Image
6. **Extract Text:** `engine.getPageTextRuns()` or listen to `selection:changed` events
7. **Get Bookmarks:** `engine.getDocumentBookmarks()`
8. **Handle Selection:** Subscribe to `selection:changed`, convert PDF coords to screen coords

The core API is **fully framework-agnostic** — no React/Vue needed. Plugin system is optional but useful for features like search, annotations, forms.

