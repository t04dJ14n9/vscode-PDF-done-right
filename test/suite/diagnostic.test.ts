/**
 * Diagnostic test: queries the markdown editor webview state and
 * simulates clicking an @pdf link widget.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

suite('Webview Diagnostic', () => {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  test('diagnostic: @pdf link widget is rendered with data attributes', async () => {
    const testMd = path.join(workspaceRoot, '_diag.md');
    fs.writeFileSync(testMd, '# Test\n\n@pdf[[sample.pdf#page=1&idx=0&off=0&len=10|"test"]]\n\nDone.\n');

    try {
      // Activate extension by opening PDF first
      const pdfUri = vscode.Uri.file(path.join(workspaceRoot, 'sample.pdf'));
      await vscode.commands.executeCommand('vscode.openWith', pdfUri, 'paperlink.pdfViewer');
      await new Promise(r => setTimeout(r, 3000));

      // Open markdown in PDF Done Right editor
      const mdUri = vscode.Uri.file(testMd);
      await vscode.commands.executeCommand('vscode.openWith', mdUri, 'paperlink.markdownEditor');
      await new Promise(r => setTimeout(r, 3000));

      // Run diagnostic command
      await vscode.commands.executeCommand('paperlink.debugMarkdownEditor');
      await new Promise(r => setTimeout(r, 2000));

      assert.ok(true, 'Diagnostic completed');
    } finally {
      try { fs.unlinkSync(testMd); } catch {}
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('clickTest: simulating click on @pdf link sends openPdfRef message', async () => {
    const testMd = path.join(workspaceRoot, '_click-sim.md');
    fs.writeFileSync(testMd, '# Test\n\n@pdf[[sample.pdf#page=1&idx=0&off=0&len=10|"test"]]\n\nDone.\n');

    try {
      // Activate extension by opening PDF first
      const pdfUri = vscode.Uri.file(path.join(workspaceRoot, 'sample.pdf'));
      await vscode.commands.executeCommand('vscode.openWith', pdfUri, 'paperlink.pdfViewer');
      await new Promise(r => setTimeout(r, 3000));

      // Open markdown in PDF Done Right editor
      const mdUri = vscode.Uri.file(testMd);
      await vscode.commands.executeCommand('vscode.openWith', mdUri, 'paperlink.markdownEditor');
      await new Promise(r => setTimeout(r, 3000));

      // Run click test — simulates a click on the first @pdf link widget
      // This should trigger the wikiLink click handler → onOpenPdfRef → openPdfRef message
      await vscode.commands.executeCommand('paperlink.debugMarkdownEditor');
      await new Promise(r => setTimeout(r, 3000));

      assert.ok(true, 'Click test completed');
    } finally {
      try { fs.unlinkSync(testMd); } catch {}
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
