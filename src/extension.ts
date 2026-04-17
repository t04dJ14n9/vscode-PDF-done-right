import * as vscode from 'vscode';
import { PdfEditorProvider } from './pdfEditorProvider';
import { PdfLinkProvider } from './pdfLinkProvider';
import { AnnotationService } from './annotationService';
import { PdfOutlineProvider } from './pdfOutlineProvider';
import { activateMarkdownItPlugin } from './markdownPlugin';

export function activate(context: vscode.ExtensionContext): { extendMarkdownIt: (md: any) => any } {
  const annotationService = new AnnotationService();

  // Register PDF outline tree view
  const outlineProvider = new PdfOutlineProvider();
  const outlineTreeView = vscode.window.createTreeView('paperlink.outline', {
    treeDataProvider: outlineProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(outlineTreeView);

  // Register PDF custom editor
  const pdfProvider = new PdfEditorProvider(context, annotationService, outlineProvider);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'paperlink.pdfViewer',
      pdfProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // Register document link provider for markdown files
  const linkProvider = new PdfLinkProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      { language: 'markdown', scheme: 'file' },
      linkProvider
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('paperlink.openPdfAtAnchor', async (args: any) => {
      const { pdfPath, anchor } = typeof args === 'string' ? JSON.parse(args) : args;
      await pdfProvider.openPdfAtAnchor(pdfPath, anchor);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('paperlink.outlineGoToPage', (page: number) => {
      outlineProvider.goToPage(page);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('paperlink.showAnnotations', async () => {
      const activeWebview = pdfProvider.getActiveWebview();
      if (activeWebview) {
        const annotations = await annotationService.getAnnotationsForPdf(activeWebview.pdfUri);
        const items = annotations.map((a) => ({
          label: a.anchor.snippet.substring(0, 80),
          description: `p.${a.anchor.page} -> ${a.markdownFile}`,
          annotation: a,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select an annotation to jump to',
        });
        if (picked) {
          activeWebview.goToAnchor(picked.annotation.anchor);
        }
      }
    })
  );

  // Return the markdown-it plugin for markdown preview
  return {
    extendMarkdownIt: activateMarkdownItPlugin,
  };
}

export function deactivate(): void {
  // Clean up
}
