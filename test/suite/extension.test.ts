import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

suite('PDF Done Right Extension Test Suite', () => {

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
    const ext = vscode.extensions.getExtension('t04dj14n9.vscode-pdf-done-right');
    assert.ok(ext, 'Extension should be installed');
  });

  test('Extension should activate on PDF open', async () => {
    const pdfPath = path.join(workspaceRoot, 'sample.pdf');
    assert.ok(fs.existsSync(pdfPath), 'sample.pdf should exist in test workspace');

    const uri = vscode.Uri.file(pdfPath);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'paperlink.pdfViewer');

    const ext = vscode.extensions.getExtension('t04dj14n9.vscode-pdf-done-right');
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

  test('Code link regex should match file with line range', () => {
    const link = '@code[[src/utils/helper.go#L12-L34|"parseConfig function"]]';
    const regex = /@code\[\[([^\]#|]+)(?:#L(\d+)(?:-L(\d+))?)?(?:\|"([^"]*)")?\]\]/g;
    const match = regex.exec(link);

    assert.ok(match, 'Regex should match code link');
    assert.strictEqual(match[1], 'src/utils/helper.go');
    assert.strictEqual(match[2], '12');
    assert.strictEqual(match[3], '34');
    assert.strictEqual(match[4], 'parseConfig function');
  });

  test('Code link regex should match file with single line', () => {
    const link = '@code[[main.go#L42]]';
    const regex = /@code\[\[([^\]#|]+)(?:#L(\d+)(?:-L(\d+))?)?(?:\|"([^"]*)")?\]\]/g;
    const match = regex.exec(link);

    assert.ok(match, 'Regex should match single-line code link');
    assert.strictEqual(match[1], 'main.go');
    assert.strictEqual(match[2], '42');
    assert.strictEqual(match[3], undefined);
    assert.strictEqual(match[4], undefined);
  });

  test('Code link regex should match folder reference', () => {
    const link = '@code[[src/utils/|"utils folder"]]';
    const regex = /@code\[\[([^\]#|]+)(?:#L(\d+)(?:-L(\d+))?)?(?:\|"([^"]*)")?\]\]/g;
    const match = regex.exec(link);

    assert.ok(match, 'Regex should match folder reference');
    assert.strictEqual(match[1], 'src/utils/');
    assert.strictEqual(match[2], undefined);
    assert.strictEqual(match[3], undefined);
    assert.strictEqual(match[4], 'utils folder');
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

    assert.ok(pdfTabs.length > 0, 'Should have a PDF Done Right PDF viewer tab open');
  });

  test('Markdown editor is registered and can open .md files', async () => {
    // Verify the PDF Done Right markdown editor can be explicitly opened.
    const mdPath = path.join(workspaceRoot, 'notes.md');
    assert.ok(fs.existsSync(mdPath), 'notes.md should exist');
    const uri = vscode.Uri.file(mdPath);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'paperlink.markdownEditor');
    await new Promise(resolve => setTimeout(resolve, 500));
    const hasEditor = vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .some(t => (t.input as any)?.viewType === 'paperlink.markdownEditor');
    assert.ok(hasEditor, 'PDF Done Right markdown editor should open when explicitly requested');
  });

  test('Markdown file opens with PDF Done Right editor by default', async () => {
    // With configurationDefaults setting workbench.editorAssociations,
    // opening a .md file should use our custom editor.
    const mdPath = path.join(workspaceRoot, '_default-open-test.md');
    const body = '# Test\n\nHello world\n';
    await vscode.workspace.fs.writeFile(vscode.Uri.file(mdPath), Buffer.from(body, 'utf8'));
    try {
      const uri = vscode.Uri.file(mdPath);
      await vscode.commands.executeCommand('vscode.open', uri);
      await new Promise(resolve => setTimeout(resolve, 1000));
      // Check if the active tab is our custom editor
      const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
      const viewType = (activeTab?.input as any)?.viewType;
      assert.ok(
        viewType === 'paperlink.markdownEditor',
        `Expected paperlink.markdownEditor but got: ${viewType}. The .md file should open in PDF Done Right by default.`,
      );
    } finally {
      try { await vscode.workspace.fs.delete(vscode.Uri.file(mdPath)); } catch { /* ignore */ }
    }
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
    assert.ok(commands.includes('paperlink.migrateLegacyPdfLinks'), 'migrateLegacyPdfLinks command');
    assert.ok(commands.includes('paperlink.openBacklink'), 'openBacklink command');
    assert.ok(commands.includes('paperlink.openMarkdownAtLocation'), 'openMarkdownAtLocation command');
    assert.ok(commands.includes('paperlink.openInMarkdownEditor'), 'openInMarkdownEditor command');
    assert.ok(commands.includes('paperlink.toggleMarkdownVimMode'), 'toggleMarkdownVimMode command');
  });

  test('Toggle Markdown Vim mode command executes', async () => {
    await vscode.commands.executeCommand('paperlink.toggleMarkdownVimMode');
    await vscode.commands.executeCommand('paperlink.toggleMarkdownVimMode');
  });

  test('Legacy PDF migration command rewrites @pdf links in markdown files', async () => {
    const mdUri = vscode.Uri.file(path.join(workspaceRoot, '_migrate-legacy-pdf-links.md'));
    const body = [
      '# Migration Test',
      '',
      '@pdf[[sample.pdf#page=2&idx=0&off=0&len=5|"hello"]]',
      '@pdf[[sample.pdf#page=4&idx=2&off=3&len=7]]',
      '',
    ].join('\n');
    await vscode.workspace.fs.writeFile(mdUri, Buffer.from(body, 'utf8'));

    try {
      await vscode.commands.executeCommand('paperlink.migrateLegacyPdfLinks', [mdUri]);
      await new Promise(resolve => setTimeout(resolve, 1200));

      const content = Buffer.from(await vscode.workspace.fs.readFile(mdUri)).toString('utf8');
      assert.ok(
        content.includes('[[sample.pdf#page=2&selection=0,0,0,5|hello]]'),
        `Expected migrated Obsidian PDF link, got:\n${content}`,
      );
      assert.ok(
        content.includes('[[sample.pdf#page=4&selection=2,3,2,10]]'),
        `Expected second migrated Obsidian PDF link, got:\n${content}`,
      );
      assert.ok(
        !content.includes('@pdf[['),
        `Expected no legacy @pdf syntax after migration, got:\n${content}`,
      );
    } finally {
      try { await vscode.workspace.fs.delete(mdUri); } catch { /* ignore */ }
    }
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
      assert.ok(pl.length >= 1, 'at least one PDF Done Right DocumentLink must be produced');
    } finally {
      try { await vscode.workspace.fs.delete(mdUri); } catch { /* ignore */ }
    }
  });

  test('Markdown DocumentLink provider turns Obsidian PDF links into a link', async () => {
    const mdUri = vscode.Uri.file(path.join(workspaceRoot, '_obsidian-pdf-link-test.md'));
    const body = 'see [[sample.pdf#page=2&selection=0,0,0,5|hi]] here';
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
      assert.ok(pl.length >= 1, 'at least one Obsidian-style PDF link must be produced');
    } finally {
      try { await vscode.workspace.fs.delete(mdUri); } catch { /* ignore */ }
    }
  });

  test('Markdown DocumentLink provider turns @code[[...]] into a link', async () => {
    const mdUri = vscode.Uri.file(path.join(workspaceRoot, '_code-link-test.md'));
    const body = 'see @code[[src/main.go#L10-L20|"main func"]] here';
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
        l.target?.toString().startsWith('command:paperlink.openCodeAtLocation'),
      );
      assert.ok(pl.length >= 1, 'at least one code DocumentLink must be produced');
    } finally {
      try { await vscode.workspace.fs.delete(mdUri); } catch { /* ignore */ }
    }
  });
});
