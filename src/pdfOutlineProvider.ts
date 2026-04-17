import * as vscode from 'vscode';
import { PdfOutlineItem } from './shared/types';

export { PdfOutlineItem };

/**
 * TreeDataProvider that displays PDF bookmarks/outline in VS Code's sidebar.
 */
export class PdfOutlineProvider implements vscode.TreeDataProvider<PdfOutlineItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PdfOutlineItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private outline: PdfOutlineItem[] = [];
  private goToPageCallback: ((page: number) => void) | undefined;

  setOutline(outline: PdfOutlineItem[], goToPage: (page: number) => void): void {
    this.outline = outline;
    this.goToPageCallback = goToPage;
    this._onDidChangeTreeData.fire(undefined);
  }

  clear(): void {
    this.outline = [];
    this.goToPageCallback = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  goToPage(page: number): void {
    if (this.goToPageCallback) {
      this.goToPageCallback(page);
    }
  }

  getTreeItem(element: PdfOutlineItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.title,
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.description = `p.${element.page}`;
    item.tooltip = `${element.title} (page ${element.page})`;
    item.iconPath = new vscode.ThemeIcon('bookmark');
    item.command = {
      command: 'paperlink.outlineGoToPage',
      title: 'Go to page',
      arguments: [element.page],
    };
    return item;
  }

  getChildren(element?: PdfOutlineItem): PdfOutlineItem[] {
    if (!element) {
      return this.outline;
    }
    return element.children;
  }

  getParent(_element: PdfOutlineItem): PdfOutlineItem | undefined {
    return undefined;
  }
}
