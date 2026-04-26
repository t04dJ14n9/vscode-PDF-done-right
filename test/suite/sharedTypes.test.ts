import * as assert from 'assert';
import {
  PdfAnchor,
  anchorToString,
  formatPdfLink,
  formatPdfQuote,
  rewriteLegacyPdfLinks,
  stringToAnchor,
} from '../../src/shared/types';

suite('shared/types', () => {
  test('anchorToString and stringToAnchor preserve Obsidian-style selection anchors', () => {
    const anchor: PdfAnchor = {
      page: 3,
      textItemIndex: 10,
      charOffset: 2,
      endTextItemIndex: 12,
      endCharOffset: 7,
      length: 0,
      snippet: 'attention is all you need',
      extraParams: { color: 'yellow' },
    };

    const raw = anchorToString(anchor);
    assert.strictEqual(raw, 'page=3&selection=10,2,12,7&color=yellow');

    const parsed = stringToAnchor(raw);
    assert.ok(parsed);
    assert.strictEqual(parsed?.page, 3);
    assert.strictEqual(parsed?.textItemIndex, 10);
    assert.strictEqual(parsed?.charOffset, 2);
    assert.strictEqual(parsed?.endTextItemIndex, 12);
    assert.strictEqual(parsed?.endCharOffset, 7);
    assert.strictEqual(parsed?.extraParams?.color, 'yellow');
  });

  test('formatPdfLink emits Obsidian-compatible wiki link syntax', () => {
    const link = formatPdfLink('papers/attention.pdf', {
      page: 5,
      textItemIndex: 12,
      charOffset: 5,
      endTextItemIndex: 12,
      endCharOffset: 45,
      length: 40,
      snippet: 'self-attention',
    });

    assert.strictEqual(
      link,
      '[[papers/attention.pdf#page=5&selection=12,5,12,45|self-attention]]',
    );
  });

  test('formatPdfQuote renders an Obsidian-style quote block plus link', () => {
    const quote = formatPdfQuote('papers/attention.pdf', {
      page: 2,
      textItemIndex: 1,
      charOffset: 0,
      endTextItemIndex: 1,
      endCharOffset: 14,
      length: 14,
      snippet: 'Attention works',
    });

    assert.strictEqual(
      quote,
      [
        '> Attention works',
        '>',
        '> [[papers/attention.pdf#page=2&selection=1,0,1,14|Attention works]]',
      ].join('\n'),
    );
  });

  test('rewriteLegacyPdfLinks migrates legacy @pdf syntax to Obsidian syntax', () => {
    const result = rewriteLegacyPdfLinks(
      [
        'before',
        '@pdf[[papers/attention.pdf#page=5&idx=12&off=5&len=40|"self-attention"]]',
        'after',
      ].join('\n'),
    );

    assert.strictEqual(result.rewrites, 1);
    assert.strictEqual(
      result.text,
      [
        'before',
        '[[papers/attention.pdf#page=5&selection=12,5,12,45|self-attention]]',
        'after',
      ].join('\n'),
    );
  });
});
