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
  endTextItemIndex?: number;
  endCharOffset?: number;
  length: number;
  snippet: string;
  extraParams?: Record<string, string>;
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
  return `p=${a.page}&i=${a.textItemIndex}&o=${a.charOffset}&ei=${a.endTextItemIndex ?? -1}&eo=${a.endCharOffset ?? -1}&l=${a.length}`;
}

function anchorHasSelection(a: PdfAnchor): boolean {
  return (
    (typeof a.endTextItemIndex === 'number' && typeof a.endCharOffset === 'number')
    || a.length > 0
  );
}

class PdfViewer {
  private pages: Map<number, PageState> = new Map();
  private currentPage = 1;
  private scale = 1.5;
  private container: HTMLElement;
  private pageContainer: HTMLElement;
  private highlights: HighlightSpec[] = [];
  private pendingAnchor: PdfAnchor | null = null;

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
    const selectedText = sel.toString().replace(/\s+/g, ' ').trim();
    if (!selectedText) return;

    const textLayerEl = range.startContainer.parentElement?.closest('.text-layer');
    if (!textLayerEl) return;

    const pageNum = parseInt(textLayerEl.getAttribute('data-page') || '0', 10);
    if (!pageNum || !pdfDoc) return;

    const anchor = this.selectionToAnchor(pageNum, range, selectedText);
    if (!anchor) return;

    this.showSelectionToolbar(anchor, range);
  }

  private selectionToAnchor(pageNum: number, range: Range, selectedText: string): PdfAnchor | null {
    const pageState = this.pages.get(pageNum);
    if (!pageState?.textRects) return null;
    const startSpan = this.getTextSpan(range.startContainer);
    const endSpan = this.getTextSpan(range.endContainer);
    if (!startSpan || !endSpan) return null;
    if (startSpan.closest('.text-layer') !== endSpan.closest('.text-layer')) return null;

    const startIdx = parseInt(startSpan.dataset.itemIndex || '', 10);
    const endIdx = parseInt(endSpan.dataset.itemIndex || '', 10);
    if ([startIdx, endIdx].some(isNaN)) return null;

    const startOffset = this.getNodeTextOffset(range.startContainer, range.startOffset, startSpan);
    const endOffset = this.getNodeTextOffset(range.endContainer, range.endOffset, endSpan);
    if (startOffset < 0 || endOffset < 0) return null;

    const normalizedStartIdx = startIdx <= endIdx ? startIdx : endIdx;
    const normalizedEndIdx = startIdx <= endIdx ? endIdx : startIdx;
    const normalizedStartOffset = startIdx <= endIdx ? startOffset : endOffset;
    const normalizedEndOffset = startIdx <= endIdx ? endOffset : startOffset;

    return {
      page: pageNum,
      textItemIndex: normalizedStartIdx,
      charOffset: normalizedStartOffset,
      endTextItemIndex: normalizedEndIdx,
      endCharOffset: normalizedEndOffset,
      length: normalizedStartIdx === normalizedEndIdx
        ? Math.max(0, normalizedEndOffset - normalizedStartOffset)
        : 0,
      snippet: selectedText,
    };
  }

  private getTextSpan(node: Node | null): HTMLElement | null {
    if (!node) return null;
    if (node instanceof HTMLElement) {
      return node.closest<HTMLElement>('span[data-item-index]');
    }
    return node.parentElement?.closest<HTMLElement>('span[data-item-index]') || null;
  }

  private getNodeTextOffset(node: Node, offset: number, span: HTMLElement): number {
    if (node.nodeType === Node.TEXT_NODE) {
      return Math.min(offset, node.textContent?.length ?? 0);
    }
    if (node === span) {
      const child = span.childNodes[Math.min(offset, Math.max(0, span.childNodes.length - 1))];
      if (child?.nodeType === Node.TEXT_NODE) {
        return offset === 0 ? 0 : (child.textContent?.length ?? 0);
      }
      return offset === 0 ? 0 : (span.textContent?.length ?? 0);
    }
    return Math.min(offset, span.textContent?.length ?? 0);
  }

  private showSelectionToolbar(anchor: PdfAnchor, range: Range): void {
    document.getElementById('selection-toolbar')?.remove();

    const rect = range.getBoundingClientRect();
    const toolbar = document.createElement('div');
    toolbar.id = 'selection-toolbar';
    toolbar.className = 'selection-toolbar';
    toolbar.style.top = `${rect.top - 48 + window.scrollY}px`;
    toolbar.style.left = `${rect.left + rect.width / 2 + window.scrollX}px`;

    const actions = document.createElement('div');
    actions.className = 'selection-toolbar-actions';

    const menu = document.createElement('div');
    menu.className = 'selection-toolbar-menu';
    menu.setAttribute('role', 'menu');

    const dismissToolbar = () => {
      toolbar.remove();
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };

    const runAction = (
      action: 'copyLink' | 'insertLink' | 'copyQuoteAndLink' | 'insertQuoteAndLink' | 'highlight',
    ) => {
      vscode.postMessage({ type: 'selectionAction', action, anchor });
      dismissToolbar();
    };

    const makeButton = (
      label: string,
      title: string,
      onClick: () => void,
      className?: string,
    ): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.title = title;
      btn.className = className ?? '';
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      return btn;
    };

    const setMenuOpen = (open: boolean) => {
      menu.classList.toggle('open', open);
      moreBtn.setAttribute('aria-expanded', String(open));
    };

    const copyBtn = makeButton(
      'Copy Link',
      'Copy the Obsidian-compatible PDF link',
      () => runAction('copyLink'),
      'primary',
    );
    const insertBtn = makeButton(
      'Insert Link',
      'Insert the PDF link into the active markdown note',
      () => runAction('insertLink'),
    );
    const moreBtn = makeButton(
      '▾',
      'More selection actions',
      () => setMenuOpen(!menu.classList.contains('open')),
      'menu-trigger',
    );
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', 'false');

    const menuActions: Array<{
      label: string;
      title: string;
      action: 'copyLink' | 'insertLink' | 'copyQuoteAndLink' | 'insertQuoteAndLink' | 'highlight';
    }> = [
      {
        label: 'Copy Link',
        title: 'Copy the PDF deep link to the clipboard',
        action: 'copyLink',
      },
      {
        label: 'Insert Link in Note',
        title: 'Insert the PDF deep link at the markdown cursor',
        action: 'insertLink',
      },
      {
        label: 'Copy Quote and Link',
        title: 'Copy a quoted block followed by the PDF link',
        action: 'copyQuoteAndLink',
      },
      {
        label: 'Insert Quote and Link',
        title: 'Insert a quoted block plus the PDF link in the active note',
        action: 'insertQuoteAndLink',
      },
      {
        label: 'Highlight Selection',
        title: 'Create a highlight without copying or inserting anything',
        action: 'highlight',
      },
    ];

    for (const item of menuActions) {
      const option = makeButton(item.label, item.title, () => runAction(item.action), 'menu-item');
      option.setAttribute('role', 'menuitem');
      menu.appendChild(option);
    }

    actions.appendChild(copyBtn);
    actions.appendChild(insertBtn);
    actions.appendChild(moreBtn);
    toolbar.appendChild(actions);
    toolbar.appendChild(menu);
    document.body.appendChild(toolbar);

    requestAnimationFrame(() => {
      const box = toolbar.getBoundingClientRect();
      const minLeft = 12 + window.scrollX + box.width / 2;
      const maxLeft = window.scrollX + window.innerWidth - 12 - box.width / 2;
      const currentLeft = rect.left + rect.width / 2 + window.scrollX;
      const clampedLeft = Math.max(minLeft, Math.min(maxLeft, currentLeft));
      let top = rect.top - box.height - 12 + window.scrollY;
      if (top < window.scrollY + 12) {
        top = rect.bottom + 12 + window.scrollY;
      }
      toolbar.style.left = `${clampedLeft}px`;
      toolbar.style.top = `${top}px`;
    });

    const onPointerDown = (e: MouseEvent) => {
      if (!toolbar.contains(e.target as Node)) {
        dismissToolbar();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissToolbar();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
    }, 0);
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

      // If goToAnchor was called before the PDF finished loading, apply it now.
      if (this.pendingAnchor) {
        const anchor = this.pendingAnchor;
        this.pendingAnchor = null;
        await this.goToAnchor(anchor);
      }
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
      console.log(`[PDFDR] PDF outline: ${raw.length} top-level bookmarks`);
    } catch (e) {
      console.error('[PDFDR] getBookmarks failed:', e);
    }
    if (bookmarkItems.length === 0) {
      // Fall back to a flat page list so the Outline panel is always useful.
      const total: number = pdfDoc.pageCount || 0;
      bookmarkItems = [];
      for (let i = 1; i <= total; i++) {
        bookmarkItems.push({ title: `Page ${i}`, page: i, children: [] });
      }
      console.log(`[PDFDR] No embedded bookmarks; synthesized ${total} page entries.`);
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
      textRects.forEach((item, itemIndex) => {
        const span = document.createElement('span');
        span.textContent = item.content;
        const left = item.rect.origin.x * this.scale;
        const top = item.rect.origin.y * this.scale;
        const width = item.rect.size.width * this.scale;
        const height = item.rect.size.height * this.scale;
        span.dataset.itemIndex = String(itemIndex);
        span.style.left = `${left}px`;
        span.style.top = `${top}px`;
        span.style.height = `${height}px`;
        span.style.lineHeight = `${height}px`;
        span.style.fontSize = `${Math.max(1, height)}px`;
        span.style.fontFamily = item.font.family || 'sans-serif';
        span.style.transformOrigin = 'left top';
        span.style.display = 'inline-block';
        pageState.textLayer.appendChild(span);
        const naturalWidth = span.getBoundingClientRect().width;
        const scaleX = naturalWidth > 0 ? width / naturalWidth : 1;
        span.style.transform = `scaleX(${scaleX})`;
      });

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

      const endItemIndex = anchor.endTextItemIndex ?? anchor.textItemIndex;
      const endCharOffset = anchor.endCharOffset ?? (anchor.charOffset + anchor.length);
      for (let i = anchor.textItemIndex; i < items.length && i <= endItemIndex; i++) {
        const item = items[i];
        const total = item.content.length;
        if (total === 0) continue;
        const startChar = i === anchor.textItemIndex ? anchor.charOffset : 0;
        const endChar = i === endItemIndex ? Math.min(total, endCharOffset) : total;
        const charsToHighlight = endChar - startChar;
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
    if (!pageEl) {
      // PDF not loaded yet — queue the anchor for after loadPdf completes.
      this.pendingAnchor = anchor;
      return;
    }
    pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.currentPage = anchor.page;
    this.updatePageInfo();

    if (!this.pages.get(anchor.page)?.rendered) await this.renderPage(anchor.page);

    if (anchorHasSelection(anchor)) {
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
