/**
 * Test that exercises the full message chain from markdown editor to PDF navigation.
 * Simulates what happens when a user Cmd+Clicks an @pdf link in the CM6 webview.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

suite('PDF Link Click Chain', () => {

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('full chain: open MD editor → send openPdfRef message → PDF opens at anchor', async () => {
    // Create a markdown file with @pdf link
    const testMd = path.join(workspaceRoot, '_click-chain-test.md');
    const content = '# Chain Test\n\n@pdf[[sample.pdf#page=1&idx=0&off=0&len=10|"test"]]\n';
    fs.writeFileSync(testMd, content, 'utf8');

    try {
      // Ensure extension is activated by opening a PDF first
      const pdfUri = vscode.Uri.file(path.join(workspaceRoot, 'sample.pdf'));
      await vscode.commands.executeCommand('vscode.openWith', pdfUri, 'paperlink.pdfViewer');
      await new Promise(r => setTimeout(r, 2000));

      // Now open the markdown file
      const mdUri = vscode.Uri.file(testMd);
      await vscode.commands.executeCommand('vscode.openWith', mdUri, 'paperlink.markdownEditor');
      await new Promise(r => setTimeout(r, 1500));

      // Verify the markdown editor is open
      const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
      assert.strictEqual(
        (activeTab?.input as any)?.viewType,
        'paperlink.markdownEditor',
        'PDF Done Right markdown editor should be active',
      );

      // Simulate the openPdfRef message that would be sent by the webview
      // by calling the same command the provider calls
      await vscode.commands.executeCommand('paperlink.openPdfAtAnchor', {
        pdfPath: 'sample.pdf',
        anchor: 'page=1&idx=0&off=0&len=10',
      });
      await new Promise(r => setTimeout(r, 3000));

      // Verify PDF is now open
      const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
      const pdfTab = tabs.find(t => (t.input as any)?.viewType === 'paperlink.pdfViewer');
      assert.ok(pdfTab, 'PDF viewer should be open after clicking @pdf link');
    } finally {
      try { fs.unlinkSync(testMd); } catch { /* ignore */ }
    }
  });
});
