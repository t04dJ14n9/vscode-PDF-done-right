/**
 * PDF Viewer Webview — runs inside VS Code's webview iframe.
 * Uses PDF.js to render pages with a text layer for selection.
 * Communicates with the extension host via postMessage.
 *
 * This file is bundled by webpack and loaded as a module script.
 * PDF.js is imported dynamically at runtime.
 */

// VS Code webview API — must be called exactly once
const vscode = acquireVsCodeApi();

// We'll assign pdfjsLib after dynamic import
let pdfjsLib: any;

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
}

class PdfViewer {
  private pdfDoc: any = null;
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

    // Tell extension host we're ready
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

    // Find which page's text layer contains this selection
    const textLayerEl = range.startContainer.parentElement?.closest('.text-layer');
    if (!textLayerEl) return;

    const pageNum = parseInt(textLayerEl.getAttribute('data-page') || '0', 10);
    if (!pageNum || !this.pdfDoc) return;

    const anchor = await this.selectionToAnchor(pageNum, selectedText);
    if (!anchor) return;

    this.showSelectionToolbar(anchor, range);
  }

  private async selectionToAnchor(
    pageNum: number,
    selectedText: string
  ): Promise<PdfAnchor | null> {
    try {
      const page = await this.pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const items: any[] = textContent.items;

      let fullText = '';
      const itemOffsets: { start: number; end: number }[] = [];

      for (const item of items) {
        const start = fullText.length;
        fullText += item.str;
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
    } catch (e) {
      console.error('Failed to build anchor:', e);
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
      this.pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
      this.updatePageInfo();
      await this.renderAllVisiblePages();
      await this.extractAndSendOutline();
    } catch (e) {
      console.error('Failed to load PDF:', e);
      this.pageContainer.innerHTML = `<div class="error">Failed to load PDF: ${e}</div>`;
    }
  }

  private async extractAndSendOutline(): Promise<void> {
    if (!this.pdfDoc) return;
    try {
      const outline = await this.pdfDoc.getOutline();
      if (!outline || outline.length === 0) return;

      const items = await this.convertOutline(outline);
      vscode.postMessage({ type: 'outline', items });
    } catch (e) {
      console.error('Failed to extract outline:', e);
    }
  }

  private async convertOutline(items: any[]): Promise<any[]> {
    const result: any[] = [];
    for (const item of items) {
      let page = 1;
      try {
        if (item.dest) {
          const dest = typeof item.dest === 'string'
            ? await this.pdfDoc.getDestination(item.dest)
            : item.dest;
          if (dest && dest[0]) {
            const pageIndex = await this.pdfDoc.getPageIndex(dest[0]);
            page = pageIndex + 1;
          }
        }
      } catch {
        // fallback to page 1
      }

      const children = item.items && item.items.length > 0
        ? await this.convertOutline(item.items)
        : [];

      result.push({
        title: item.title || 'Untitled',
        page,
        children,
      });
    }
    return result;
  }

  private async renderAllVisiblePages(): Promise<void> {
    if (!this.pdfDoc) return;
    this.pageContainer.innerHTML = '';
    this.pages.clear();

    for (let i = 1; i <= this.pdfDoc.numPages; i++) {
      const pageWrapper = document.createElement('div');
      pageWrapper.className = 'page-wrapper';
      pageWrapper.id = `page-${i}`;

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';

      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      textLayer.setAttribute('data-page', String(i));

      const highlightLayer = document.createElement('div');
      highlightLayer.className = 'highlight-layer';

      pageWrapper.appendChild(canvas);
      pageWrapper.appendChild(textLayer);
      pageWrapper.appendChild(highlightLayer);
      this.pageContainer.appendChild(pageWrapper);

      this.pages.set(i, {
        pageNum: i,
        canvas,
        textLayer,
        highlightLayer,
        rendered: false,
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
    if (!pageState || pageState.rendered || !this.pdfDoc) return;
    pageState.rendered = true;

    try {
      const page = await this.pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: this.scale });
      const dpr = window.devicePixelRatio || 1;

      // Set the page wrapper to the CSS size
      const wrapper = pageState.canvas.parentElement!;
      wrapper.style.width = `${Math.floor(viewport.width)}px`;
      wrapper.style.height = `${Math.floor(viewport.height)}px`;

      // Canvas: render at native (DPR) resolution for sharpness
      const canvas = pageState.canvas;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext('2d')!;
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
      await page.render({ canvasContext: ctx, viewport, transform }).promise;

      // Text layer: use inset positioning so it fills the page wrapper
      const textContent = await page.getTextContent();
      pageState.textLayer.innerHTML = '';

      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: pageState.textLayer,
        viewport: viewport,
      });
      await textLayer.render();

      // Draw annotation highlights for this page
      this.drawHighlightsForPage(pageNum, page, viewport);
    } catch (e) {
      console.error(`Failed to render page ${pageNum}:`, e);
    }
  }

  private async drawHighlightsForPage(
    pageNum: number,
    page: any,
    viewport: any
  ): Promise<void> {
    const pageState = this.pages.get(pageNum);
    if (!pageState) return;

    pageState.highlightLayer.innerHTML = '';

    const pageAnnotations = this.annotations.filter((a) => a.anchor.page === pageNum);
    if (pageAnnotations.length === 0) return;

    const textContent = await page.getTextContent();
    const items: any[] = textContent.items;

    for (const annotation of pageAnnotations) {
      const { anchor } = annotation;
      let charCount = 0;

      for (let i = anchor.textItemIndex; i < items.length && charCount < anchor.length; i++) {
        const item = items[i];
        const startChar = i === anchor.textItemIndex ? anchor.charOffset : 0;
        const availableChars = item.str.length - startChar;
        const charsToHighlight = Math.min(availableChars, anchor.length - charCount);

        if (charsToHighlight > 0) {
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const highlightEl = document.createElement('div');
          highlightEl.className = 'annotation-highlight';
          highlightEl.style.backgroundColor = annotation.color || 'rgba(255, 230, 0, 0.3)';
          highlightEl.style.left = `${tx[4]}px`;
          highlightEl.style.top = `${tx[5] - item.height * this.scale}px`;
          highlightEl.style.width = `${item.width * this.scale}px`;
          highlightEl.style.height = `${item.height * this.scale}px`;
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
    if (!this.pdfDoc) return;
    for (const [pageNum, pageState] of this.pages) {
      if (pageState.rendered) {
        this.pdfDoc.getPage(pageNum).then((page: any) => {
          const viewport = page.getViewport({ scale: this.scale });
          this.drawHighlightsForPage(pageNum, page, viewport);
        });
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

      // Only flash highlight if there's actual text to highlight
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
    if (this.pdfDoc && this.currentPage < this.pdfDoc.numPages) {
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
    if (!this.pdfDoc) return;
    this.pdfDoc.getPage(1).then((page: any) => {
      const viewport = page.getViewport({ scale: 1.0 });
      this.scale = (this.container.clientWidth - 40) / viewport.width;
      this.rerender();
    });
  }

  private rerender(): void {
    for (const [, p] of this.pages) {
      p.rendered = false;
      p.textLayer.innerHTML = '';
      p.highlightLayer.innerHTML = '';
    }
    this.renderAllVisiblePages();
    document.getElementById('zoom-level')!.textContent = `${Math.round(this.scale * 100)}%`;
  }

  private updatePageInfo(): void {
    const total = this.pdfDoc ? this.pdfDoc.numPages : 0;
    document.getElementById('page-info')!.textContent = `${this.currentPage} / ${total}`;
    vscode.postMessage({ type: 'pageChanged', page: this.currentPage });
  }
}

// Exported init function — called from the inline module script in the HTML
(window as any).__initPdfViewer = function (lib: any) {
  pdfjsLib = lib;
  new PdfViewer();
};
