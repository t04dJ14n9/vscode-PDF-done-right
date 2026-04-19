/**
 * PDF Viewer Webview — runs inside VS Code's webview iframe.
 * Uses PDFium (via EmbedPDF) for pixel-accurate rendering and text positioning.
 * Communicates with the extension host via postMessage.
 */

import { createPdfiumEngine } from '@embedpdf/engines/pdfium-direct-engine';

const vscode = acquireVsCodeApi();

let engine: any;
let pdfDoc: any;

interface PdfAnchor {
  page: number;
  textItemIndex: number;
  charOffset: number;
  length: number;
  snippet: string;
}

interface HighlightSpec {
  anchor: PdfAnchor;
  /** 'referenced' = green (has markdown backlinks), 'annotated' = yellow (orphan). */
  kind: 'referenced' | 'annotated';
  color?: string; // optional override for annotated
}

interface ReferenceListItem {
  source: string;
  sourceLine: number;
  sourceCol: number;
  /** The PDF snippet captured in the link (legacy; kept for tooltip). */
  snippet: string;
  /** The markdown line around the @pdf[[…]] token — shown as the primary text. */
  contextLine?: string;
}

interface PageState {
  pageNum: number;
  canvas: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  highlightLayer: HTMLDivElement;
  rendered: boolean;
  textRects: any[] | null;
}

function anchorKey(a: PdfAnchor): string {
  return `p=${a.page}&i=${a.textItemIndex}&o=${a.charOffset}&l=${a.length}`;
}

class PdfViewer {
  private pages: Map<number, PageState> = new Map();
  private currentPage = 1;
  private scale = 1.5;
  private container: HTMLElement;
  private pageContainer: HTMLElement;
  private highlights: HighlightSpec[] = [];

  constructor() {
    this.container = document.getElementById('viewer-container')!;
    this.pageContainer = document.getElementById('page-container')!;

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
        case 'setHighlights':
          this.highlights = [
            ...msg.referenced.map((h: any) => ({ anchor: h.anchor, kind: 'referenced' as const })),
            ...msg.annotated.map((h: any) => ({ anchor: h.anchor, kind: 'annotated' as const, color: h.color })),
          ];
          this.redrawAllHighlights();
          break;
        case 'referencesForAnchor':
          this.showReferencePopover(msg.anchor, msg.items);
          break;
        case 'setTheme':
          document.body.dataset.theme = msg.theme;
          break;
        case 'navigate':
          if (msg.direction === 'prev') this.prevPage();
          else this.nextPage();
          break;
        case 'zoom':
          this.zoom(msg.delta);
          break;
        case 'zoomFitWidth':
          this.zoomFitWidth();
          break;
      }
    });
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
    copyBtn.title = 'Copy PDF link to clipboard (also creates a highlight)';
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
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    try {
      pdfDoc = await engine
        .openDocumentBuffer({ id: 'doc-' + Date.now(), content: bytes.buffer })
        .toPromise();
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
    let bookmarkItems: any[] = [];
    try {
      const bookmarksObj = await engine.getBookmarks(pdfDoc).toPromise();
      const raw = bookmarksObj?.bookmarks ?? [];
      bookmarkItems = raw.length ? this.convertBookmarks(raw) : [];
      console.log(`[PaperLink] PDF outline: ${raw.length} top-level bookmarks`);
    } catch (e) {
      console.error('[PaperLink] getBookmarks failed:', e);
    }
    if (bookmarkItems.length === 0) {
      // Fall back to a flat page list so the Outline panel is always useful.
      const total: number = pdfDoc.pageCount || 0;
      bookmarkItems = [];
      for (let i = 1; i <= total; i++) {
        bookmarkItems.push({ title: `Page ${i}`, page: i, children: [] });
      }
      console.log(`[PaperLink] No embedded bookmarks; synthesized ${total} page entries.`);
    }
    vscode.postMessage({ type: 'outline', items: bookmarkItems });
  }

  private convertBookmarks(bookmarks: any[]): any[] {
    return bookmarks.map((bm: any) => {
      let page = 1;
      if (bm.target) {
        if (bm.target.type === 'destination' && bm.target.destination) {
          page = bm.target.destination.pageIndex + 1;
        } else if (
          bm.target.type === 'action' &&
          bm.target.action?.type === 1 /* Goto */ &&
          bm.target.action.destination
        ) {
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

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageId = parseInt(entry.target.id.replace('page-', ''), 10);
            if (pageId && !this.pages.get(pageId)?.rendered) this.renderPage(pageId);
          }
        }
      },
      { root: this.container, rootMargin: '200px' },
    );
    for (const [, page] of this.pages) {
      observer.observe(page.canvas.parentElement!);
    }
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
      const blob: Blob = await engine
        .renderPage(pdfDoc, pageObj, { scaleFactor: this.scale, dpr, withAnnotations: true })
        .toPromise();

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

      const textRects: any[] = await engine.getPageTextRects(pdfDoc, pageObj).toPromise();
      pageState.textRects = textRects;
      pageState.textLayer.innerHTML = '';
      for (const item of textRects) {
        const span = document.createElement('span');
        span.textContent = item.content;
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

      this.drawHighlightsForPage(pageNum);
    } catch (e) {
      console.error(`Failed to render page ${pageNum}:`, e);
    }
  }

  private drawHighlightsForPage(pageNum: number): void {
    const pageState = this.pages.get(pageNum);
    if (!pageState?.textRects) return;

    pageState.highlightLayer.innerHTML = '';
    const items = pageState.textRects;

    for (const h of this.highlights) {
      const anchor = h.anchor;
      if (anchor.page !== pageNum) continue;

      // One group element per anchor, containing one child rect per text-item
      // span. Mouse-enter anywhere in the group highlights all siblings.
      const group = document.createElement('div');
      group.className = `annotation-group ${h.kind}`;
      group.dataset.anchorKey = anchorKey(anchor);
      // Groups should be invisible themselves; clicks and hovers are handled
      // per-rect but bubble up.
      group.style.position = 'absolute';
      group.style.left = '0';
      group.style.top = '0';
      group.style.right = '0';
      group.style.bottom = '0';
      group.style.pointerEvents = 'none';

      let charCount = 0;
      for (let i = anchor.textItemIndex; i < items.length && charCount < anchor.length; i++) {
        const item = items[i];
        const total = item.content.length;
        if (total === 0) continue;
        const startChar = i === anchor.textItemIndex ? anchor.charOffset : 0;
        const availableChars = total - startChar;
        const charsToHighlight = Math.min(availableChars, anchor.length - charCount);
        if (charsToHighlight <= 0) continue;

        // Slice the text-item's bounding rect proportionally by character range
        // so a partial-line selection only highlights the selected glyphs.
        const fullLeft = item.rect.origin.x * this.scale;
        const fullTop = item.rect.origin.y * this.scale;
        const fullWidth = item.rect.size.width * this.scale;
        const fullHeight = item.rect.size.height * this.scale;
        const perChar = fullWidth / total;
        const sliceLeft = fullLeft + perChar * startChar;
        const sliceWidth = perChar * charsToHighlight;

        const hl = document.createElement('div');
        hl.className = `annotation-highlight ${h.kind}`;
        if (h.color && h.kind === 'annotated') {
          hl.style.backgroundColor = h.color;
        }
        hl.style.left = `${sliceLeft}px`;
        hl.style.top = `${fullTop}px`;
        hl.style.width = `${sliceWidth}px`;
        hl.style.height = `${fullHeight}px`;
        hl.title =
          h.kind === 'referenced'
            ? `Click to see markdown notes referencing this`
            : 'Highlight';
        hl.dataset.anchorKey = anchorKey(anchor);

        hl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (h.kind === 'referenced') {
            // Ask the host for references, and remember where to anchor the popover.
            this.pendingPopoverAnchor = anchor;
            this.pendingPopoverElement = hl;
            vscode.postMessage({ type: 'requestReferencesForAnchor', anchor });
          }
        });

        // Coordinated hover: toggle `.hover-active` on every sibling rect
        // belonging to the same anchor group, so the whole highlight lights up
        // as a single unit instead of showing per-line outlines.
        const key = anchorKey(anchor);
        hl.addEventListener('mouseenter', () => {
          for (const el of Array.from(
            pageState.highlightLayer.querySelectorAll(`[data-anchor-key="${CSS.escape(key)}"]`),
          )) {
            (el as HTMLElement).classList.add('hover-active');
          }
        });
        hl.addEventListener('mouseleave', () => {
          for (const el of Array.from(
            pageState.highlightLayer.querySelectorAll(`[data-anchor-key="${CSS.escape(key)}"]`),
          )) {
            (el as HTMLElement).classList.remove('hover-active');
          }
        });

        group.appendChild(hl);
        charCount += charsToHighlight;
      }

      pageState.highlightLayer.appendChild(group);
    }
  }

  private redrawAllHighlights(): void {
    if (!pdfDoc) return;
    for (const [pageNum, pageState] of this.pages) {
      if (pageState.rendered) this.drawHighlightsForPage(pageNum);
    }
  }

  // ─── Popover (references) ─────────────────────────────────────────────────

  private pendingPopoverAnchor: PdfAnchor | null = null;
  private pendingPopoverElement: HTMLElement | null = null;

  private showReferencePopover(anchor: PdfAnchor, items: ReferenceListItem[]): void {
    this.dismissPopover();

    if (!this.pendingPopoverElement) return;
    // If a different click raced in, ignore.
    if (
      !this.pendingPopoverAnchor ||
      anchorKey(this.pendingPopoverAnchor) !== anchorKey(anchor)
    ) {
      return;
    }

    const host = document.createElement('div');
    host.className = 'ref-popover';
    host.setAttribute('role', 'menu');
    host.id = 'ref-popover';

    const header = document.createElement('div');
    header.className = 'ref-header';
    header.textContent = items.length > 0
      ? `${items.length} markdown note${items.length === 1 ? '' : 's'} reference this`
      : 'No markdown notes reference this';
    host.appendChild(header);

    if (items.length === 0) {
      const e = document.createElement('div');
      e.className = 'ref-empty';
      e.textContent = 'Create a reference by pasting the copied PDF link into a .md file.';
      host.appendChild(e);
    } else {
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'ref-item';
        row.setAttribute('role', 'menuitem');
        row.tabIndex = 0;

        // Primary: markdown context line (the text around the @pdf[[…]] token).
        // Falls back to the PDF snippet if the context couldn't be read.
        const primary = document.createElement('div');
        primary.className = 'ref-context';
        primary.textContent = it.contextLine && it.contextLine.length > 0
          ? it.contextLine
          : (it.snippet ? `"${it.snippet}"` : '(empty line)');
        row.appendChild(primary);

        // Secondary: file path + line:col location.
        const meta = document.createElement('div');
        meta.className = 'ref-meta';
        const p = document.createElement('span');
        p.className = 'ref-path';
        p.textContent = it.source;
        const loc = document.createElement('span');
        loc.className = 'ref-loc';
        loc.textContent = `L${it.sourceLine + 1}:${it.sourceCol + 1}`;
        meta.appendChild(p);
        meta.appendChild(loc);
        row.appendChild(meta);

        // Tooltip keeps the raw PDF snippet available on hover.
        if (it.snippet) row.title = `PDF snippet: "${it.snippet}"`;

        row.addEventListener('click', () => {
          vscode.postMessage({
            type: 'openMarkdownAtLocation',
            path: it.source,
            line: it.sourceLine,
            col: it.sourceCol,
          });
          this.dismissPopover();
        });
        row.addEventListener('keydown', (ev: KeyboardEvent) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            (ev.currentTarget as HTMLElement).click();
          }
        });
        host.appendChild(row);
      }
    }

    document.body.appendChild(host);

    // Position below the highlight, clamp to viewport.
    const rect = this.pendingPopoverElement.getBoundingClientRect();
    const margin = 4;
    let top = rect.bottom + margin + window.scrollY;
    let left = rect.left + window.scrollX;
    // After layout pass, adjust for viewport.
    requestAnimationFrame(() => {
      const hrect = host.getBoundingClientRect();
      if (hrect.bottom > window.innerHeight - 10) {
        // Flip above
        top = rect.top - hrect.height - margin + window.scrollY;
      }
      if (hrect.right > window.innerWidth - 10) {
        left = window.innerWidth - hrect.width - 10 + window.scrollX;
      }
      host.style.top = `${top}px`;
      host.style.left = `${left}px`;
    });
    host.style.top = `${top}px`;
    host.style.left = `${left}px`;

    // Dismiss on outside click / Escape
    const onDown = (e: MouseEvent) => {
      if (!host.contains(e.target as Node)) this.dismissPopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.dismissPopover();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    this.popoverCleanup = () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }

  private popoverCleanup: (() => void) | null = null;

  private dismissPopover(): void {
    document.getElementById('ref-popover')?.remove();
    this.popoverCleanup?.();
    this.popoverCleanup = null;
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  async goToAnchor(anchor: PdfAnchor): Promise<void> {
    const pageEl = document.getElementById(`page-${anchor.page}`);
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.currentPage = anchor.page;
      this.updatePageInfo();

      if (!this.pages.get(anchor.page)?.rendered) await this.renderPage(anchor.page);

      if (anchor.length > 0) {
        // Transient blue flash to indicate the target.
        const ghost: HighlightSpec = {
          anchor,
          kind: 'annotated',
          color: 'rgba(0, 150, 255, 0.4)',
        };
        this.highlights.push(ghost);
        this.redrawAllHighlights();
        setTimeout(() => {
          this.highlights = this.highlights.filter(h => h !== ghost);
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
    vscode.postMessage({ type: 'zoomChanged', scale: this.scale });
  }

  private updatePageInfo(): void {
    const total = pdfDoc ? pdfDoc.pageCount : 0;
    vscode.postMessage({ type: 'pageChanged', page: this.currentPage, totalPages: total });
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
