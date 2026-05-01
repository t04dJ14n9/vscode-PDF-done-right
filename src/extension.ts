import * as vscode from 'vscode';
import * as path from 'path';
import { PdfEditorProvider } from './pdfEditorProvider';
import { PdfLinkProvider } from './pdfLinkProvider';
import { PdfOutlineProvider } from './pdfOutlineProvider';
import { IndexService } from './index/indexService';
import { MarkdownIndexer } from './index/markdownIndexer';
import { FileRenameWatcher } from './index/fileRenameWatcher';
import { BacklinksProvider } from './backlinksProvider';
import { MarkdownEditorProvider } from './markdownEditorProvider';
import { activateMarkdownItPlugin } from './markdownPlugin';
import { getGitRoot } from './util/gitRoot';
import { log } from './util/logger';
import {
  ReferenceEntry,
  stringToAnchor,
  CodeReferenceEntry,
  WikiReferenceEntry,
  rewriteLegacyPdfLinks,
} from './shared/types';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<{
  extendMarkdownIt: (md: any) => any;
  requestMarkdownDiagnostic: (uri?: vscode.Uri) => Promise<any>;
  requestMarkdownImageDoubleClickTest: (uri: vscode.Uri) => Promise<any>;
  requestMarkdownImagePasteTest: (uri: vscode.Uri) => Promise<any>;
  requestMarkdownImageCursorLineTest: (uri: vscode.Uri) => Promise<any>;
}> {
  const gitRoot = getGitRoot();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const projectRoot = gitRoot ?? workspaceRoot;
  const indexService = new IndexService();

  if (projectRoot) {
    try {
      await indexService.init(projectRoot);
    } catch (e) {
      log.error('IndexService init failed', e);
    }

    const indexer = new MarkdownIndexer(indexService, projectRoot);
    // Kick off the full scan in the background — don't block activation.
    indexer.init().catch(e => log.error('MarkdownIndexer.init failed', e));
    context.subscriptions.push(indexer);

    const renameWatcher = new FileRenameWatcher(indexService, projectRoot);
    context.subscriptions.push(renameWatcher);

    // Backlinks + forward-links views in Explorer.
    const backlinks = new BacklinksProvider(indexService, projectRoot, 'backlinks');
    const backlinksView = vscode.window.createTreeView('paperlink.backlinks', {
      treeDataProvider: backlinks,
      showCollapseAll: false,
    });
    const forwardLinks = new BacklinksProvider(indexService, projectRoot, 'forward');
    const forwardLinksView = vscode.window.createTreeView('paperlink.forwardLinks', {
      treeDataProvider: forwardLinks,
      showCollapseAll: false,
    });
    context.subscriptions.push(backlinksView, forwardLinksView);

    context.subscriptions.push({
      dispose: () => { void indexService.dispose(); },
    });

    // Register extension-host-wide commands that need the indexer.
    context.subscriptions.push(
      vscode.commands.registerCommand('paperlink.refreshIndex', async () => {
        await indexer.refresh();
        vscode.window.showInformationMessage('PDF Done Right: index rebuilt');
      }),
      vscode.commands.registerCommand('paperlink.migrateLegacyPdfLinks', async (args?: any) => {
        const requestedUris: vscode.Uri[] = Array.isArray(args)
          ? args.filter((u): u is vscode.Uri => u instanceof vscode.Uri)
          : Array.isArray(args?.uris)
            ? args.uris.filter((u: unknown): u is vscode.Uri => u instanceof vscode.Uri)
            : [];
        const markdownUris = requestedUris.length > 0
          ? requestedUris.filter(u => u.scheme === 'file' && u.path.toLowerCase().endsWith('.md'))
          : await vscode.workspace.findFiles(
            '**/*.md',
            '{**/node_modules/**,**/.paperlink/**,**/.git/**}',
          );

        const edit = new vscode.WorkspaceEdit();
        const touched = new Set<string>();
        let rewrittenLinks = 0;

        for (const uri of markdownUris) {
          let text: string;
          try {
            const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            if (open) {
              text = open.getText();
            } else {
              const data = await vscode.workspace.fs.readFile(uri);
              text = Buffer.from(data).toString('utf8');
            }
          } catch (e) {
            log.warn(`Could not read markdown file during legacy PDF migration: ${uri.fsPath}`, e);
            continue;
          }

          const result = rewriteLegacyPdfLinks(text);
          if (result.rewrites === 0 || result.text === text) continue;

          rewrittenLinks += result.rewrites;
          touched.add(uri.toString());
          const lineBreaks = text.match(/\n/g)?.length ?? 0;
          const endLine = lineBreaks;
          const endCharacter = text.length - (text.lastIndexOf('\n') + 1);
          edit.replace(
            uri,
            new vscode.Range(new vscode.Position(0, 0), new vscode.Position(endLine, endCharacter)),
            result.text,
          );
        }

        if (rewrittenLinks === 0) {
          vscode.window.showInformationMessage('PDF Done Right: no legacy @pdf links found.');
          return;
        }

        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) {
          vscode.window.showWarningMessage('PDF Done Right: legacy PDF link migration failed.');
          return;
        }

        for (const key of touched) {
          const uri = vscode.Uri.parse(key);
          const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key)
            ?? await vscode.workspace.openTextDocument(uri);
          await doc.save();
        }

        await indexer.refresh();
        vscode.window.showInformationMessage(
          `PDF Done Right: migrated ${rewrittenLinks} legacy PDF link${rewrittenLinks === 1 ? '' : 's'}.`,
        );
      }),
      vscode.commands.registerCommand(
        'paperlink.openBacklink',
        async (ref: ReferenceEntry) => {
          if (!ref) return;
          const absPath = path.join(projectRoot, ref.source);
          const mdUri = vscode.Uri.file(absPath);
          const doc = await vscode.workspace.openTextDocument(mdUri);
          const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
          const pos = new vscode.Position(
            Math.max(0, ref.sourceLine | 0),
            Math.max(0, ref.sourceCol | 0),
          );
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          editor.selection = new vscode.Selection(pos, pos);
        },
      ),
      vscode.commands.registerCommand(
        'paperlink.openMarkdownAtLocation',
        async (args: { path: string; line: number; col: number }) => {
          if (!args?.path) return;
          const abs = path.join(projectRoot, args.path);
          const mdUri = vscode.Uri.file(abs);
          const doc = await vscode.workspace.openTextDocument(mdUri);
          const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
          const pos = new vscode.Position(
            Math.max(0, args.line | 0),
            Math.max(0, args.col | 0),
          );
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          editor.selection = new vscode.Selection(pos, pos);
        },
      ),
      vscode.commands.registerCommand(
        'paperlink.openCodeAtLocation',
        async (ref: CodeReferenceEntry) => {
          if (!ref || !projectRoot) return;
          const absPath = path.join(projectRoot, ref.targetPath);
          const uri = vscode.Uri.file(absPath);
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
            if (ref.startLine > 0) {
              const startLine = Math.max(0, ref.startLine - 1);
              const endLine = ref.endLine > ref.startLine ? Math.min(doc.lineCount - 1, ref.endLine - 1) : startLine;
              const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
              editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
              editor.selection = new vscode.Selection(range.start, range.end);
          }
        } catch {
          // Target might be a folder — try opening in explorer
          vscode.commands.executeCommand('revealInExplorer', uri);
          }
        },
      ),
      vscode.commands.registerCommand(
        'paperlink.openWikiLink',
        async (ref: WikiReferenceEntry) => {
          if (!ref || !projectRoot) return;
          // Try to resolve note name to a file: scan for .md files matching the note name
          const noteName = ref.targetNote;
          const candidates = await vscode.workspace.findFiles(
            `**/${noteName}.md`,
            '{**/node_modules/**,**/.paperlink/**,**/.git/**}',
            10,
          );
          if (candidates.length > 0) {
            const doc = await vscode.workspace.openTextDocument(candidates[0]);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
            if (ref.targetSection) {
              // Try to find the section heading in the document
              const text = doc.getText();
              const sectionRegex = new RegExp(`^#+\\s+${escapeRegex(ref.targetSection)}`, 'm');
              const sectionMatch = sectionRegex.exec(text);
              if (sectionMatch) {
                const pos = doc.positionAt(sectionMatch.index);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                editor.selection = new vscode.Selection(pos, pos);
              }
            }
          } else {
            vscode.window.showWarningMessage(`Note "${noteName}" not found in workspace`);
          }
        },
      ),
      vscode.commands.registerCommand('paperlink.openInMarkdownEditor', async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) return;
        await vscode.commands.executeCommand(
          'vscode.openWith',
          target,
          MarkdownEditorProvider.viewType,
        );
      }),
      vscode.commands.registerCommand('paperlink.toggleMarkdownVimMode', async () => {
        const cfg = vscode.workspace.getConfiguration('paperlink.markdown');
        const current = cfg.get<boolean>('vimMode', false);
        const next = !current;
        const target = vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;

        await cfg.update('vimMode', next, target);
        vscode.window.showInformationMessage(`PDF Done Right: Markdown Vim mode ${next ? 'enabled' : 'disabled'}.`);
      }),
    );
  } else {
    log.warn('No workspace folder; PDF Done Right will run in read-only mode.');
  }

  // PDF outline tree view (always registered; hidden via `when` context key).
  const outlineProvider = new PdfOutlineProvider();
  const outlineTreeView = vscode.window.createTreeView('paperlink.outline', {
    treeDataProvider: outlineProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(outlineTreeView);

  // PDF custom editor
  const pdfProvider = new PdfEditorProvider(
    context,
    indexService,
    outlineProvider,
    projectRoot ?? process.cwd(),
  );
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('paperlink.pdfViewer', pdfProvider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  // Markdown editor (priority "default" — opens .md files in PDF Done Right by default).
  const mdEditorProvider = new MarkdownEditorProvider(context, indexService, projectRoot);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      mdEditorProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Markdown → DocumentLink provider
  const linkProvider = new PdfLinkProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      { language: 'markdown', scheme: 'file' },
      linkProvider,
    ),
  );

  // Diagnostic command for debugging the markdown editor webview
  // Also stores last diagnostic result for test access
  let lastDiagnostic: any = null;
  context.subscriptions.push(
    vscode.commands.registerCommand('paperlink.debugMarkdownEditor', async () => {
      const diag = await mdEditorProvider.requestDiagnostic();
      lastDiagnostic = diag;
      const msg = typeof diag === 'object' ? JSON.stringify(diag, null, 2) : String(diag);
      console.log('[PDFDR] MD Editor Diagnostic:', msg);
      vscode.window.showInformationMessage(`MD Editor: view=${diag?.viewExists} pdf=${diag?.pdfLinkCount} wiki=${diag?.wikiLinkCount} code=${diag?.codeLinkCount} lines=${diag?.docLines}`);
    }),
  );

  // Expose diagnostic method for tests
  const requestMarkdownDiagnostic = async (uri?: vscode.Uri) => {
    if (uri) {
      return mdEditorProvider.requestDiagnosticForDocument(uri);
    }
    return mdEditorProvider.requestDiagnostic();
  };

  const requestMarkdownImageDoubleClickTest = async (uri: vscode.Uri) => {
    return mdEditorProvider.imageDoubleClickTestForDocument(uri);
  };

  const requestMarkdownImagePasteTest = async (uri: vscode.Uri) => {
    return mdEditorProvider.imagePasteTestForDocument(uri);
  };

  const requestMarkdownImageCursorLineTest = async (uri: vscode.Uri) => {
    return mdEditorProvider.imageCursorLineTestForDocument(uri);
  };

  // Legacy PDF-outline + show-annotations commands
  context.subscriptions.push(
    vscode.commands.registerCommand('paperlink.openPdfAtAnchor', async (args: any) => {
      const { pdfPath, anchor } = typeof args === 'string' ? JSON.parse(args) : args;
      const debugLog = vscode.workspace.getConfiguration('paperlink').get<boolean>('debugLogging');
      if (debugLog) {
        console.log(`[PDFDR] openPdfAtAnchor: pdfPath=${pdfPath}, anchor=${anchor}`);
      }
      await pdfProvider.openPdfAtAnchor(pdfPath, anchor);
    }),
    vscode.commands.registerCommand('paperlink.outlineGoToPage', (page: number) => {
      outlineProvider.goToPage(page);
    }),
    vscode.commands.registerCommand('paperlink.showAnnotations', async () => {
      const active = pdfProvider.getActiveWebview();
      if (!active) return;
      const pdfRel = projectRoot
        ? path.relative(projectRoot, active.pdfUri.fsPath).replace(/\\/g, '/')
        : path.basename(active.pdfUri.fsPath);
      const anns = indexService.getAnnotationsForPdf(pdfRel);
      const items = anns.map(a => ({
        label: (a.snippet || a.anchor).substring(0, 80),
        description: `p.${a.page}`,
        anchor: a.anchor,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an annotation to jump to',
      });
      if (picked) {
        const parsed = stringToAnchor(picked.anchor);
        if (parsed) active.goToAnchor(parsed);
      }
    }),
  );

  // PDF navigation/zoom commands (editor/title bar buttons)
  context.subscriptions.push(
    vscode.commands.registerCommand('paperlink.prevPage', () => {
      const active = pdfProvider.getActiveWebview();
      if (active) active.postMessage({ type: 'navigate', direction: 'prev' });
    }),
    vscode.commands.registerCommand('paperlink.nextPage', () => {
      const active = pdfProvider.getActiveWebview();
      if (active) active.postMessage({ type: 'navigate', direction: 'next' });
    }),
    vscode.commands.registerCommand('paperlink.zoomIn', () => {
      const active = pdfProvider.getActiveWebview();
      if (active) active.postMessage({ type: 'zoom', delta: 0.25 });
    }),
    vscode.commands.registerCommand('paperlink.zoomOut', () => {
      const active = pdfProvider.getActiveWebview();
      if (active) active.postMessage({ type: 'zoom', delta: -0.25 });
    }),
    vscode.commands.registerCommand('paperlink.zoomFitWidth', () => {
      const active = pdfProvider.getActiveWebview();
      if (active) active.postMessage({ type: 'zoomFitWidth' });
    }),
  );

  return {
    extendMarkdownIt: activateMarkdownItPlugin,
    requestMarkdownDiagnostic,
    requestMarkdownImageDoubleClickTest,
    requestMarkdownImagePasteTest,
    requestMarkdownImageCursorLineTest,
  };
}

export function deactivate(): void {
  log.dispose();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
