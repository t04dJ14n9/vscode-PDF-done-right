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
import { ReferenceEntry, stringToAnchor } from './shared/types';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<{ extendMarkdownIt: (md: any) => any }> {
  const gitRoot = getGitRoot();
  const indexService = new IndexService();

  if (gitRoot) {
    try {
      await indexService.init(gitRoot);
    } catch (e) {
      log.error('IndexService init failed', e);
    }

    const indexer = new MarkdownIndexer(indexService, gitRoot);
    // Kick off the full scan in the background — don't block activation.
    indexer.init().catch(e => log.error('MarkdownIndexer.init failed', e));
    context.subscriptions.push(indexer);

    const renameWatcher = new FileRenameWatcher(indexService, gitRoot);
    context.subscriptions.push(renameWatcher);

    // Backlinks right-sidebar view
    const backlinks = new BacklinksProvider(indexService, gitRoot);
    const backlinksView = vscode.window.createTreeView('paperlink.backlinks', {
      treeDataProvider: backlinks,
      showCollapseAll: false,
    });
    context.subscriptions.push(backlinksView);

    context.subscriptions.push({
      dispose: () => { void indexService.dispose(); },
    });

    // Register extension-host-wide commands that need the indexer.
    context.subscriptions.push(
      vscode.commands.registerCommand('paperlink.refreshIndex', async () => {
        await indexer.refresh();
        vscode.window.showInformationMessage('PaperLink: index rebuilt');
      }),
      vscode.commands.registerCommand(
        'paperlink.openBacklink',
        async (ref: ReferenceEntry) => {
          if (!ref) return;
          const absPath = path.join(gitRoot, ref.source);
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
          const abs = path.join(gitRoot, args.path);
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
      vscode.commands.registerCommand('paperlink.openInMarkdownEditor', async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) return;
        await vscode.commands.executeCommand(
          'vscode.openWith',
          target,
          MarkdownEditorProvider.viewType,
        );
      }),
    );
  } else {
    log.warn('No workspace folder; PaperLink will run in read-only mode.');
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
    gitRoot ?? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()),
  );
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('paperlink.pdfViewer', pdfProvider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  // Markdown editor scaffold (priority "option" — never default).
  const mdEditorProvider = new MarkdownEditorProvider(context);
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

  // Legacy PDF-outline + show-annotations commands
  context.subscriptions.push(
    vscode.commands.registerCommand('paperlink.openPdfAtAnchor', async (args: any) => {
      const { pdfPath, anchor } = typeof args === 'string' ? JSON.parse(args) : args;
      await pdfProvider.openPdfAtAnchor(pdfPath, anchor);
    }),
    vscode.commands.registerCommand('paperlink.outlineGoToPage', (page: number) => {
      outlineProvider.goToPage(page);
    }),
    vscode.commands.registerCommand('paperlink.showAnnotations', async () => {
      const active = pdfProvider.getActiveWebview();
      if (!active) return;
      const pdfRel = gitRoot
        ? path.relative(gitRoot, active.pdfUri.fsPath).replace(/\\/g, '/')
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

  return {
    extendMarkdownIt: activateMarkdownItPlugin,
  };
}

export function deactivate(): void {
  log.dispose();
}
