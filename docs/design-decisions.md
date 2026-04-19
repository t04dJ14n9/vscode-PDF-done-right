# Design Decisions

This document records key architectural choices and the reasoning behind them.

## 1. VS Code Extension vs Standalone App

**Decision**: Start with a VS Code extension, not a full Electron+Capacitor app.

**Why**: VS Code provides markdown editing, file management, search, git, plugins, AI (Copilot), and cross-platform support for free. Building those from scratch would take months. The extension lets us validate the core idea (bidirectional PDF-markdown linking) in weeks.

**Trade-off**: No mobile/tablet support, no handwriting input. These can be added later by extracting the core logic into a standalone app.

## 2. PDFium WASM over PDF.js

**Decision**: Use Chrome's PDFium engine (via `@embedpdf/engines`) instead of Mozilla's PDF.js.

**Why**: PDF.js renders text as a DOM overlay that approximates glyph positions using web font metrics. This causes visible drift between the rendered canvas and the invisible text layer -- breaking macOS Dictionary Lookup and precise text selection. PDFium's `getPageTextRects()` returns coordinates computed by the same engine that renders the pixels, so alignment is exact.

**Trade-off**: 4.4 MB WASM binary (vs ~1.6 MB for PDF.js). Acceptable for an extension loaded once and cached.

**History**: The initial implementation (commit `036c294`) used PDF.js. The migration to PDFium (commit `5b6b22d`) changed only `pdf-viewer.ts`, `pdfEditorProvider.ts`, `webpack.config.js`, and `package.json` -- the annotation system, link syntax, and extension host code were untouched, validating the architecture's engine independence.

## 3. Sidecar JSON over Embedded PDF Annotations

**Decision**: Store annotations in `.paperlink.json` files next to each PDF, not inside the PDF itself.

**Why**:
- PDFs are read-only in most workflows (downloaded papers)
- Sidecar files sync naturally with git, Dropbox, WebDAV
- JSON is human-readable and mergeable
- No risk of corrupting the PDF
- Easy to back up, export, or migrate

**Trade-off**: Annotations are invisible to other PDF readers. This is intentional -- they're links to your notes, not PDF markup.

## 4. Custom Link Syntax (`@pdf[[...]]`)

**Decision**: Use `@pdf[[path#anchor|"snippet"]]` instead of standard markdown links.

**Why**:
- Standard `[text](url)` can't encode the anchor parameters readably
- The `@pdf[[...]]` syntax is visually distinct, easy to grep, and won't conflict with normal links
- Inspired by Obsidian's `[[...]]` wiki-link syntax but prefixed with `@pdf` to avoid ambiguity
- The regex is simple and fast to match

**Alternative considered**: `[snippet](paperlink://path?page=5&idx=12)` -- rejected because it looks like a broken URL in renderers that don't understand the scheme.

## 5. Text Item Index Anchoring

**Decision**: Anchor text selections by `{page, textItemIndex, charOffset, length}` instead of bounding box coordinates.

**Why**:
- Text item indices are stable across zoom levels and window sizes
- Character offsets within a text item are invariant to rendering scale
- The snippet field provides a fallback for fuzzy matching if the PDF is re-processed and indices shift
- Bounding box coordinates would break on zoom, DPI change, or page rotation

**Limitation**: If the PDF is modified (pages reordered, text reflowed), anchors break. The snippet enables recovery via text search.

## 6. No Web Worker for PDFium (MVP)

**Decision**: Run PDFium on the main thread via `createPdfiumEngine()` (direct mode), not in a Web Worker.

**Why**: Simpler architecture for MVP. The extension opens one PDF at a time, and PDFium rendering is fast enough that blocking the main thread briefly during page render is acceptable.

**Future**: For large PDFs or multi-document scenarios, switch to `@embedpdf/engines/pdfium-worker-engine` which runs PDFium in a dedicated worker. The `PdfEngine` interface is identical -- no viewer code changes needed.

## 7. IntersectionObserver for Lazy Rendering

**Decision**: Create DOM elements for all pages upfront but only render (canvas + text layer) when a page scrolls into view.

**Why**: A 500-page PDF would consume gigabytes of memory if all pages were rendered at once. The IntersectionObserver with a 200px root margin pre-renders pages just before they become visible, keeping memory usage proportional to the viewport.

## 8. Markdown-it Plugin for Preview

**Decision**: Extend VS Code's built-in markdown preview via `extendMarkdownIt` rather than building a custom preview.

**Why**: VS Code's markdown preview already handles scrolling, theming, and the full CommonMark spec. We only need to add rendering for our `@pdf[[...]]` syntax, which a markdown-it text rule handles cleanly. The preview script (`markdown-preview.ts`) intercepts clicks and routes them back to the extension host.
