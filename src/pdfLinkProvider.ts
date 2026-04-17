import * as vscode from 'vscode';
import * as path from 'path';
import { PDF_LINK_REGEX, stringToAnchor } from './shared/types';

/**
 * DocumentLinkProvider that detects @pdf[[path/to/file.pdf#anchor|"snippet"]]
 * patterns in markdown files and makes them clickable.
 */
export class PdfLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const text = document.getText();

    // Reset the regex state
    const regex = new RegExp(PDF_LINK_REGEX.source, PDF_LINK_REGEX.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const fullMatch = match[0];
      const pdfRelPath = match[1]; // e.g., "papers/attention.pdf"
      const anchorStr = match[2]; // e.g., "page=5&idx=12&off=5&len=40"

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

    return links;
  }
}
