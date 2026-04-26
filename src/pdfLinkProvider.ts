import * as vscode from 'vscode';
import { findPdfLinkMatches, CODE_LINK_REGEX, stringToAnchor } from './shared/types';

/**
 * DocumentLinkProvider that detects legacy and Obsidian-style PDF links in
 * markdown files and makes them clickable.
 */
export class PdfLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const text = document.getText();

    for (const match of findPdfLinkMatches(text)) {
      const fullMatch = match.fullMatch;
      const pdfRelPath = match.pdfPath;
      const anchorStr = match.anchor;

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + fullMatch.length);
      const range = new vscode.Range(startPos, endPos);

      // Create a command URI that will open the PDF at the anchor
      const commandUri = vscode.Uri.parse(
        `command:paperlink.openPdfAtAnchor?${encodeURIComponent(
          JSON.stringify({ pdfPath: pdfRelPath, anchor: anchorStr })
        )}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Open PDF: ${pdfRelPath} (page ${stringToAnchor(anchorStr)?.page || '?'})`;
      links.push(link);
    }

    // @code[[…]] links
    const codeRegex = new RegExp(CODE_LINK_REGEX.source, CODE_LINK_REGEX.flags);
    let codeMatch: RegExpExecArray | null;

    while ((codeMatch = codeRegex.exec(text)) !== null) {
      const fullMatch = codeMatch[0];
      const codeRelPath = codeMatch[1]; // e.g., "src/main.go"
      const startLine = codeMatch[2]; // e.g., "12"
      const endLine = codeMatch[3]; // e.g., "34"

      const startPos = document.positionAt(codeMatch.index);
      const endPos = document.positionAt(codeMatch.index + fullMatch.length);
      const range = new vscode.Range(startPos, endPos);

      const commandUri = vscode.Uri.parse(
        `command:paperlink.openCodeAtLocation?${encodeURIComponent(
          JSON.stringify({
            targetPath: codeRelPath,
            startLine: startLine ? parseInt(startLine) : 0,
            endLine: endLine ? parseInt(endLine) : 0,
            snippet: codeMatch[4] || '',
          })
        )}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Open code: ${codeRelPath}${startLine ? ` (line ${startLine})` : ''}`;
      links.push(link);
    }

    return links;
  }
}
