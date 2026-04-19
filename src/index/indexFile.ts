import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AnnotationEntry, IndexFile, ReferenceEntry } from '../shared/types';

/**
 * Read / write `<gitRoot>/.paperlink/index.json`.
 *
 * Responsibilities:
 *   • Schema validation with safe defaults on corruption.
 *   • Deterministic sort before serialization so git diffs are clean.
 *   • Pretty-print (2-space indent + trailing newline) for readability.
 *   • Atomic writes via `write-temp + fs.rename`; readers never see
 *     a truncated file even if the process crashes mid-write.
 *
 * This module is deliberately dependency-free (only `node:fs`) — so it can
 * be unit-tested against a real temp directory without spinning up VS Code.
 */

export const INDEX_DIR = '.paperlink';
export const INDEX_FILENAME = 'index.json';

/** The empty index written on first initialization. */
export function emptyIndex(): IndexFile {
  return { version: 2, annotations: [], references: [] };
}

/** Read `index.json` from disk; returns an empty index if missing / corrupt. */
export async function loadIndex(gitRoot: string): Promise<IndexFile> {
  const file = path.join(gitRoot, INDEX_DIR, INDEX_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return emptyIndex();
    }
    throw e;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<IndexFile>;
    return normalize(parsed);
  } catch {
    // Backup the corrupt file then return an empty index so the extension
    // can proceed and rebuild from a full scan.
    const bak = file + '.bak';
    try {
      await fs.rename(file, bak);
    } catch {
      /* best effort */
    }
    return emptyIndex();
  }
}

/** Write `index.json` atomically to `<gitRoot>/.paperlink/index.json`. */
export async function saveIndex(gitRoot: string, index: IndexFile): Promise<void> {
  const dir = path.join(gitRoot, INDEX_DIR);
  await fs.mkdir(dir, { recursive: true });

  const sorted = normalize(index);
  const json = JSON.stringify(sorted, null, 2) + '\n';

  // Write to a unique tmp path in the same directory, then rename.
  // Same directory ensures the rename is atomic on the same filesystem.
  const tmp = path.join(
    dir,
    `${INDEX_FILENAME}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    await fs.writeFile(tmp, json, 'utf8');
    await fs.rename(tmp, path.join(dir, INDEX_FILENAME));
  } catch (e) {
    // Best-effort cleanup if rename failed
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Deterministically sort + validate the index. Unknown fields are dropped. */
export function normalize(input: Partial<IndexFile>): IndexFile {
  const annotations = Array.isArray(input.annotations)
    ? input.annotations.filter(isAnnotationEntry).map(normalizeAnnotation)
    : [];
  const references = Array.isArray(input.references)
    ? input.references.filter(isReferenceEntry).map(normalizeReference)
    : [];

  // Dedupe annotations by (pdf, anchor). Later wins.
  const annMap = new Map<string, AnnotationEntry>();
  for (const a of annotations) {
    annMap.set(`${a.pdf}|${a.anchor}`, a);
  }
  const annSorted = [...annMap.values()].sort(compareAnnotations);

  // Dedupe references by (source, sourceLine, sourceCol). Later wins.
  const refMap = new Map<string, ReferenceEntry>();
  for (const r of references) {
    refMap.set(`${r.source}|${r.sourceLine}|${r.sourceCol}`, r);
  }
  const refSorted = [...refMap.values()].sort(compareReferences);

  return { version: 2, annotations: annSorted, references: refSorted };
}

function compareAnnotations(a: AnnotationEntry, b: AnnotationEntry): number {
  if (a.pdf !== b.pdf) return a.pdf < b.pdf ? -1 : 1;
  if (a.page !== b.page) return a.page - b.page;
  if (a.anchor !== b.anchor) return a.anchor < b.anchor ? -1 : 1;
  return 0;
}

function compareReferences(a: ReferenceEntry, b: ReferenceEntry): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.sourceLine !== b.sourceLine) return a.sourceLine - b.sourceLine;
  if (a.sourceCol !== b.sourceCol) return a.sourceCol - b.sourceCol;
  return 0;
}

function isAnnotationEntry(v: any): v is AnnotationEntry {
  return (
    v &&
    typeof v === 'object' &&
    typeof v.pdf === 'string' &&
    typeof v.anchor === 'string' &&
    typeof v.page === 'number'
  );
}

function isReferenceEntry(v: any): v is ReferenceEntry {
  return (
    v &&
    typeof v === 'object' &&
    typeof v.source === 'string' &&
    typeof v.pdf === 'string' &&
    typeof v.anchor === 'string' &&
    typeof v.sourceLine === 'number' &&
    typeof v.sourceCol === 'number'
  );
}

function normalizeAnnotation(a: AnnotationEntry): AnnotationEntry {
  return {
    pdf: toPosix(a.pdf),
    page: a.page | 0,
    anchor: a.anchor,
    snippet: typeof a.snippet === 'string' ? a.snippet : '',
    color: typeof a.color === 'string' ? a.color : 'rgba(255,230,0,0.35)',
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : new Date().toISOString(),
  };
}

function normalizeReference(r: ReferenceEntry): ReferenceEntry {
  return {
    source: toPosix(r.source),
    sourceLine: r.sourceLine | 0,
    sourceCol: r.sourceCol | 0,
    sourceLength: typeof r.sourceLength === 'number' ? r.sourceLength | 0 : 0,
    pdf: toPosix(r.pdf),
    page: r.page | 0,
    anchor: r.anchor,
    snippet: typeof r.snippet === 'string' ? r.snippet : '',
  };
}

/** Convert Windows back-slashes to POSIX forward-slashes. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Compute `targetPath` relative to `gitRoot` in POSIX form. */
export function toPosixRelative(gitRoot: string, targetPath: string): string {
  return toPosix(path.relative(gitRoot, targetPath));
}

/** Exposed for tests — returns the fully-qualified path of the index file. */
export function indexFilePath(gitRoot: string): string {
  return path.join(gitRoot, INDEX_DIR, INDEX_FILENAME);
}

// `os` is imported to keep a hook for temp-dir inspection during tests;
// kept to discourage accidental unused-import removal.
void os;
