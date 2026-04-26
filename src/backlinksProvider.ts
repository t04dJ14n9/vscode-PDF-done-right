import * as vscode from 'vscode';
import * as path from 'path';
import { IndexService } from './index/indexService';
import { ReferenceEntry, CodeReferenceEntry, WikiReferenceEntry, AnnotationEntry } from './shared/types';
import { toPosix } from './index/indexFile';

/**
 * Tree item kinds shown in the Backlinks view:
 *   • Section — "Backlinks (N)" / "Outgoing (N)" top-level header
 *   • Ref     — individual reference row under a section
 *   • Empty   — filler row shown when a section has zero items
 */
type SectionKey = 'backlinks' | 'outgoing' | 'codeBacklinks' | 'codeOutgoing' | 'wikiBacklinks' | 'wikiOutgoing' | 'annotations';

type BacklinksNode =
  | { kind: 'section'; key: SectionKey; label: string; count: number }
  | { kind: 'ref'; ref: ReferenceEntry | CodeReferenceEntry; side: 'inbound' | 'outbound' }
  | { kind: 'wikiRef'; ref: WikiReferenceEntry; side: 'inbound' | 'outbound' }
  | { kind: 'annotation'; annotation: AnnotationEntry }
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
    // PDFs are targets, not sources, so they do not have outgoing @pdf references.
    return [];
  }

  /** Get forward links (annotations) for a PDF file. */
  private getAnnotationsForActiveFile(activeRelPath: string): AnnotationEntry[] {
    if (activeRelPath.toLowerCase().endsWith('.pdf')) {
      return this.indexService.getAnnotationsAsForwardLinks(activeRelPath);
    }
    return [];
  }

  /** Get wiki backlinks for the active file. */
  private getWikiBacklinksForActiveFile(activeRelPath: string): WikiReferenceEntry[] {
    // Extract note name from the .md file path
    if (!activeRelPath.toLowerCase().endsWith('.md')) return [];
    const basename = path.basename(activeRelPath, path.extname(activeRelPath));
    return this.indexService.getWikiBacklinks(basename);
  }

  /** Get wiki outgoing references from the active file. */
  private getWikiOutgoingForActiveFile(activeRelPath: string): WikiReferenceEntry[] {
    if (!activeRelPath.toLowerCase().endsWith('.md')) return [];
    return this.indexService.getWikiOutgoing(activeRelPath);
  }

  getTreeItem(element: BacklinksNode): vscode.TreeItem {
    if (element.kind === 'section') {
      const item = new vscode.TreeItem(
        `${element.label} (${element.count})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = `paperlink.section.${element.key}`;
      item.iconPath = new vscode.ThemeIcon(
        element.key === 'backlinks' ? 'references'
          : element.key === 'codeBacklinks' ? 'symbol-method'
            : element.key === 'codeOutgoing' ? 'file-code'
              : 'link-external',
      );
      return item;
    }
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      item.description = '';
      return item;
    }
    if (element.kind === 'wikiRef') {
      const r = element.ref;
      const displayText = r.targetSection
        ? `${r.targetNote} › ${r.targetSection}`
        : r.targetNote;
      const item = new vscode.TreeItem(displayText, vscode.TreeItemCollapsibleState.None);
      if (element.side === 'inbound') {
        item.description = `${r.source}:${r.sourceLine + 1}`;
        item.tooltip = `${r.source} (line ${r.sourceLine + 1})`;
      } else {
        item.description = r.targetNote;
        item.tooltip = r.targetSection ? `${r.targetNote}#${r.targetSection}` : r.targetNote;
      }
      item.iconPath = new vscode.ThemeIcon(
        element.side === 'inbound' ? 'arrow-small-left' : 'arrow-small-right',
      );
      item.command = {
        command: element.side === 'inbound'
          ? 'paperlink.openBacklink'
          : 'paperlink.openWikiLink',
        title: 'Open wiki link',
        arguments: [r],
      };
      return item;
    }
    if (element.kind === 'annotation') {
      const a = element.annotation;
      const displayText = a.snippet || `p.${a.page}`;
      const item = new vscode.TreeItem(displayText, vscode.TreeItemCollapsibleState.None);
      item.description = `p.${a.page}`;
      item.tooltip = `Annotation on p.${a.page}: ${a.snippet || '(no snippet)'}`;
      item.iconPath = new vscode.ThemeIcon('highlight');
      if (this.activeRelPath) {
        item.command = {
          command: 'paperlink.openPdfAtAnchor',
          title: 'Open annotation in PDF',
          arguments: [{ pdfPath: this.activeRelPath, anchor: a.anchor }],
        };
      }
      return item;
    }
    // kind === 'ref'
    const r = element.ref;
    // Check if this is a CodeReferenceEntry (has targetPath)
    const isCodeRef = 'targetPath' in r;

    if (isCodeRef) {
      const cr = r as CodeReferenceEntry;
      const displayText = cr.snippet || path.basename(cr.targetPath);
      const item = new vscode.TreeItem(displayText, vscode.TreeItemCollapsibleState.None);
      item.description = `${cr.targetPath}${cr.startLine ? ':' + cr.startLine : ''}`;
      item.tooltip = `${cr.targetPath}${cr.startLine ? ` (line ${cr.startLine}${cr.endLine > cr.startLine ? '-' + cr.endLine : ''})` : ''}`;
      item.iconPath = new vscode.ThemeIcon(
        element.side === 'inbound' ? 'arrow-small-left' : 'arrow-small-right',
      );
      item.command = {
        command: 'paperlink.openCodeAtLocation',
        title: 'Open code reference',
        arguments: [cr],
      };
      return item;
    }

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
    if (element.side === 'outbound' && !activeIsPdf) {
      item.command = {
        command: 'paperlink.openPdfAtAnchor',
        title: 'Open PDF reference',
        arguments: [{ pdfPath: r.pdf, anchor: r.anchor }],
      };
    } else {
      item.command = {
        command: 'paperlink.openBacklink',
        title: 'Open backlink',
        arguments: [r],
      };
    }
    return item;
  }

  getChildren(element?: BacklinksNode): BacklinksNode[] {
    if (!element) {
      if (!this.activeRelPath) {
        return [{ kind: 'empty', text: 'No active file.' }];
      }
      const backlinks = this.indexService.getBacklinks(this.activeRelPath);
      const outgoing = this.getOutgoingForActiveFile(this.activeRelPath);
      const codeBacklinks: CodeReferenceEntry[] = this.indexService.getCodeBacklinks(this.activeRelPath);
      const codeOutgoing: CodeReferenceEntry[] = this.activeRelPath.toLowerCase().endsWith('.md')
        ? this.indexService.getCodeOutgoing(this.activeRelPath)
        : [];
      const wikiBacklinks = this.getWikiBacklinksForActiveFile(this.activeRelPath);
      const wikiOutgoing = this.getWikiOutgoingForActiveFile(this.activeRelPath);
      const annotations = this.getAnnotationsForActiveFile(this.activeRelPath);

      if (this.mode === 'backlinks') {
        const allInbound = [
          ...backlinks.map(r => ({ kind: 'ref' as const, ref: r, side: 'inbound' as const })),
          ...codeBacklinks.map(r => ({ kind: 'ref' as const, ref: r as any, side: 'inbound' as const })),
          ...wikiBacklinks.map(r => ({ kind: 'wikiRef' as const, ref: r, side: 'inbound' as const })),
        ];
        if (allInbound.length === 0) {
          return [{ kind: 'empty', text: '(no files reference this)' }];
        }
        return allInbound;
      }

      if (this.mode === 'forward') {
        const allOutbound = [
          ...outgoing.map(r => ({ kind: 'ref' as const, ref: r, side: 'outbound' as const })),
          ...codeOutgoing.map(r => ({ kind: 'ref' as const, ref: r as any, side: 'outbound' as const })),
          ...wikiOutgoing.map(r => ({ kind: 'wikiRef' as const, ref: r, side: 'outbound' as const })),
          ...annotations.map(a => ({ kind: 'annotation' as const, annotation: a })),
        ];
        if (allOutbound.length === 0) {
          const text = this.activeRelPath.toLowerCase().endsWith('.pdf')
            ? '(no forward links)'
            : '(no outgoing references)';
          return [{ kind: 'empty', text }];
        }
        return allOutbound;
      }

      const outgoingLabel = this.activeRelPath.toLowerCase().endsWith('.pdf')
        ? 'Forward Links'
        : 'Outgoing';
      return [
        { kind: 'section', key: 'backlinks', label: 'Backlinks', count: backlinks.length },
        { kind: 'section', key: 'outgoing', label: outgoingLabel, count: outgoing.length },
        { kind: 'section', key: 'codeBacklinks', label: 'Code Backlinks', count: codeBacklinks.length },
        { kind: 'section', key: 'codeOutgoing', label: 'Code Outgoing', count: codeOutgoing.length },
        { kind: 'section', key: 'wikiBacklinks', label: 'Wiki Backlinks', count: wikiBacklinks.length },
        { kind: 'section', key: 'wikiOutgoing', label: 'Wiki Outgoing', count: wikiOutgoing.length },
        ...(annotations.length > 0 ? [{ kind: 'section' as const, key: 'annotations' as SectionKey, label: 'Annotations', count: annotations.length }] : []),
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
      if (element.key === 'codeBacklinks') {
        const refs: CodeReferenceEntry[] = this.indexService.getCodeBacklinks(this.activeRelPath);
        if (refs.length === 0) {
          return [{ kind: 'empty', text: '(no code references this)' }];
        }
        return refs.map(r => ({ kind: 'ref' as const, ref: r as any, side: 'inbound' as const }));
      }
      if (element.key === 'codeOutgoing') {
        const refs: CodeReferenceEntry[] = this.indexService.getCodeOutgoing(this.activeRelPath);
        if (refs.length === 0) {
          return [{ kind: 'empty', text: '(no outgoing code references)' }];
        }
        return refs.map(r => ({ kind: 'ref' as const, ref: r as any, side: 'outbound' as const }));
      }
      if (element.key === 'wikiBacklinks') {
        const refs = this.getWikiBacklinksForActiveFile(this.activeRelPath);
        if (refs.length === 0) {
          return [{ kind: 'empty', text: '(no wiki links reference this)' }];
        }
        return refs.map(r => ({ kind: 'wikiRef' as const, ref: r, side: 'inbound' as const }));
      }
      if (element.key === 'wikiOutgoing') {
        const refs = this.getWikiOutgoingForActiveFile(this.activeRelPath);
        if (refs.length === 0) {
          return [{ kind: 'empty', text: '(no outgoing wiki links)' }];
        }
        return refs.map(r => ({ kind: 'wikiRef' as const, ref: r, side: 'outbound' as const }));
      }
      if (element.key === 'annotations') {
        const anns = this.getAnnotationsForActiveFile(this.activeRelPath);
        if (anns.length === 0) {
          return [{ kind: 'empty', text: '(no annotations)' }];
        }
        return anns.map(a => ({ kind: 'annotation' as const, annotation: a }));
      }
    }
    return [];
  }
}
