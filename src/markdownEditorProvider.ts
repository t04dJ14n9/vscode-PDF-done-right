import * as vscode from 'vscode';

/**
 * Scaffold CustomTextEditorProvider for `*.md`, registered with
 * priority `"option"` so it never steals default opens of markdown files.
 *
 * This is a placeholder to reserve the integration point for a future
 * Obsidian-like rich editor (to be ported from `~/Code/mark_pdf_down`).
 * It exposes a documented message protocol that the real editor will
 * implement; today it simply syncs plain text.
 *
 * Protocol stubs (Extension ⇄ Webview):
 *   host → webview:
 *     { type: 'setText'; text: string }
 *     { type: 'reveal'; line: number; col: number }
 *   webview → host:
 *     { type: 'ready' }
 *     { type: 'edit'; edits: { line: number; col: number; text: string }[] }
 *     { type: 'getSelection' }
 *     { type: 'replaceSelection'; text: string }
 *     { type: 'insertLinkAtCaret'; link: string }
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'paperlink.markdownEditor';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    // Push the current document text to the webview on any change.
    const updateWebview = () => {
      webviewPanel.webview.postMessage({
        type: 'setText',
        text: document.getText(),
      });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) updateWebview();
    });
    webviewPanel.onDidDispose(() => changeSub.dispose());

    webviewPanel.webview.onDidReceiveMessage(msg => {
      switch (msg?.type) {
        case 'ready':
          updateWebview();
          break;
        // All other incoming messages are placeholders for the real editor.
        default:
          break;
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'markdown-editor.js'),
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
    script-src 'nonce-${nonce}' ${webview.cspSource};
    style-src 'unsafe-inline' ${webview.cspSource};">
  <title>PaperLink Markdown Editor</title>
  <style>
    html, body {
      height: 100%;
      margin: 0;
      background: #1e1e1e;
      color: #cccccc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      text-align: center;
      gap: 12px;
      padding: 40px;
    }
    .placeholder h1 {
      font-size: 20px;
      font-weight: 500;
      margin: 0;
    }
    .placeholder p {
      opacity: 0.6;
      font-size: 13px;
      max-width: 440px;
      line-height: 1.5;
    }
    pre.preview {
      width: 80%;
      max-height: 40vh;
      overflow: auto;
      background: #252526;
      border: 1px solid #3e3e42;
      border-radius: 4px;
      padding: 10px 14px;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="placeholder">
    <h1>PaperLink Markdown Editor — coming soon</h1>
    <p>
      This is a placeholder. Open markdown files with the default text editor for now.
      A richer Obsidian-style editor will be ported here in a future release.
    </p>
    <pre class="preview" id="preview"></pre>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let t = '';
  const s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += s.charAt(Math.floor(Math.random() * s.length));
  return t;
}
