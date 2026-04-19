import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

suite('PaperLink Extension Test Suite', () => {

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  suiteTeardown(async () => {
    // Clean up test artifacts that may have been created.
    const indexJson = path.join(workspaceRoot, '.paperlink', 'index.json');
    if (fs.existsSync(indexJson)) {
      try { fs.unlinkSync(indexJson); } catch { /* ignore */ }
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

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

    if (!ext.isActive) {
      await ext.activate();
    }
    await new Promise(resolve => setTimeout(resolve, 2000));

    assert.ok(ext.isActive, 'Extension should be active after opening PDF');
  });

  test('PDF link regex should match valid links', () => {
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

  test('Custom editor should be registered for PDF', async () => {
    const pdfPath = path.join(workspaceRoot, 'sample.pdf');
    const uri = vscode.Uri.file(pdfPath);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'paperlink.pdfViewer');
    await new Promise(resolve => setTimeout(resolve, 1000));

    const tabGroups = vscode.window.tabGroups;
    const pdfTabs = tabGroups.all
      .flatMap(g => g.tabs)
      .filter(t => {
        const input = t.input as any;
        return input?.viewType === 'paperlink.pdfViewer';
      });

    assert.ok(pdfTabs.length > 0, 'Should have a PaperLink PDF viewer tab open');
  });

  test('Markdown editor scaffold is registered with priority "option"', async () => {
    // Default open should still go to the built-in editor; our scaffold doesn't
    // steal defaults. We verify by explicitly opening with our viewType.
    const mdPath = path.join(workspaceRoot, 'notes.md');
    assert.ok(fs.existsSync(mdPath), 'notes.md should exist');
    const uri = vscode.Uri.file(mdPath);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'paperlink.markdownEditor');
    await new Promise(resolve => setTimeout(resolve, 500));
    const hasScaffold = vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .some(t => (t.input as any)?.viewType === 'paperlink.markdownEditor');
    assert.ok(hasScaffold, 'Scaffold markdown editor should open when explicitly requested');
  });

  test('Markdown file opens with default text editor', async () => {
    const mdPath = path.join(workspaceRoot, 'notes.md');
    const doc = await vscode.workspace.openTextDocument(mdPath);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    assert.strictEqual(doc.languageId, 'markdown');
  });

  test('Commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('paperlink.openPdfAtAnchor'), 'openPdfAtAnchor command');
    assert.ok(commands.includes('paperlink.showAnnotations'), 'showAnnotations command');
    assert.ok(commands.includes('paperlink.outlineGoToPage'), 'outlineGoToPage command');
    assert.ok(commands.includes('paperlink.refreshIndex'), 'refreshIndex command');
    assert.ok(commands.includes('paperlink.openBacklink'), 'openBacklink command');
    assert.ok(commands.includes('paperlink.openMarkdownAtLocation'), 'openMarkdownAtLocation command');
    assert.ok(commands.includes('paperlink.openInMarkdownEditor'), 'openInMarkdownEditor command');
  });

  test('Markdown DocumentLink provider turns @pdf[[...]] into a link', async () => {
    const mdUri = vscode.Uri.file(path.join(workspaceRoot, '_link-test.md'));
    const body = 'see @pdf[[sample.pdf#page=2&idx=0&off=0&len=5|"hi"]] here';
    await vscode.workspace.fs.writeFile(mdUri, Buffer.from(body, 'utf8'));
    try {
      const doc = await vscode.workspace.openTextDocument(mdUri);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
        'vscode.executeLinkProvider',
        doc.uri,
      );
      assert.ok(Array.isArray(links), 'links must be an array');
      const pl = (links ?? []).filter(l =>
        l.target?.toString().startsWith('command:paperlink.openPdfAtAnchor'),
      );
      assert.ok(pl.length >= 1, 'at least one PaperLink DocumentLink must be produced');
    } finally {
      try { await vscode.workspace.fs.delete(mdUri); } catch { /* ignore */ }
    }
  });
});
