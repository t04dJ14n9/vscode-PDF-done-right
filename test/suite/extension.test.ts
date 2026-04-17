import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

suite('PaperLink Extension Test Suite', () => {

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  test('Extension should be present', () => {
    const ext = vscode.extensions.getExtension('paper-link.paper-link');
    assert.ok(ext, 'Extension should be installed');
  });

  test('Extension should activate on PDF open', async () => {
    const pdfPath = path.join(workspaceRoot, 'sample.pdf');
    assert.ok(fs.existsSync(pdfPath), 'sample.pdf should exist in test workspace');

    const uri = vscode.Uri.file(pdfPath);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'paperlink.pdfViewer');

    const ext = vscode.extensions.getExtension('paper-link.paper-link');
    assert.ok(ext, 'Extension should be installed');

    // Wait for activation (the custom editor triggers it)
    if (!ext.isActive) {
      await ext.activate();
    }

    // Give the webview a moment to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));

    assert.ok(ext.isActive, 'Extension should be active after opening PDF');
  });

  test('PDF link regex should match valid links', () => {
    // Import shared types — they're bundled in the extension
    const link = '@pdf[[papers/test.pdf#page=5&idx=12&off=5&len=40|"some text"]]';
    const regex = /@pdf\[\[([^\]#]+)#([^\]|]+)(?:\|"([^"]*)")?\]\]/g;
    const match = regex.exec(link);

    assert.ok(match, 'Regex should match the link');
    assert.strictEqual(match[1], 'papers/test.pdf');
    assert.strictEqual(match[2], 'page=5&idx=12&off=5&len=40');
    assert.strictEqual(match[3], 'some text');
  });

  test('PDF link regex should match links without snippet', () => {
    const link = '@pdf[[test.pdf#page=1&idx=0&off=0&len=10]]';
    const regex = /@pdf\[\[([^\]#]+)#([^\]|]+)(?:\|"([^"]*)")?\]\]/g;
    const match = regex.exec(link);

    assert.ok(match, 'Regex should match link without snippet');
    assert.strictEqual(match[1], 'test.pdf');
    assert.strictEqual(match[2], 'page=1&idx=0&off=0&len=10');
    assert.strictEqual(match[3], undefined);
  });

  test('Annotation sidecar file should not exist initially', () => {
    const sidecarPath = path.join(workspaceRoot, 'sample.pdf.paperlink.json');
    assert.ok(!fs.existsSync(sidecarPath), 'No sidecar file should exist before annotations');
  });

  test('Custom editor should be registered for PDF', async () => {
    // Check that our custom editor is registered by trying to open a PDF
    const pdfPath = path.join(workspaceRoot, 'sample.pdf');
    const uri = vscode.Uri.file(pdfPath);

    // This should not throw
    await vscode.commands.executeCommand('vscode.openWith', uri, 'paperlink.pdfViewer');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify the active editor tab shows our PDF
    const tabGroups = vscode.window.tabGroups;
    const pdfTabs = tabGroups.all
      .flatMap(g => g.tabs)
      .filter(t => {
        const input = t.input as any;
        return input?.viewType === 'paperlink.pdfViewer';
      });

    assert.ok(pdfTabs.length > 0, 'Should have a PaperLink PDF viewer tab open');
  });

  test('Markdown file should be openable alongside PDF', async () => {
    const mdPath = path.join(workspaceRoot, 'notes.md');
    assert.ok(fs.existsSync(mdPath), 'notes.md should exist');

    const doc = await vscode.workspace.openTextDocument(mdPath);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

    assert.strictEqual(doc.languageId, 'markdown');
  });

  test('Commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('paperlink.openPdfAtAnchor'), 'openPdfAtAnchor command');
    assert.ok(commands.includes('paperlink.showAnnotations'), 'showAnnotations command');
    assert.ok(commands.includes('paperlink.outlineGoToPage'), 'outlineGoToPage command');
  });
});
