import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  AnnotationEntry,
  IndexFile,
  LegacyAnnotationStore,
  PdfAnchor,
  PDF_LINK_REGEX,
  ReferenceEntry,
  anchorToString,
  stringToAnchor,
} from '../shared/types';
import {
  INDEX_DIR,
  emptyIndex,
  indexFilePath,
  loadIndex,
  saveIndex,
  toPosix,
  toPosixRelative,
} from './indexFile';
import { log } from '../util/logger';

/**
 * In-memory source of truth for PaperLink.
 * Persists to `<gitRoot>/.paperlink/index.json` (debounced).
 *
 * Two maps are derived for O(1) lookup:
 *   byTargetAnchor  — `pdf|anchor` → references pointing at this passage
 *   bySource        — `.md` path → references originating from this file
 *   byTargetPdf     — PDF path → all references targeting any passage in this PDF
 */

export interface IndexChangeEvent {
  /** POSIX-relative paths whose backlinks/outgoing set may have changed. */
  changedFiles: string[];
}

const DEBOUNCE_MS = 200;

export class IndexService {
  private index: IndexFile = emptyIndex();
  private gitRoot: string | undefined;

  private byTargetAnchor = new Map<string, ReferenceEntry[]>();
  private bySource = new Map<string, ReferenceEntry[]>();
  private byTargetPdf = new Map<string, ReferenceEntry[]>();
  private annotationByKey = new Map<string, AnnotationEntry>();

  private readonly _onDidChange = new vscode.EventEmitter<IndexChangeEvent>();
  readonly onDidChange = this._onDidChange.event;

  private pendingFlushTimer: NodeJS.Timeout | undefined;
  private pendingFlushPromise: Promise<void> | undefined;
  private pendingFlushResolve: (() => void) | undefined;

  /**
   * Initialize: load index.json from gitRoot and run one-shot migration if the
   * file doesn't exist but legacy sidecars do.
   */
  async init(gitRoot: string): Promise<void> {
    this.gitRoot = gitRoot;
    const filePath = indexFilePath(gitRoot);

    let existed = true;
    try {
      await fs.access(filePath);
    } catch {
      existed = false;
    }

    this.index = await loadIndex(gitRoot);
    this.rebuildIndexes();

    if (!existed) {
      const migrated = await this.migrateLegacySidecars();
      if (migrated.count > 0) {
        log.info(`Migrated ${migrated.count} legacy sidecar annotations`);
        await this.flushNow();
      }
    }

    log.info(
      `IndexService ready: ${this.index.annotations.length} annotations, ${this.index.references.length} references (${path.relative(gitRoot, filePath)})`,
    );
  }

  /** Resolve a POSIX-relative path to a fsPath under gitRoot. */
  absolutePath(relPosix: string): string {
    if (!this.gitRoot) throw new Error('IndexService not initialized');
    return path.join(this.gitRoot, relPosix);
  }

  /** Compute a POSIX-relative path from gitRoot. */
  relativePath(absPath: string): string {
    if (!this.gitRoot) throw new Error('IndexService not initialized');
    return toPosixRelative(this.gitRoot, absPath);
  }

  /** Raw immutable view. Callers must not mutate the returned arrays. */
  snapshot(): IndexFile {
    return this.index;
  }

  // ─── Annotation CRUD ──────────────────────────────────────────────────────

  upsertAnnotation(a: AnnotationEntry): void {
    const norm = { ...a, pdf: toPosix(a.pdf) };
    const key = annotationKey(norm);
    const idx = this.index.annotations.findIndex(x => annotationKey(x) === key);
    if (idx >= 0) {
      this.index.annotations[idx] = norm;
    } else {
      this.index.annotations.push(norm);
    }
    this.annotationByKey.set(key, norm);
    this.scheduleFlush();
    this._onDidChange.fire({ changedFiles: [norm.pdf] });
  }

  removeAnnotation(pdf: string, anchor: string): void {
    const key = `${toPosix(pdf)}|${anchor}`;
    const before = this.index.annotations.length;
    this.index.annotations = this.index.annotations.filter(a => annotationKey(a) !== key);
    if (this.index.annotations.length === before) return;
    this.annotationByKey.delete(key);
    this.scheduleFlush();
    this._onDidChange.fire({ changedFiles: [toPosix(pdf)] });
  }

  getAnnotationsForPdf(pdf: string): AnnotationEntry[] {
    const p = toPosix(pdf);
    return this.index.annotations.filter(a => a.pdf === p);
  }

  // ─── Reference CRUD ───────────────────────────────────────────────────────

  /** Replace the set of references whose source === `source`. */
  replaceReferencesForFile(source: string, refs: ReferenceEntry[]): boolean {
    const src = toPosix(source);
    const kept: ReferenceEntry[] = [];
    let removed = 0;
    for (const r of this.index.references) {
      if (r.source === src) removed++;
      else kept.push(r);
    }
    const normRefs = refs.map(r => ({ ...r, source: src, pdf: toPosix(r.pdf) }));
    const changed = removed > 0 || normRefs.length > 0;
    this.index.references = [...kept, ...normRefs];
    this.rebuildIndexes();
    if (changed) {
      this.scheduleFlush();
      const touchedPdfs = new Set<string>();
      for (const r of normRefs) touchedPdfs.add(r.pdf);
      this._onDidChange.fire({
        changedFiles: [src, ...touchedPdfs],
      });
    }
    return changed;
  }

  /** All references to this specific (pdf, anchor) passage. */
  getReferencesForAnchor(pdf: string, anchor: string): ReferenceEntry[] {
    const target = toPosix(pdf);
    return this.index.references.filter(
      r => r.anchor === anchor && refMatchesTarget(r, target),
    );
  }

  /** All references to any passage in this PDF. */
  getReferencesForPdf(pdf: string): ReferenceEntry[] {
    const target = toPosix(pdf);
    return this.index.references.filter(r => refMatchesTarget(r, target));
  }

  /**
   * Backlinks for the given file (PDF or .md):
   *   • For a PDF target: every .md reference pointing at any passage in it.
   *   • For a .md target: every other .md that references this .md — currently
   *     empty because `@pdf[[…]]` only targets PDFs. Kept for symmetry + future
   *     wiki-link support.
   */
  getBacklinks(fileRel: string): ReferenceEntry[] {
    const p = toPosix(fileRel);
    if (p.toLowerCase().endsWith('.pdf')) {
      return this.index.references.filter(r => refMatchesTarget(r, p));
    }
    return [];
  }

  /** Outgoing references *from* this file. */
  getOutgoing(fileRel: string): ReferenceEntry[] {
    const p = toPosix(fileRel);
    if (p.toLowerCase().endsWith('.md')) {
      return this.bySource.get(p) ?? [];
    }
    return [];
  }

  // ─── Rename handling (no text rewriting — caller does WorkspaceEdit) ─────

  /**
   * Update all `pdf` fields where the value matches `oldRel` → `newRel`.
   * Does NOT modify .md text; the caller (FileRenameWatcher) is responsible
   * for applying a WorkspaceEdit first.
   */
  renamePdfInIndex(oldRel: string, newRel: string): boolean {
    const oldP = toPosix(oldRel);
    const newP = toPosix(newRel);
    if (oldP === newP) return false;
    let changed = false;
    const touched = new Set<string>();

    for (const a of this.index.annotations) {
      if (a.pdf === oldP) {
        a.pdf = newP;
        changed = true;
      }
    }
    for (const r of this.index.references) {
      if (r.pdf === oldP) {
        r.pdf = newP;
        changed = true;
        touched.add(r.source);
      }
    }
    if (changed) {
      this.rebuildIndexes();
      this.scheduleFlush();
      this._onDidChange.fire({ changedFiles: [oldP, newP, ...touched] });
    }
    return changed;
  }

  /** Rewrite `source` field on references from `oldRel` → `newRel`. */
  renameMarkdownInIndex(oldRel: string, newRel: string): boolean {
    const oldP = toPosix(oldRel);
    const newP = toPosix(newRel);
    if (oldP === newP) return false;
    let changed = false;
    for (const r of this.index.references) {
      if (r.source === oldP) {
        r.source = newP;
        changed = true;
      }
    }
    if (changed) {
      this.rebuildIndexes();
      this.scheduleFlush();
      this._onDidChange.fire({ changedFiles: [oldP, newP] });
    }
    return changed;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /** Schedule a debounced save. Multiple rapid mutations coalesce. */
  private scheduleFlush(): void {
    if (!this.gitRoot) return;
    if (!this.pendingFlushPromise) {
      this.pendingFlushPromise = new Promise<void>(resolve => {
        this.pendingFlushResolve = resolve;
      });
    }
    if (this.pendingFlushTimer) clearTimeout(this.pendingFlushTimer);
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = undefined;
      void this.flushNow();
    }, DEBOUNCE_MS);
  }

  /** Force an immediate write, bypassing the debounce. Awaitable. */
  async flushNow(): Promise<void> {
    if (!this.gitRoot) return;
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = undefined;
    }
    try {
      await saveIndex(this.gitRoot, this.index);
    } catch (e) {
      log.error('Failed to persist index.json', e);
    }
    const resolve = this.pendingFlushResolve;
    this.pendingFlushPromise = undefined;
    this.pendingFlushResolve = undefined;
    resolve?.();
  }

  async dispose(): Promise<void> {
    await this.flushNow();
    this._onDidChange.dispose();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private rebuildIndexes(): void {
    this.byTargetAnchor.clear();
    this.bySource.clear();
    this.byTargetPdf.clear();
    this.annotationByKey.clear();

    for (const r of this.index.references) {
      const kAnchor = `${r.pdf}|${r.anchor}`;
      pushToMap(this.byTargetAnchor, kAnchor, r);
      pushToMap(this.bySource, r.source, r);
      pushToMap(this.byTargetPdf, r.pdf, r);
    }
    for (const a of this.index.annotations) {
      this.annotationByKey.set(annotationKey(a), a);
    }
  }

  /**
   * One-shot migration: read every `*.paperlink.json` sidecar under gitRoot,
   * import its annotations + references scanned from `*.md`, and delete the
   * sidecars on success.
   */
  private async migrateLegacySidecars(): Promise<{ count: number }> {
    if (!this.gitRoot) return { count: 0 };
    const gitRoot = this.gitRoot;

    // Discover sidecars and markdown without relying on VS Code workspace API,
    // so this also works during headless init (e.g. tests).
    const sidecars = await findFiles(gitRoot, /\.paperlink\.json$/, [INDEX_DIR, 'node_modules', '.git']);

    let count = 0;
    for (const sc of sidecars) {
      try {
        const raw = await fs.readFile(sc, 'utf8');
        const store = JSON.parse(raw) as LegacyAnnotationStore;
        const pdfAbs = sc.replace(/\.paperlink\.json$/, '');
        const pdfRel = toPosixRelative(gitRoot, pdfAbs);
        for (const a of store.annotations ?? []) {
          const anchorStr = typeof a.anchor === 'object' ? anchorToString(a.anchor) : '';
          if (!anchorStr) continue;
          this.upsertAnnotationQuiet({
            pdf: pdfRel,
            page: a.anchor.page,
            anchor: anchorStr,
            snippet: a.anchor.snippet || '',
            color: a.color || 'rgba(255,230,0,0.35)',
            createdAt: a.createdAt || new Date().toISOString(),
          });
          count++;
        }
        await fs.unlink(sc).catch(() => {/* best effort */});
      } catch (e) {
        log.warn(`Skipping unreadable sidecar: ${sc}`, e);
      }
    }

    this.rebuildIndexes();
    return { count };
  }

  /** Internal: mutate without scheduling a flush or firing an event. */
  private upsertAnnotationQuiet(a: AnnotationEntry): void {
    const norm = { ...a, pdf: toPosix(a.pdf) };
    const key = annotationKey(norm);
    const idx = this.index.annotations.findIndex(x => annotationKey(x) === key);
    if (idx >= 0) this.index.annotations[idx] = norm;
    else this.index.annotations.push(norm);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function annotationKey(a: AnnotationEntry): string {
  return `${a.pdf}|${a.anchor}`;
}

function pushToMap<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/**
 * A reference matches a target PDF path if the reference's `pdf` field
 * resolves to `target` when treated as either:
 *   • gitRoot-relative (as authored), or
 *   • relative to the markdown file's directory.
 * Both interpretations are accepted so users can write short paths like
 * `sample.pdf` next to their note, OR full gitRoot-relative paths.
 */
function refMatchesTarget(r: ReferenceEntry, target: string): boolean {
  if (r.pdf === target) return true;
  const dir = dirnamePosix(r.source);
  if (dir && joinPosix(dir, r.pdf) === target) return true;
  return false;
}

function dirnamePosix(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

function joinPosix(dir: string, rel: string): string {
  if (rel.startsWith('/')) rel = rel.slice(1);
  const combined = dir ? `${dir}/${rel}` : rel;
  const parts: string[] = [];
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Parse a markdown file's text content into reference entries.
 * Exported so both `MarkdownIndexer` (on save) and the initial full scan can
 * share the exact same parse logic.
 *
 * We store the `pdf` path exactly as authored in the markdown (normalised to
 * POSIX). The lookup side (IndexService.getReferencesFor*) performs flexible
 * matching so links written relative to the note's directory *or* relative to
 * gitRoot both resolve to the same PDF.
 */
export function parseMarkdownReferences(
  sourceRelPosix: string,
  text: string,
): ReferenceEntry[] {
  const refs: ReferenceEntry[] = [];
  const regex = new RegExp(PDF_LINK_REGEX.source, PDF_LINK_REGEX.flags);
  let match: RegExpExecArray | null;

  // Build line-offset table once.
  const lineOffsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) lineOffsets.push(i + 1);
  }

  while ((match = regex.exec(text)) !== null) {
    const full = match[0];
    const pdfRelLink = match[1];
    const anchorStr = match[2];
    const snippet = match[3] ?? '';
    const anchor = stringToAnchor(anchorStr) as PdfAnchor | null;
    if (!anchor) continue;

    // Guard: if a link got pasted inside another link the outer regex may
    // capture a nonsense path like "test-wo@pdf[[test-workspace/sample.pdf".
    // Reject any pdf path that contains `@pdf[[`, newlines, or brackets.
    if (/@pdf\[\[|[\n\r\[\]]/.test(pdfRelLink)) continue;

    const { line, col } = offsetToLineCol(match.index, lineOffsets);
    refs.push({
      source: sourceRelPosix,
      sourceLine: line,
      sourceCol: col,
      sourceLength: full.length,
      pdf: toPosix(pdfRelLink),
      page: anchor.page,
      anchor: anchorStr,
      snippet,
    });
  }
  return refs;
}

function offsetToLineCol(offset: number, lineOffsets: number[]): { line: number; col: number } {
  // Binary search for the line whose offset is <= offset.
  let lo = 0,
    hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - lineOffsets[lo] };
}

/**
 * Depth-first file walk; returns absolute paths of files matching `match`.
 * Used only during migration — live indexing uses VS Code's `findFiles`.
 */
async function findFiles(
  root: string,
  match: RegExp,
  excludeDirs: string[],
): Promise<string[]> {
  const excludeSet = new Set(excludeDirs);
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDir: boolean; isFile: boolean }>;
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      entries = dirents.map(d => ({
        name: d.name,
        isDir: d.isDirectory(),
        isFile: d.isFile(),
      }));
    } catch {
      return;
    }
    for (const e of entries) {
      if (excludeSet.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDir) await walk(full);
      else if (e.isFile && match.test(e.name)) out.push(full);
    }
  }

  await walk(root);
  return out;
}
