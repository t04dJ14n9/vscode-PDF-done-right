import * as vscode from 'vscode';
import * as path from 'path';
import { IndexService } from './index/indexService';
import { PdfOutlineProvider, PdfOutlineItem } from './pdfOutlineProvider';
import {
  PdfAnchor,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  formatPdfLink,
  stringToAnchor,
  anchorToString,
  ReferenceListItem,
} from './shared/types';
import { toPosix } from './index/indexFile';
import { log } from './util/logger';

interface ActiveWebviewInfo {
  panel: vscode.WebviewPanel;
  pdfUri: vscode.Uri;
  goToAnchor(anchor: PdfAnchor): void;
  goToPage(page: number): void;
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private webviews = new Map<string, ActiveWebviewInfo>();
  private activeDocKey: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly indexService: IndexService,
    private readonly outlineProvider: PdfOutlineProvider,
    private readonly gitRoot: string,
  ) {
    // Live-refresh open webviews when the index changes (e.g. a referenced
    // markdown file is saved — new highlights should appear immediately).
    this.context.subscriptions.push(
      this.indexService.onDidChange(e => {
        for (const [, info] of this.webviews) {
          const pdfRel = this.getRelativePath(info.pdfUri);
          if (e.changedFiles.some(f => f === pdfRel || f.toLowerCase().endsWith('.md'))) {
            this.sendHighlights(info.panel.webview, info.pdfUri);
          }
        }
      }),
    );
  }

  getActiveWebview(): ActiveWebviewInfo | undefined {
    return this.activeDocKey ? this.webviews.get(this.activeDocKey) : undefined;
  }

  async openPdfAtAnchor(pdfPath: string, anchorStr: string): Promise<void> {
    const pdfUri = vscode.Uri.file(path.join(this.gitRoot, pdfPath));
    const anchor = stringToAnchor(anchorStr);
    if (!anchor) return;

    await vscode.commands.executeCommand('vscode.openWith', pdfUri, 'paperlink.pdfViewer');

    setTimeout(() => {
      const key = pdfUri.toString();
      const info = this.webviews.get(key);
      if (info) info.goToAnchor(anchor);
    }, 500);
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const pdfUri = document.uri;
    const key = pdfUri.toString();

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const goToAnchor = (anchor: PdfAnchor) => {
      this.postMessage(webviewPanel.webview, { type: 'goToAnchor', anchor });
    };
    const goToPage = (page: number) => {
      this.postMessage(webviewPanel.webview, {
        type: 'goToAnchor',
        anchor: { page, textItemIndex: 0, charOffset: 0, length: 0, snippet: '' },
      });
    };

    this.webviews.set(key, { panel: webviewPanel, pdfUri, goToAnchor, goToPage });
    this.activeDocKey = key;
    vscode.commands.executeCommand('setContext', 'paperlink.pdfOpen', true);

    webviewPanel.webview.onDidReceiveMessage(
      async (msg: WebviewToExtensionMessage) => {
        switch (msg.type) {
          case 'ready':
            await this.loadPdfIntoWebview(webviewPanel.webview, pdfUri);
            break;

          case 'outline':
            this.outlineProvider.setOutline(
              (msg as any).items as PdfOutlineItem[],
              (page: number) => goToPage(page),
            );
            break;

          case 'copyLinkToClipboard': {
            const relPath = this.getRelativePath(pdfUri);
            const link = formatPdfLink(relPath, msg.anchor);
            await vscode.env.clipboard.writeText(link);
            vscode.window.showInformationMessage('PDF link copied to clipboard');
            // Also record an annotation so the passage is highlighted even
            // before the user saves a markdown reference to it.
            this.indexService.upsertAnnotation({
              pdf: relPath,
              page: msg.anchor.page,
              anchor: anchorToString(msg.anchor),
              snippet: msg.anchor.snippet || '',
              color: 'rgba(255,230,0,0.35)',
              createdAt: new Date().toISOString(),
            });
            break;
          }

          case 'requestInsertLink': {
            const relPath = this.getRelativePath(pdfUri);
            const link = formatPdfLink(relPath, msg.anchor);
            await this.insertLinkAtCursor(link);
            this.indexService.upsertAnnotation({
              pdf: relPath,
              page: msg.anchor.page,
              anchor: anchorToString(msg.anchor),
              snippet: msg.anchor.snippet || '',
              color: 'rgba(255,230,0,0.35)',
              createdAt: new Date().toISOString(),
            });
            break;
          }

          case 'requestReferencesForAnchor': {
            const relPath = this.getRelativePath(pdfUri);
            const anchorStr = anchorToString(msg.anchor);
            const refs = this.indexService.getReferencesForAnchor(relPath, anchorStr);
            const items: ReferenceListItem[] = await Promise.all(
              refs.map(async r => ({
                source: r.source,
                sourceLine: r.sourceLine,
                sourceCol: r.sourceCol,
                snippet: r.snippet,
                contextLine: await this.readMarkdownLine(r.source, r.sourceLine),
              })),
            );
            this.postMessage(webviewPanel.webview, {
              type: 'referencesForAnchor',
              anchor: msg.anchor,
              items,
            });
            break;
          }

          case 'openMarkdownAtLocation': {
            await this.openMarkdownAt(msg.path, msg.line, msg.col);
            break;
          }

          case 'selectionMade':
            break;
          case 'pageChanged':
            break;
        }
      },
      undefined,
      [],
    );

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activeDocKey = key;
        vscode.commands.executeCommand('setContext', 'paperlink.pdfOpen', true);
        this.sendHighlights(webviewPanel.webview, pdfUri);
      }
    });

    webviewPanel.onDidDispose(() => {
      this.webviews.delete(key);
      if (this.activeDocKey === key) {
        this.activeDocKey = undefined;
        this.outlineProvider.clear();
        vscode.commands.executeCommand('setContext', 'paperlink.pdfOpen', false);
      }
    });
  }

  private async loadPdfIntoWebview(webview: vscode.Webview, pdfUri: vscode.Uri): Promise<void> {
    try {
      const data = await vscode.workspace.fs.readFile(pdfUri);
      const base64 = Buffer.from(data).toString('base64');
      this.postMessage(webview, { type: 'loadPdf', data: base64 });
      this.sendHighlights(webview, pdfUri);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to load PDF: ${e}`);
      log.error('loadPdfIntoWebview failed', e);
    }
  }

  /**
   * Compute highlights for the given PDF from BOTH annotations (user-authored)
   * and references (markdown tokens pointing at passages), and send them to
   * the webview. Referenced anchors take precedence for click handling.
   */
  private sendHighlights(webview: vscode.Webview, pdfUri: vscode.Uri): void {
    const pdfRel = this.getRelativePath(pdfUri);
    const annotations = this.indexService.getAnnotationsForPdf(pdfRel);
    const references = this.indexService.getReferencesForPdf(pdfRel);

    // Anchors that have at least one markdown reference pointing at them.
    const referencedAnchors = new Set<string>();
    const referenced: { anchor: PdfAnchor }[] = [];
    for (const r of references) {
      if (referencedAnchors.has(r.anchor)) continue;
      referencedAnchors.add(r.anchor);
      const a = stringToAnchor(r.anchor);
      if (a) {
        a.snippet = r.snippet || '';
        referenced.push({ anchor: a });
      }
    }

    // User-authored annotations WITHOUT markdown backlinks — rendered with
    // a distinct color so the UI reads "orphan highlight".
    const annotated: { anchor: PdfAnchor; color: string }[] = [];
    for (const ann of annotations) {
      if (referencedAnchors.has(ann.anchor)) continue;
      const a = stringToAnchor(ann.anchor);
      if (!a) continue;
      a.snippet = ann.snippet || '';
      annotated.push({ anchor: a, color: ann.color });
    }

    this.postMessage(webview, { type: 'setHighlights', annotated, referenced });
  }

  private postMessage(webview: vscode.Webview, msg: ExtensionToWebviewMessage): void {
    webview.postMessage(msg);
  }

  private getRelativePath(uri: vscode.Uri): string {
    return toPosix(path.relative(this.gitRoot, uri.fsPath));
  }

  private async insertLinkAtCursor(link: string): Promise<void> {
    const editors = vscode.window.visibleTextEditors.filter(
      e => e.document.languageId === 'markdown',
    );
    const editor = editors[0];
    if (!editor) {
      vscode.window.showWarningMessage('No markdown editor is open. Link copied to clipboard.');
      await vscode.env.clipboard.writeText(link);
      return;
    }
    await editor.edit(b => b.insert(editor.selection.active, link));
    vscode.window.showInformationMessage('PDF link inserted');
  }

  private async openMarkdownAt(relPath: string, line: number, col: number): Promise<void> {
    const mdUri = vscode.Uri.file(path.join(this.gitRoot, relPath));
    const doc = await vscode.workspace.openTextDocument(mdUri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    const pos = new vscode.Position(
      Math.max(0, line | 0),
      Math.max(0, col | 0),
    );
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(pos, pos);
  }

  /**
   * Read the given 0-based line from a markdown file under gitRoot and return
   * the trimmed text. Used to show "what the note says around this reference"
   * in the popover, which is more useful than the PDF text the link targets.
   */
  private async readMarkdownLine(relPath: string, line: number): Promise<string | undefined> {
    try {
      const uri = vscode.Uri.file(path.join(this.gitRoot, relPath));
      // Prefer an already-open document so edits-in-progress are reflected.
      const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
      const doc = open ?? await vscode.workspace.openTextDocument(uri);
      if (line < 0 || line >= doc.lineCount) return undefined;
      const text = doc.lineAt(line).text.trim();
      return text.length > 240 ? text.slice(0, 237) + '…' : text;
    } catch {
      return undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const viewerJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdf-viewer.js'),
    );
    const wasmUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfium.wasm'),
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
    script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource};
    style-src 'unsafe-inline' ${webview.cspSource};
    img-src ${webview.cspSource} blob: data:;
    font-src ${webview.cspSource};
    connect-src ${webview.cspSource};">
  <title>PaperLink PDF Viewer</title>
  <style>
    :root {
      --bg: #1e1e1e;
      --toolbar-bg: #252526;
      --text: #cccccc;
      --btn-bg: #3c3c3c;
      --btn-hover: #505050;
      --page-bg: #ffffff;
      --highlight-annotated: rgba(255, 230, 0, 0.35);
      --highlight-referenced: rgba(90, 200, 120, 0.40);
      --selection-toolbar-bg: #007acc;
      --popover-bg: #2d2d30;
      --popover-border: #3e3e42;
    }
    [data-theme="light"] {
      --bg: #f3f3f3;
      --toolbar-bg: #e8e8e8;
      --text: #333333;
      --btn-bg: #d4d4d4;
      --btn-hover: #c0c0c0;
      --popover-bg: #ffffff;
      --popover-border: #d0d0d0;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      overflow: hidden; height: 100vh;
      display: flex; flex-direction: column;
    }
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 12px;
      background: var(--toolbar-bg);
      border-bottom: 1px solid rgba(128,128,128,0.2);
      flex-shrink: 0; z-index: 100;
    }
    .toolbar button {
      background: var(--btn-bg); color: var(--text); border: none;
      padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 13px;
    }
    .toolbar button:hover { background: var(--btn-hover); }
    .toolbar .separator { width: 1px; height: 20px; background: rgba(128,128,128,0.3); }
    .toolbar #page-info, .toolbar #zoom-level {
      font-size: 13px; min-width: 60px; text-align: center;
    }
    #viewer-container {
      flex: 1; overflow-y: auto; overflow-x: auto;
      display: flex; justify-content: center;
    }
    #page-container {
      display: flex; flex-direction: column; align-items: center;
      gap: 12px; padding: 12px;
    }
    .page-wrapper {
      position: relative;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      background: var(--page-bg);
    }
    .pdf-canvas { display: block; }
    .text-layer {
      position: absolute; left: 0; top: 0; right: 0; bottom: 0;
      overflow: hidden; opacity: 0.25; line-height: 1.0;
    }
    .text-layer span {
      position: absolute; white-space: pre; color: transparent;
      pointer-events: all;
    }
    .text-layer br { display: none; }
    .text-layer ::selection { background: rgba(0, 100, 255, 0.3); }
    .highlight-layer {
      position: absolute; left: 0; top: 0; right: 0; bottom: 0;
      pointer-events: none;
    }
    .annotation-highlight {
      position: absolute; pointer-events: all; cursor: pointer;
      border-radius: 2px; transition: opacity 0.2s;
    }
    .annotation-highlight.referenced { background-color: var(--highlight-referenced); }
    .annotation-highlight.annotated { background-color: var(--highlight-annotated); }
    .annotation-highlight:hover {
      opacity: 0.8;
      outline: 2px solid rgba(0, 120, 255, 0.6);
    }
    .selection-toolbar {
      position: absolute; transform: translateX(-50%);
      display: flex; gap: 4px; padding: 4px 8px;
      background: var(--selection-toolbar-bg);
      border-radius: 6px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
      z-index: 1000;
    }
    .selection-toolbar button {
      background: transparent; color: white; border: none;
      padding: 4px 8px; border-radius: 3px; cursor: pointer;
      font-size: 12px; white-space: nowrap;
    }
    .selection-toolbar button:hover { background: rgba(255,255,255,0.2); }

    .ref-popover {
      position: absolute;
      background: var(--popover-bg);
      color: var(--text);
      border: 1px solid var(--popover-border);
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      padding: 6px 0;
      min-width: 280px;
      max-width: 440px;
      max-height: 320px;
      overflow: auto;
      z-index: 1001;
      font-size: 12px;
    }
    .ref-popover .ref-header {
      padding: 4px 12px 6px;
      font-size: 11px;
      opacity: 0.6;
      border-bottom: 1px solid var(--popover-border);
      margin-bottom: 4px;
    }
    .ref-popover .ref-item {
      display: block;
      padding: 6px 12px;
      cursor: pointer;
      line-height: 1.4;
    }
    .ref-popover .ref-item:hover { background: rgba(128,128,128,0.18); }
    .ref-popover .ref-context {
      font-size: 12px;
      line-height: 1.4;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      word-break: break-word;
    }
    .ref-popover .ref-meta {
      display: flex;
      gap: 6px;
      margin-top: 2px;
      font-size: 11px;
      opacity: 0.6;
    }
    .ref-popover .ref-path { font-weight: 500; }
    .ref-popover .ref-loc { opacity: 0.85; }
    .ref-popover .ref-empty {
      padding: 10px 12px;
      opacity: 0.6;
      font-style: italic;
    }

    .error {
      padding: 40px; text-align: center; color: #f44; font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="btn-prev" title="Previous page">&#9664;</button>
    <span id="page-info">1 / 1</span>
    <button id="btn-next" title="Next page">&#9654;</button>
    <div class="separator"></div>
    <button id="btn-zoom-out" title="Zoom out">&minus;</button>
    <span id="zoom-level">150%</span>
    <button id="btn-zoom-in" title="Zoom in">+</button>
    <button id="btn-zoom-fit" title="Fit width">Fit</button>
  </div>
  <div id="viewer-container">
    <div id="page-container"></div>
  </div>

  <script nonce="${nonce}">
    window.__pdfiumWasmUrl = "${wasmUri}";
  </script>
  <script nonce="${nonce}" src="${viewerJsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
