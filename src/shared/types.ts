/**
 * Shared types between extension host and webview.
 * This file is imported by both sides.
 */

/** A stable anchor pointing to a specific text range in a PDF */
export interface PdfAnchor {
  /** 1-based page number */
  page: number;
  /** Index into page.getTextContent().items[] */
  textItemIndex: number;
  /** Character offset within the text item */
  charOffset: number;
  /** Inclusive start / exclusive end range for Obsidian-style selection links. */
  endTextItemIndex?: number;
  /** Exclusive end char offset within `endTextItemIndex`. */
  endCharOffset?: number;
  /** Number of characters selected */
  length: number;
  /** The actual selected text (for fallback matching) */
  snippet: string;
  /** Unrecognized query params preserved from parsed links when available. */
  extraParams?: Record<string, string>;
}

/** Serializes an anchor to a compact string for use in links */
export function anchorToString(a: PdfAnchor): string {
  const parts = [`page=${a.page}`];

  if (typeof a.endTextItemIndex === 'number' && typeof a.endCharOffset === 'number') {
    parts.push(
      `selection=${a.textItemIndex},${a.charOffset},${a.endTextItemIndex},${a.endCharOffset}`,
    );
  } else if (a.length > 0) {
    // Best-effort fallback for legacy anchors that only store start+length.
    parts.push(
      `selection=${a.textItemIndex},${a.charOffset},${a.textItemIndex},${a.charOffset + a.length}`,
    );
  }

  if (a.extraParams) {
    for (const [key, value] of Object.entries(a.extraParams)) {
      if (value !== '') parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }

  return parts.join('&');
}

/** Parses an anchor string back to a PdfAnchor (snippet is empty) */
export function stringToAnchor(s: string): PdfAnchor | null {
  const params = new URLSearchParams(s);
  const page = parseInt(params.get('page') || '', 10);
  if (isNaN(page)) return null;

  const extraParams: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (!['page', 'selection', 'idx', 'off', 'len', 'snippet'].includes(key)) {
      extraParams[key] = value;
    }
  }

  const selection = params.get('selection');
  if (selection) {
    const parts = selection.split(',').map(p => parseInt(p.trim(), 10));
    if (parts.length !== 4 || parts.some(isNaN)) return null;
    const [startIdx, startOff, endIdx, endOff] = parts;
    return {
      page,
      textItemIndex: startIdx,
      charOffset: startOff,
      endTextItemIndex: endIdx,
      endCharOffset: endOff,
      length: startIdx === endIdx ? Math.max(0, endOff - startOff) : 0,
      snippet: params.get('snippet') || '',
      extraParams,
    };
  }

  const textItemIndex = parseInt(params.get('idx') || '', 10);
  const charOffset = parseInt(params.get('off') || '', 10);
  const length = parseInt(params.get('len') || '', 10);
  if (![textItemIndex, charOffset, length].some(isNaN)) {
    return {
      page,
      textItemIndex,
      charOffset,
      length,
      snippet: params.get('snippet') || '',
      extraParams,
    };
  }

  // Page-only / annotation-only links are still navigable at page granularity.
  return {
    page,
    textItemIndex: 0,
    charOffset: 0,
    length: 0,
    snippet: params.get('snippet') || '',
    extraParams,
  };
}

/** The link syntax used in markdown: @pdf[[path/to/file.pdf#anchor|"snippet"]] */
export const PDF_LINK_REGEX = /@pdf\[\[([^\]#]+)#([^\]|]+)(?:\|"([^"]*)")?\]\]/g;
/** Obsidian/PDF++ PDF links: [[path/to/file.pdf#page=...&selection=...|snippet]] */
export const OBSIDIAN_PDF_LINK_REGEX = /\[\[([^\]#|]+?\.pdf)#([^\]|]+)(?:\|([^\]]*))?\]\]/gi;

export interface PdfLinkMatch {
  fullMatch: string;
  index: number;
  pdfPath: string;
  anchor: string;
  snippet: string;
  syntax: 'legacy' | 'obsidian';
}

export function findPdfLinkMatches(text: string): PdfLinkMatch[] {
  const matches: PdfLinkMatch[] = [];

  const legacy = new RegExp(PDF_LINK_REGEX.source, PDF_LINK_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = legacy.exec(text)) !== null) {
    matches.push({
      fullMatch: match[0],
      index: match.index,
      pdfPath: (match[1] ?? '').trim(),
      anchor: (match[2] ?? '').trim(),
      snippet: match[3] ?? '',
      syntax: 'legacy',
    });
  }

  const obsidian = new RegExp(OBSIDIAN_PDF_LINK_REGEX.source, OBSIDIAN_PDF_LINK_REGEX.flags);
  while ((match = obsidian.exec(text)) !== null) {
    matches.push({
      fullMatch: match[0],
      index: match.index,
      pdfPath: (match[1] ?? '').trim(),
      anchor: (match[2] ?? '').trim(),
      snippet: match[3] ?? '',
      syntax: 'obsidian',
    });
  }

  matches.sort((a, b) => a.index - b.index || b.fullMatch.length - a.fullMatch.length);

  const deduped: PdfLinkMatch[] = [];
  let lastCoveredEnd = -1;
  for (const m of matches) {
    if (m.index < lastCoveredEnd) continue;
    deduped.push(m);
    lastCoveredEnd = m.index + m.fullMatch.length;
  }

  return deduped;
}

export function hasAnchorSelection(anchor: PdfAnchor): boolean {
  return (
    (typeof anchor.endTextItemIndex === 'number' && typeof anchor.endCharOffset === 'number')
    || anchor.length > 0
  );
}

/** Format a markdown PDF link */
export function formatPdfLink(relativePath: string, anchor: PdfAnchor): string {
  return formatPdfLinkFromParts(relativePath, anchorToString(anchor), anchor.snippet);
}

/** Format a markdown PDF link using a raw anchor string (preserves unsupported params). */
export function formatPdfLinkFromParts(
  relativePath: string,
  anchor: string,
  snippet?: string,
): string {
  const normalizedSnippet = snippet ?? '';
  const safeSnippet = normalizedSnippet.length > 60
    ? normalizedSnippet.substring(0, 57) + '...'
    : normalizedSnippet;
  return `[[${relativePath}#${anchor}${safeSnippet ? `|${safeSnippet}` : ''}]]`;
}

function formatQuoteLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => `> ${line.trimEnd()}`.trimEnd())
    .join('\n');
}

/** Format an Obsidian-style quoted block followed by the PDF deep link. */
export function formatPdfQuote(relativePath: string, anchor: PdfAnchor): string {
  const quote = anchor.snippet.trim();
  if (!quote) return formatPdfLink(relativePath, anchor);
  return `${formatQuoteLines(quote)}\n>\n> ${formatPdfLink(relativePath, anchor)}`;
}

/** Legacy formatter kept for migration / compatibility when needed. */
export function formatLegacyPdfLink(relativePath: string, anchor: PdfAnchor): string {
  const snippet = anchor.snippet.length > 60
    ? anchor.snippet.substring(0, 57) + '...'
    : anchor.snippet;
  return `@pdf[[${relativePath}#${anchorToString(anchor)}|"${snippet}"]]`;
}

export interface RewriteLegacyPdfLinksResult {
  text: string;
  rewrites: number;
}

/** Rewrite legacy `@pdf[[...]]` links to native Obsidian `[[...]]` PDF links. */
export function rewriteLegacyPdfLinks(text: string): RewriteLegacyPdfLinksResult {
  const legacy = new RegExp(PDF_LINK_REGEX.source, PDF_LINK_REGEX.flags);
  let rewrites = 0;

  const rewritten = text.replace(legacy, (full, rawPdfPath, rawAnchor, rawSnippet) => {
    const pdfPath = (rawPdfPath ?? '').trim();
    const anchorStr = (rawAnchor ?? '').trim();
    const snippet = rawSnippet ?? '';
    const parsed = stringToAnchor(anchorStr);
    if (!parsed) return full;
    rewrites += 1;
    return formatPdfLinkFromParts(pdfPath, anchorToString(parsed), snippet);
  });

  return { text: rewritten, rewrites };
}

// ─── Code references ───────────────────────────────────────────────────────

/**
 * The link syntax used in markdown: @code[[path/to/file.go#L12-L34|"snippet"]]
 * Also supports folder references: @code[[path/to/folder/|"label"]]
 */
export const CODE_LINK_REGEX = /@code\[\[([^\]#|]+)(?:#L(\d+)(?:-L(\d+))?)?(?:\|"([^"]*)")?\]\]/g;

/** A parsed `@code[[…]]` occurrence inside a markdown file. */
export interface CodeReferenceEntry {
  /** POSIX-relative path of the .md file */
  source: string;
  /** 0-based line number in the .md */
  sourceLine: number;
  /** 0-based column number where the @code[[ starts */
  sourceCol: number;
  /** Length (in characters) of the entire @code[[...]] token */
  sourceLength: number;
  /** POSIX-relative target path (file or folder) from gitRoot */
  targetPath: string;
  /** 1-based start line, or 0 for folder refs */
  startLine: number;
  /** 1-based end line (inclusive), or 0 for folder refs / single-line refs */
  endLine: number;
  /** Display snippet (from the link's `|"..."` suffix, if any) */
  snippet: string;
}

/** Format a markdown code link */
export function formatCodeLink(
  relativePath: string,
  startLine?: number,
  endLine?: number,
  snippet?: string,
): string {
  const loc = startLine
    ? endLine && endLine > startLine
      ? `#L${startLine}-L${endLine}`
      : `#L${startLine}`
    : '';
  const label = snippet
    ? snippet.length > 60
      ? snippet.substring(0, 57) + '...'
      : snippet
    : '';
  return `@code[[${relativePath}${loc}${label ? `|"${label}"` : ''}]]`;
}

/** Regex for [[wikilink]] / [[note#section]] syntax in markdown */
export const WIKI_LINK_REGEX = /\[\[([^\]#|]+)(?:#([^\]|]+))?\]\]/g;

/** A parsed `[[wikilink]]` occurrence inside a markdown file. */
export interface WikiReferenceEntry {
  /** POSIX-relative path of the .md file */
  source: string;
  /** 0-based line number in the .md */
  sourceLine: number;
  /** 0-based column number where the [[ starts */
  sourceCol: number;
  /** Length (in characters) of the entire [[...]] token */
  sourceLength: number;
  /** The note name (file basename without .md) from the link */
  targetNote: string;
  /** Optional section heading (after #) */
  targetSection: string;
}

// ─── JSON index ─────────────────────────────────────────────────────────────

/**
 * A user-authored highlight on a PDF passage.
 * Stored in index.json; may or may not have any markdown references pointing at it.
 */
export interface AnnotationEntry {
  /** POSIX-relative path (from gitRoot) to the PDF */
  pdf: string;
  /** 1-based page */
  page: number;
  /** Serialized PdfAnchor ("page=…&idx=…&off=…&len=…") */
  anchor: string;
  /** Display text captured when the annotation was created */
  snippet: string;
  /** Highlight color (CSS) */
  color: string;
  /** ISO creation timestamp */
  createdAt: string;
}

/**
 * A parsed `@pdf[[…]]` occurrence inside a markdown file.
 * Purely derived from scanning the .md — rebuilt on every save.
 */
export interface ReferenceEntry {
  /** POSIX-relative path of the .md file */
  source: string;
  /** 0-based line number in the .md */
  sourceLine: number;
  /** 0-based column number where the @pdf[[ starts */
  sourceCol: number;
  /** Length (in characters) of the entire @pdf[[...]] token */
  sourceLength: number;
  /** POSIX-relative PDF path from gitRoot */
  pdf: string;
  /** 1-based page (from anchor) */
  page: number;
  /** Serialized anchor string */
  anchor: string;
  /** Display snippet (from the link's `|"..."` suffix, if any) */
  snippet: string;
}

/** On-disk JSON schema: .paperlink/index.json */
export interface IndexFile {
  version: 4;
  annotations: AnnotationEntry[];
  references: ReferenceEntry[];
  codeReferences: CodeReferenceEntry[];
  wikiReferences: WikiReferenceEntry[];
}

/** Item shown in the reference popover / backlinks panel */
export interface ReferenceListItem {
  source: string;       // path rel to gitRoot
  sourceLine: number;   // 0-based
  sourceCol: number;
  /** Legacy snippet from the @pdf[[…|"…"]] suffix (the PDF text). */
  snippet: string;
  /** The markdown source line the reference lives on, trimmed. */
  contextLine?: string;
}

// ─── Legacy sidecar (kept only for one-shot migration) ──────────────────────

export interface LegacyAnnotation {
  id: string;
  anchor: PdfAnchor;
  markdownFile: string;
  blockRef?: string;
  color: string;
  createdAt: string;
}

export interface LegacyAnnotationStore {
  version: 1;
  pdfFile: string;
  annotations: LegacyAnnotation[];
}

// ─── Messages ───────────────────────────────────────────────────────────────

export type ExtensionToWebviewMessage =
  | { type: 'loadPdf'; data: string } // base64 encoded PDF
  | { type: 'goToAnchor'; anchor: PdfAnchor }
  /**
   * Tell the webview which passages have highlights.
   * `annotated` anchors were authored by the user; `referenced` anchors have
   * at least one markdown note pointing at them.
   */
  | {
      type: 'setHighlights';
      annotated: { anchor: PdfAnchor; color: string }[];
      referenced: { anchor: PdfAnchor }[];
    }
  | {
      type: 'referencesForAnchor';
      anchor: PdfAnchor;
      items: ReferenceListItem[];
    }
  | { type: 'setTheme'; theme: 'light' | 'dark' }
  | { type: 'navigate'; direction: 'prev' | 'next' }
  | { type: 'zoom'; delta: number }
  | { type: 'zoomFitWidth' };

/** Outline item from PDFium's getBookmarks() */
export interface PdfOutlineItem {
  title: string;
  page: number;
  children: PdfOutlineItem[];
}

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'selectionMade'; anchor: PdfAnchor }
  | { type: 'pageChanged'; page: number; totalPages: number }
  | { type: 'requestInsertLink'; anchor: PdfAnchor }
  | { type: 'copyLinkToClipboard'; anchor: PdfAnchor }
  | {
      type: 'selectionAction';
      action: 'copyLink' | 'insertLink' | 'copyQuoteAndLink' | 'insertQuoteAndLink' | 'highlight';
      anchor: PdfAnchor;
    }
  | { type: 'requestReferencesForAnchor'; anchor: PdfAnchor }
  | {
      type: 'openMarkdownAtLocation';
      path: string;
      line: number;
      col: number;
    }
  | { type: 'zoomChanged'; scale: number }
  | { type: 'outline'; items: PdfOutlineItem[] };
