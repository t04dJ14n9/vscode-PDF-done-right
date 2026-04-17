import * as vscode from 'vscode';
import * as path from 'path';
import { AnnotationService } from './annotationService';
import { PdfOutlineProvider, PdfOutlineItem } from './pdfOutlineProvider';
import {
  PdfAnchor,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  formatPdfLink,
  stringToAnchor,
} from './shared/types';

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
    private readonly annotationService: AnnotationService,
    private readonly outlineProvider: PdfOutlineProvider
  ) {}

  getActiveWebview(): ActiveWebviewInfo | undefined {
    return this.activeDocKey ? this.webviews.get(this.activeDocKey) : undefined;
  }

  async openPdfAtAnchor(pdfPath: string, anchorStr: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) return;

    const pdfUri = vscode.Uri.joinPath(workspaceFolder, pdfPath);
    const anchor = stringToAnchor(anchorStr);
    if (!anchor) return;

    // Open the PDF
    await vscode.commands.executeCommand('vscode.openWith', pdfUri, 'paperlink.pdfViewer');

    // Wait a bit for the webview to load, then navigate
    setTimeout(() => {
      const key = pdfUri.toString();
      const info = this.webviews.get(key);
      if (info) {
        info.goToAnchor(anchor);
      }
    }, 500);
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const pdfUri = document.uri;
    const key = pdfUri.toString();

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
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

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(
      async (msg: WebviewToExtensionMessage) => {
        switch (msg.type) {
          case 'ready':
            await this.loadPdfIntoWebview(webviewPanel.webview, pdfUri);
            break;

          case 'outline':
            this.outlineProvider.setOutline(
              (msg as any).items as PdfOutlineItem[],
              (page: number) => goToPage(page)
            );
            break;

          case 'copyLinkToClipboard': {
            const relativePath = this.getRelativePath(pdfUri);
            const link = formatPdfLink(relativePath, msg.anchor);
            await vscode.env.clipboard.writeText(link);
            vscode.window.showInformationMessage('PDF link copied to clipboard');
            break;
          }

          case 'requestInsertLink': {
            const relativePath = this.getRelativePath(pdfUri);
            const link = formatPdfLink(relativePath, msg.anchor);
            await this.insertLinkAtCursor(link);
            break;
          }

          case 'annotationClicked': {
            const annotations = await this.annotationService.getAnnotationsForPdf(pdfUri);
            const annotation = annotations.find((a) => a.id === msg.annotationId);
            if (annotation) {
              await this.openMarkdownAtRef(annotation.markdownFile, annotation.blockRef);
            }
            break;
          }

          case 'selectionMade':
            break;
          case 'pageChanged':
            break;
        }
      },
      undefined,
      []
    );

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activeDocKey = key;
        vscode.commands.executeCommand('setContext', 'paperlink.pdfOpen', true);
        this.sendAnnotations(webviewPanel.webview, pdfUri);
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
      await this.sendAnnotations(webview, pdfUri);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to load PDF: ${e}`);
    }
  }

  private async sendAnnotations(webview: vscode.Webview, pdfUri: vscode.Uri): Promise<void> {
    const annotations = await this.annotationService.getAnnotationsForPdf(pdfUri);
    this.postMessage(webview, { type: 'highlightAnnotations', annotations });
  }

  private postMessage(webview: vscode.Webview, msg: ExtensionToWebviewMessage): void {
    webview.postMessage(msg);
  }

  private getRelativePath(uri: vscode.Uri): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folder) {
      return path.relative(folder.fsPath, uri.fsPath).replace(/\\/g, '/');
    }
    return path.basename(uri.fsPath);
  }

  private async insertLinkAtCursor(link: string): Promise<void> {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => e.document.languageId === 'markdown'
    );
    const editor = editors[0];
    if (!editor) {
      vscode.window.showWarningMessage('No markdown editor is open. Link copied to clipboard.');
      await vscode.env.clipboard.writeText(link);
      return;
    }

    await editor.edit((editBuilder) => {
      editBuilder.insert(editor.selection.active, link);
    });
    vscode.window.showInformationMessage('PDF link inserted');
  }

  private async openMarkdownAtRef(
    markdownFile: string,
    blockRef?: string
  ): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) return;

    const mdUri = vscode.Uri.joinPath(folder, markdownFile);
    const doc = await vscode.workspace.openTextDocument(mdUri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

    if (blockRef) {
      const text = doc.getText();
      const blockPattern = new RegExp(`\\^${blockRef}|#{1,6}\\s+${blockRef}`, 'i');
      const match = text.match(blockPattern);
      if (match && match.index !== undefined) {
        const pos = doc.positionAt(match.index);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(pos, pos);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const pdfJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdf.mjs')
    );
    const pdfWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdf.worker.mjs')
    );
    const viewerJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdf-viewer.js')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
    script-src 'nonce-${nonce}' ${webview.cspSource};
    style-src 'unsafe-inline' ${webview.cspSource};
    img-src ${webview.cspSource} blob: data:;
    font-src ${webview.cspSource};
    worker-src blob: ${webview.cspSource};">
  <title>PaperLink PDF Viewer</title>
  <style>
    :root {
      --bg: #1e1e1e;
      --toolbar-bg: #252526;
      --text: #cccccc;
      --btn-bg: #3c3c3c;
      --btn-hover: #505050;
      --page-bg: #ffffff;
      --highlight: rgba(255, 230, 0, 0.35);
      --selection-toolbar-bg: #007acc;
    }
    [data-theme="light"] {
      --bg: #f3f3f3;
      --toolbar-bg: #e8e8e8;
      --text: #333333;
      --btn-bg: #d4d4d4;
      --btn-hover: #c0c0c0;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--toolbar-bg);
      border-bottom: 1px solid rgba(128,128,128,0.2);
      flex-shrink: 0;
      z-index: 100;
    }
    .toolbar button {
      background: var(--btn-bg);
      color: var(--text);
      border: none;
      padding: 4px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
    }
    .toolbar button:hover { background: var(--btn-hover); }
    .toolbar .separator { width: 1px; height: 20px; background: rgba(128,128,128,0.3); }
    .toolbar #page-info, .toolbar #zoom-level {
      font-size: 13px;
      min-width: 60px;
      text-align: center;
    }
    #viewer-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      display: flex;
      justify-content: center;
    }
    #page-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 12px;
    }
    .page-wrapper {
      position: relative;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      background: var(--page-bg);
    }
    .pdf-canvas { display: block; }
    .text-layer {
      position: absolute;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      opacity: 0.25;
      line-height: 1.0;
    }
    .text-layer span {
      position: absolute;
      white-space: pre;
      color: transparent;
      pointer-events: all;
    }
    .text-layer br {
      display: none;
    }
    .text-layer ::selection {
      background: rgba(0, 100, 255, 0.3);
    }
    .highlight-layer {
      position: absolute;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
    }
    .annotation-highlight {
      position: absolute;
      pointer-events: all;
      cursor: pointer;
      border-radius: 2px;
      transition: opacity 0.2s;
    }
    .annotation-highlight:hover {
      opacity: 0.8;
      outline: 2px solid rgba(0, 120, 255, 0.6);
    }
    .selection-toolbar {
      position: absolute;
      transform: translateX(-50%);
      display: flex;
      gap: 4px;
      padding: 4px 8px;
      background: var(--selection-toolbar-bg);
      border-radius: 6px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
      z-index: 1000;
    }
    .selection-toolbar button {
      background: transparent;
      color: white;
      border: none;
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    .selection-toolbar button:hover { background: rgba(255,255,255,0.2); }
    .error {
      padding: 40px;
      text-align: center;
      color: #f44;
      font-size: 16px;
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

  <script nonce="${nonce}" src="${viewerJsUri}"></script>
  <script nonce="${nonce}" type="module">
    import * as pdfjsLib from "${pdfJsUri}";
    pdfjsLib.GlobalWorkerOptions.workerSrc = "${pdfWorkerUri}";
    window.__initPdfViewer(pdfjsLib);
  </script>
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
