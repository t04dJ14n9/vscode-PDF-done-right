/**
 * Hybrid Rendering Extension for CodeMirror 6
 *
 * Provides Obsidian-style live preview:
 *   - On non-active lines: markdown syntax characters are hidden and content
 *     is styled (rendered mode)
 *   - On the active (cursor) line: raw markdown is shown with syntax
 *     highlighting (source mode)
 *   - When text is selected across lines: all affected lines show raw markdown
 *     (source mode) to prevent decoration interference with selection
 *
 * Handles:
 * - Headings: hide # markers, apply heading font size
 * - Bold: hide ** markers, apply bold style
 * - Italic: hide * or _ markers, apply italic style
 * - Strikethrough: hide ~~ markers, apply strikethrough style
 * - Blockquote: hide > marker, apply left border style
 * - Horizontal rule: replace --- with styled line
 * - Inline code: hide backtick markers, apply background highlight
 * - Links: hide [text](url) syntax, show only text
 * - Images: replace ![alt](url) with inline image widget
 * - Lists: replace - / * / 1. markers with styled bullet/number widgets
 * - Task lists: replace - [ ] / - [x] with checkbox widget
 * - Tables: apply table-like styling
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
import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';

// ─── Widgets ─────────────────────────────────────────────────────────────────

/**
 * Widget for horizontal rule.
 */
class HorizontalRuleWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-hybrid-hr';
    return el;
  }

  override eq(): boolean {
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Widget for task list checkbox.
 */
class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly lineFrom: number) {
    super();
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.className = 'cm-hybrid-task-checkbox';
    el.checked = this.checked;
    // Make interactive — clicking toggles the checkbox in the document
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Find the view and dispatch a transaction to toggle [ ] ↔ [x]
      const view = (el as any).cmView?.view as EditorView | undefined;
      if (view) {
        const doc = view.state.doc;
        // Find the line that contains this checkbox
        const line = doc.lineAt(this.lineFrom);
        const text = line.text;
        const toggleMatch = /\[(?: |x|X|1)\]/.exec(text);
        if (!toggleMatch) return;
        const replaceWith = this.checked ? '[ ]' : '[x]';
        view.dispatch({
          changes: {
            from: line.from + toggleMatch.index,
            to: line.from + toggleMatch.index + toggleMatch[0].length,
            insert: replaceWith,
          },
        });
      }
    });
    return el;
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return this.checked === other.checked;
  }

  override ignoreEvent(): boolean {
    return false; // allow clicks for toggle support
  }
}

/**
 * Widget for an unordered list bullet point.
 */
class BulletWidget extends WidgetType {
  constructor(readonly indent: number) {
    super();
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-hybrid-bullet';
    el.textContent = '•';
    return el;
  }

  override eq(other: BulletWidget): boolean {
    return this.indent === other.indent;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Widget for an ordered list number.
 */
class NumberWidget extends WidgetType {
  constructor(readonly number: number, readonly indent: number) {
    super();
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-hybrid-number';
    el.textContent = `${this.number}.`;
    return el;
  }

  override eq(other: NumberWidget): boolean {
    return this.number === other.number && this.indent === other.indent;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Widget for inline image preview.
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly alt: string,
    readonly url: string,
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'cm-hybrid-image';
    container.dataset.url = this.url;

    const img = document.createElement('img');
    img.src = this.url;
    img.alt = this.alt;
    img.className = 'cm-hybrid-image-img';
    img.onerror = () => {
      // Fallback: show alt text if image fails to load
      img.style.display = 'none';
      const fallback = document.createElement('span');
      fallback.className = 'cm-hybrid-image-fallback';
      fallback.textContent = this.alt || this.url;
      container.appendChild(fallback);
    };

    container.appendChild(img);
    return container;
  }

  override eq(other: ImageWidget): boolean {
    return this.url === other.url && this.alt === other.alt;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

// ─── Pre-built decorations (reused across lines) ─────────────────────────────

const boldMark = Decoration.mark({ class: 'cm-hybrid-bold' });
const italicMark = Decoration.mark({ class: 'cm-hybrid-italic' });
const strikethroughMark = Decoration.mark({ class: 'cm-hybrid-strikethrough' });
const inlineCodeMark = Decoration.mark({ class: 'cm-hybrid-inline-code' });
const blockquoteLineDeco = Decoration.line({ class: 'cm-hybrid-blockquote-line' });
const listLineDeco = Decoration.line({ class: 'cm-hybrid-list-line' });
const taskListLineDeco = Decoration.line({ class: 'cm-hybrid-task-list-line' });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get all line numbers that contain the cursor or part of a selection.
 */
function getActiveLineNumbers(view: EditorView): Set<number> {
  const doc = view.state.doc;
  const activeLines = new Set<number>();

  for (const range of view.state.selection.ranges) {
    const startLine = doc.lineAt(range.from).number;
    const endLine = doc.lineAt(range.to).number;
    for (let l = startLine; l <= endLine; l++) {
      activeLines.add(l);
    }
  }

  return activeLines;
}

/**
 * Determine the emphasis style (bold, italic, or both) for content inside
 * EmphasisMark delimiters by examining the delimiter text.
 */
function getEmphasisClass(text: string): string {
  if (text.length >= 3) return 'cm-hybrid-bold-italic'; // *** or ___
  if (text.length === 2) return 'cm-hybrid-bold';       // ** or __
  return 'cm-hybrid-italic';                              // * or _
}

/**
 * Check if a position range overlaps with any of the given ranges.
 */
function overlapsAny(pos: { from: number; to: number }, ranges: Array<{ from: number; to: number }>): boolean {
  return ranges.some(r => pos.from < r.to && pos.to > r.from);
}

/**
 * Calculate list indentation level from leading whitespace.
 * Each 2 spaces or 1 tab = one level of nesting.
 */
function getIndentLevel(indent: string): number {
  let level = 0;
  for (const ch of indent) {
    if (ch === '\t') {
      level++;
    } else {
      level += 0.5; // 2 spaces = 1 level
    }
  }
  return Math.floor(level);
}

// ─── Decoration Builder ─────────────────────────────────────────────────────

/**
 * Build decorations that hide markdown syntax on non-active lines.
 */
function buildHybridDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const activeLines = getActiveLineNumbers(view);
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);

      // Always apply line-level decorations regardless of cursor
      // so that line height doesn't jump when cursor enters/leaves
      applyLineDecorations(line, decorations);

      if (!activeLines.has(line.number)) {
        try {
          processLine(view, tree, line, decorations);
        } catch (e) {
          console.error('[hybridRendering] Error processing line', line.number, e);
        }
      }

      pos = line.to + 1;
    }
  }

  return Decoration.set(decorations, true);
}

/**
 * Apply line-level decorations that persist on ALL lines (including cursor line).
 * This prevents visual jumps when the cursor enters/leaves a line.
 */
function applyLineDecorations(
  line: { from: number; text: string },
  decorations: Range<Decoration>[],
) {
  const text = line.text;

  // Headings
  const headingMatch = text.match(/^(#{1,6})\s/);
  if (headingMatch) {
    const level = headingMatch[1]!.length;
    decorations.push(
      Decoration.line({
        class: `cm-hybrid-heading-line cm-hybrid-heading-line-${level}`,
      }).range(line.from),
    );
    return; // headings can't be lists/blockquotes at the same time
  }

  // Blockquote lines — always apply so the border stays when cursor is on the line
  const bqMatch = text.match(/^(\s*(?:>\s*)+)/);
  if (bqMatch) {
    decorations.push(blockquoteLineDeco.range(line.from));
  }

  // Task list lines
  const taskMatch = text.match(/^(\s*)([-*+])\s+\[([ xX1])\]\s/);
  if (taskMatch) {
    decorations.push(taskListLineDeco.range(line.from));
    return;
  }

  // Regular list lines (not task lists) — but not inside blockquotes
  const listMatch = text.match(/^(\s*)([-*+]|\d+[.)])\s/);
  if (listMatch && !taskMatch && !bqMatch) {
    decorations.push(listLineDeco.range(line.from));
  }
}

// Debug counters
let processLineCallCount = 0;
let emphasisMarkCount = 0;
let applyInlineCallCount = 0;
let emphasisNodeCount = 0;
let boldMarkCount = 0;
let italicMarkCount = 0;
const delimiterLenDistribution: Record<number, number> = {};

let lastReplacedRanges: Array<{ from: number; to: number }> = [];

export function getHybridDebugStats() {
  return { processLineCallCount, emphasisMarkCount, applyInlineCallCount, emphasisNodeCount, boldMarkCount, italicMarkCount, delimiterLens: delimiterLenDistribution, lastReplacedRanges };
}

export function resetHybridDebugStats() {
  processLineCallCount = 0;
  emphasisMarkCount = 0;
  applyInlineCallCount = 0;
  emphasisNodeCount = 0;
  boldMarkCount = 0;
  italicMarkCount = 0;
  for (const key in delimiterLenDistribution) delete delimiterLenDistribution[key];
}

/**
 * Process a single non-active line to hide markdown syntax.
 * Pushes decorations into the provided array.
 */
function processLine(
  view: EditorView,
  tree: ReturnType<typeof syntaxTree>,
  line: { from: number; to: number; text: string; number: number },
  decorations: Range<Decoration>[],
) {
  processLineCallCount++;
  const doc = view.state.doc;
  const text = line.text;

  // ── Horizontal Rule (---, ***, ___) ──
  if (/^\s*[-*_]\s*[-*_]\s*[-*_][\s\-*_]*$/.test(text) && /^[\s\-*_]+$/.test(text)) {
    decorations.push(
      Decoration.replace({
        widget: new HorizontalRuleWidget(),
      }).range(line.from, line.to),
    );
    return;
  }

  // Track ranges already decorated to avoid overlaps
  const replacedRanges: Array<{ from: number; to: number }> = [];

  // ── ATX Headings: # Heading ──
  const headingMatch = text.match(/^(#{1,6})\s/);
  if (headingMatch) {
    const prefixLen = headingMatch[0].length;
    decorations.push(
      Decoration.replace({}).range(line.from, line.from + prefixLen),
    );
    replacedRanges.push({ from: line.from, to: line.from + prefixLen });
  }

  // ── Blockquote: > text or >> text ──
  const bqMatch = text.match(/^(\s*(?:>\s*)+)/);
  if (bqMatch && !headingMatch) {
    const prefixLen = bqMatch[1]!.length;
    decorations.push(
      Decoration.replace({}).range(line.from, line.from + prefixLen),
    );
    replacedRanges.push({ from: line.from, to: line.from + prefixLen });
  }

  // ── Task list: - [x] text / - [1] text / - [ ] text ──
  const taskMatch = text.match(/^(\s*)([-*+])\s+\[([ xX1])\]\s/);
  if (taskMatch && !headingMatch) {
    const fullPrefix = taskMatch[0];
    const checked = taskMatch[3] !== ' ' && taskMatch[3] !== undefined;
    const indent = taskMatch[1]!;
    const indentLevel = getIndentLevel(indent);

    // Replace the entire prefix (whitespace + marker + [x] + space) with a checkbox widget
    decorations.push(
      Decoration.replace({
        widget: new TaskCheckboxWidget(checked, line.from),
      }).range(line.from, line.from + fullPrefix.length),
    );
    replacedRanges.push({ from: line.from, to: line.from + fullPrefix.length });

    // Add indentation for nested task lists (merge with task-list-line class)
    if (indentLevel > 0) {
      decorations.push(
        Decoration.line({
          class: `cm-hybrid-task-list-line cm-hybrid-list-indent-${Math.min(indentLevel, 6)}`,
        }).range(line.from),
      );
    }
  } else {
    // ── Regular list: - text / * text / 1. text ──
    const listMatch = text.match(/^(\s*)([-*+]|\d+[.)])\s/);
    if (listMatch && !headingMatch && !bqMatch) {
      const indent = listMatch[1]!;
      const marker = listMatch[2]!;
      const indentLen = indent.length;
      const markerLen = marker.length;
      const prefixLen = indentLen + markerLen + 1; // +1 for the space after marker
      const indentLevel = getIndentLevel(indent);

      if (/^\d+[.)]$/.test(marker)) {
        // Ordered list — replace with number widget
        const num = parseInt(marker, 10);
        decorations.push(
          Decoration.replace({
            widget: new NumberWidget(num, indentLevel),
          }).range(line.from + indentLen, line.from + prefixLen),
        );
      } else {
        // Unordered list — replace with bullet widget
        decorations.push(
          Decoration.replace({
            widget: new BulletWidget(indentLevel),
          }).range(line.from + indentLen, line.from + prefixLen),
        );
      }
      replacedRanges.push({ from: line.from + indentLen, to: line.from + prefixLen });

      // Add indentation for nested lists (merge with list-line class)
      if (indentLevel > 0) {
        decorations.push(
          Decoration.line({
            class: `cm-hybrid-list-line cm-hybrid-list-indent-${Math.min(indentLevel, 6)}`,
          }).range(line.from),
        );
      }
    }
  }

  // ── Image: ![alt](url) ──
  // Process images BEFORE links because the Lezer parser treats Image as a
  // separate node type. We need to replace the entire image syntax with a widget.
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imageRegex.exec(text)) !== null) {
    const from = line.from + imgMatch.index;
    const to = from + imgMatch[0].length;
    if (!overlapsAny({ from, to }, replacedRanges)) {
      decorations.push(
        Decoration.replace({
          widget: new ImageWidget(imgMatch[1] ?? '', imgMatch[2] ?? ''),
        }).range(from, to),
      );
      replacedRanges.push({ from, to });
    }
  }

  // ── Table rows ──
  const tableCellRegex = /\|/g;
  let tableMatch: RegExpExecArray | null;
  const pipePositions: number[] = [];
  while ((tableMatch = tableCellRegex.exec(text)) !== null) {
    pipePositions.push(line.from + tableMatch.index);
  }
  if (pipePositions.length >= 2) {
    // Determine if this is a header row, separator row, or data row
    const isSeparator = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(text);
    const isHeader = !isSeparator && pipePositions.length >= 2 &&
      (line.number === 1 || !doc.line(line.number - 1).text.match(/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/));

    if (isSeparator) {
      decorations.push(
        Decoration.line({ class: 'cm-hybrid-table-separator-line' }).range(line.from),
      );
    } else if (isHeader) {
      decorations.push(
        Decoration.line({ class: 'cm-hybrid-table-header-line' }).range(line.from),
      );
    } else {
      decorations.push(
        Decoration.line({ class: 'cm-hybrid-table-line' }).range(line.from),
      );
    }

    // Hide the | delimiters (skip the first and last if they are edge pipes)
    for (let i = 0; i < pipePositions.length; i++) {
      const pos = pipePositions[i]!;
      // Skip edge pipes at the very start or end of the line
      if (i === 0 && text.trimStart().startsWith('|')) {
        decorations.push(Decoration.replace({}).range(pos, pos + 1));
        replacedRanges.push({ from: pos, to: pos + 1 });
      } else if (i === pipePositions.length - 1 && text.trimEnd().endsWith('|')) {
        decorations.push(Decoration.replace({}).range(pos, pos + 1));
        replacedRanges.push({ from: pos, to: pos + 1 });
      } else {
        decorations.push(Decoration.replace({}).range(pos, pos + 1));
        replacedRanges.push({ from: pos, to: pos + 1 });
      }
    }
  }

  // ── Collect inline decorations from the syntax tree ──
  const inlineDecos: Array<{ from: number; to: number; type: string }> = [];

  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      const nodeName = node.name;

      // Image: already handled above by regex
      if (nodeName === 'Image') {
        return false;
      }

      // Link: hide [ and ](url) delimiters, keep display text
      if (nodeName === 'Link') {
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (cursor.name === 'LinkMark') {
              inlineDecos.push({ from: cursor.from, to: cursor.to, type: 'cm-hybrid-link-delimiter' });
            }
          } while (cursor.nextSibling());
        }
        return false;
      }

      // StrongEmphasis / Emphasis: hide their delimiter ranges
      if (nodeName === 'StrongEmphasis' || nodeName === 'Emphasis') {
        const cursor = node.node.cursor();
        const marks: Array<{ from: number; to: number }> = [];
        let hasNonMark = false;
        if (cursor.firstChild()) {
          do {
            if (cursor.name === 'EmphasisMark') {
              marks.push({ from: cursor.from, to: cursor.to });
            } else {
              hasNonMark = true;
            }
          } while (cursor.nextSibling());
        }

        if (marks.length >= 2) {
          let openTo: number;
          let closeFrom: number;
          if (hasNonMark) {
            // Consecutive opening marks from the start
            openTo = node.from;
            for (const mark of marks) {
              if (mark.from === openTo) {
                openTo = mark.to;
              } else {
                break;
              }
            }
            // Consecutive closing marks from the end
            closeFrom = node.to;
            for (let i = marks.length - 1; i >= 0; i--) {
              if (marks[i].to === closeFrom) {
                closeFrom = marks[i].from;
              } else {
                break;
              }
            }
          } else {
            // No non-mark children: split marks in half
            const half = Math.floor(marks.length / 2);
            openTo = marks[half - 1].to;
            closeFrom = marks[half].from;
          }

          const cls = nodeName === 'StrongEmphasis' ? 'cm-hybrid-bold' : 'cm-hybrid-italic';
          inlineDecos.push({ from: node.from, to: openTo, type: cls });
          inlineDecos.push({ from: closeFrom, to: node.to, type: cls });
        }
      }

      // StrikethroughMark: ~~ delimiters
      if (nodeName === 'StrikethroughMark') {
        inlineDecos.push({ from: node.from, to: node.to, type: 'cm-hybrid-strikethrough' });
      }

      // CodeMark: backtick delimiters for inline code
      if (nodeName === 'CodeMark') {
        const parent = node.node.parent;
        if (parent && parent.name === 'InlineCode') {
          inlineDecos.push({ from: node.from, to: node.to, type: 'cm-hybrid-inline-code' });
        }
      }
    },
  });

  // Regex-based fallback for bold if tree didn't catch any **
  if (!inlineDecos.some(d => d.type === 'cm-hybrid-bold')) {
    const boldRegex = /\*\*(?=\S)(.*?\S)\*\*/g;
    let boldMatch: RegExpExecArray | null;
    while ((boldMatch = boldRegex.exec(text)) !== null) {
      const absFrom = line.from + boldMatch.index;
      inlineDecos.push({ from: absFrom, to: absFrom + 2, type: 'cm-hybrid-bold' });
      const closeFrom = absFrom + boldMatch[0].length - 2;
      inlineDecos.push({ from: closeFrom, to: closeFrom + 2, type: 'cm-hybrid-bold' });
    }
  }

  // Regex-based fallback for italic if tree didn't catch any *
  if (!inlineDecos.some(d => d.type === 'cm-hybrid-italic')) {
    const italicRegex = /(?<!\*)\*(?=\S)(.*?\S)\*(?!\*)/g;
    let italicMatch: RegExpExecArray | null;
    while ((italicMatch = italicRegex.exec(text)) !== null) {
      const absFrom = line.from + italicMatch.index;
      inlineDecos.push({ from: absFrom, to: absFrom + 1, type: 'cm-hybrid-italic' });
      const closeFrom = absFrom + italicMatch[0].length - 1;
      inlineDecos.push({ from: closeFrom, to: closeFrom + 1, type: 'cm-hybrid-italic' });
    }
  }

  // Regex-based fallback for strikethrough if tree didn't catch any ~~
  if (!inlineDecos.some(d => d.type === 'cm-hybrid-strikethrough')) {
    const stRegex = /~~(?=\S)(.*?\S)~~/g;
    let stMatch: RegExpExecArray | null;
    while ((stMatch = stRegex.exec(text)) !== null) {
      const absFrom = line.from + stMatch.index;
      inlineDecos.push({ from: absFrom, to: absFrom + 2, type: 'cm-hybrid-strikethrough' });
      const closeFrom = absFrom + stMatch[0].length - 2;
      inlineDecos.push({ from: closeFrom, to: closeFrom + 2, type: 'cm-hybrid-strikethrough' });
    }
  }

  // Sort by position
  inlineDecos.sort((a, b) => a.from - b.from || a.to - b.to);

  // Add inline decorations, skipping overlaps with already-decorated ranges
  for (const d of inlineDecos) {
    if (overlapsAny(d, replacedRanges)) continue;

    // Hide the delimiter by replacing it with an empty widget
    decorations.push(
      Decoration.replace({
        widget: new (class extends WidgetType {
          override toDOM() {
            return document.createElement('span');
          }
          override eq() { return true; }
          override ignoreEvent() { return true; }
        })(),
      }).range(d.from, d.to),
    );

    replacedRanges.push(d);
  }

  // ── Apply mark (style) decorations for bold/italic/strikethrough/inline-code ──
  applyInlineMarkDecorations(view, tree, line, decorations, replacedRanges);
}

/**
 * Apply mark decorations (bold, italic, strikethrough, inline code styles)
 * to the content between delimiter pairs.
 */
function applyInlineMarkDecorations(
  view: EditorView,
  tree: ReturnType<typeof syntaxTree>,
  line: { from: number; to: number; text: string; number: number },
  decorations: Range<Decoration>[],
  replacedRanges: Array<{ from: number; to: number }>,
) {
  applyInlineCallCount++;
  lastReplacedRanges = replacedRanges;
  // Collect emphasis content ranges from the syntax tree
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      // Skip Link and Image — handled by other extensions
      if (node.name === 'Link' || node.name === 'Image') {
        return false;
      }

      // Emphasis / StrongEmphasis node contains the entire bold/italic block including delimiters
      if (node.name === 'Emphasis' || node.name === 'StrongEmphasis') {
        emphasisNodeCount++;
        // Find delimiter lengths by looking at EmphasisMark children.
        // The parser may represent ** as either one EmphasisMark(length=2)
        // or two EmphasisMark(length=1) nodes, and content may or may not
        // appear as explicit child nodes. We handle both cases robustly.
        const cursor = node.node.cursor();
        const marks: Array<{ from: number; to: number }> = [];
        let hasNonMark = false;
        if (cursor.firstChild()) {
          do {
            if (cursor.name === 'EmphasisMark') {
              marks.push({ from: cursor.from, to: cursor.to });
            } else {
              hasNonMark = true;
            }
          } while (cursor.nextSibling());
        }

        if (marks.length >= 2) {
          let contentFrom: number;
          let contentTo: number;
          let openLen: number;
          let closeLen: number;

          if (hasNonMark) {
            // Consecutive opening marks from the start
            contentFrom = node.from;
            for (const mark of marks) {
              if (mark.from === contentFrom) {
                contentFrom = mark.to;
              } else {
                break;
              }
            }
            openLen = contentFrom - node.from;

            // Consecutive closing marks from the end
            contentTo = node.to;
            for (let i = marks.length - 1; i >= 0; i--) {
              if (marks[i].to === contentTo) {
                contentTo = marks[i].from;
              } else {
                break;
              }
            }
            closeLen = node.to - contentTo;
          } else {
            // No non-mark children: split marks in half
            const half = Math.floor(marks.length / 2);
            contentFrom = marks[half - 1].to;
            contentTo = marks[half].from;
            openLen = contentFrom - node.from;
            closeLen = node.to - contentTo;
          }

          const delimiterLen = Math.max(openLen, closeLen);
          delimiterLenDistribution[delimiterLen] = (delimiterLenDistribution[delimiterLen] || 0) + 1;

          if (delimiterLen >= 3) {
            // Bold + Italic (*** or ___)
            if (!overlapsAny({ from: contentFrom, to: contentTo }, replacedRanges)) {
              decorations.push(boldMark.range(contentFrom, contentTo));
              decorations.push(italicMark.range(contentFrom, contentTo));
              boldMarkCount++;
              italicMarkCount++;
            }
          } else if (delimiterLen === 2) {
            // Bold
            if (!overlapsAny({ from: contentFrom, to: contentTo }, replacedRanges)) {
              decorations.push(boldMark.range(contentFrom, contentTo));
              boldMarkCount++;
            }
          } else if (delimiterLen === 1) {
            // Italic
            if (!overlapsAny({ from: contentFrom, to: contentTo }, replacedRanges)) {
              decorations.push(italicMark.range(contentFrom, contentTo));
              italicMarkCount++;
            }
          }
        }
      }

      // Strikethrough content
      if (node.name === 'Strikethrough') {
        let contentFrom = node.from;
        let contentTo = node.to;

        const cursor = node.node.cursor();
        let firstMark = true;
        if (cursor.firstChild()) {
          do {
            if (cursor.name === 'StrikethroughMark') {
              if (firstMark) {
                contentFrom = cursor.to;
                firstMark = false;
              } else {
                contentTo = cursor.from;
              }
            }
          } while (cursor.nextSibling());
        }

        if (!overlapsAny({ from: contentFrom, to: contentTo }, replacedRanges)) {
          decorations.push(strikethroughMark.range(contentFrom, contentTo));
        }
      }

      // InlineCode content
      if (node.name === 'InlineCode') {
        // Apply inline code mark to the ENTIRE InlineCode range including delimiters
        // This ensures the background color covers the full span
        if (!overlapsAny({ from: node.from, to: node.to }, replacedRanges)) {
          decorations.push(inlineCodeMark.range(node.from, node.to));
        } else {
          // Even if some parts overlap, try to mark the content portion
          let contentFrom = node.from;
          let contentTo = node.to;

          const cursor = node.node.cursor();
          let firstMark = true;
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'CodeMark') {
                if (firstMark) {
                  contentFrom = cursor.to;
                  firstMark = false;
                } else {
                  contentTo = cursor.from;
                }
              }
            } while (cursor.nextSibling());
          }

          if (!overlapsAny({ from: contentFrom, to: contentTo }, replacedRanges)) {
            decorations.push(inlineCodeMark.range(contentFrom, contentTo));
          }
        }
      }
    },
  });

  // Fallback for strikethrough via regex (if syntax tree didn't catch it)
  const stRegex = /~~(?=\S)(.*?\S)~~/g;
  let stMatch: RegExpExecArray | null;
  while ((stMatch = stRegex.exec(line.text)) !== null) {
    const contentFrom = line.from + stMatch.index + 2;
    const contentTo = contentFrom + stMatch[1]!.length;
    if (!overlapsAny({ from: contentFrom, to: contentTo }, replacedRanges)) {
      decorations.push(strikethroughMark.range(contentFrom, contentTo));
    }
  }
}

// ─── Extension Factory ───────────────────────────────────────────────────────

/**
 * Creates the hybrid rendering CM6 extension.
 */
export function hybridRendering() {
  class HybridRenderingPlugin {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildHybridDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged
      ) {
        this.decorations = buildHybridDecorations(update.view);
      }
    }
  }

  const decorationPlugin = ViewPlugin.fromClass(
    HybridRenderingPlugin,
    {
      decorations: (v: HybridRenderingPlugin) => v.decorations,
    },
  );

  const hybridStyles = EditorView.baseTheme({
    // ── Heading line styles ──
    '.cm-hybrid-heading-line': {
      fontWeight: 'bold',
      lineHeight: '1.5',
      paddingTop: '0.25em',
      paddingBottom: '0.1em',
      textDecoration: 'none',
    },
    '.cm-hybrid-heading-line *': {
      textDecoration: 'none',
    },
    '.cm-hybrid-heading-line-1': {
      fontSize: '1.4em',
    },
    '.cm-hybrid-heading-line-2': {
      fontSize: '1.25em',
    },
    '.cm-hybrid-heading-line-3': {
      fontSize: '1.15em',
    },
    '.cm-hybrid-heading-line-4': {
      fontSize: '1.08em',
    },
    '.cm-hybrid-heading-line-5': {
      fontSize: '1.03em',
    },
    '.cm-hybrid-heading-line-6': {
      fontSize: '1em',
      color: 'var(--paperlink-text-muted, #888)',
    },

    // ── Bold / Italic / Bold-Italic / Strikethrough ──
    '.cm-hybrid-bold': {
      fontWeight: 'bold',
    },
    '.cm-hybrid-italic': {
      fontStyle: 'italic',
    },
    '.cm-hybrid-bold-italic': {
      fontWeight: 'bold',
      fontStyle: 'italic',
    },
    '.cm-hybrid-strikethrough': {
      textDecoration: 'line-through',
      opacity: '0.7',
    },

    // ── Inline code ──
    '.cm-hybrid-inline-code': {
      backgroundColor: 'var(--paperlink-inline-code-bg, rgba(255,255,255,0.12))',
      borderRadius: '4px',
      padding: '2px 6px',
      fontFamily: 'var(--paperlink-font-mono, monospace)',
      fontSize: '0.85em',
      color: 'var(--paperlink-text, #e06c75)',
    },
    '&dark .cm-hybrid-inline-code': {
      backgroundColor: 'var(--paperlink-inline-code-bg, rgba(255,255,255,0.12))',
      color: '#ff7b72',
    },
    '&light .cm-hybrid-inline-code': {
      backgroundColor: 'var(--paperlink-inline-code-bg, rgba(0,0,0,0.08))',
      color: '#d73a49',
    },

    // ── Blockquote ──
    '.cm-hybrid-blockquote-line': {
      borderLeft: '3px solid var(--paperlink-border, #7f6df2)',
      paddingLeft: '12px',
      color: 'var(--paperlink-text-muted, #999)',
      fontStyle: 'italic',
    },

    // ── List lines ──
    '.cm-hybrid-list-line': {
      paddingBottom: '2px',
    },

    // ── List indentation (nested lists) ──
    '.cm-hybrid-list-indent-1': {
      paddingLeft: '24px',
    },
    '.cm-hybrid-list-indent-2': {
      paddingLeft: '48px',
    },
    '.cm-hybrid-list-indent-3': {
      paddingLeft: '72px',
    },
    '.cm-hybrid-list-indent-4': {
      paddingLeft: '96px',
    },
    '.cm-hybrid-list-indent-5': {
      paddingLeft: '120px',
    },
    '.cm-hybrid-list-indent-6': {
      paddingLeft: '144px',
    },

    // ── Task list ──
    '.cm-hybrid-task-list-line': {
      // Base task list styling
    },
    '.cm-hybrid-task-checkbox': {
      marginRight: '6px',
      verticalAlign: 'middle',
      cursor: 'pointer',
      accentColor: 'var(--paperlink-link-color, #7f6df2)',
    },

    // ── Bullet widget ──
    '.cm-hybrid-bullet': {
      color: 'var(--paperlink-text-muted, #999)',
      marginRight: '8px',
      fontSize: '0.9em',
      display: 'inline-block',
      width: '1em',
      textAlign: 'center',
    },

    // ── Number widget ──
    '.cm-hybrid-number': {
      color: 'var(--paperlink-text-muted, #999)',
      marginRight: '4px',
      fontWeight: '500',
      fontSize: '0.9em',
    },

    // ── Images ──
    '.cm-hybrid-image': {
      display: 'inline-block',
      maxWidth: '100%',
    },
    '.cm-hybrid-image-img': {
      maxWidth: '100%',
      maxHeight: '300px',
      borderRadius: '4px',
      border: '1px solid var(--paperlink-border, #444)',
      display: 'block',
    },
    '.cm-hybrid-image-fallback': {
      color: 'var(--paperlink-text-muted, #888)',
      fontStyle: 'italic',
      fontSize: '0.9em',
    },

    // ── Inline code content color override ──
    '&': {
      '--ink-internal-syntax-code-color': 'var(--paperlink-text, #dcddde)',
    },

    // ── Horizontal rule ──
    '.cm-hybrid-hr': {
      borderBottom: '1px solid var(--paperlink-border, #555)',
      margin: '0',
      height: '0',
    },

    // ── Hidden delimiter ──
    '.cm-hybrid-hidden-delimiter': {
      opacity: '0',
      fontSize: '0',
      display: 'inline-block',
      width: '0',
      overflow: 'hidden',
    },

    // ── Link styling (rendered mode) ──
    '.cm-hybrid-link-text': {
      color: 'var(--paperlink-link-color, #7f6df2)',
      textDecoration: 'underline',
      textDecorationColor: 'var(--paperlink-link-color, #7f6df2)',
      textUnderlineOffset: '2px',
      cursor: 'pointer',
    },
    '.cm-hybrid-link-text:hover': {
      opacity: '0.85',
    },

    // ── Tables ──
    '.cm-hybrid-table-line': {
      fontFamily: 'var(--paperlink-font-mono, monospace)',
    },
    '.cm-hybrid-table-header-line': {
      fontWeight: 'bold',
      borderBottom: '2px solid var(--paperlink-border, #555)',
    },
    '.cm-hybrid-table-separator-line': {
      borderBottom: '1px solid var(--paperlink-border, #444)',
    },
    '.cm-hybrid-table-cell': {
      padding: '4px 12px',
      borderRight: '1px solid var(--paperlink-border, #444)',
    },
    '.cm-hybrid-table-cell:last-child': {
      borderRight: 'none',
    },
  });

  return [decorationPlugin, hybridStyles];
}
