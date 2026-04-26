# Roadmap

## Current Status (v0.2.0)

Knowledge management VS Code extension with PDF + code linking and CM6 markdown editor.

- [x] PDF rendering via PDFium WASM (HiDPI, sharp text)
- [x] Text selection with stable anchoring
- [x] `@pdf[[...]]` link syntax in markdown (editor + preview)
- [x] `@code[[path#L1-L2|"snippet"]]` code reference links
- [x] Bidirectional navigation (markdown → PDF/code, PDF → markdown)
- [x] Shared JSON index at `.paperlink/index.json` (schema v3)
- [x] PDF outline/bookmarks in Explorer sidebar
- [x] Backlinks + Forward Links panels in Explorer
- [x] CodeMirror 6 markdown editor with Obsidian-style live preview
- [x] Selection toolbar (Copy Link / Insert in Note)
- [x] File rename propagation (PDFs, markdown, code targets)
- [x] All settings via VS Code native configuration (`paperlink.markdown.*`)
- [x] Integration test suite (50 tests)

## Short Term

### v0.3 — Polish & PDF Usability

- [ ] Auto-zoom to content area (ignore blank margins), especially useful for laptop screens
- [ ] Persistent scroll position and zoom level (restore on reopen)
- [ ] Keyboard shortcuts for common actions (copy link, navigate pages)
- [ ] Dark/light theme auto-detection from VS Code
- [ ] Search within PDF (text search with highlight)
- [ ] Page thumbnails sidebar
- [ ] Better annotation management (delete, edit color, list all across workspace)

### v0.4 — Code Reference Enhancements

- [ ] Relative path resolution for `@code[[…]]` links (e.g. `./utils/helper.go`)
- [ ] Code reference autocomplete (suggest workspace files on `@code[[` trigger)
- [ ] Folder hover preview (show file tree for `@code[[path/to/folder/]]`)
- [ ] Git blame integration for code reference lines
- [ ] Stale/broken code reference detection in CLI

### v0.5 — CLI Tool

- [ ] `paperlink index verify` — check index integrity, detect broken references
- [ ] `paperlink index rebuild` — full reindex from workspace scan
- [ ] `paperlink links list --broken` — list all broken @pdf/@code references
- [ ] `paperlink stats` — summary of annotations, references, code refs
- [ ] `paperlink rename <old> <new>` — propagate renames through index + markdown
- [ ] `paperlink export` — export index as markdown summary
- [ ] Ship as standalone binary via `npx` or `go build`

## Medium Term

### v0.6 — Advanced Annotations & Export

- [ ] Highlight colors and categories
- [ ] Export annotations as markdown summary
- [ ] Annotation tagging (e.g. "important", "follow-up")
- [ ] Batch annotation operations

### v0.7 — Knowledge Graph

- [ ] Visual graph view (D3/Cytoscape) showing file ↔ annotation ↔ reference relationships
- [ ] Search across all indexed content (full-text + anchor snippets)
- [ ] Tag-based navigation across PDFs and notes
- [ ] Orphan detection (notes with no references, unlinked PDFs)

## Long Term

### v1.0 — Cross-Platform Knowledge System

- [ ] Mobile app (tablet + phone) via Capacitor/React Native
- [ ] Git-synced knowledge base (index + notes in repo, no cloud services needed)
- [ ] Video reference support (`@video[[path#timestamp|"snippet"]]`)
- [ ] Reference management (arXiv one-click download, citation graph)
- [ ] Shared library extraction (anchor format, index schema, link syntax) for reuse in mobile/CLI

### Architecture Note

The extension's core logic (anchor format, index storage, link syntax) is engine-agnostic and can be extracted into a shared library. The PDFium WASM engine, the CM6 editor, and the annotation data format work identically in Electron, Capacitor, and VS Code webviews. The CLI tool operates on the same `.paperlink/index.json` without any VS Code dependency.
