import * as vscode from 'vscode';
import * as path from 'path';
import { IndexService } from './index/indexService';

/**
 * CustomTextEditorProvider for `*.md` using a CodeMirror 6 webview.
 *
 * Provides an Obsidian-style rich markdown editor with:
 *   - Live preview (hybrid rendering — hides syntax on non-cursor lines)
 *   - Wiki-link, @pdf, @code link navigation
 *   - Inline @pdf link rendering
 *   - Vim mode (opt-in via setting)
 *   - All settings via paperlink.markdown.* configuration
 *
 * Protocol (Extension host ⇄ Webview):
 *   host → webview:
 *     { type: 'setText'; text: string }
 *     { type: 'reveal'; line: number; col: number }
 *     { type: 'setSettings'; settings: Partial<EditorSettings> }
 *   webview → host:
 *     { type: 'ready' }
 *     { type: 'edit'; text: string }
 *     { type: 'save' }
 *     { type: 'openFile'; path: string }
 *     { type: 'openCodeRef'; path: string; startLine?: number; endLine?: number }
 *     { type: 'openPdfRef'; pdfPath: string; anchor: string }
 *     { type: 'openExternal'; url: string }
 *     { type: 'pasteImage'; mimeType: string; dataUrl: string }
 *     { type: 'requestImageData'; requestId: string; path: string }
 *     { type: 'openImage'; path: string }
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'paperlink.markdownEditor';

  /** Active webview panels keyed by document URI string */
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly indexService: IndexService | undefined,
    private readonly gitRoot: string | undefined,
  ) {}

  /** Request diagnostic info from the active markdown editor webview */
  async requestDiagnostic(): Promise<any> {
    return this._sendAndReceive('diagnostic');
  }

  /** Request diagnostic from a specific document's webview */
  async requestDiagnosticForDocument(uri: vscode.Uri): Promise<any> {
    return this._sendAndReceive('diagnostic', 5000, uri.toString());
  }

  /** Simulate clicking the first @pdf link in the active markdown editor */
  async clickTest(): Promise<any> {
    return this._sendAndReceive('clickTest');
  }

  /** Simulate double-clicking the first embedded image in a document webview */
  async imageDoubleClickTestForDocument(uri: vscode.Uri): Promise<any> {
    return this._sendAndReceive('imageDoubleClickTest', 5000, uri.toString());
  }

  /** Simulate pasting an image into a document webview */
  async imagePasteTestForDocument(uri: vscode.Uri): Promise<any> {
    return this._sendAndReceive('imagePasteTest', 5000, uri.toString());
  }

  /** Move the cursor onto the first embedded image and report its preview geometry */
  async imageCursorLineTestForDocument(uri: vscode.Uri): Promise<any> {
    return this._sendAndReceive('imageCursorLineTest', 5000, uri.toString());
  }

  private async _sendAndReceive(type: string, timeoutMs = 5000, targetUri?: string): Promise<any> {
    let panel: vscode.WebviewPanel | undefined;

    if (targetUri) {
      panel = this.panels.get(targetUri);
      console.log(`[PDFDR MD] _sendAndReceive targetUri=${targetUri}, panelFound=${!!panel}, panelsKeys=${Array.from(this.panels.keys()).join(', ')}`);
    } else {
      const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
      const viewType = (activeTab?.input as any)?.viewType;
      if (viewType !== MarkdownEditorProvider.viewType) {
        return { error: 'No active PDF Done Right markdown editor' };
      }
      const uriStr = (activeTab?.input as any)?.uri?.toString();
      panel = uriStr ? this.panels.get(uriStr) : undefined;
    }

    if (!panel) {
      return { error: 'No webview panel found for editor' };
    }

    return new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve({ error: `${type} timeout` }), timeoutMs);
      const sub = panel!.webview.onDidReceiveMessage((msg: any) => {
        if (msg?.type === type) {
          clearTimeout(timeout);
          sub.dispose();
          resolve(msg);
        }
      });
      panel!.webview.postMessage({ type });
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const key = document.uri.toString();
    this.panels.set(key, webviewPanel);
    webviewPanel.onDidDispose(() => this.panels.delete(key));

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    // Track whether an edit originated from the webview to avoid echo loops.
    let ignoreNextChange = false;
    let saveAfterNextWebviewEdit = false;

    const pushText = () => {
      webviewPanel.webview.postMessage({
        type: 'setText',
        text: document.getText(),
      });
    };

    const pushSettings = () => {
      const cfg = vscode.workspace.getConfiguration('paperlink.markdown');
      const editorCfg = vscode.workspace.getConfiguration('editor');
      const resolvedSettings = resolveMarkdownEditorSettings(cfg, editorCfg);

      webviewPanel.webview.postMessage({
        type: 'setSettings',
        settings: resolvedSettings,
      });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        if (ignoreNextChange) {
          ignoreNextChange = false;
          return;
        }
        pushText();
      }
    });

    const settingsSub = vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('paperlink.markdown')
        || e.affectsConfiguration('editor.fontFamily')
        || e.affectsConfiguration('editor.fontSize')
        || e.affectsConfiguration('editor.lineHeight')
        || e.affectsConfiguration('editor.lineNumbers')
        || e.affectsConfiguration('editor.wordWrap')
        || e.affectsConfiguration('editor.tabSize')
        || e.affectsConfiguration('editor.bracketPairColorization.enabled')
      ) {
        pushSettings();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      settingsSub.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
      const debugLog = vscode.workspace.getConfiguration('paperlink').get<boolean>('debugLogging');
      if (debugLog) {
        console.log(`[PDFDR MD] Received message: ${msg?.type}`, msg);
      }
      switch (msg?.type) {
        case 'ready':
          console.log('[PDFDR MD] Webview ready — sending text and settings');
          pushText();
          pushSettings();
          break;

        case 'error':
          console.error(`[PDFDR MD] Webview error: ${msg.message} at ${msg.source}:${msg.line}`);
          break;

        case 'diagnostic':
          console.log(`[PDFDR MD] Diagnostic: ${JSON.stringify(msg, null, 2)}`);
          break;

        case 'edit': {
          const newText = msg.text as string;
          if (newText === document.getText()) break;
          ignoreNextChange = true;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            newText,
          );
          await vscode.workspace.applyEdit(edit);
          if (saveAfterNextWebviewEdit) {
            saveAfterNextWebviewEdit = false;
            await document.save();
          }
          break;
        }

        case 'save':
          if (document.isDirty) {
            await document.save();
          }
          break;

        case 'openFile': {
          const filePath = msg.path as string;
          if (this.gitRoot) {
            const absPath = vscode.Uri.file(path.join(this.gitRoot, filePath));
            try {
              await vscode.workspace.openTextDocument(absPath);
              await vscode.commands.executeCommand('vscode.open', absPath);
            } catch {
              // file may not exist
            }
          }
          break;
        }

        case 'openCodeRef': {
          const codePath = msg.path as string;
          const startLine = msg.startLine as number | undefined;
          const endLine = msg.endLine as number | undefined;
          if (this.gitRoot) {
            const absPath = vscode.Uri.file(path.join(this.gitRoot, codePath));
            try {
              const doc = await vscode.workspace.openTextDocument(absPath);
              const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
              if (startLine && startLine > 0) {
                const sLine = Math.max(0, startLine - 1);
                const eLine = endLine && endLine > startLine
                  ? Math.min(doc.lineCount - 1, endLine - 1)
                  : sLine;
                const range = new vscode.Range(sLine, 0, eLine, doc.lineAt(eLine).text.length);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                editor.selection = new vscode.Selection(range.start, range.end);
              }
            } catch {
              vscode.commands.executeCommand('revealInExplorer', absPath);
            }
          }
          break;
        }

        case 'openPdfRef': {
          const pdfPath = msg.pdfPath as string;
          const anchor = msg.anchor as string;
          if (debugLog) {
            console.log(`[PDFDR MD] openPdfRef: pdfPath=${pdfPath}, anchor=${anchor}, gitRoot=${this.gitRoot}`);
          }
          if (this.gitRoot) {
            await vscode.commands.executeCommand('paperlink.openPdfAtAnchor', { pdfPath, anchor });
          } else {
            console.warn('[PDFDR MD] Cannot open PDF ref — no gitRoot');
          }
          break;
        }

        case 'openExternal': {
          const url = msg.url as string;
          await vscode.env.openExternal(vscode.Uri.parse(url));
          break;
        }

        case 'openImage': {
          const imagePath = String(msg.path ?? '').trim();
          const abs = await resolveImagePath(imagePath, document.uri.fsPath, this.gitRoot);
          if (!abs) {
            console.warn(`[PDFDR MD] Cannot open image — not found: ${imagePath}`);
            break;
          }
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs), vscode.ViewColumn.Beside);
          break;
        }

        case 'pasteImage': {
          if (!this.gitRoot) {
            console.warn('[PDFDR MD] Cannot paste image — no gitRoot');
            break;
          }
          const mimeType = String(msg.mimeType ?? 'image/png');
          const dataUrl = String(msg.dataUrl ?? '');
          const bytes = parseImageDataUrl(dataUrl);
          if (!bytes) {
            console.warn('[PDFDR MD] Cannot paste image — invalid data URL');
            break;
          }

          const ext = imageExtensionFromMime(mimeType);
          const assetDir = path.join(this.gitRoot, '.asset');
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(assetDir));

          const baseName = `Pasted image ${formatImageTimestamp(new Date())}`;
          let fileName = `${baseName}.${ext}`;
          let absPath = path.join(assetDir, fileName);
          let serial = 1;
          while (await fileExists(absPath)) {
            fileName = `${baseName}-${serial}.${ext}`;
            absPath = path.join(assetDir, fileName);
            serial += 1;
          }

          await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), bytes);
          saveAfterNextWebviewEdit = true;
          webviewPanel.webview.postMessage({ type: 'insertText', text: `![[${fileName}]]` });
          break;
        }

        case 'requestImageData': {
          const requestId = String(msg.requestId ?? '');
          const imagePath = String(msg.path ?? '').trim();
          const abs = await resolveImagePath(imagePath, document.uri.fsPath, this.gitRoot);
          if (!requestId) break;
          if (!abs) {
            webviewPanel.webview.postMessage({ type: 'imageData', requestId, path: imagePath, dataUrl: null });
            break;
          }
          try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
            const mime = mimeFromPath(abs);
            const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
            webviewPanel.webview.postMessage({ type: 'imageData', requestId, path: imagePath, dataUrl });
          } catch {
            webviewPanel.webview.postMessage({ type: 'imageData', requestId, path: imagePath, dataUrl: null });
          }
          break;
        }
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
    style-src 'unsafe-inline' ${webview.cspSource};
    font-src ${webview.cspSource};
    img-src ${webview.cspSource} data: https:;">
  <title>PDF Done Right Editor</title>
  <style>
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #cccccc);
      font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    }
    #editor {
      height: 100%;
      overflow: hidden;
    }
    .cm-editor {
      height: 100%;
    }
    .cm-scroller {
      overflow: auto;
    }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function resolveMarkdownVimMode(
  cfg: Pick<vscode.WorkspaceConfiguration, 'get'>,
): boolean {
  return cfg.get<boolean>('vimMode', false);
}

export interface MarkdownTypographySettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export interface MarkdownEditorSettings extends MarkdownTypographySettings {
  lineNumbers: boolean;
  wordWrap: boolean;
  tabSize: number;
  spellcheck: boolean;
  vimMode: boolean;
  editorTheme: string;
  hybridRendering: boolean;
  codeFenceHiding: boolean;
  syntaxHighlighting: boolean;
  bracketPairColorization: boolean;
}

type ConfigLike = Pick<vscode.WorkspaceConfiguration, 'get'> & {
  inspect?: vscode.WorkspaceConfiguration['inspect'];
};

function hasUserConfigured(cfg: ConfigLike, section: string): boolean {
  const inspected = cfg.inspect?.(section) as Record<string, unknown> | undefined;
  if (!inspected) return false;
  return [
    'globalValue',
    'workspaceValue',
    'workspaceFolderValue',
    'defaultLanguageValue',
    'globalLanguageValue',
    'workspaceLanguageValue',
    'workspaceFolderLanguageValue',
  ].some(key => inspected[key] !== undefined);
}

function getMarkdownOrEditor<T>(
  markdownCfg: ConfigLike,
  markdownSection: string,
  markdownDefault: T,
  editorCfg: ConfigLike,
  editorSection: string,
  editorDefault: unknown,
  normalize: (value: unknown) => T,
): T {
  if (hasUserConfigured(markdownCfg, markdownSection)) {
    return markdownCfg.get<T>(markdownSection, markdownDefault);
  }
  return normalize(editorCfg.get(editorSection, editorDefault));
}

function editorLineNumbersToBoolean(value: unknown): boolean {
  return value !== 'off' && value !== false;
}

function editorWordWrapToBoolean(value: unknown): boolean {
  return value !== 'off' && value !== false;
}

function editorTabSizeToNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

export function resolveMarkdownEditorSettings(
  markdownCfg: ConfigLike,
  editorCfg: ConfigLike,
): MarkdownEditorSettings {
  const typography = resolveMarkdownTypography(markdownCfg, editorCfg);
  return {
    ...typography,
    lineNumbers: getMarkdownOrEditor(
      markdownCfg,
      'lineNumbers',
      true,
      editorCfg,
      'lineNumbers',
      'on',
      editorLineNumbersToBoolean,
    ),
    wordWrap: getMarkdownOrEditor(
      markdownCfg,
      'wordWrap',
      true,
      editorCfg,
      'wordWrap',
      'off',
      editorWordWrapToBoolean,
    ),
    tabSize: getMarkdownOrEditor(
      markdownCfg,
      'tabSize',
      2,
      editorCfg,
      'tabSize',
      2,
      editorTabSizeToNumber,
    ),
    spellcheck: markdownCfg.get<boolean>('spellcheck', true),
    vimMode: resolveMarkdownVimMode(markdownCfg),
    editorTheme: markdownCfg.get<string>('editorTheme', 'inherit'),
    hybridRendering: markdownCfg.get<boolean>('hybridRendering', true),
    codeFenceHiding: markdownCfg.get<boolean>('codeFenceHiding', true),
    syntaxHighlighting: markdownCfg.get<boolean>('syntaxHighlighting', true),
    bracketPairColorization: getMarkdownOrEditor(
      markdownCfg,
      'bracketPairColorization',
      true,
      editorCfg,
      'bracketPairColorization.enabled',
      true,
      value => value !== false,
    ),
  };
}

export function resolveMarkdownTypography(
  markdownCfg: ConfigLike,
  editorCfg: ConfigLike,
): MarkdownTypographySettings {
  const markdownFontFamily = markdownCfg.get<string>('fontFamily', 'JetBrains Mono, Menlo, Monaco, Courier New, monospace');
  const markdownFontSize = markdownCfg.get<number>('fontSize', 14);
  const markdownLineHeight = markdownCfg.get<number>('lineHeight', 1.6);
  const useVSCodeEditorTypography = markdownCfg.get<boolean>('useVSCodeEditorTypography', true);

  if (!useVSCodeEditorTypography) {
    return {
      fontFamily: markdownFontFamily,
      fontSize: markdownFontSize,
      lineHeight: markdownLineHeight,
    };
  }

  const editorFontFamily = (editorCfg.get<string>('fontFamily', '') || '').trim();
  const fontFamily = editorFontFamily || markdownFontFamily;
  const fontSize = editorCfg.get<number>('fontSize', markdownFontSize);
  const editorLineHeightPx = editorCfg.get<number>('lineHeight', 0);
  const lineHeight = editorLineHeightPx > 0 && fontSize > 0
    ? Math.max(1, editorLineHeightPx / fontSize)
    : markdownLineHeight;

  return { fontFamily, fontSize, lineHeight };
}

export function formatImageTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}${hh}${mm}${ss}`;
}

export function imageExtensionFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('bmp')) return 'bmp';
  if (normalized.includes('svg')) return 'svg';
  return 'png';
}

export function parseImageDataUrl(dataUrl: string): Uint8Array | null {
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(dataUrl);
  if (!match || !match[1]) return null;
  try {
    return Buffer.from(match[1], 'base64');
  } catch {
    return null;
  }
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
    return true;
  } catch {
    return false;
  }
}

export async function resolveImagePath(imagePath: string, documentPath: string, gitRoot: string | undefined): Promise<string | null> {
  if (!imagePath) return null;
  const docDir = path.dirname(documentPath);
  const candidates: string[] = [];
  const hasSeparator = imagePath.includes('/') || imagePath.includes('\\');

  if (path.isAbsolute(imagePath)) {
    candidates.push(imagePath);
  } else {
    candidates.push(path.join(docDir, imagePath));
    if (!hasSeparator) {
      candidates.push(path.join(docDir, '.asset', imagePath));
      candidates.push(path.join(docDir, '.aseet', imagePath)); // legacy typo fallback
    }
    if (gitRoot) {
      candidates.push(path.join(gitRoot, imagePath));
      if (!hasSeparator) {
        candidates.push(path.join(gitRoot, '.asset', imagePath));
        candidates.push(path.join(gitRoot, '.aseet', imagePath)); // legacy typo fallback
      }
    }
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (await fileExists(normalized)) return normalized;
  }
  return null;
}

export function mimeFromPath(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function getNonce(): string {
  let t = '';
  const s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += s.charAt(Math.floor(Math.random() * s.length));
  return t;
}
