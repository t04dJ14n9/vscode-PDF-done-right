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

/** An annotation linking a PDF anchor to a markdown location */
export interface Annotation {
  id: string;
  anchor: PdfAnchor;
  /** Relative path to the markdown file from workspace root */
  markdownFile: string;
  /** Optional block ID or heading in the markdown file */
  blockRef?: string;
  /** Color for the highlight */
  color: string;
  /** When the annotation was created */
  createdAt: string;
}

/** Sidecar file stored as {pdfname}.paperlink.json */
export interface AnnotationStore {
  version: 1;
  pdfFile: string;
  annotations: Annotation[];
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

// Messages between extension host and webview
export type ExtensionToWebviewMessage =
  | { type: 'loadPdf'; data: string } // base64 encoded PDF
  | { type: 'goToAnchor'; anchor: PdfAnchor }
  | { type: 'highlightAnnotations'; annotations: Annotation[] }
  | { type: 'setTheme'; theme: 'light' | 'dark' };

/** Outline item from PDF.js getOutline() */
export interface PdfOutlineItem {
  title: string;
  page: number;
  children: PdfOutlineItem[];
}

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'selectionMade'; anchor: PdfAnchor }
  | { type: 'annotationClicked'; annotationId: string }
  | { type: 'pageChanged'; page: number }
  | { type: 'requestInsertLink'; anchor: PdfAnchor }
  | { type: 'copyLinkToClipboard'; anchor: PdfAnchor }
  | { type: 'outline'; items: PdfOutlineItem[] };
