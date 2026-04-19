# Roadmap

## Current Status (v0.1.0)

Minimal viable extension: PDF viewer with bidirectional markdown linking.

- [x] PDF rendering via PDFium WASM (HiDPI, sharp text)
- [x] Text selection with stable anchoring
- [x] `@pdf[[...]]` link syntax in markdown (editor + preview)
- [x] Bidirectional navigation (markdown -> PDF, PDF -> markdown)
- [x] Annotation sidecar storage (.paperlink.json)
- [x] PDF outline/bookmarks in Explorer sidebar
- [x] Selection toolbar (Copy Link / Insert in Note)
- [x] Integration test suite (8 tests)

## Short Term

### v0.2 -- Polish & Usability

- [ ] Auto-zoom to content area (ignore blank margins), especially useful for laptop screens
- [ ] Persistent scroll position and zoom level (restore on reopen)
- [ ] Keyboard shortcuts for common actions (copy link, navigate pages)
- [ ] Dark/light theme auto-detection from VS Code
- [ ] Search within PDF (text search with highlight)
- [ ] Page thumbnails sidebar
- [ ] Better annotation management (delete, edit color, list all across workspace)

### v0.3 -- Cloud Sync & Storage

- [ ] WebDAV sync support (compatible with Zotero's WebDAV)
- [ ] Dropbox / Google Drive / iCloud integration via their APIs
- [ ] Conflict resolution for annotation sidecar files

## Medium Term

### v0.4 -- AI Knowledge Base

- [ ] Vector database (ChromaDB) for document embeddings
- [ ] Automatic embedding generation on PDF import
- [ ] AI chat interface for querying across papers
- [ ] "Ask about this selection" context action
- [ ] Agent-generated summaries per paper and per section

### v0.5 -- Advanced Annotations

- [ ] Handwriting / Apple Pencil support (for Capacitor mobile build)
- [ ] Freeform ink annotations on PDF pages
- [ ] Highlight colors and categories
- [ ] Export annotations as markdown summary

## Long Term

### v1.0 -- Full Desktop App

If the VS Code extension proves the concept, consider building a standalone app:

- [ ] Vue + Electron + Capacitor for desktop and mobile
- [ ] EmbedPDF component library (SelectionLayer, AnnotationLayer, Scroller) for the full app
- [ ] Plugin system (Vim mode, custom storage backends)
- [ ] Reference management (arXiv one-click download, citation graph)
- [ ] NotebookLM-style knowledge base with local agent
- [ ] CLI tool mirroring all GUI functionality

### Architecture Note

The current extension's core logic (anchor format, annotation storage, link syntax) is engine-agnostic and can be extracted into a shared library. The PDFium WASM engine and the annotation data format work identically in Electron, Capacitor, and VS Code webviews.
