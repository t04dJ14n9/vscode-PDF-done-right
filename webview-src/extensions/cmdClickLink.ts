/**
 * Cmd+Click Link Navigation Extension for CodeMirror 6
 *
 * Links are displayed with accent color:
 *   - On lines without cursor: rendered as clickable widgets (display text only for markdown links)
 *   - On cursor line: raw markdown syntax visible but styled with accent color for editing
 *
 * When Cmd/Ctrl+click is performed on a link, it navigates:
 *   - External URLs (http/https) → calls onOpenExternal callback
 *   - Relative paths → calls onOpenFile callback
 *
 * When hovering with Cmd/Ctrl held, cursor changes to pointer.
 * Cmd+Enter also opens the link at cursor position.
 */
import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  keymap,
} from '@codemirror/view';
import { Prec } from '@codemirror/state';
import type {
  ViewUpdate,
  DecorationSet,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// Callback type for opening files internally
export type OpenFileCallback = (filePath: string) => void;
// Callback type for opening external URLs
export type OpenExternalCallback = (url: string) => void;

export interface CmdClickLinkConfig {
  onOpenExternal?: OpenExternalCallback;
  onOpenFile?: OpenFileCallback;
  currentFilePath?: () => string;
}

/**
 * Widget that renders a styled link display text.
 */
class LinkWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly url: string,
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-rendered-link';
    span.textContent = this.text;
    span.title = this.url;
    span.dataset.url = this.url;
    return span;
  }

  override eq(other: LinkWidget): boolean {
    return this.text === other.text && this.url === other.url;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Widget that renders a raw HTTP/HTTPS URL as a clickable link.
 */
class RawUrlWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-rendered-link cm-raw-url';
    span.textContent = this.url;
    span.title = `Open ${this.url}`;
    span.dataset.url = this.url;
    return span;
  }

  override eq(other: RawUrlWidget): boolean {
    return this.url === other.url;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

// Regex to match Markdown links [text](url)
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

// Regex to match raw HTTP/HTTPS URLs (not already inside markdown link syntax)
const RAW_URL_REGEX = /https?:\/\/[^\s<>[\]()"'`]+/g;

// Decoration for styling links on the cursor line (keeps raw markdown visible but colored)
const cursorLineLinkMark = Decoration.mark({
  class: 'cm-cursor-line-link',
});

/**
 * Build decorations that replace [text](url) with styled link widgets
 * and raw HTTP(S) URLs with clickable link widgets on lines that don't contain the cursor.
 * On the cursor line, apply mark decorations to style links while keeping raw markdown visible.
 */
function buildLinkDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const cursorLine = doc.lineAt(view.state.selection.main.head).number;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const isCursorLine = i === cursorLine;

    // Collect all matches with their positions
    const matches: Array<{ from: number; to: number; widget?: WidgetType; isLink: boolean }> = [];

    // Find markdown links
    let match: RegExpExecArray | null;
    MARKDOWN_LINK_REGEX.lastIndex = 0;
    while ((match = MARKDOWN_LINK_REGEX.exec(line.text)) !== null) {
      const from = line.from + match.index;
      const to = from + match[0].length;

      if (isCursorLine) {
        // On cursor line: apply mark decoration to style the link
        matches.push({ from, to, isLink: true });
      } else {
        // On other lines: replace with widget
        const displayText = match[1] ?? '';
        const url = match[2] ?? '';
        matches.push({ from, to, widget: new LinkWidget(displayText, url), isLink: true });
      }
    }

    // Find raw URLs that are NOT inside markdown links
    RAW_URL_REGEX.lastIndex = 0;
    while ((match = RAW_URL_REGEX.exec(line.text)) !== null) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      const url = match[0];

      // Check if this URL is inside a markdown link
      const isInsideMarkdownLink = matches.some(
        (m) => m.from <= from && m.to >= to
      );

      if (!isInsideMarkdownLink) {
        if (isCursorLine) {
          // On cursor line: apply mark decoration to style the URL
          matches.push({ from, to, isLink: true });
        } else {
          // On other lines: replace with widget
          matches.push({ from, to, widget: new RawUrlWidget(url), isLink: true });
        }
      }
    }

    // Sort by position and add to builder
    matches.sort((a, b) => a.from - b.from);
    for (const m of matches) {
      if (m.widget) {
        builder.add(m.from, m.to, Decoration.replace({ widget: m.widget }));
      } else if (m.isLink) {
        // Apply mark decoration for cursor line links
        builder.add(m.from, m.to, cursorLineLinkMark);
      }
    }
  }

  return builder.finish();
}

/**
 * Find the URL at the current cursor position.
 * Returns the URL string if found, null otherwise.
 */
function findUrlAtCursor(view: EditorView): string | null {
  const doc = view.state.doc;
  const cursorPos = view.state.selection.main.head;
  const line = doc.lineAt(cursorPos);

  // Check for markdown link at cursor
  MARKDOWN_LINK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK_REGEX.exec(line.text)) !== null) {
    const linkStart = line.from + match.index;
    const linkEnd = linkStart + match[0].length;

    if (cursorPos >= linkStart && cursorPos <= linkEnd) {
      return match[2] ?? null;
    }
  }

  // Check for raw URL at cursor
  RAW_URL_REGEX.lastIndex = 0;
  while ((match = RAW_URL_REGEX.exec(line.text)) !== null) {
    const urlStart = line.from + match.index;
    const urlEnd = urlStart + match[0].length;

    if (cursorPos >= urlStart && cursorPos <= urlEnd) {
      return match[0];
    }
  }

  return null;
}

/**
 * Navigate to a URL using the provided config callbacks.
 */
function navigateToUrl(url: string, config: CmdClickLinkConfig) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    config.onOpenExternal?.(url);
  } else {
    // Relative file path
    if (config.onOpenFile) {
      const currentPath = config.currentFilePath?.() ?? '';
      const dir = currentPath.substring(0, currentPath.lastIndexOf('/'));
      const resolvedPath = url.startsWith('/') ? url : `${dir}/${url}`;
      config.onOpenFile(resolvedPath);
    }
  }
}

/**
 * Creates the Cmd+Click link navigation extension.
 */
export function cmdClickLink(config: CmdClickLinkConfig = {}) {
  const decorationPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildLinkDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = buildLinkDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );

  const clickHandler = EditorView.domEventHandlers({
    mousedown(event: MouseEvent, view: EditorView) {
      // Only handle Cmd+Click (macOS) or Ctrl+Click (Windows/Linux)
      if (!event.metaKey && !event.ctrlKey) return false;

      const target = event.target as HTMLElement;

      // Check if clicked on a rendered link widget
      const linkEl = target.closest<HTMLElement>('.cm-rendered-link');
      if (linkEl && linkEl.dataset.url) {
        event.preventDefault();
        event.stopPropagation();

        const url = linkEl.dataset.url;
        navigateToUrl(url, config);
        return true;
      }

      // Also handle clicks on raw link text when cursor is on the line
      // Try to extract URL from the line at click position
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      const line = view.state.doc.lineAt(pos);

      // Check markdown links
      MARKDOWN_LINK_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MARKDOWN_LINK_REGEX.exec(line.text)) !== null) {
        const linkStart = line.from + match.index;
        const linkEnd = linkStart + match[0].length;

        if (pos >= linkStart && pos <= linkEnd) {
          event.preventDefault();
          event.stopPropagation();
          navigateToUrl(match[2] ?? '', config);
          return true;
        }
      }

      // Check raw URLs
      RAW_URL_REGEX.lastIndex = 0;
      while ((match = RAW_URL_REGEX.exec(line.text)) !== null) {
        const urlStart = line.from + match.index;
        const urlEnd = urlStart + match[0].length;

        if (pos >= urlStart && pos <= urlEnd) {
          event.preventDefault();
          event.stopPropagation();
          navigateToUrl(match[0], config);
          return true;
        }
      }

      return false;
    },

    mousemove(event: MouseEvent) {
      const target = event.target as HTMLElement;
      const isModKeyHeld = event.metaKey || event.ctrlKey;

      // When Cmd/Ctrl is held, change cursor on links
      const linkEl = target.closest<HTMLElement>('.cm-rendered-link');
      if (linkEl && isModKeyHeld) {
        linkEl.style.cursor = 'pointer';
        linkEl.style.textDecoration = 'underline';
      } else if (linkEl) {
        linkEl.style.cursor = '';
      }

      return false;
    },
  });

  // Keyboard shortcut: Cmd+Enter to open link at cursor
  // Use highest priority to override vim mode's keymap
  const keyboardHandler = Prec.highest(keymap.of([
    {
      key: 'Mod-Enter',
      run(view: EditorView): boolean {
        const url = findUrlAtCursor(view);
        if (url) {
          navigateToUrl(url, config);
          return true;
        }
        return false;
      },
    },
  ]));

  const linkStyles = EditorView.baseTheme({
    '.cm-rendered-link': {
      color: 'var(--paperlink-link-color, var(--vscode-textLink-foreground, #3794ff))',
      textDecoration: 'underline',
      textDecorationColor: 'var(--paperlink-link-color, var(--vscode-textLink-foreground, #3794ff))',
      textUnderlineOffset: '2px',
      cursor: 'default',
    },
    '.cm-rendered-link:hover': {
      opacity: '0.8',
    },
    '.cm-raw-url': {
      color: 'var(--paperlink-link-color, var(--vscode-textLink-foreground, #3794ff))',
    },
    // Style for links on the cursor line (keeps raw markdown visible but colored)
    // Use !important and target child spans to override syntax highlighting token colors
    '.cm-cursor-line-link, .cm-cursor-line-link span, .cm-cursor-line-link *': {
      color: 'var(--paperlink-link-color, var(--vscode-textLink-foreground, #3794ff)) !important',
    },
    '.cm-cursor-line-link': {
      textDecoration: 'underline',
      textDecorationColor: 'var(--paperlink-link-color, var(--vscode-textLink-foreground, #3794ff))',
      textUnderlineOffset: '2px',
    },
  });

  return [decorationPlugin, clickHandler, keyboardHandler, linkStyles];
}
