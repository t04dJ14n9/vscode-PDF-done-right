/**
 * Pure-logic E2E test for PaperLink bidirectional links.
 * Run: node test/pure-e2e.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ─── Inline regex & parsers (matching src/shared/types.ts & src/index/indexService.ts) ──
const WIKI_LINK_REGEX = /\[\[([^\]#|]+)(?:#([^\]|]+))?\]\]/g;
const PDF_LINK_REGEX = /@pdf\[\[([^\]]+?)#([^\]]+?)\|"(.*?)"\]\]/g;

function offsetToLineCol(offset, lineOffsets) {
  let lo = 0, hi = lineOffsets.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; lineOffsets[mid] <= offset ? lo = mid : hi = mid - 1; }
  return { line: lo, col: offset - lineOffsets[lo] };
}

function buildLineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) { if (text.charCodeAt(i) === 10) offsets.push(i + 1); }
  return offsets;
}

function parseWikiReferences(sourceRel, text) {
  const refs = [];
  const lineOffsets = buildLineOffsets(text);
  const regex = new RegExp(WIKI_LINK_REGEX.source, WIKI_LINK_REGEX.flags);
  let match;
  while ((match = regex.exec(text)) !== null) {
    const noteName = (match[1] ?? '').trim();
    const section = match[2]?.trim() ?? '';
    if (!noteName) continue;
    if (match.index >= 5) {
      const prefix = text.slice(Math.max(0, match.index - 6), match.index);
      if (/@pdf\[?$/.test(prefix) || /@code\[?$/.test(prefix)) continue;
    }
    const { line, col } = offsetToLineCol(match.index, lineOffsets);
    refs.push({ source: sourceRel, sourceLine: line, sourceCol: col, sourceLength: match[0].length, targetNote: noteName, targetSection: section });
  }
  return refs;
}

function parsePdfReferences(sourceRel, text) {
  const refs = [];
  const lineOffsets = buildLineOffsets(text);
  const regex = new RegExp(PDF_LINK_REGEX.source, PDF_LINK_REGEX.flags);
  let match;
  while ((match = regex.exec(text)) !== null) {
    const { line, col } = offsetToLineCol(match.index, lineOffsets);
    refs.push({ source: sourceRel, sourceLine: line, sourceCol: col, sourceLength: match[0].length, pdf: match[1], anchor: match[2], snippet: match[3] });
  }
  return refs;
}

// ─── Test harness ────────────────────────────────────────────────
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.error(`  ❌ ${msg}`); }
}
function section(t) { console.log(`\n━━━ ${t} ━━━`); }

// ═══════════════════════════════════════════════════════════════════

section('1. WIKI_LINK_REGEX - basic matches');
{
  const text = 'see [[my-note]] and [[intro#Summary]] and [[another]]';
  const m = [...text.matchAll(new RegExp(WIKI_LINK_REGEX.source, WIKI_LINK_REGEX.flags))];
  assert(m.length === 3, 'Finds 3 wiki links');
  assert(m[0][1] === 'my-note', 'First = my-note');
  assert(m[1][1] === 'intro' && m[1][2] === 'Summary', 'Second = intro#Summary');
  assert(m[2][1] === 'another', 'Third = another');
}

section('2. parseWikiReferences - skips @pdf/@code');
{
  const text = '@pdf[[sample.pdf#page=1|"hi"]] and @code[[src.go#L10]] and [[real-wiki]]';
  const refs = parseWikiReferences('notes.md', text);
  assert(refs.length === 1, 'Only 1 wiki ref (skips @pdf and @code)');
  assert(refs[0].targetNote === 'real-wiki', 'Wiki ref = real-wiki');
}

section('3. parseWikiReferences - section support');
{
  const refs = parseWikiReferences('x.md', 'link to [[intro#Summary]] here');
  assert(refs.length === 1, '1 wiki ref');
  assert(refs[0].targetNote === 'intro', 'targetNote = intro');
  assert(refs[0].targetSection === 'Summary', 'targetSection = Summary');
}

section('4. parseWikiReferences - line/col');
{
  const text = ['# Title', '', 'see [[target]] here'].join('\n');
  const refs = parseWikiReferences('notes.md', text);
  assert(refs.length === 1, '1 wiki ref');
  assert(refs[0].sourceLine === 2, 'sourceLine = 2');
  assert(refs[0].sourceCol === 4, 'sourceCol = 4');
  assert(refs[0].sourceLength === '[[target]]'.length, 'sourceLength = 10');
}

section('5. parsePdfReferences - basic');
{
  const text = '@pdf[[sample.pdf#page=1&idx=0&off=0&len=25|"Attention"]] and more';
  const refs = parsePdfReferences('notes.md', text);
  assert(refs.length === 1, '1 @pdf reference');
  assert(refs[0].pdf === 'sample.pdf', 'Target PDF = sample.pdf');
  assert(refs[0].snippet === 'Attention', 'Snippet = Attention');
}

section('6. Real test-workspace/notes.md');
{
  const notesText = readFileSync(join(projectRoot, 'test-workspace', 'notes.md'), 'utf8');
  const wikiRefs = parseWikiReferences('notes.md', notesText);
  const pdfRefs = parsePdfReferences('notes.md', notesText);
  console.log(`  📝 notes.md: ${wikiRefs.length} wiki refs, ${pdfRefs.length} pdf refs`);
  assert(wikiRefs.length === 3, 'notes.md has 3 wiki refs');
  assert(pdfRefs.length >= 3, `notes.md has ${pdfRefs.length} pdf refs (≥3)`);
  const targets = wikiRefs.map(r => r.targetNote);
  assert(targets.includes('transformers'), '→ [[transformers]]');
  assert(targets.includes('attention'), '→ [[attention#Multi-Head]]');
  assert(targets.includes('notes'), '→ [[notes]]');
}

section('7. Real test-workspace/transformers.md');
{
  const text = readFileSync(join(projectRoot, 'test-workspace', 'transformers.md'), 'utf8');
  const refs = parseWikiReferences('transformers.md', text);
  assert(refs.length === 1, 'transformers.md has 1 wiki ref');
  assert(refs[0].targetNote === 'notes', '→ [[notes]]');
}

section('8. Bidirectional link verification');
{
  const allRefs = [
    ...parseWikiReferences('notes.md', readFileSync(join(projectRoot, 'test-workspace', 'notes.md'), 'utf8')),
    ...parseWikiReferences('transformers.md', readFileSync(join(projectRoot, 'test-workspace', 'transformers.md'), 'utf8')),
  ];
  const backlinks = new Map();
  for (const r of allRefs) {
    if (!backlinks.has(r.targetNote)) backlinks.set(r.targetNote, []);
    backlinks.get(r.targetNote).push(r);
  }
  const tBL = backlinks.get('transformers') ?? [];
  assert(tBL.length === 1 && tBL[0].source === 'notes.md', 'transformers: 1 backlink from notes.md');
  const nBL = backlinks.get('notes') ?? [];
  assert(nBL.length === 2, `notes: ${nBL.length} backlinks (expected 2: self-ref + transformers.md)`);
  assert(nBL.some(r => r.source === 'transformers.md'), 'notes: backlink from transformers.md');
  assert(nBL.some(r => r.source === 'notes.md'), 'notes: self-referencing backlink from notes.md');
  const aBL = backlinks.get('attention') ?? [];
  assert(aBL.length === 1 && aBL[0].targetSection === 'Multi-Head', 'attention: 1 backlink targeting #Multi-Head');
}

section('9. pickSafeInsertPosition regex - nested brackets');
{
  const re = /@pdf\[\[(?:[^\]]|\](?!\]))*\]\]/g;
  assert([...'@pdf[[sample.pdf#page=1&idx=0&off=0&len=25|"Attention"]]'.matchAll(re)].length === 1, 'Basic @pdf matches');
  assert([...'text @pdf[[paper.pdf#page=2|"snippet"]] more'.matchAll(re)].length === 1, 'Snippets match');
}

section('10. No [!PDF] callout remnants in source');
{
  let found = false;
  try {
    const out = execSync(`grep -rl '\\[!PDF\\]\\|pdfReference' ${join(projectRoot, 'src')} ${join(projectRoot, 'webview-src')} --include='*.ts' 2>/dev/null || true`, { encoding: 'utf8' });
    if (out.trim()) { console.error(`  ⚠️ Found in: ${out.trim()}`); found = true; }
  } catch {}
  assert(!found, 'No [!PDF]/pdfReference in src/ or webview-src/');
}

section('11. IndexFile v4 schema in compiled output');
{
  const src = readFileSync(join(projectRoot, 'out', 'src', 'index', 'indexFile.js'), 'utf8');
  assert(src.includes('version: 4'), 'version: 4 in indexFile.js');
  assert(src.includes('wikiReferences'), 'wikiReferences in indexFile.js');
}

section('12. Self-reference: [[notes]] in notes.md');
{
  const refs = parseWikiReferences('notes.md', readFileSync(join(projectRoot, 'test-workspace', 'notes.md'), 'utf8'));
  const selfRefs = refs.filter(r => r.targetNote === 'notes');
  assert(selfRefs.length === 1, 'notes.md has 1 self-referencing [[notes]]');
}

// ─── Summary ─────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
console.log(`${'═'.repeat(50)}`);
process.exit(fail > 0 ? 1 : 0);
