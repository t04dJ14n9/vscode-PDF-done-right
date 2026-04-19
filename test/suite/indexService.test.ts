import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IndexService, parseMarkdownReferences } from '../../src/index/indexService';
import { indexFilePath } from '../../src/index/indexFile';
import { AnnotationEntry } from '../../src/shared/types';

async function withTempRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperlink-svc-'));
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
    snippet: 'x',
    color: 'rgba(255,230,0,0.35)',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

suite('IndexService', () => {
  test('init creates empty index for virgin repo', async () => {
    await withTempRepo(async (dir) => {
      const svc = new IndexService();
      await svc.init(dir);
      assert.strictEqual(svc.snapshot().annotations.length, 0);
      assert.strictEqual(svc.snapshot().references.length, 0);
      await svc.dispose();
    });
  });

  test('upsertAnnotation adds then updates in place', async () => {
    await withTempRepo(async (dir) => {
      const svc = new IndexService();
      await svc.init(dir);
      svc.upsertAnnotation(ann({ snippet: 'first' }));
      svc.upsertAnnotation(ann({ snippet: 'second' }));
      await svc.flushNow();

      assert.strictEqual(svc.snapshot().annotations.length, 1);
      assert.strictEqual(svc.snapshot().annotations[0].snippet, 'second');

      const raw = JSON.parse(await fs.readFile(indexFilePath(dir), 'utf8'));
      assert.strictEqual(raw.annotations.length, 1);
      assert.strictEqual(raw.annotations[0].snippet, 'second');
      await svc.dispose();
    });
  });

  test('removeAnnotation drops matching entry', async () => {
    await withTempRepo(async (dir) => {
      const svc = new IndexService();
      await svc.init(dir);
      svc.upsertAnnotation(ann({ anchor: 'a1' }));
      svc.upsertAnnotation(ann({ anchor: 'a2' }));
      svc.removeAnnotation('a.pdf', 'a1');
      await svc.flushNow();
      assert.deepStrictEqual(
        svc.snapshot().annotations.map(a => a.anchor),
        ['a2'],
      );
      await svc.dispose();
    });
  });

  test('replaceReferencesForFile replaces only that file', async () => {
    await withTempRepo(async (dir) => {
      const svc = new IndexService();
      await svc.init(dir);
      svc.replaceReferencesForFile('notes.md', [
        { source: 'notes.md', sourceLine: 0, sourceCol: 0, sourceLength: 10, pdf: 'a.pdf', page: 1, anchor: 'A', snippet: 'a' },
        { source: 'notes.md', sourceLine: 2, sourceCol: 0, sourceLength: 10, pdf: 'a.pdf', page: 2, anchor: 'B', snippet: 'b' },
      ]);
      svc.replaceReferencesForFile('other.md', [
        { source: 'other.md', sourceLine: 5, sourceCol: 0, sourceLength: 10, pdf: 'b.pdf', page: 1, anchor: 'C', snippet: 'c' },
      ]);
      assert.strictEqual(svc.snapshot().references.length, 3);

      // Re-replace notes.md with one entry — other.md untouched
      svc.replaceReferencesForFile('notes.md', [
        { source: 'notes.md', sourceLine: 0, sourceCol: 0, sourceLength: 10, pdf: 'a.pdf', page: 1, anchor: 'A', snippet: 'a' },
      ]);
      assert.strictEqual(svc.snapshot().references.length, 2);
      await svc.dispose();
    });
  });

  test('getReferencesForAnchor and getBacklinks', async () => {
    await withTempRepo(async (dir) => {
      const svc = new IndexService();
      await svc.init(dir);
      svc.replaceReferencesForFile('notes.md', [
        { source: 'notes.md', sourceLine: 0, sourceCol: 0, sourceLength: 10, pdf: 'a.pdf', page: 1, anchor: 'A', snippet: 'n1' },
        { source: 'notes.md', sourceLine: 2, sourceCol: 0, sourceLength: 10, pdf: 'a.pdf', page: 2, anchor: 'B', snippet: 'n2' },
      ]);
      svc.replaceReferencesForFile('other.md', [
        { source: 'other.md', sourceLine: 0, sourceCol: 0, sourceLength: 10, pdf: 'a.pdf', page: 1, anchor: 'A', snippet: 'o1' },
      ]);
      const forA = svc.getReferencesForAnchor('a.pdf', 'A');
      assert.strictEqual(forA.length, 2);
      assert.deepStrictEqual(forA.map(r => r.source).sort(), ['notes.md', 'other.md']);

      const backlinks = svc.getBacklinks('a.pdf');
      assert.strictEqual(backlinks.length, 3);

      const outgoing = svc.getOutgoing('notes.md');
      assert.strictEqual(outgoing.length, 2);
      await svc.dispose();
    });
  });

  test('renamePdfInIndex updates annotations and references', async () => {
    await withTempRepo(async (dir) => {
      const svc = new IndexService();
      await svc.init(dir);
      svc.upsertAnnotation(ann({ pdf: 'old.pdf', anchor: 'A' }));
      svc.replaceReferencesForFile('notes.md', [
        { source: 'notes.md', sourceLine: 0, sourceCol: 0, sourceLength: 10, pdf: 'old.pdf', page: 1, anchor: 'A', snippet: 'x' },
      ]);
      const changed = svc.renamePdfInIndex('old.pdf', 'new.pdf');
      assert.strictEqual(changed, true);
      assert.strictEqual(svc.snapshot().annotations[0].pdf, 'new.pdf');
      assert.strictEqual(svc.snapshot().references[0].pdf, 'new.pdf');
      // Backlinks keyed by new path
      assert.strictEqual(svc.getBacklinks('new.pdf').length, 1);
      assert.strictEqual(svc.getBacklinks('old.pdf').length, 0);
      await svc.dispose();
    });
  });

  test('renameMarkdownInIndex updates source fields', async () => {
    await withTempRepo(async (dir) => {
      const svc = new IndexService();
      await svc.init(dir);
      svc.replaceReferencesForFile('old.md', [
        { source: 'old.md', sourceLine: 0, sourceCol: 0, sourceLength: 10, pdf: 'a.pdf', page: 1, anchor: 'A', snippet: 'x' },
      ]);
      const changed = svc.renameMarkdownInIndex('old.md', 'new.md');
      assert.strictEqual(changed, true);
      assert.strictEqual(svc.snapshot().references[0].source, 'new.md');
      assert.strictEqual(svc.getOutgoing('new.md').length, 1);
      assert.strictEqual(svc.getOutgoing('old.md').length, 0);
      await svc.dispose();
    });
  });

  test('rename with identical old==new is a no-op', async () => {
    await withTempRepo(async (dir) => {
      const svc = new IndexService();
      await svc.init(dir);
      svc.upsertAnnotation(ann({ pdf: 'x.pdf' }));
      assert.strictEqual(svc.renamePdfInIndex('x.pdf', 'x.pdf'), false);
      assert.strictEqual(svc.renameMarkdownInIndex('x.md', 'x.md'), false);
      await svc.dispose();
    });
  });

  test('onDidChange fires with changedFiles', async () => {
    await withTempRepo(async (dir) => {
      const svc = new IndexService();
      await svc.init(dir);
      const events: string[][] = [];
      const sub = svc.onDidChange(e => events.push(e.changedFiles));
      svc.upsertAnnotation(ann({ pdf: 'zoo.pdf' }));
      svc.replaceReferencesForFile('notes.md', [
        { source: 'notes.md', sourceLine: 0, sourceCol: 0, sourceLength: 10, pdf: 'zoo.pdf', page: 1, anchor: 'A', snippet: 'x' },
      ]);
      sub.dispose();
      assert.ok(events.length >= 2);
      assert.ok(events[0].includes('zoo.pdf'));
      await svc.dispose();
    });
  });

  test('migration from legacy sidecars imports annotations then deletes sidecars', async () => {
    await withTempRepo(async (dir) => {
      // Create a fake PDF + its sidecar
      const pdfPath = path.join(dir, 'papers', 'attention.pdf');
      await fs.mkdir(path.dirname(pdfPath), { recursive: true });
      await fs.writeFile(pdfPath, '%PDF-1.4 fake', 'utf8');
      const sidecar = pdfPath + '.paperlink.json';
      await fs.writeFile(
        sidecar,
        JSON.stringify({
          version: 1,
          pdfFile: 'attention.pdf',
          annotations: [
            {
              id: '1',
              anchor: { page: 5, textItemIndex: 12, charOffset: 5, length: 40, snippet: 'self-attention' },
              markdownFile: 'notes.md',
              color: 'rgba(255,230,0,0.35)',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
        'utf8',
      );

      const svc = new IndexService();
      await svc.init(dir);

      const anns = svc.snapshot().annotations;
      assert.strictEqual(anns.length, 1);
      assert.strictEqual(anns[0].pdf, 'papers/attention.pdf');
      assert.strictEqual(anns[0].anchor, 'page=5&idx=12&off=5&len=40');

      // Sidecar was deleted
      await assert.rejects(fs.access(sidecar));

      // index.json was written
      await assert.doesNotReject(fs.access(indexFilePath(dir)));
      await svc.dispose();
    });
  });
});

suite('parseMarkdownReferences', () => {
  test('returns empty array when no links', () => {
    assert.deepStrictEqual(parseMarkdownReferences('notes.md', 'hello world'), []);
  });

  test('extracts line / col for each match', () => {
    const text = [
      '# notes',
      '',
      'see @pdf[[a.pdf#page=1&idx=0&off=0&len=5|"hi"]] here',
      'and @pdf[[b.pdf#page=2&idx=1&off=0&len=3]] too',
    ].join('\n');
    const refs = parseMarkdownReferences('notes.md', text);
    assert.strictEqual(refs.length, 2);

    assert.strictEqual(refs[0].pdf, 'a.pdf');
    assert.strictEqual(refs[0].sourceLine, 2);
    assert.strictEqual(refs[0].sourceCol, 4); // "see "
    assert.strictEqual(refs[0].snippet, 'hi');

    assert.strictEqual(refs[1].pdf, 'b.pdf');
    assert.strictEqual(refs[1].sourceLine, 3);
    assert.strictEqual(refs[1].sourceCol, 4); // "and "
    assert.strictEqual(refs[1].snippet, '');
  });

  test('sourceLength matches the exact token length', () => {
    const token = '@pdf[[a.pdf#page=1&idx=0&off=0&len=5|"xx"]]';
    const refs = parseMarkdownReferences('n.md', `X ${token} Y`);
    assert.strictEqual(refs[0].sourceLength, token.length);
  });

  test('skips malformed anchor', () => {
    const text = '@pdf[[a.pdf#bogus|"x"]]';
    assert.deepStrictEqual(parseMarkdownReferences('n.md', text), []);
  });
});
