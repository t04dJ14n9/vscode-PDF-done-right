# EmbedPDF Vanilla JS Examples

These are real examples from the official repository.

## Example 1: Simple Document Loading

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EmbedPDF Document Loading</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-100 p-6">
  <div class="mx-auto flex max-w-7xl flex-col gap-4">
    <section class="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <button id="load-url-btn" class="rounded-md bg-white px-3 py-2 text-sm font-medium shadow-sm">
        Load URL
      </button>

      <label class="cursor-pointer rounded-md bg-white px-3 py-2 text-sm font-medium">
        Upload Local
        <input id="file-input" type="file" class="hidden" accept=".pdf" />
      </label>

      <div class="flex items-center gap-2">
        <span class="text-sm text-slate-500">Active document:</span>
        <select id="document-select" class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm" disabled>
          <option value="">Select Document...</option>
        </select>
      </div>
    </section>

    <div class="h-[700px] overflow-hidden rounded-xl border border-slate-300 bg-white">
      <div id="pdf-viewer" class="h-full w-full"></div>
    </div>
  </div>

  <script type="module">
    import EmbedPDF from 'https://cdn.jsdelivr.net/npm/@embedpdf/snippet/dist/embedpdf.js';

    const loadUrlButton = document.getElementById('load-url-btn');
    const fileInput = document.getElementById('file-input');
    const documentSelect = document.getElementById('document-select');

    const viewer = EmbedPDF.init({
      type: 'container',
      target: document.getElementById('pdf-viewer'),
      theme: { preference: 'system' },
      tabBar: 'always',
      documentManager: {
        maxDocuments: 5,
      },
    });

    const registry = await viewer.registry;
    const docManager = registry.getPlugin('document-manager')?.provides();

    if (!docManager) {
      throw new Error('Document manager plugin not available');
    }

    function renderDocumentSelect() {
      const docs = docManager.getOpenDocuments();
      const activeDocumentId = docManager.getActiveDocumentId();

      documentSelect.innerHTML = '';

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = docs.length === 0 ? 'Select Document...' : 'Choose a document';
      placeholder.disabled = true;
      documentSelect.append(placeholder);

      for (const doc of docs) {
        const option = document.createElement('option');
        option.value = doc.id;
        option.textContent = doc.name || 'Untitled';
        documentSelect.append(option);
      }

      documentSelect.disabled = docs.length === 0;
      documentSelect.value = activeDocumentId || '';
    }

    docManager.onDocumentOpened(renderDocumentSelect);
    docManager.onDocumentClosed(renderDocumentSelect);
    docManager.onActiveDocumentChanged(renderDocumentSelect);
    renderDocumentSelect();

    loadUrlButton.addEventListener('click', async () => {
      await docManager.openDocumentUrl({
        url: 'https://snippet.embedpdf.com/ebook.pdf',
        documentId: 'ebook-demo',
      });
    });

    fileInput.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const buffer = await file.arrayBuffer();
      await docManager.openDocumentBuffer({
        buffer,
        name: file.name,
        autoActivate: true,
      });

      event.target.value = '';
    });

    documentSelect.addEventListener('change', async (event) => {
      const documentId = event.target.value;
      if (!documentId) return;
      await docManager.setActiveDocument(documentId);
    });
  </script>
</body>
</html>
```

---

## Example 2: Text Selection

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EmbedPDF Selection</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-100 p-6">
  <div class="mx-auto flex max-w-7xl flex-col gap-4">
    <section class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <div class="flex items-center gap-2">
        <button
          id="copy-btn"
          type="button"
          disabled
          class="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:bg-slate-300"
        >
          Copy
        </button>
        <button
          id="clear-btn"
          type="button"
          disabled
          class="rounded bg-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-50"
        >
          Clear
        </button>
      </div>

      <span id="last-action" class="text-sm text-green-600"></span>
    </section>

    <div class="h-[700px] overflow-hidden rounded-xl border border-slate-300 bg-white">
      <div id="pdf-viewer" class="h-full w-full"></div>
    </div>
  </div>

  <script type="module">
    import EmbedPDF from 'https://cdn.jsdelivr.net/npm/@embedpdf/snippet/dist/embedpdf.js';

    const copyButton = document.getElementById('copy-btn');
    const clearButton = document.getElementById('clear-btn');
    const lastAction = document.getElementById('last-action');

    const viewer = EmbedPDF.init({
      type: 'container',
      target: document.getElementById('pdf-viewer'),
      theme: { preference: 'system' },
      documentManager: {
        initialDocuments: [
          {
            url: 'https://snippet.embedpdf.com/ebook.pdf',
            documentId: 'ebook',
          },
        ],
      },
    });

    const registry = await viewer.registry;
    const selection = registry.getPlugin('selection')?.provides()?.forDocument('ebook');

    if (!selection) {
      throw new Error('Selection plugin not available');
    }

    function showAction(message) {
      lastAction.textContent = message;
      window.clearTimeout(showAction.timeoutId);
      showAction.timeoutId = window.setTimeout(() => {
        lastAction.textContent = '';
      }, 2000);
    }

    selection.onSelectionChange((currentSelection) => {
      const hasSelection = !!currentSelection;
      copyButton.disabled = !hasSelection;
      clearButton.disabled = !hasSelection;
    });

    copyButton.addEventListener('click', () => {
      selection.copyToClipboard();
      showAction('Copied to clipboard!');
    });

    clearButton.addEventListener('click', () => {
      selection.clear();
      showAction('Selection cleared');
    });
  </script>
</body>
</html>
```

---

## Example 3: Form State Tracking

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EmbedPDF Form State</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-100 p-6">
  <div class="mx-auto flex max-w-7xl flex-col gap-4">
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div class="h-[700px] overflow-hidden rounded-xl border border-slate-300 bg-white">
        <div id="pdf-viewer" class="h-full w-full"></div>
      </div>

      <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div class="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <h4 class="text-sm font-semibold text-slate-900">Form State</h4>
          <p class="mt-1 text-xs text-slate-500">
            Fill the PDF on the left to watch the values update live.
          </p>
        </div>

        <div class="grid grid-cols-3 border-b border-slate-200 bg-slate-50 text-xs">
          <div class="px-4 py-3">
            <div class="text-slate-500">Fields</div>
            <div id="field-count" class="mt-1 text-sm font-semibold text-slate-900">0</div>
          </div>
          <div class="border-x border-slate-200 px-4 py-3">
            <div class="text-slate-500">Filled</div>
            <div id="filled-count" class="mt-1 text-sm font-semibold text-slate-900">0</div>
          </div>
          <div class="px-4 py-3">
            <div class="text-slate-500">Changes</div>
            <div id="change-count" class="mt-1 text-sm font-semibold text-slate-900">0</div>
          </div>
        </div>

        <div class="max-h-[540px] overflow-auto p-4">
          <pre id="form-values" class="text-xs text-slate-800">Waiting for form fields...</pre>
        </div>
      </div>
    </div>
  </div>

  <script type="module">
    import EmbedPDF from 'https://cdn.jsdelivr.net/npm/@embedpdf/snippet/dist/embedpdf.js';

    const documentId = 'form-doc';
    const fieldCount = document.getElementById('field-count');
    const filledCount = document.getElementById('filled-count');
    const changeCount = document.getElementById('change-count');
    const formValuesElement = document.getElementById('form-values');

    let changes = 0;

    const viewer = EmbedPDF.init({
      type: 'container',
      target: document.getElementById('pdf-viewer'),
      theme: { preference: 'system' },
      documentManager: {
        initialDocuments: [
          {
            url: 'https://www.embedpdf.com/form.pdf',
            documentId,
          },
        ],
      },
      export: {
        defaultFileName: 'filled-form.pdf',
      },
    });

    const registry = await viewer.registry;
    const formScope = registry.getPlugin('form')?.provides()?.forDocument(documentId);

    if (!formScope) {
      throw new Error('Form plugin not available');
    }

    function renderValues() {
      const values = formScope.getFormValues();
      const filled = Object.values(values).filter(
        (value) => value !== '' && value !== 'Off',
      ).length;

      filledCount.textContent = String(filled);
      formValuesElement.textContent =
        Object.keys(values).length > 0
          ? JSON.stringify(values, null, 2)
          : 'Waiting for form fields...';
    }

    fieldCount.textContent = String(formScope.getFormFields().length);
    renderValues();

    formScope.onFormReady((fields) => {
      fieldCount.textContent = String(fields.length);
      renderValues();
    });

    formScope.onFieldValueChange(() => {
      changes += 1;
      changeCount.textContent = String(changes);
      renderValues();
    });
  </script>
</body>
</html>
```

---

## Example 4: Low-Level API (Direct Engine)

```typescript
import { 
  createPdfiumDirectEngine,
  DEFAULT_PDFIUM_WASM_URL 
} from '@embedpdf/engines/pdfium-direct-engine';
import { BitmapFormat, RenderFlag } from '@embedpdf/engines';

class PDFViewer {
  constructor() {
    this.engine = null;
    this.document = null;
    this.currentPage = 0;
  }

  async init(pdfUrl) {
    // 1. Initialize the WASM engine
    this.engine = await createPdfiumDirectEngine(DEFAULT_PDFIUM_WASM_URL);

    // 2. Load PDF
    this.document = await this.engine.openDocumentUrl(pdfUrl);
    console.log(`PDF loaded: ${this.document.pages.length} pages`);

    // 3. Get outline/bookmarks
    const outline = await this.engine.getDocumentBookmarks(this.document);
    console.log('Outline:', outline);

    // 4. Render first page
    await this.renderPage(0);

    // 5. Extract text
    const textRuns = await this.engine.getPageTextRuns(this.document.pages[0]);
    console.log('First page text:', textRuns.runs.map(r => r.text).join(' '));

    // 6. Listen for selections
    this.engine.on('selection:changed', (selection) => {
      if (selection) {
        console.log('Selected text:', selection.text);
        console.log('Selection bounds:', selection.bounds);
      }
    });
  }

  async renderPage(pageIndex) {
    const page = this.document.pages[pageIndex];
    const canvas = document.getElementById('canvas');

    // Render page
    const result = await this.engine.renderPage(page, {
      scale: 1.5,
      width: canvas.width,
      height: canvas.height,
      format: BitmapFormat.Bitmap_BGRA,
      flags: RenderFlag.ANNOT | RenderFlag.LCD_TEXT
    });

    // Display on canvas
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(result.imageData);

    console.log(`Rendered page ${pageIndex + 1}`);
  }

  async destroy() {
    if (this.document) {
      await this.engine.closeDocument(this.document);
    }
  }
}

// Usage
const viewer = new PDFViewer();
await viewer.init('https://example.com/sample.pdf');
```

---

## Example 5: Worker Mode (Non-Blocking UI)

```typescript
import {
  createPdfiumWorkerEngine,
  DEFAULT_PDFIUM_WASM_URL
} from '@embedpdf/engines/pdfium-worker-engine';

async function initWorkerEngine() {
  // Use worker mode for large PDFs — UI stays responsive
  const engine = await createPdfiumWorkerEngine(DEFAULT_PDFIUM_WASM_URL);
  
  // All operations are delegated to worker thread
  const doc = await engine.openDocumentUrl('large-pdf.pdf');
  
  // This doesn't block UI
  const textRuns = await engine.getPageTextRuns(doc.pages[0]);
  
  return engine;
}
```

---

## Example 6: Coordinate Conversion (Text Selection)

```typescript
function pdfToScreenCoords(pdfRect, pageHeight, canvasScale) {
  // PDF origin = bottom-left, Y increases upward
  // Canvas origin = top-left, Y increases downward
  
  return {
    x: pdfRect.left * canvasScale,
    y: (pageHeight - pdfRect.bottom) * canvasScale,  // Flip Y
    width: (pdfRect.right - pdfRect.left) * canvasScale,
    height: (pdfRect.bottom - pdfRect.top) * canvasScale
  };
}

// Usage
engine.on('selection:changed', (selection) => {
  selection.bounds.forEach(bbox => {
    const screenRect = pdfToScreenCoords(
      bbox, 
      selection.pageHeight, 
      1.5  // canvasScale = 150%
    );
    
    // Now you can highlight the text on screen
    console.log('Highlight at:', screenRect);
  });
});
```

---

## Key Patterns

### Pattern 1: Plugin Access
```typescript
// Get plugin API via registry
const registry = await viewer.registry;
const plugin = registry.getPlugin('plugin-name')?.provides()?.forDocument(docId);
```

### Pattern 2: Event Listeners
```typescript
// Listen for events
engine.on('selection:changed', (selection) => { ... });
formScope.onFieldValueChange(() => { ... });
selection.onSelectionChange((sel) => { ... });
```

### Pattern 3: Async Operations
```typescript
// Always await engine operations
const doc = await engine.openDocumentUrl(url);
const result = await engine.renderPage(page, options);
const text = await engine.getPageTextRuns(page);
```

### Pattern 4: Resource Cleanup
```typescript
// Clean up when done
await engine.closeDocument(doc);
// Or for full cleanup:
viewer.destroy?.();
```

---

## Resources

- Live Examples: https://github.com/embedpdf/embed-pdf-viewer/tree/main/examples/vanilla-tailwind
- Docs: https://www.embedpdf.com/docs
- NPM Packages: @embedpdf/core, @embedpdf/engines, @embedpdf/pdfium
