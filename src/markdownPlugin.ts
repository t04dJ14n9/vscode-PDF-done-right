import { PDF_LINK_REGEX, stringToAnchor } from './shared/types';

/**
 * Markdown-it plugin that renders @pdf[[...]] links as styled clickable
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

    // Check if content contains our PDF link pattern
    const regex = new RegExp(PDF_LINK_REGEX.source, PDF_LINK_REGEX.flags);
    if (!regex.test(content)) {
      return defaultRender(tokens, idx, options, env, self);
    }

    // Reset regex and replace matches with styled links
    const regex2 = new RegExp(PDF_LINK_REGEX.source, PDF_LINK_REGEX.flags);
    const html = content.replace(
      regex2,
      (
        fullMatch: string,
        pdfPath: string,
        anchorStr: string,
        snippet: string | undefined
      ) => {
        const anchor = stringToAnchor(anchorStr);
        const displayText = snippet || `${pdfPath} p.${anchor?.page || '?'}`;
        const escapedPath = md.utils.escapeHtml(pdfPath);
        const escapedAnchor = md.utils.escapeHtml(anchorStr);

        return `<a class="paperlink-pdf-link" href="#"
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
      }
    );

    return html;
  };

  return md;
}
