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

export class BacklinksProvider implements vscode.TreeDataProvider<BacklinksNode> {
  private _onDidChange = new vscode.EventEmitter<BacklinksNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private activeRelPath: string | undefined;

  constructor(
    private readonly indexService: IndexService,
    private readonly gitRoot: string,
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
    // Prefer the active text editor (markdown).
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      const abs = editor.document.uri.fsPath;
      if (abs.startsWith(this.gitRoot + path.sep)) {
        return toPosix(path.relative(this.gitRoot, abs));
      }
    }
    // Fall back to the active tab's input (covers custom PDF editor).
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const input = tab?.input as any;
    const uri: vscode.Uri | undefined = input?.uri;
    if (uri && uri.scheme === 'file' && uri.fsPath.startsWith(this.gitRoot + path.sep)) {
      return toPosix(path.relative(this.gitRoot, uri.fsPath));
    }
    return undefined;
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
    const otherSide = element.side === 'inbound' ? r.source : r.pdf;
    const displayText = r.snippet || path.basename(otherSide);
    const item = new vscode.TreeItem(displayText, vscode.TreeItemCollapsibleState.None);
    item.description = `${otherSide}:${r.sourceLine + 1}`;
    item.tooltip = `${otherSide} (line ${r.sourceLine + 1}, col ${r.sourceCol + 1})`;
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
      const outgoing = this.indexService.getOutgoing(this.activeRelPath);
      return [
        { kind: 'section', key: 'backlinks', label: 'Backlinks', count: backlinks.length },
        { kind: 'section', key: 'outgoing', label: 'Outgoing', count: outgoing.length },
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
        const refs = this.indexService.getOutgoing(this.activeRelPath);
        if (refs.length === 0) {
          return [{ kind: 'empty', text: '(no outgoing references)' }];
        }
        return refs.map(r => ({ kind: 'ref' as const, ref: r, side: 'outbound' as const }));
      }
    }
    return [];
  }
}
