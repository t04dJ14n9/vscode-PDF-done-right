import * as vscode from 'vscode';
import * as path from 'path';
import { IndexService } from './index/indexService';
import { ReferenceEntry } from './shared/types';
import { toPosix } from './index/indexFile';

/**
 * Tree item kinds shown in the Backlinks view:
 *   • Section — "Backlinks (N)" / "Outgoing (N)" top-level header
 *   • Ref     — individual reference row under a section
 *   • Empty   — filler row shown when a section has zero items
 */
type BacklinksNode =
  | { kind: 'section'; key: 'backlinks' | 'outgoing'; label: string; count: number }
  | { kind: 'ref'; ref: ReferenceEntry; side: 'inbound' | 'outbound' }
  | { kind: 'empty'; text: string };

type BacklinksViewMode = 'combined' | 'backlinks' | 'forward';

export class BacklinksProvider implements vscode.TreeDataProvider<BacklinksNode> {
  private _onDidChange = new vscode.EventEmitter<BacklinksNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private activeRelPath: string | undefined;

  constructor(
    private readonly indexService: IndexService,
    private readonly gitRoot: string,
    private readonly mode: BacklinksViewMode = 'combined',
  ) {
    // Re-render when the active editor OR the active PDF webview changes.
    vscode.window.onDidChangeActiveTextEditor(() => this.refreshFromActive());

    // Also react to index changes.
    indexService.onDidChange(() => this._onDidChange.fire(undefined));

    // React when custom (PDF) editors change focus — tabGroups.onDidChangeTabs
    // covers this.
    vscode.window.tabGroups.onDidChangeTabs(() => this.refreshFromActive());

    this.refreshFromActive();
  }

  /** Called externally (e.g. command palette) to bounce the view. */
  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  /** Current file (POSIX relative to gitRoot), if any. */
  getActiveRelPath(): string | undefined {
    return this.activeRelPath;
  }

  private refreshFromActive(): void {
    const rel = this.computeActiveRelPath();
    if (rel !== this.activeRelPath) {
      this.activeRelPath = rel;
      this._onDidChange.fire(undefined);
    }
  }

  private computeActiveRelPath(): string | undefined {
    // Prefer active tab input first so custom PDF editors win over stale
    // activeTextEditor state.
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const input = tab?.input as { uri?: vscode.Uri } | undefined;
    const tabUri = input?.uri;
    if (tabUri && tabUri.scheme === 'file' && tabUri.fsPath.startsWith(this.gitRoot + path.sep)) {
      return toPosix(path.relative(this.gitRoot, tabUri.fsPath));
    }

    // Fall back to active text editor.
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      const abs = editor.document.uri.fsPath;
      if (abs.startsWith(this.gitRoot + path.sep)) {
        return toPosix(path.relative(this.gitRoot, abs));
      }
    }

    return undefined;
  }

  private getOutgoingForActiveFile(activeRelPath: string): ReferenceEntry[] {
    // For markdown files, outgoing means links authored in this note.
    if (activeRelPath.toLowerCase().endsWith('.md')) {
      return this.indexService.getOutgoing(activeRelPath);
    }
    // PDFs are targets, not sources, so they do not have outgoing links.
    if (activeRelPath.toLowerCase().endsWith('.pdf')) {
      return [];
    }
    return [];
  }

  getTreeItem(element: BacklinksNode): vscode.TreeItem {
    if (element.kind === 'section') {
      const item = new vscode.TreeItem(
        `${element.label} (${element.count})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = `paperlink.section.${element.key}`;
      item.iconPath = new vscode.ThemeIcon(
        element.key === 'backlinks' ? 'references' : 'link-external',
      );
      return item;
    }
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      item.description = '';
      return item;
    }
    // kind === 'ref'
    const r = element.ref;
    const activeIsPdf = this.activeRelPath?.toLowerCase().endsWith('.pdf') ?? false;
    const otherSide = element.side === 'inbound'
      ? r.source
      : activeIsPdf
        ? r.source
        : r.pdf;
    const displayText = r.snippet || path.basename(otherSide);
    const item = new vscode.TreeItem(displayText, vscode.TreeItemCollapsibleState.None);

    if (activeIsPdf || element.side === 'inbound') {
      item.description = `${otherSide}:${r.sourceLine + 1}`;
      item.tooltip = `${otherSide} (line ${r.sourceLine + 1}, col ${r.sourceCol + 1})`;
    } else {
      item.description = `${otherSide} (p.${r.page})`;
      item.tooltip = `${otherSide} (page ${r.page})`;
    }

    item.iconPath = new vscode.ThemeIcon(
      element.side === 'inbound' ? 'arrow-small-left' : 'arrow-small-right',
    );
    item.command = {
      command: 'paperlink.openBacklink',
      title: 'Open backlink',
      arguments: [r],
    };
    return item;
  }

  getChildren(element?: BacklinksNode): BacklinksNode[] {
    if (!element) {
      if (!this.activeRelPath) {
        return [{ kind: 'empty', text: 'No active file.' }];
      }
      const backlinks = this.indexService.getBacklinks(this.activeRelPath);
      const outgoing = this.getOutgoingForActiveFile(this.activeRelPath);

      if (this.mode === 'backlinks') {
        if (backlinks.length === 0) {
          return [{ kind: 'empty', text: '(no files reference this)' }];
        }
        return backlinks.map(r => ({ kind: 'ref' as const, ref: r, side: 'inbound' as const }));
      }

      if (this.mode === 'forward') {
        if (outgoing.length === 0) {
          const text = this.activeRelPath.toLowerCase().endsWith('.pdf')
            ? '(no forward links)'
            : '(no outgoing references)';
          return [{ kind: 'empty', text }];
        }
        return outgoing.map(r => ({ kind: 'ref' as const, ref: r, side: 'outbound' as const }));
      }

      const outgoingLabel = this.activeRelPath.toLowerCase().endsWith('.pdf')
        ? 'Forward Links'
        : 'Outgoing';
      return [
        { kind: 'section', key: 'backlinks', label: 'Backlinks', count: backlinks.length },
        { kind: 'section', key: 'outgoing', label: outgoingLabel, count: outgoing.length },
      ];
    }
    if (element.kind === 'section' && this.activeRelPath) {
      if (element.key === 'backlinks') {
        const refs = this.indexService.getBacklinks(this.activeRelPath);
        if (refs.length === 0) {
          return [{ kind: 'empty', text: '(no files reference this)' }];
        }
        return refs.map(r => ({ kind: 'ref' as const, ref: r, side: 'inbound' as const }));
      }
      if (element.key === 'outgoing') {
        const refs = this.getOutgoingForActiveFile(this.activeRelPath);
        if (refs.length === 0) {
          const text = this.activeRelPath.toLowerCase().endsWith('.pdf')
            ? '(no forward links)'
            : '(no outgoing references)';
          return [{ kind: 'empty', text }];
        }
        return refs.map(r => ({ kind: 'ref' as const, ref: r, side: 'outbound' as const }));
      }
    }
    return [];
  }
}
