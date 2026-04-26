import { findPdfLinkMatches, CODE_LINK_REGEX, stringToAnchor } from './shared/types';

/**
 * Markdown-it plugin that renders PDF links as styled clickable
 * elements in VS Code's markdown preview.
 */
export function activateMarkdownItPlugin(md: any): any {
  // Add a custom rule to the markdown-it core
  const defaultRender =
    md.renderer.rules.text ||
    function (tokens: any[], idx: number): string {
      return md.utils.escapeHtml(tokens[idx].content);
    };

  md.renderer.rules.text = function (
    tokens: any[],
    idx: number,
    options: any,
    env: any,
    self: any
  ): string {
    const content = tokens[idx].content;

    const pdfMatches = findPdfLinkMatches(content);
    if (pdfMatches.length === 0) {
      return defaultRender(tokens, idx, options, env, self);
    }

    let cursor = 0;
    let withPdfReplaced = '';
    for (const match of pdfMatches) {
      withPdfReplaced += md.utils.escapeHtml(content.slice(cursor, match.index));
      const anchor = stringToAnchor(match.anchor);
      const displayText = match.snippet || `${match.pdfPath} p.${anchor?.page || '?'}`;
      const escapedPath = md.utils.escapeHtml(match.pdfPath);
      const escapedAnchor = md.utils.escapeHtml(match.anchor);

      withPdfReplaced += `<a class="paperlink-pdf-link" href="#"
          data-pdf-path="${escapedPath}"
          data-pdf-anchor="${escapedAnchor}"
          title="Open ${escapedPath} at page ${anchor?.page || '?'}"
          style="
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 1px 6px;
            background: rgba(0, 122, 204, 0.1);
            border: 1px solid rgba(0, 122, 204, 0.3);
            border-radius: 4px;
            color: #007acc;
            text-decoration: none;
            font-size: 0.9em;
            cursor: pointer;
          ">
          <span style="font-size: 0.85em;">&#128196;</span>
          ${md.utils.escapeHtml(displayText)}
        </a>`;
      cursor = match.index + match.fullMatch.length;
    }
    withPdfReplaced += md.utils.escapeHtml(content.slice(cursor));

    // Replace @code[[…]] tokens with styled links
    const codeRegex = new RegExp(CODE_LINK_REGEX.source, CODE_LINK_REGEX.flags);
    if (!codeRegex.test(withPdfReplaced)) {
      return withPdfReplaced;
    }

    const codeRegex2 = new RegExp(CODE_LINK_REGEX.source, CODE_LINK_REGEX.flags);
    const html = withPdfReplaced.replace(
      codeRegex2,
      (
        fullMatch: string,
        codePath: string,
        startLine: string | undefined,
        endLine: string | undefined,
        snippet: string | undefined
      ) => {
        const isFolder = codePath.endsWith('/');
        const displayText = snippet
          || (startLine ? `${codePath} (line ${startLine})` : (isFolder ? `${codePath}` : `${codePath}`));
        const escapedPath = md.utils.escapeHtml(codePath);

        return `<a class="paperlink-code-link" href="#"
          data-code-path="${escapedPath}"
          data-code-start-line="${startLine || ''}"
          data-code-end-line="${endLine || ''}"
          title="Open code: ${escapedPath}${startLine ? ' (line ' + startLine + ')' : ''}"
          style="
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 1px 6px;
            background: rgba(88, 166, 255, 0.1);
            border: 1px solid rgba(88, 166, 255, 0.3);
            border-radius: 4px;
            color: #58a6ff;
            text-decoration: none;
            font-size: 0.9em;
            cursor: pointer;
          ">
          <span style="font-size: 0.85em;">&#9000;</span>
          ${md.utils.escapeHtml(displayText)}
        </a>`;
      }
    );

    return html;
  };

  return md;
}
