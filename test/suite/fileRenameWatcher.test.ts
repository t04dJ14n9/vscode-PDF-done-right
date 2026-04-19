import * as assert from 'assert';
import { planRenames } from '../../src/index/fileRenameWatcher';
import { ReferenceEntry } from '../../src/shared/types';

function ref(partial: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    source: 'notes.md',
    sourceLine: 2,
    sourceCol: 4,
    sourceLength: 45,
    pdf: 'papers/attention.pdf',
    page: 5,
    anchor: 'page=5&idx=12&off=5&len=40',
    snippet: 'self-attention',
    ...partial,
  };
}

suite('planRenames', () => {
  test('empty renames → empty plan', () => {
    const p = planRenames([], []);
    assert.deepStrictEqual(p, { textEdits: [], pdfRenames: [], mdRenames: [] });
  });

  test('identical old/new is dropped', () => {
    const p = planRenames([{ oldRel: 'a.pdf', newRel: 'a.pdf' }], []);
    assert.strictEqual(p.pdfRenames.length, 0);
    assert.strictEqual(p.textEdits.length, 0);
  });

  test('PDF rename classifies as pdfRenames', () => {
    const p = planRenames([{ oldRel: 'a.pdf', newRel: 'b.pdf' }], []);
    assert.deepStrictEqual(p.pdfRenames, [{ oldRel: 'a.pdf', newRel: 'b.pdf' }]);
    assert.strictEqual(p.mdRenames.length, 0);
  });

  test('MD rename classifies as mdRenames', () => {
    const p = planRenames([{ oldRel: 'notes.md', newRel: 'journal.md' }], []);
    assert.deepStrictEqual(p.mdRenames, [{ oldRel: 'notes.md', newRel: 'journal.md' }]);
    assert.strictEqual(p.pdfRenames.length, 0);
  });

  test('other extensions are ignored', () => {
    const p = planRenames(
      [{ oldRel: 'a.png', newRel: 'b.png' }, { oldRel: 'tmp.tmp', newRel: 'tmp2.tmp' }],
      [],
    );
    assert.deepStrictEqual(p, { textEdits: [], pdfRenames: [], mdRenames: [] });
  });

  test('PDF rename produces a text edit for each referencing .md', () => {
    const refs = [
      ref({ source: 'a.md', sourceLine: 1, sourceCol: 0 }),
      ref({ source: 'b.md', sourceLine: 7, sourceCol: 2 }),
    ];
    const p = planRenames(
      [{ oldRel: 'papers/attention.pdf', newRel: 'papers/2017-attention.pdf' }],
      refs,
    );
    assert.strictEqual(p.textEdits.length, 2);
    // Replacement should use the new PDF path
    for (const te of p.textEdits) {
      assert.ok(te.replacement.startsWith('@pdf[[papers/2017-attention.pdf#'));
      assert.ok(te.replacement.includes('"self-attention"'));
    }
    // Coordinates preserved
    assert.strictEqual(p.textEdits[0].source, 'a.md');
    assert.strictEqual(p.textEdits[0].line, 1);
    assert.strictEqual(p.textEdits[0].col, 0);
    assert.strictEqual(p.textEdits[0].oldLength, 45);
  });

  test('PDF rename with references to OTHER pdfs is ignored', () => {
    const refs = [ref({ pdf: 'unrelated.pdf' })];
    const p = planRenames(
      [{ oldRel: 'papers/attention.pdf', newRel: 'papers/new.pdf' }],
      refs,
    );
    assert.strictEqual(p.textEdits.length, 0);
    assert.strictEqual(p.pdfRenames.length, 1);
  });

  test('mixed event: PDF + one of its referencing MDs renamed at the same time', () => {
    const refs = [ref({ source: 'old.md', pdf: 'a.pdf' })];
    const p = planRenames(
      [
        { oldRel: 'a.pdf', newRel: 'b.pdf' },
        { oldRel: 'old.md', newRel: 'new.md' },
      ],
      refs,
    );
    assert.strictEqual(p.pdfRenames.length, 1);
    assert.strictEqual(p.mdRenames.length, 1);
    assert.strictEqual(p.textEdits.length, 1);
    // Edit targets the NEW .md path (VS Code remaps buffer before our edits)
    assert.strictEqual(p.textEdits[0].source, 'new.md');
    assert.ok(p.textEdits[0].replacement.startsWith('@pdf[[b.pdf#'));
  });

  test('undo semantics: reverse rename is symmetric', () => {
    const refs = [ref({ pdf: 'a.pdf' })];
    const forward = planRenames([{ oldRel: 'a.pdf', newRel: 'b.pdf' }], refs);
    // After forward, references are logically `pdf: 'b.pdf'`. Simulate by flipping.
    const flipped = refs.map(r => ({ ...r, pdf: 'b.pdf' }));
    const reverse = planRenames([{ oldRel: 'b.pdf', newRel: 'a.pdf' }], flipped);
    assert.strictEqual(reverse.textEdits.length, forward.textEdits.length);
    assert.ok(reverse.textEdits[0].replacement.startsWith('@pdf[[a.pdf#'));
  });

  test('sourceLength=0 falls back to computed token length', () => {
    const refs = [ref({ sourceLength: 0, snippet: 'x' })];
    const p = planRenames(
      [{ oldRel: 'papers/attention.pdf', newRel: 'x.pdf' }],
      refs,
    );
    assert.strictEqual(p.textEdits.length, 1);
    // Legacy sourceLength=0 — we should have computed something > 0
    assert.ok(p.textEdits[0].oldLength > 10);
  });

  test('malformed anchor drops the edit but keeps the rename classification', () => {
    const refs = [ref({ anchor: 'garbage' })];
    const p = planRenames([{ oldRel: 'papers/attention.pdf', newRel: 'x.pdf' }], refs);
    assert.strictEqual(p.textEdits.length, 0);
    assert.strictEqual(p.pdfRenames.length, 1);
  });
});
