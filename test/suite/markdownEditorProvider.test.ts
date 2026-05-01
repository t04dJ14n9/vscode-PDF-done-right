import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  formatImageTimestamp,
  imageExtensionFromMime,
  mimeFromPath,
  resolveMarkdownEditorSettings,
  parseImageDataUrl,
  resolveImagePath,
  resolveMarkdownTypography,
  resolveMarkdownVimMode,
} from '../../src/markdownEditorProvider';

suite('markdownEditorProvider', () => {
  test('resolveMarkdownVimMode defaults to false', () => {
    const cfg = {
      get: <T>(_section: string, defaultValue?: T) => defaultValue,
    };

    assert.strictEqual(resolveMarkdownVimMode(cfg), false);
  });

  test('resolveMarkdownVimMode respects true', () => {
    const cfg = {
      get: <T>(_section: string, _defaultValue?: T) => true as unknown as T,
    };

    assert.strictEqual(resolveMarkdownVimMode(cfg), true);
  });

  test('resolveMarkdownVimMode respects false', () => {
    const cfg = {
      get: <T>(_section: string, _defaultValue?: T) => false as unknown as T,
    };

    assert.strictEqual(resolveMarkdownVimMode(cfg), false);
  });

  test('resolveMarkdownTypography uses VS Code editor typography by default', () => {
    const markdownCfg = {
      get: <T>(section: string, defaultValue?: T) => {
        if (section === 'fontFamily') return 'Markdown Font' as unknown as T;
        if (section === 'fontSize') return 14 as unknown as T;
        if (section === 'lineHeight') return 1.6 as unknown as T;
        if (section === 'useVSCodeEditorTypography') return true as unknown as T;
        return defaultValue as T;
      },
    };
    const editorCfg = {
      get: <T>(section: string, defaultValue?: T) => {
        if (section === 'fontFamily') return 'Editor Font' as unknown as T;
        if (section === 'fontSize') return 16 as unknown as T;
        if (section === 'lineHeight') return 24 as unknown as T;
        return defaultValue as T;
      },
    };

    const resolved = resolveMarkdownTypography(markdownCfg, editorCfg);
    assert.strictEqual(resolved.fontFamily, 'Editor Font');
    assert.strictEqual(resolved.fontSize, 16);
    assert.strictEqual(resolved.lineHeight, 1.5);
  });

  test('resolveMarkdownTypography falls back to markdown typography when disabled', () => {
    const markdownCfg = {
      get: <T>(section: string, defaultValue?: T) => {
        if (section === 'fontFamily') return 'Markdown Font' as unknown as T;
        if (section === 'fontSize') return 15 as unknown as T;
        if (section === 'lineHeight') return 1.7 as unknown as T;
        if (section === 'useVSCodeEditorTypography') return false as unknown as T;
        return defaultValue as T;
      },
    };
    const editorCfg = {
      get: <T>(_section: string, defaultValue?: T) => defaultValue as T,
    };

    const resolved = resolveMarkdownTypography(markdownCfg, editorCfg);
    assert.strictEqual(resolved.fontFamily, 'Markdown Font');
    assert.strictEqual(resolved.fontSize, 15);
    assert.strictEqual(resolved.lineHeight, 1.7);
  });

  test('resolveMarkdownEditorSettings falls back to VS Code editor settings', () => {
    const markdownCfg = {
      get: <T>(section: string, defaultValue?: T) => {
        if (section === 'fontFamily') return 'Markdown Font' as unknown as T;
        if (section === 'fontSize') return 14 as unknown as T;
        if (section === 'lineHeight') return 1.6 as unknown as T;
        return defaultValue as T;
      },
      inspect: <T>(section: string) => ({ key: section, defaultValue: undefined as T }),
    };
    const editorCfg = {
      get: <T>(section: string, defaultValue?: T) => {
        if (section === 'fontFamily') return 'Editor Font' as unknown as T;
        if (section === 'fontSize') return 17 as unknown as T;
        if (section === 'lineHeight') return 34 as unknown as T;
        if (section === 'lineNumbers') return 'off' as unknown as T;
        if (section === 'wordWrap') return 'off' as unknown as T;
        if (section === 'tabSize') return 6 as unknown as T;
        if (section === 'bracketPairColorization.enabled') return false as unknown as T;
        return defaultValue as T;
      },
    };

    const resolved = resolveMarkdownEditorSettings(markdownCfg, editorCfg);
    assert.strictEqual(resolved.fontFamily, 'Editor Font');
    assert.strictEqual(resolved.fontSize, 17);
    assert.strictEqual(resolved.lineHeight, 2);
    assert.strictEqual(resolved.lineNumbers, false);
    assert.strictEqual(resolved.wordWrap, false);
    assert.strictEqual(resolved.tabSize, 6);
    assert.strictEqual(resolved.bracketPairColorization, false);
  });

  test('resolveMarkdownEditorSettings keeps explicit PaperLink overrides', () => {
    const explicit = new Set(['lineNumbers', 'wordWrap', 'tabSize', 'bracketPairColorization']);
    const markdownCfg = {
      get: <T>(section: string, defaultValue?: T) => {
        if (section === 'lineNumbers') return true as unknown as T;
        if (section === 'wordWrap') return true as unknown as T;
        if (section === 'tabSize') return 2 as unknown as T;
        if (section === 'bracketPairColorization') return true as unknown as T;
        return defaultValue as T;
      },
      inspect: <T>(section: string) => explicit.has(section)
        ? ({ key: section, workspaceValue: true as T })
        : ({ key: section, defaultValue: undefined as T }),
    };
    const editorCfg = {
      get: <T>(section: string, defaultValue?: T) => {
        if (section === 'lineNumbers') return 'off' as unknown as T;
        if (section === 'wordWrap') return 'off' as unknown as T;
        if (section === 'tabSize') return 8 as unknown as T;
        if (section === 'bracketPairColorization.enabled') return false as unknown as T;
        return defaultValue as T;
      },
    };

    const resolved = resolveMarkdownEditorSettings(markdownCfg, editorCfg);
    assert.strictEqual(resolved.lineNumbers, true);
    assert.strictEqual(resolved.wordWrap, true);
    assert.strictEqual(resolved.tabSize, 2);
    assert.strictEqual(resolved.bracketPairColorization, true);
  });

  test('formatImageTimestamp outputs Obsidian-style timestamp', () => {
    const date = new Date(2026, 3, 25, 23, 50, 42);
    assert.strictEqual(formatImageTimestamp(date), '20260425235042');
  });

  test('imageExtensionFromMime maps common image MIME types', () => {
    assert.strictEqual(imageExtensionFromMime('image/png'), 'png');
    assert.strictEqual(imageExtensionFromMime('image/jpeg'), 'jpg');
    assert.strictEqual(imageExtensionFromMime('image/jpg'), 'jpg');
    assert.strictEqual(imageExtensionFromMime('image/webp'), 'webp');
    assert.strictEqual(imageExtensionFromMime('image/svg+xml'), 'svg');
    assert.strictEqual(imageExtensionFromMime('unknown/type'), 'png');
  });

  test('parseImageDataUrl decodes valid data URL and rejects invalid schema', () => {
    const valid = parseImageDataUrl('data:image/png;base64,SGVsbG8=');
    assert.ok(valid);
    assert.strictEqual(Buffer.from(valid!).toString('utf8'), 'Hello');

    const invalid = parseImageDataUrl('data:text/plain;base64,SGVsbG8=');
    assert.strictEqual(invalid, null);
  });

  test('mimeFromPath maps common extensions', () => {
    assert.strictEqual(mimeFromPath('/tmp/image.png'), 'image/png');
    assert.strictEqual(mimeFromPath('/tmp/image.jpg'), 'image/jpeg');
    assert.strictEqual(mimeFromPath('/tmp/image.jpeg'), 'image/jpeg');
    assert.strictEqual(mimeFromPath('/tmp/image.gif'), 'image/gif');
    assert.strictEqual(mimeFromPath('/tmp/image.webp'), 'image/webp');
    assert.strictEqual(mimeFromPath('/tmp/image.bmp'), 'image/bmp');
    assert.strictEqual(mimeFromPath('/tmp/image.svg'), 'image/svg+xml');
  });

  test('resolveImagePath checks document, repo, and .asset fallback', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'paperlink-md-provider-'));
    try {
      const notesDir = path.join(tempRoot, 'notes');
      const imagesDir = path.join(tempRoot, 'images');
      const assetDir = path.join(tempRoot, '.asset');
      await fs.mkdir(notesDir, { recursive: true });
      await fs.mkdir(imagesDir, { recursive: true });
      await fs.mkdir(assetDir, { recursive: true });

      const documentPath = path.join(notesDir, 'daily.md');
      await fs.writeFile(documentPath, '# test');

      const localImage = path.join(notesDir, 'local.png');
      const repoImage = path.join(imagesDir, 'repo.png');
      const pastedImage = path.join(assetDir, 'Pasted image 20260425235042.png');
      await fs.writeFile(localImage, Buffer.from([1]));
      await fs.writeFile(repoImage, Buffer.from([2]));
      await fs.writeFile(pastedImage, Buffer.from([3]));

      assert.strictEqual(
        await resolveImagePath('local.png', documentPath, tempRoot),
        path.normalize(localImage),
      );

      assert.strictEqual(
        await resolveImagePath('images/repo.png', documentPath, tempRoot),
        path.normalize(repoImage),
      );

      assert.strictEqual(
        await resolveImagePath('Pasted image 20260425235042.png', documentPath, tempRoot),
        path.normalize(pastedImage),
      );

      assert.strictEqual(
        await resolveImagePath(path.join(assetDir, 'Pasted image 20260425235042.png'), documentPath, tempRoot),
        path.normalize(pastedImage),
      );

      assert.strictEqual(
        await resolveImagePath('missing.png', documentPath, tempRoot),
        null,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('resolveImagePath checks note-local .asset fallback', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'paperlink-md-provider-'));
    try {
      const notesDir = path.join(tempRoot, 'notes');
      const noteAssetDir = path.join(notesDir, '.asset');
      await fs.mkdir(noteAssetDir, { recursive: true });

      const documentPath = path.join(notesDir, 'daily.md');
      await fs.writeFile(documentPath, '# test');

      const pastedImage = path.join(noteAssetDir, 'Pasted image 20260425235042.png');
      await fs.writeFile(pastedImage, Buffer.from([3]));

      assert.strictEqual(
        await resolveImagePath('Pasted image 20260425235042.png', documentPath, tempRoot),
        path.normalize(pastedImage),
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('resolveImagePath keeps legacy .aseet fallback for existing files', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'paperlink-md-provider-'));
    try {
      const notesDir = path.join(tempRoot, 'notes');
      const legacyAssetDir = path.join(tempRoot, '.aseet');
      await fs.mkdir(notesDir, { recursive: true });
      await fs.mkdir(legacyAssetDir, { recursive: true });

      const documentPath = path.join(notesDir, 'daily.md');
      await fs.writeFile(documentPath, '# test');

      const pastedImage = path.join(legacyAssetDir, 'Pasted image 20260425235042.png');
      await fs.writeFile(pastedImage, Buffer.from([3]));

      assert.strictEqual(
        await resolveImagePath('Pasted image 20260425235042.png', documentPath, tempRoot),
        path.normalize(pastedImage),
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
