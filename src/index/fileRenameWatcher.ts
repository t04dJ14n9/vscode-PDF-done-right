import * as vscode from 'vscode';
import * as path from 'path';
import { IndexService } from './indexService';
import { toPosix } from './indexFile';
import { log } from '../util/logger';
import { formatPdfLinkFromParts, formatCodeLink, PdfAnchor, stringToAnchor, ReferenceEntry, CodeReferenceEntry } from '../shared/types';

/**
 * Watches `onDidRenameFiles` and propagates the rename through:
 *   • `.md` files that contain `@pdf[[oldPdfPath#…]]` tokens — rewritten via
 *     a single `WorkspaceEdit` so the change is ONE undo unit.
 *   • The in-memory index (annotations + references) — `pdf` or `source`
 *     fields updated as appropriate.
 *
 * The bulk of the logic is pulled into `planRenames()` which is a pure
 * function over an IndexService snapshot, so it can be unit-tested without
 * any VS Code side effects.
 */
export class FileRenameWatcher implements vscode.Disposable {
  private sub: vscode.Disposable;

  constructor(
    private readonly indexService: IndexService,
    private readonly gitRoot: string,
  ) {
    this.sub = vscode.workspace.onDidRenameFiles(e => this.handle(e));
  }

  dispose(): void {
    this.sub.dispose();
  }

  private async handle(e: vscode.FileRenameEvent): Promise<void> {
    const renames: RenamePair[] = [];
    for (const { oldUri, newUri } of e.files) {
      if (oldUri.scheme !== 'file' || newUri.scheme !== 'file') continue;
      if (!this.underGitRoot(oldUri.fsPath) || !this.underGitRoot(newUri.fsPath)) continue;
      renames.push({
        oldRel: toPosix(path.relative(this.gitRoot, oldUri.fsPath)),
        newRel: toPosix(path.relative(this.gitRoot, newUri.fsPath)),
      });
    }
    if (renames.length === 0) return;

    const plan = planRenames(renames, this.indexService.snapshot().references, this.indexService.snapshot().codeReferences);
    if (plan.textEdits.length === 0 && plan.pdfRenames.length === 0 && plan.mdRenames.length === 0 && plan.codeTargetRenames.length === 0) {
      return;
    }

    // Apply text edits (rewriting `@pdf[[…]]` tokens) first, in one undo unit.
    if (plan.textEdits.length > 0) {
      const edit = new vscode.WorkspaceEdit();
      for (const te of plan.textEdits) {
        const uri = vscode.Uri.file(path.join(this.gitRoot, te.source));
        edit.replace(
          uri,
          new vscode.Range(
            new vscode.Position(te.line, te.col),
            new vscode.Position(te.line, te.col + te.oldLength),
          ),
          te.replacement,
        );
      }
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        log.warn(
          `Rename propagation: WorkspaceEdit was rejected; index.json was NOT updated to keep state consistent.`,
        );
        return;
      }
      // Persist the .md changes so on-disk content matches what we just edited.
      for (const te of plan.textEdits) {
        const uri = vscode.Uri.file(path.join(this.gitRoot, te.source));
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        await doc?.save();
      }
    }

    // Update the index (annotations + references).
    for (const { oldRel, newRel } of plan.pdfRenames) {
      this.indexService.renamePdfInIndex(oldRel, newRel);
    }
    for (const { oldRel, newRel } of plan.mdRenames) {
      this.indexService.renameMarkdownInIndex(oldRel, newRel);
    }
    for (const { oldRel, newRel } of plan.codeTargetRenames) {
      this.indexService.renameCodeTargetInIndex(oldRel, newRel);
    }

    log.info(
      `Rename propagated: ${plan.pdfRenames.length} PDFs, ${plan.mdRenames.length} MDs, ${plan.codeTargetRenames.length} code targets, ${plan.textEdits.length} token rewrites.`,
    );
  }

  private underGitRoot(fsPath: string): boolean {
    const p = fsPath + path.sep;
    return p.startsWith(this.gitRoot + path.sep);
  }
}

// ─── Pure planning functions (unit-testable) ────────────────────────────────

export interface RenamePair {
  oldRel: string;
  newRel: string;
}

export interface PlannedTextEdit {
  source: string; // .md file (POSIX rel)
  line: number;
  col: number;
  oldLength: number;
  replacement: string;
}

export interface RenamePlan {
  textEdits: PlannedTextEdit[];
  pdfRenames: RenamePair[];
  mdRenames: RenamePair[];
  codeTargetRenames: RenamePair[];
}

/**
 * Pure function: classifies renames by extension and produces the full
 * list of text edits that must be applied to `.md` files referencing any
 * renamed PDF. No VS Code / filesystem dependencies — exported for tests.
 */
export function planRenames(
  renames: RenamePair[],
  references: readonly ReferenceEntry[],
  codeReferences: readonly CodeReferenceEntry[] = [],
): RenamePlan {
  const pdfRenames: RenamePair[] = [];
  const mdRenames: RenamePair[] = [];
  const codeTargetRenames: RenamePair[] = [];

  for (const r of renames) {
    if (r.oldRel === r.newRel) continue;
    const ext = r.oldRel.toLowerCase().split('.').pop();
    if (ext === 'pdf') pdfRenames.push(r);
    else if (ext === 'md') mdRenames.push(r);
    else codeTargetRenames.push(r);
  }

  if (pdfRenames.length === 0 && mdRenames.length === 0 && codeTargetRenames.length === 0) {
    return { textEdits: [], pdfRenames: [], mdRenames: [], codeTargetRenames: [] };
  }

  // Fast lookup: old PDF path → new PDF path
  const pdfMap = new Map(pdfRenames.map(r => [r.oldRel, r.newRel]));

  // Fast lookup: old code target path → new code target path
  const codeTargetMap = new Map(codeTargetRenames.map(r => [r.oldRel, r.newRel]));

  // If a .md is ALSO being renamed this tick, its edits need to be keyed by
  // the NEW source path because the rename happens before our edits propagate.
  // We detect this via the mdRenames list.
  const mdMap = new Map(mdRenames.map(r => [r.oldRel, r.newRel]));

  const textEdits: PlannedTextEdit[] = [];
  for (const ref of references) {
    const newPdf = pdfMap.get(ref.pdf);
    if (!newPdf) continue;

    const anchor = stringToAnchor(ref.anchor) as PdfAnchor | null;
    if (!anchor) continue;

    const snippet = ref.snippet ?? '';
    const replacement = formatPdfLinkFromParts(newPdf, ref.anchor, snippet);

    const source = mdMap.get(ref.source) ?? ref.source;

    textEdits.push({
      source,
      line: ref.sourceLine,
      col: ref.sourceCol,
      oldLength: ref.sourceLength || estimateTokenLength(ref.pdf, ref.anchor, ref.snippet),
      replacement,
    });
  }

  // Generate text edits for @code[[…]] tokens referencing renamed code targets.
  for (const cref of codeReferences) {
    const newTarget = codeTargetMap.get(cref.targetPath);
    if (!newTarget) continue;

    // Also resolve relative targetPath via source directory
    let matchedOld: string | undefined;
    for (const [oldRel] of codeTargetMap) {
      if (cref.targetPath === oldRel) { matchedOld = oldRel; break; }
      // Check relative-to-source resolution
      const dir = dirnamePosix(cref.source);
      if (dir && joinPosix(dir, cref.targetPath) === oldRel) { matchedOld = oldRel; break; }
    }
    if (!matchedOld) continue;
    const newTargetPath = codeTargetMap.get(matchedOld)!;

    const replacement = formatCodeLink(newTargetPath, cref.startLine || undefined, cref.endLine > cref.startLine ? cref.endLine : undefined, cref.snippet || undefined);

    const source = mdMap.get(cref.source) ?? cref.source;

    textEdits.push({
      source,
      line: cref.sourceLine,
      col: cref.sourceCol,
      oldLength: cref.sourceLength || estimateCodeTokenLength(cref.targetPath, cref.startLine, cref.endLine, cref.snippet),
      replacement,
    });
  }

  return { textEdits, pdfRenames, mdRenames, codeTargetRenames };
}

/** Fallback when `sourceLength` is 0 (pre-v2 index). */
function estimateTokenLength(pdf: string, anchor: string, snippet: string): number {
  // `[[${pdf}#${anchor}|${snippet ≤ 60 chars}]]`
  const snip = snippet.length > 60 ? snippet.substring(0, 57) + '...' : snippet;
  return `[[${pdf}#${anchor}${snip ? `|${snip}` : ''}]]`.length;
}

/** Fallback when `sourceLength` is 0 for code references. */
function estimateCodeTokenLength(targetPath: string, startLine: number, endLine: number, snippet: string): number {
  const loc = startLine
    ? endLine > startLine
      ? `#L${startLine}-L${endLine}`
      : `#L${startLine}`
    : '';
  const snip = snippet.length > 60 ? snippet.substring(0, 57) + '...' : snippet;
  return `@code[[${targetPath}${loc}${snip ? `|"${snip}"` : ''}]]`.length;
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
