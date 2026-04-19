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
  /** Number of characters selected */
  length: number;
  /** The actual selected text (for fallback matching) */
  snippet: string;
}

/** Serializes an anchor to a compact string for use in links */
export function anchorToString(a: PdfAnchor): string {
  return `page=${a.page}&idx=${a.textItemIndex}&off=${a.charOffset}&len=${a.length}`;
}

/** Parses an anchor string back to a PdfAnchor (snippet is empty) */
export function stringToAnchor(s: string): PdfAnchor | null {
  const params = new URLSearchParams(s);
  const page = parseInt(params.get('page') || '', 10);
  const textItemIndex = parseInt(params.get('idx') || '', 10);
  const charOffset = parseInt(params.get('off') || '', 10);
  const length = parseInt(params.get('len') || '', 10);
  if ([page, textItemIndex, charOffset, length].some(isNaN)) {
    return null;
  }
  return { page, textItemIndex, charOffset, length, snippet: params.get('snippet') || '' };
}

/** The link syntax used in markdown: @pdf[[path/to/file.pdf#anchor|"snippet"]] */
export const PDF_LINK_REGEX = /@pdf\[\[([^\]#]+)#([^\]|]+)(?:\|"([^"]*)")?\]\]/g;

/** Format a markdown PDF link */
export function formatPdfLink(relativePath: string, anchor: PdfAnchor): string {
  const snippet = anchor.snippet.length > 60
    ? anchor.snippet.substring(0, 57) + '...'
    : anchor.snippet;
  return `@pdf[[${relativePath}#${anchorToString(anchor)}|"${snippet}"]]`;
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
  version: 2;
  annotations: AnnotationEntry[];
  references: ReferenceEntry[];
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
  | { type: 'setTheme'; theme: 'light' | 'dark' };

/** Outline item from PDFium's getBookmarks() */
export interface PdfOutlineItem {
  title: string;
  page: number;
  children: PdfOutlineItem[];
}

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'selectionMade'; anchor: PdfAnchor }
  | { type: 'pageChanged'; page: number }
  | { type: 'requestInsertLink'; anchor: PdfAnchor }
  | { type: 'copyLinkToClipboard'; anchor: PdfAnchor }
  | { type: 'requestReferencesForAnchor'; anchor: PdfAnchor }
  | {
      type: 'openMarkdownAtLocation';
      path: string;
      line: number;
      col: number;
    }
  | { type: 'outline'; items: PdfOutlineItem[] };
