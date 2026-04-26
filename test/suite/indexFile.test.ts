import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  emptyIndex,
  indexFilePath,
  loadIndex,
  normalize,
  saveIndex,
  toPosix,
  toPosixRelative,
} from '../../src/index/indexFile';
import { AnnotationEntry, IndexFile, ReferenceEntry } from '../../src/shared/types';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperlink-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function ann(partial: Partial<AnnotationEntry> = {}): AnnotationEntry {
  return {
    pdf: 'a.pdf',
    page: 1,
    anchor: 'page=1&idx=0&off=0&len=5',
    snippet: 'hello',
    color: 'rgba(255,230,0,0.35)',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function ref(partial: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    source: 'notes.md',
    sourceLine: 0,
    sourceCol: 0,
    sourceLength: 40,
    pdf: 'a.pdf',
    page: 1,
    anchor: 'page=1&idx=0&off=0&len=5',
    snippet: 'hello',
    ...partial,
  };
}

suite('indexFile', () => {
  test('emptyIndex shape', () => {
    assert.deepStrictEqual(emptyIndex(), { version: 4, annotations: [], references: [], codeReferences: [], wikiReferences: [] });
  });

  test('toPosix converts back-slashes', () => {
    assert.strictEqual(toPosix('foo\\bar\\baz.pdf'), 'foo/bar/baz.pdf');
  });

  test('toPosixRelative returns POSIX form relative to root', () => {
    const root = path.resolve('/tmp/repo');
    const full = path.join(root, 'papers', 'x.pdf');
    assert.strictEqual(toPosixRelative(root, full), 'papers/x.pdf');
  });

  test('normalize sorts annotations deterministically', () => {
    const input: IndexFile = {
      version: 4,
      annotations: [
        ann({ pdf: 'b.pdf', page: 1, anchor: 'x1' }),
        ann({ pdf: 'a.pdf', page: 3, anchor: 'x3' }),
        ann({ pdf: 'a.pdf', page: 1, anchor: 'x2' }),
        ann({ pdf: 'a.pdf', page: 1, anchor: 'x1' }),
      ],
      references: [],
      codeReferences: [],
      wikiReferences: [],
    };
    const out = normalize(input);
    assert.deepStrictEqual(
      out.annotations.map(a => [a.pdf, a.page, a.anchor]),
      [
        ['a.pdf', 1, 'x1'],
        ['a.pdf', 1, 'x2'],
        ['a.pdf', 3, 'x3'],
        ['b.pdf', 1, 'x1'],
      ],
    );
  });

  test('normalize sorts references by (source, line, col)', () => {
    const input: IndexFile = {
      version: 4,
      annotations: [],
      references: [
        ref({ source: 'b.md', sourceLine: 0, sourceCol: 0 }),
        ref({ source: 'a.md', sourceLine: 5, sourceCol: 0 }),
        ref({ source: 'a.md', sourceLine: 3, sourceCol: 10 }),
        ref({ source: 'a.md', sourceLine: 3, sourceCol: 0 }),
      ],
      codeReferences: [],
      wikiReferences: [],
    };
    const out = normalize(input);
    assert.deepStrictEqual(
      out.references.map(r => [r.source, r.sourceLine, r.sourceCol]),
      [
        ['a.md', 3, 0],
        ['a.md', 3, 10],
        ['a.md', 5, 0],
        ['b.md', 0, 0],
      ],
    );
  });

  test('normalize dedupes annotations by (pdf, anchor)', () => {
    const out = normalize({
      version: 4,
      annotations: [
        ann({ anchor: 'X', snippet: 'first' }),
        ann({ anchor: 'X', snippet: 'second' }),
      ],
      references: [],
      codeReferences: [],
      wikiReferences: [],
    });
    assert.strictEqual(out.annotations.length, 1);
    assert.strictEqual(out.annotations[0].snippet, 'second');
  });

  test('normalize drops malformed entries', () => {
    const out = normalize({
      version: 4,
      annotations: [ann(), { page: 'nope' } as any, { pdf: 5, anchor: 'x' } as any],
      references: [ref(), { } as any],
      codeReferences: [],
      wikiReferences: [],
    });
    assert.strictEqual(out.annotations.length, 1);
    assert.strictEqual(out.references.length, 1);
  });

  test('load + save roundtrip preserves structure', async () => {
    await withTempDir(async (dir) => {
      const input: IndexFile = {
        version: 4,
        annotations: [ann({ anchor: 'b' }), ann({ anchor: 'a' })],
        references: [ref({ sourceLine: 3 }), ref({ sourceLine: 0 })],
        codeReferences: [],
        wikiReferences: [],
      };
      await saveIndex(dir, input);
      const out = await loadIndex(dir);
      // Both arrays sorted deterministically
      assert.deepStrictEqual(out.annotations.map(a => a.anchor), ['a', 'b']);
      assert.deepStrictEqual(out.references.map(r => r.sourceLine), [0, 3]);
    });
  });

  test('load returns empty for missing file', async () => {
    await withTempDir(async (dir) => {
      const out = await loadIndex(dir);
      assert.deepStrictEqual(out, emptyIndex());
    });
  });

  test('load on corrupt JSON backs up and returns empty', async () => {
    await withTempDir(async (dir) => {
      const file = indexFilePath(dir);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '{not json}', 'utf8');
      const out = await loadIndex(dir);
      assert.deepStrictEqual(out, emptyIndex());
      // Backup exists
      await assert.doesNotReject(fs.access(file + '.bak'));
    });
  });

  test('save is atomic: no tmp files left behind', async () => {
    await withTempDir(async (dir) => {
      await saveIndex(dir, emptyIndex());
      const ls = await fs.readdir(path.join(dir, '.paperlink'));
      assert.deepStrictEqual(ls.filter(n => n.startsWith('index.json.tmp')), []);
      assert.ok(ls.includes('index.json'));
    });
  });

  test('save uses LF-ending pretty-printed JSON', async () => {
    await withTempDir(async (dir) => {
      await saveIndex(dir, { version: 4, annotations: [ann()], references: [], codeReferences: [], wikiReferences: [] });
      const raw = await fs.readFile(indexFilePath(dir), 'utf8');
      assert.ok(raw.endsWith('\n'), 'must end with newline');
      assert.ok(raw.includes('\n  '), 'must be pretty-printed (2-space indent)');
    });
  });
});
