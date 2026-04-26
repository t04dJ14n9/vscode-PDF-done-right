/**
 * Code Block Fence Hiding Extension for CodeMirror 6
 *
 * When the cursor is NOT inside a fenced code block, hides the opening ```
 * and closing ``` delimiter lines, showing only the code content with
 * syntax highlighting and a styled container. Content lines get a
 * background color to form a visual block.
 *
 * When the cursor IS on any line within the code block (including delimiters),
 * all lines are shown in raw form.
 */
import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
} from '@codemirror/view';
import type {
  ViewUpdate,
  DecorationSet,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

interface CodeBlockRange {
  /** Line number of the opening ``` */
  openLine: number;
  /** Line number of the closing ``` */
  closeLine: number;
  /** Language identifier (e.g., "typescript") */
  language: string;
  /** Character position of opening ``` line start */
  openFrom: number;
  /** Character position of opening ``` line end */
  openTo: number;
  /** Character position of closing ``` line start */
  closeFrom: number;
  /** Character position of closing ``` line end */
  closeTo: number;
}

/**
 * Widget for the top border of a code block (replaces opening ```).
 * Displays just the language name (e.g. "json") in a single-line-height bar.
 */
class CodeBlockTopWidget extends WidgetType {
  constructor(readonly language: string) {
    super();
  }

  override toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'cm-code-block-top';
    const langLabel = document.createElement('span');
    langLabel.className = 'cm-code-block-lang';
    langLabel.textContent = this.language || 'code';
    div.appendChild(langLabel);
    return div;
  }

  override eq(other: CodeBlockTopWidget): boolean {
    return this.language === other.language;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Widget for the bottom border of a code block (replaces closing ```).
 */
class CodeBlockBottomWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'cm-code-block-bottom';
    div.textContent = '\u200B'; // zero-width space to maintain line height
    return div;
  }

  override eq(): boolean {
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

// Pre-built line decoration for code block content lines
const codeContentLineDeco = Decoration.line({ class: 'cm-code-block-content-line' });

/**
 * Find all fenced code block ranges in the document using regex-based approach.
 * Falls back from syntax tree to regex for robustness.
 */
function findCodeBlocks(view: EditorView): CodeBlockRange[] {
  const doc = view.state.doc;
  const blocks: CodeBlockRange[] = [];
  const fenceRegex = /^(`{3,})([\w]*)\s*$/;

  let openLine: number | null = null;
  let openFrom = 0;
  let openTo = 0;
  let language = '';

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const match = fenceRegex.exec(line.text);

    if (match) {
      if (openLine === null) {
        // Opening fence
        openLine = i;
        openFrom = line.from;
        openTo = line.to;
        language = match[2] || '';
      } else {
        // Closing fence
        blocks.push({
          openLine,
          closeLine: i,
          language,
          openFrom,
          openTo,
          closeFrom: line.from,
          closeTo: line.to,
        });
        openLine = null;
      }
    }
  }

  return blocks;
}

/**
 * Check if the cursor is within a code block (including delimiter lines).
 */
function isCursorInBlock(view: EditorView, block: CodeBlockRange): boolean {
  const doc = view.state.doc;

  for (const range of view.state.selection.ranges) {
    const startLine = doc.lineAt(range.from).number;
    const endLine = doc.lineAt(range.to).number;

    // Cursor is within the block if it's on any line from open to close (inclusive)
    if (startLine <= block.closeLine && endLine >= block.openLine) {
      return true;
    }
  }

  return false;
}

/**
 * Build decorations to hide code block fences when cursor is outside,
 * and apply background styling to content lines.
 */
function buildCodeFenceDecorations(view: EditorView): DecorationSet {
  const decorations: Array<{ from: number; to: number; deco: Decoration }> = [];
  const blocks = findCodeBlocks(view);
  const doc = view.state.doc;

  for (const block of blocks) {
    if (isCursorInBlock(view, block)) continue; // Show raw when cursor is inside

    // Replace opening ``` line with a styled top widget
    decorations.push({
      from: block.openFrom,
      to: block.openTo,
      deco: Decoration.replace({
        widget: new CodeBlockTopWidget(block.language),
      }),
    });

    // Replace closing ``` line with a styled bottom widget
    decorations.push({
      from: block.closeFrom,
      to: block.closeTo,
      deco: Decoration.replace({
        widget: new CodeBlockBottomWidget(),
      }),
    });

    // Apply line-level background decoration to content lines
    for (let i = block.openLine + 1; i < block.closeLine; i++) {
      const contentLine = doc.line(i);
      decorations.push({
        from: contentLine.from,
        to: contentLine.from,
        deco: codeContentLineDeco,
      });
    }
  }

  // Sort decorations by position (required by Decoration.set)
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);

  return Decoration.set(
    decorations.map(d => d.deco.range(d.from, d.to)),
    true,
  );
}

/**
 * Creates the code block fence hiding CM6 extension.
 */
export function codeFenceHiding() {
  const decorationPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildCodeFenceDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = buildCodeFenceDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );

  // Widget styles for the replacement widgets
  const codeFenceStyles = EditorView.baseTheme({
    '&dark': {
      '--paperlink-code-bg': 'rgba(255, 255, 255, 0.045)',
      '--paperlink-code-border': 'rgba(255, 255, 255, 0.11)',
      '--paperlink-code-chip-bg': 'rgba(255, 255, 255, 0.08)',
      '--paperlink-code-chip-border': 'rgba(255, 255, 255, 0.14)',
      '--paperlink-code-keyword': '#d7b7ff',
      '--paperlink-code-type': '#ffd37d',
      '--paperlink-code-function': '#8cc6ff',
      '--paperlink-code-name': '#d1d9e6',
      '--paperlink-code-literal': '#ffb38a',
      '--paperlink-code-string': '#d4f2a3',
      '--paperlink-code-comment': '#9ea7b3',
      '--paperlink-code-operator': '#a4e9ff',
    },
    '&light': {
      '--paperlink-code-bg': 'rgba(0, 0, 0, 0.04)',
      '--paperlink-code-border': 'rgba(0, 0, 0, 0.12)',
      '--paperlink-code-chip-bg': 'rgba(0, 0, 0, 0.06)',
      '--paperlink-code-chip-border': 'rgba(0, 0, 0, 0.12)',
      '--paperlink-code-keyword': '#7c4dff',
      '--paperlink-code-type': '#8a5a00',
      '--paperlink-code-function': '#235dd9',
      '--paperlink-code-name': '#344458',
      '--paperlink-code-literal': '#b44717',
      '--paperlink-code-string': '#2f7d32',
      '--paperlink-code-comment': '#69717d',
      '--paperlink-code-operator': '#006b8f',
    },
    '.cm-code-block-top': {
      display: 'flex',
      justifyContent: 'flex-end',
      alignItems: 'center',
      boxSizing: 'border-box',
      borderTopLeftRadius: 'var(--paperlink-radius, 6px)',
      borderTopRightRadius: 'var(--paperlink-radius, 6px)',
      backgroundColor: 'var(--paperlink-code-bg)',
      borderTop: '1px solid var(--paperlink-code-border)',
      borderLeft: '1px solid var(--paperlink-code-border)',
      borderRight: '1px solid var(--paperlink-code-border)',
      borderBottom: 'none',
      padding: '0 12px',
      lineHeight: 'inherit',
      fontFamily: 'var(--paperlink-font-mono, var(--vscode-editor-font-family, monospace))',
    },
    '.cm-code-block-lang': {
      fontSize: '10px',
      lineHeight: '1.2',
      color: 'var(--vscode-descriptionForeground, #9a9a9a)',
      fontFamily: 'var(--paperlink-font-mono, var(--vscode-editor-font-family, monospace))',
      letterSpacing: '0.2px',
      textTransform: 'lowercase',
      opacity: '0.92',
      padding: '0 7px',
      borderRadius: '6px',
      backgroundColor: 'var(--paperlink-code-chip-bg)',
      border: '1px solid var(--paperlink-code-chip-border)',
    },
    '.cm-code-block-bottom': {
      display: 'block',
      boxSizing: 'border-box',
      borderBottomLeftRadius: 'var(--paperlink-radius, 6px)',
      borderBottomRightRadius: 'var(--paperlink-radius, 6px)',
      backgroundColor: 'var(--paperlink-code-bg)',
      borderLeft: '1px solid var(--paperlink-code-border)',
      borderRight: '1px solid var(--paperlink-code-border)',
      borderBottom: '1px solid var(--paperlink-code-border)',
      padding: '0',
      lineHeight: 'inherit',
    },
    // Background for code block content lines (between fences)
    '.cm-code-block-content-line': {
      backgroundColor: 'var(--paperlink-code-bg)',
      borderLeft: '1px solid var(--paperlink-code-border)',
      borderRight: '1px solid var(--paperlink-code-border)',
      paddingLeft: '12px',
      paddingRight: '12px',
      boxSizing: 'border-box',
      fontFamily: 'var(--paperlink-font-mono, var(--vscode-editor-font-family, monospace))',
      lineHeight: 'inherit',
    },
  });

  return [decorationPlugin, codeFenceStyles];
}
