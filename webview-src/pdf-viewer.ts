/**
 * PDF Viewer Webview — runs inside VS Code's webview iframe.
 * Uses PDFium (via EmbedPDF) for pixel-accurate rendering and text positioning.
 * Communicates with the extension host via postMessage.
 */

import { createPdfiumEngine } from '@embedpdf/engines/pdfium-direct-engine';

// VS Code webview API — must be called exactly once
const vscode = acquireVsCodeApi();

// Engine is set during initialization
let engine: any;
let pdfDoc: any;

interface PdfAnchor {
  page: number;
  textItemIndex: number;
  charOffset: number;
  length: number;
  snippet: string;
}

interface Annotation {
  id: string;
  anchor: PdfAnchor;
  markdownFile: string;
  blockRef?: string;
  color: string;
  createdAt: string;
}

interface PageState {
  pageNum: number;
  canvas: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  highlightLayer: HTMLDivElement;
  rendered: boolean;
  textRects: any[] | null; // PdfTextRectObject[]
}

class PdfViewer {
  private pages: Map<number, PageState> = new Map();
  private currentPage = 1;
  private scale = 1.5;
  private container: HTMLElement;
  private pageContainer: HTMLElement;
  private annotations: Annotation[] = [];

  constructor() {
    this.container = document.getElementById('viewer-container')!;
    this.pageContainer = document.getElementById('page-container')!;

    this.setupControls();
    this.setupMessageListener();
    this.setupSelectionListener();

    vscode.postMessage({ type: 'ready' });
  }

  private setupMessageListener(): void {
    window.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case 'loadPdf':
          this.loadPdf(msg.data);
          break;
        case 'goToAnchor':
          this.goToAnchor(msg.anchor);
          break;
        case 'highlightAnnotations':
          this.annotations = msg.annotations;
          this.redrawAllHighlights();
          break;
        case 'setTheme':
          document.body.dataset.theme = msg.theme;
          break;
      }
    });
  }

  private setupControls(): void {
    document.getElementById('btn-prev')?.addEventListener('click', () => this.prevPage());
    document.getElementById('btn-next')?.addEventListener('click', () => this.nextPage());
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => this.zoom(0.25));
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => this.zoom(-0.25));
    document.getElementById('btn-zoom-fit')?.addEventListener('click', () => this.zoomFitWidth());
  }

  private setupSelectionListener(): void {
    this.pageContainer.addEventListener('mouseup', () => {
      setTimeout(() => this.handleTextSelection(), 50);
    });
  }

  private async handleTextSelection(): Promise<void> {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;

    const range = sel.getRangeAt(0);
    const selectedText = sel.toString().trim();
    if (!selectedText) return;

    const textLayerEl = range.startContainer.parentElement?.closest('.text-layer');
    if (!textLayerEl) return;

    const pageNum = parseInt(textLayerEl.getAttribute('data-page') || '0', 10);
    if (!pageNum || !pdfDoc) return;

    const anchor = this.selectionToAnchor(pageNum, selectedText);
    if (!anchor) return;

    this.showSelectionToolbar(anchor, range);
  }

  private selectionToAnchor(pageNum: number, selectedText: string): PdfAnchor | null {
    const pageState = this.pages.get(pageNum);
    if (!pageState?.textRects) return null;

    const items = pageState.textRects;

    // Build full page text and find the selection within it
    let fullText = '';
    const itemOffsets: { start: number; end: number }[] = [];

    for (const item of items) {
      const start = fullText.length;
      fullText += item.content;
      itemOffsets.push({ start, end: fullText.length });
    }

    const selIdx = fullText.indexOf(selectedText);
    if (selIdx === -1) return null;

    for (let i = 0; i < itemOffsets.length; i++) {
      if (selIdx >= itemOffsets[i].start && selIdx < itemOffsets[i].end) {
        return {
          page: pageNum,
          textItemIndex: i,
          charOffset: selIdx - itemOffsets[i].start,
          length: selectedText.length,
          snippet: selectedText,
        };
      }
    }
    return null;
  }

  private showSelectionToolbar(anchor: PdfAnchor, range: Range): void {
    document.getElementById('selection-toolbar')?.remove();

    const rect = range.getBoundingClientRect();
    const toolbar = document.createElement('div');
    toolbar.id = 'selection-toolbar';
    toolbar.className = 'selection-toolbar';
    toolbar.style.top = `${rect.top - 40 + window.scrollY}px`;
    toolbar.style.left = `${rect.left + rect.width / 2}px`;

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy Link';
    copyBtn.title = 'Copy PDF link to clipboard';
    copyBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'copyLinkToClipboard', anchor });
      toolbar.remove();
    });

    const insertBtn = document.createElement('button');
    insertBtn.textContent = 'Insert in Note';
    insertBtn.title = 'Insert link at cursor in active markdown editor';
    insertBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'requestInsertLink', anchor });
      toolbar.remove();
    });

    toolbar.appendChild(copyBtn);
    toolbar.appendChild(insertBtn);
    document.body.appendChild(toolbar);

    const removeToolbar = (e: MouseEvent) => {
      if (!toolbar.contains(e.target as Node)) {
        toolbar.remove();
        document.removeEventListener('mousedown', removeToolbar);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', removeToolbar), 100);
  }

  private async loadPdf(base64Data: string): Promise<void> {
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    try {
      pdfDoc = await engine.openDocumentBuffer(
        { id: 'doc-' + Date.now(), content: bytes.buffer },
      ).toPromise();
      this.updatePageInfo();
      await this.renderAllVisiblePages();
      await this.extractAndSendOutline();
    } catch (e: any) {
      console.error('Failed to load PDF:', e);
      this.pageContainer.innerHTML = `<div class="error">Failed to load PDF: ${e?.message || e}</div>`;
    }
  }

  private async extractAndSendOutline(): Promise<void> {
    if (!pdfDoc) return;
    try {
      const bookmarksObj = await engine.getBookmarks(pdfDoc).toPromise();
      if (!bookmarksObj?.bookmarks?.length) return;

      const items = this.convertBookmarks(bookmarksObj.bookmarks);
      vscode.postMessage({ type: 'outline', items });
    } catch (e) {
      console.error('Failed to extract outline:', e);
    }
  }

  private convertBookmarks(bookmarks: any[]): any[] {
    return bookmarks.map((bm: any) => {
      let page = 1;
      if (bm.target) {
        if (bm.target.type === 'destination' && bm.target.destination) {
          page = bm.target.destination.pageIndex + 1; // 0-indexed → 1-indexed
        } else if (bm.target.type === 'action' && bm.target.action?.type === 1 /* Goto */ && bm.target.action.destination) {
          page = bm.target.action.destination.pageIndex + 1;
        }
      }
      return {
        title: bm.title || 'Untitled',
        page,
        children: bm.children?.length ? this.convertBookmarks(bm.children) : [],
      };
    });
  }

  private async renderAllVisiblePages(): Promise<void> {
    if (!pdfDoc) return;
    this.pageContainer.innerHTML = '';
    this.pages.clear();

    for (let i = 0; i < pdfDoc.pageCount; i++) {
      const pageObj = pdfDoc.pages[i];
      const pageNum = i + 1;
      const cssWidth = Math.floor(pageObj.size.width * this.scale);
      const cssHeight = Math.floor(pageObj.size.height * this.scale);

      const pageWrapper = document.createElement('div');
      pageWrapper.className = 'page-wrapper';
      pageWrapper.id = `page-${pageNum}`;
      pageWrapper.style.width = `${cssWidth}px`;
      pageWrapper.style.height = `${cssHeight}px`;

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';

      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      textLayer.setAttribute('data-page', String(pageNum));

      const highlightLayer = document.createElement('div');
      highlightLayer.className = 'highlight-layer';

      pageWrapper.appendChild(canvas);
      pageWrapper.appendChild(textLayer);
      pageWrapper.appendChild(highlightLayer);
      this.pageContainer.appendChild(pageWrapper);

      this.pages.set(pageNum, {
        pageNum,
        canvas,
        textLayer,
        highlightLayer,
        rendered: false,
        textRects: null,
      });
    }

    // Use IntersectionObserver for lazy rendering
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageId = parseInt(entry.target.id.replace('page-', ''), 10);
            if (pageId && !this.pages.get(pageId)?.rendered) {
              this.renderPage(pageId);
            }
          }
        }
      },
      { root: this.container, rootMargin: '200px' }
    );

    for (const [, page] of this.pages) {
      observer.observe(page.canvas.parentElement!);
    }

    // Render first page immediately
    await this.renderPage(1);
  }

  private async renderPage(pageNum: number): Promise<void> {
    const pageState = this.pages.get(pageNum);
    if (!pageState || pageState.rendered || !pdfDoc) return;
    pageState.rendered = true;

    const pageIndex = pageNum - 1;
    const pageObj = pdfDoc.pages[pageIndex];
    const dpr = window.devicePixelRatio || 1;

    try {
      // Render page as image blob
      const blob: Blob = await engine.renderPage(pdfDoc, pageObj, {
        scaleFactor: this.scale,
        dpr,
        withAnnotations: true,
      }).toPromise();

      // Draw blob onto canvas
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          const canvas = pageState.canvas;
          canvas.width = img.width;
          canvas.height = img.height;
          canvas.style.width = `${Math.floor(pageObj.size.width * this.scale)}px`;
          canvas.style.height = `${Math.floor(pageObj.size.height * this.scale)}px`;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          resolve();
        };
        img.onerror = reject;
        img.src = url;
      });

      // Build text layer from PDFium's precise text rects
      const textRects: any[] = await engine.getPageTextRects(pdfDoc, pageObj).toPromise();
      pageState.textRects = textRects;
      pageState.textLayer.innerHTML = '';

      for (const item of textRects) {
        const span = document.createElement('span');
        span.textContent = item.content;
        // PDFium getPageTextRects returns device coordinates (top-left origin)
        // Just scale to CSS pixels — no Y-flip needed
        const left = item.rect.origin.x * this.scale;
        const top = item.rect.origin.y * this.scale;
        const width = item.rect.size.width * this.scale;
        const height = item.rect.size.height * this.scale;
        span.style.left = `${left}px`;
        span.style.top = `${top}px`;
        span.style.width = `${width}px`;
        span.style.height = `${height}px`;
        span.style.fontSize = `${item.font.size * this.scale}px`;
        span.style.fontFamily = item.font.family || 'sans-serif';
        pageState.textLayer.appendChild(span);
      }

      // Draw annotation highlights
      this.drawHighlightsForPage(pageNum);
    } catch (e) {
      console.error(`Failed to render page ${pageNum}:`, e);
    }
  }

  private drawHighlightsForPage(pageNum: number): void {
    const pageState = this.pages.get(pageNum);
    if (!pageState?.textRects) return;

    pageState.highlightLayer.innerHTML = '';

    const pageAnnotations = this.annotations.filter((a) => a.anchor.page === pageNum);
    if (pageAnnotations.length === 0) return;

    const items = pageState.textRects;

    for (const annotation of pageAnnotations) {
      const { anchor } = annotation;
      let charCount = 0;

      for (let i = anchor.textItemIndex; i < items.length && charCount < anchor.length; i++) {
        const item = items[i];
        const startChar = i === anchor.textItemIndex ? anchor.charOffset : 0;
        const availableChars = item.content.length - startChar;
        const charsToHighlight = Math.min(availableChars, anchor.length - charCount);

        if (charsToHighlight > 0) {
          const highlightEl = document.createElement('div');
          highlightEl.className = 'annotation-highlight';
          highlightEl.style.backgroundColor = annotation.color || 'rgba(255, 230, 0, 0.3)';
          // Device coordinates — no Y-flip needed
          const left = item.rect.origin.x * this.scale;
          const top = item.rect.origin.y * this.scale;
          highlightEl.style.left = `${left}px`;
          highlightEl.style.top = `${top}px`;
          highlightEl.style.width = `${item.rect.size.width * this.scale}px`;
          highlightEl.style.height = `${item.rect.size.height * this.scale}px`;
          highlightEl.title = `Note: ${annotation.markdownFile}`;
          highlightEl.dataset.annotationId = annotation.id;

          highlightEl.addEventListener('click', () => {
            vscode.postMessage({ type: 'annotationClicked', annotationId: annotation.id });
          });

          pageState.highlightLayer.appendChild(highlightEl);
          charCount += charsToHighlight;
        }
      }
    }
  }

  private redrawAllHighlights(): void {
    if (!pdfDoc) return;
    for (const [pageNum, pageState] of this.pages) {
      if (pageState.rendered) {
        this.drawHighlightsForPage(pageNum);
      }
    }
  }

  async goToAnchor(anchor: PdfAnchor): Promise<void> {
    const pageEl = document.getElementById(`page-${anchor.page}`);
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.currentPage = anchor.page;
      this.updatePageInfo();

      if (!this.pages.get(anchor.page)?.rendered) {
        await this.renderPage(anchor.page);
      }

      if (anchor.length > 0) {
        const tempAnnotation: Annotation = {
          id: '__temp__',
          anchor,
          markdownFile: '',
          color: 'rgba(0, 150, 255, 0.4)',
          createdAt: new Date().toISOString(),
        };
        this.annotations.push(tempAnnotation);
        this.redrawAllHighlights();

        setTimeout(() => {
          this.annotations = this.annotations.filter((a) => a.id !== '__temp__');
          this.redrawAllHighlights();
        }, 2000);
      }
    }
  }

  private prevPage(): void {
    if (this.currentPage > 1) {
      this.currentPage--;
      document.getElementById(`page-${this.currentPage}`)?.scrollIntoView({ behavior: 'smooth' });
      this.updatePageInfo();
    }
  }

  private nextPage(): void {
    if (pdfDoc && this.currentPage < pdfDoc.pageCount) {
      this.currentPage++;
      document.getElementById(`page-${this.currentPage}`)?.scrollIntoView({ behavior: 'smooth' });
      this.updatePageInfo();
    }
  }

  private zoom(delta: number): void {
    this.scale = Math.max(0.5, Math.min(4.0, this.scale + delta));
    this.rerender();
  }

  private zoomFitWidth(): void {
    if (!pdfDoc) return;
    const firstPage = pdfDoc.pages[0];
    this.scale = (this.container.clientWidth - 40) / firstPage.size.width;
    this.rerender();
  }

  private rerender(): void {
    for (const [, p] of this.pages) {
      p.rendered = false;
      p.textLayer.innerHTML = '';
      p.highlightLayer.innerHTML = '';
      p.textRects = null;
    }
    this.renderAllVisiblePages();
    document.getElementById('zoom-level')!.textContent = `${Math.round(this.scale * 100)}%`;
  }

  private updatePageInfo(): void {
    const total = pdfDoc ? pdfDoc.pageCount : 0;
    document.getElementById('page-info')!.textContent = `${this.currentPage} / ${total}`;
    vscode.postMessage({ type: 'pageChanged', page: this.currentPage });
  }
}

// Exported init function — called after engine is created
(window as any).__initPdfViewer = function (eng: any) {
  engine = eng;
  new PdfViewer();
};

// Self-bootstrap: init PDFium engine from WASM URL set by the webview HTML
(async function boot() {
  const wasmUrl = (window as any).__pdfiumWasmUrl;
  if (!wasmUrl) {
    console.error('__pdfiumWasmUrl not set');
    return;
  }

  try {
    const eng = await createPdfiumEngine(wasmUrl);
    (window as any).__initPdfViewer(eng);
  } catch (e: any) {
    console.error('Failed to init PDFium engine:', e);
    document.getElementById('page-container')!.innerHTML =
      `<div class="error">Failed to init PDFium: ${e?.message || e}</div>`;
  }
})();
