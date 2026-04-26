import * as vscode from 'vscode';
import * as path from 'path';
import { IndexService, parseMarkdownReferences, parseCodeReferences, parseWikiReferences } from './indexService';
import { log } from '../util/logger';
import { toPosix } from './indexFile';

/**
 * Watches markdown files in the workspace and keeps the IndexService's
 * `references` table in sync.
 *
 *   • Full scan of `**​/*.md` on activation.
 *   • onDidSaveTextDocument → rebuild entries for that one file.
 *   • onDidDeleteFiles      → drop entries whose source matches.
 *   • onDidCreateFiles      → parse the new file immediately.
 *
 * Rename events are handled by FileRenameWatcher, not here.
 */
export class MarkdownIndexer implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly indexService: IndexService,
    private readonly gitRoot: string,
  ) {}

  async init(): Promise<void> {
    const before = Date.now();
    const uris = await vscode.workspace.findFiles(
      '**/*.md',
      '{**/node_modules/**,**/.paperlink/**,**/.git/**}',
    );
    for (const uri of uris) {
      await this.rebuildForFile(uri);
    }
    await this.indexService.flushNow();
    log.info(`Indexed ${uris.length} markdown files in ${Date.now() - before} ms`);

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(async doc => {
        if (doc.languageId === 'markdown') {
          await this.rebuildForFile(doc.uri);
        }
      }),
      vscode.workspace.onDidDeleteFiles(e => {
        for (const uri of e.files) {
          if (isMarkdown(uri) && this.underGitRoot(uri)) {
            const rel = toPosix(path.relative(this.gitRoot, uri.fsPath));
            this.indexService.replaceReferencesForFile(rel, []);
            this.indexService.replaceCodeReferencesForFile(rel, []);
            this.indexService.replaceWikiReferencesForFile(rel, []);
          }
        }
      }),
      vscode.workspace.onDidCreateFiles(async e => {
        for (const uri of e.files) {
          if (isMarkdown(uri) && this.underGitRoot(uri)) {
            await this.rebuildForFile(uri);
          }
        }
      }),
    );
  }

  /** Reparse a single markdown file and update the index. */
  private async rebuildForFile(uri: vscode.Uri): Promise<void> {
    if (!this.underGitRoot(uri)) return;
    const rel = toPosix(path.relative(this.gitRoot, uri.fsPath));

    let text: string;
    try {
      // Prefer the open TextDocument so unsaved edits land immediately on save.
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
      if (open) {
        text = open.getText();
      } else {
        const data = await vscode.workspace.fs.readFile(uri);
        text = Buffer.from(data).toString('utf8');
      }
    } catch (e) {
      log.warn(`Could not read ${rel}`, e);
      this.indexService.replaceReferencesForFile(rel, []);
      return;
    }

    const refs = parseMarkdownReferences(rel, text);
    this.indexService.replaceReferencesForFile(rel, refs);

    const codeRefs = parseCodeReferences(rel, text);
    this.indexService.replaceCodeReferencesForFile(rel, codeRefs);

    const wikiRefs = parseWikiReferences(rel, text);
    this.indexService.replaceWikiReferencesForFile(rel, wikiRefs);
  }

  private underGitRoot(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') return false;
    const p = uri.fsPath + path.sep;
    return p.startsWith(this.gitRoot + path.sep);
  }

  /** Manual rescan — bound to the `paperlink.refreshIndex` command. */
  async refresh(): Promise<void> {
    // Wipe all references, then re-scan.
    for (const source of uniqueSources(this.indexService)) {
      this.indexService.replaceReferencesForFile(source, []);
    }
    await this.init();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function isMarkdown(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.md');
}

function uniqueSources(svc: IndexService): Set<string> {
  const s = new Set<string>();
  for (const r of svc.snapshot().references) s.add(r.source);
  for (const r of svc.snapshot().codeReferences) s.add(r.source);
  for (const r of svc.snapshot().wikiReferences) s.add(r.source);
  return s;
}
