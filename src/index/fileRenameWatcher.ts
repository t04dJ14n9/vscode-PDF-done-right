import * as vscode from 'vscode';
import * as path from 'path';
import { IndexService } from './indexService';
import { toPosix } from './indexFile';
import { log } from '../util/logger';
import { formatPdfLink, PdfAnchor, stringToAnchor, ReferenceEntry } from '../shared/types';

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

    const plan = planRenames(renames, this.indexService.snapshot().references);
    if (plan.textEdits.length === 0 && plan.pdfRenames.length === 0 && plan.mdRenames.length === 0) {
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

    log.info(
      `Rename propagated: ${plan.pdfRenames.length} PDFs, ${plan.mdRenames.length} MDs, ${plan.textEdits.length} token rewrites.`,
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
}

/**
 * Pure function: classifies renames by extension and produces the full
 * list of text edits that must be applied to `.md` files referencing any
 * renamed PDF. No VS Code / filesystem dependencies — exported for tests.
 */
export function planRenames(
  renames: RenamePair[],
  references: readonly ReferenceEntry[],
): RenamePlan {
  const pdfRenames: RenamePair[] = [];
  const mdRenames: RenamePair[] = [];

  for (const r of renames) {
    if (r.oldRel === r.newRel) continue;
    const ext = r.oldRel.toLowerCase().split('.').pop();
    if (ext === 'pdf') pdfRenames.push(r);
    else if (ext === 'md') mdRenames.push(r);
    // Other extensions ignored.
  }

  if (pdfRenames.length === 0 && mdRenames.length === 0) {
    return { textEdits: [], pdfRenames: [], mdRenames: [] };
  }

  // Fast lookup: old PDF path → new PDF path
  const pdfMap = new Map(pdfRenames.map(r => [r.oldRel, r.newRel]));

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
    const replacement = formatPdfLink(newPdf, {
      page: anchor.page,
      textItemIndex: anchor.textItemIndex,
      charOffset: anchor.charOffset,
      length: anchor.length,
      snippet,
    });

    // After applyEdit VS Code's rename-tracking has already moved the file —
    // but applyEdit runs against the PRE-rename URI. We therefore use the
    // original source path. If the .md itself was also renamed, VS Code will
    // have already moved the buffer, so we need to target the NEW path.
    // In practice VS Code fires a single event with all renames; applyEdit
    // against `vscode.Uri.file(pathForFile)` is re-resolved by VS Code to the
    // current document, so using old path is safe as long as the document has
    // been remapped. To play it safest, we target whichever path is current
    // from the index's point of view — which is still `ref.source` because
    // IndexService.renameMarkdownInIndex hasn't been called yet.
    const source = mdMap.get(ref.source) ?? ref.source;

    textEdits.push({
      source,
      line: ref.sourceLine,
      col: ref.sourceCol,
      oldLength: ref.sourceLength || estimateTokenLength(ref.pdf, ref.anchor, ref.snippet),
      replacement,
    });
  }

  return { textEdits, pdfRenames, mdRenames };
}

/** Fallback when `sourceLength` is 0 (pre-v2 index). */
function estimateTokenLength(pdf: string, anchor: string, snippet: string): number {
  // `@pdf[[${pdf}#${anchor}|"${snippet ≤ 60 chars}"]]`
  const snip = snippet.length > 60 ? snippet.substring(0, 57) + '...' : snippet;
  return `@pdf[[${pdf}#${anchor}|"${snip}"]]`.length;
}
