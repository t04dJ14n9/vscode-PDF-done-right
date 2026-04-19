# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## Project overview

PaperLink is a VS Code extension (v0.2.0, TypeScript) that creates bidirectional links between PDF passages and Markdown notes. It ships a custom PDF editor powered by PDFium/WASM, a markdown document-link provider, a shared JSON index, a backlinks sidebar and a scaffold for a future Obsidian-style markdown editor.

## Common commands

All commands run from repo root. Node 18+ and VS Code 1.85+ are required.

```bash
npm install                 # install deps (includes @embedpdf/pdfium + WASM)
npm run compile             # production webpack build (4 targets → dist/)
npm run watch               # development build with live reload

npm run compile-tests       # tsc -p test/tsconfig.json → out/**
npm test                    # compile + compile-tests + launch VS Code Electron runner

npm run lint                # eslint src --ext ts
npm run package             # vsce package → paper-link-0.2.0.vsix
```

### Running a single test

`test/runTest.js` launches a real VS Code instance against `test-workspace/` and runs every `out/**/*.test.js` through `test/suite/index.js` (Mocha TDD). To run just one file, compile then filter with Mocha's grep:

```bash
npm run compile && npm run compile-tests
node out/test/runTest.js --grep "fileRenameWatcher"   # fuzzy suite name
# or invoke mocha directly against one compiled file (outside VS Code; only works for unit-style suites):
npx mocha out/test/suite/indexFile.test.js
```

`runTest.ts` resolves `extensionTestsPath` as `out/test/suite/index` and passes `--disable-extensions` plus the `test-workspace` folder to VS Code.

### Launching the extension interactively

Press **F5** in VS Code ("Run Extension" launch config) or from CLI attach to a dev Electron instance via:

```bash
# keep watch running in another terminal
npm run watch
# then F5, or run the smoke driver against a dev instance:
PORT=9333 node out/test/smoke.js
```

`test/smoke.ts` is a Chrome DevTools Protocol (CDP) driver that expects `code --remote-debugging-port=$PORT test-workspace`. It dismisses the welcome screen, opens `sample.pdf` via Cmd+P, probes every iframe for `title === "PaperLink PDF Viewer"`, asserts highlight counts, verifies `.paperlink/index.json` was produced and writes `test/screenshots/smoke-full.png`.

## Architecture

### Three tiers

```
VS Code core ──▶ Extension host (Node)  ──postMessage──▶ Webview (DOM + WASM)
              (src/**.ts, out or dist)                   (webview-src/**.ts)
```

- **Extension host** (`src/**/*.ts`, bundled to `dist/extension.js`, target: node) owns all I/O, command registration, custom-editor providers, tree views, index persistence and the `onDidRenameFiles` watcher.
- **Webviews** (`webview-src/*.ts`) are bundled as three separate browser-target webpack entries: `pdf-viewer.js`, `markdown-preview.js`, `markdown-editor.js`. They cannot touch disk or the workspace; they only post typed messages.
- **Shared types** live in `src/shared/types.ts` and are imported by *both* sides. Any new message type or index field must be added here first.

### Four webpack targets

`webpack.config.js` exports an array of four configs (never a single config object). One is `target: 'node'` with `externals: { vscode: 'commonjs vscode' }`; the other three are `target: 'web'` and use `tsconfig.webview.json` (DOM lib, no Node types). The PDFium WASM asset is copied verbatim from `node_modules/@embedpdf/pdfium/dist/pdfium.wasm` into `dist/pdfium.wasm` via `copy-webpack-plugin`.

### Storage model — single JSON index

All state is one text file: `<gitRoot>/.paperlink/index.json` (schema version 2). Shape:

```
{ version: 2,
  annotations: [ { pdf, page, anchor, snippet, color, createdAt } ],
  references:  [ { source, sourceLine, sourceCol, sourceLength,
                   pdf, page, anchor, snippet } ] }
```

- **gitRoot resolution** is in `src/util/gitRoot.ts`. It runs `git rev-parse --show-toplevel` and *explicitly filters* `workspaceFolders[0]` when the path points at the VS Code / Electron app bundle (observed bug with untitled workspaces). Changes to this heuristic affect every dev VS Code launch — tread carefully.
- **Atomic write + deterministic sort** (`src/index/indexFile.ts`): entries are sorted by `(pdf, page, anchor)` or `(source, line, col)` and written via tmp+rename so concurrent collaborators editing different passages produce non-overlapping git diffs that auto-merge.
- **Sidecar migration**: on first run, any legacy `*.paperlink.json` sidecars are merged into `index.json` and deleted. This is one-shot, gated on the absence of `index.json`.

### IndexService is the source of truth

`src/index/indexService.ts` holds the parsed `IndexFile` in memory plus three derived lookup maps (`byTargetAnchor`, `bySource`, `byTargetPdf`) and emits `onDidChange`. Consumers (PdfEditorProvider, BacklinksProvider) subscribe to this event; nobody reads `index.json` directly at runtime. Writes are debounced 200 ms via `pendingFlushTimer`.

Rebuild flow:
1. `MarkdownIndexer` (`markdownIndexer.ts`) scans the workspace for `*.md`, parses each with `PDF_LINK_REGEX`, and calls `indexService.replaceReferencesForSource(...)`. Incremental updates happen on `onDidSaveTextDocument` / `onDidDeleteFiles`.
2. `FileRenameWatcher` (`fileRenameWatcher.ts`) listens to `onDidRenameFiles`. For each rename it calls a pure `planRenames()` helper that returns both a `WorkspaceEdit` (rewriting every `@pdf[[oldPath#…]]` token across every referencing `.md` as a single undo unit) and the set of index mutations to apply. This pure-function separation is why it is unit-testable without a VS Code host.
3. `PdfEditorProvider` (`pdfEditorProvider.ts`) posts `setHighlights` messages to the webview whenever `IndexService.onDidChange` fires for its PDF, tagging each anchor as `annotated` (user highlight) or `referenced` (has markdown backlinks).

### Message protocol

Defined as discriminated unions in `src/shared/types.ts`:

- Host → webview (`ExtensionToWebviewMessage`): `loadPdf`, `goToAnchor`, `setHighlights`, `referencesForAnchor`, `setTheme`.
- Webview → host (`WebviewToExtensionMessage`): `ready`, `selectionMade`, `pageChanged`, `requestInsertLink`, `copyLinkToClipboard`, `requestReferencesForAnchor`, `openMarkdownAtLocation`, `outline`.

Clicks on a highlight in `pdf-viewer.ts` fire `requestReferencesForAnchor`; the host responds with a `referencesForAnchor` message carrying the `ReferenceListItem[]`, which the webview renders as an in-viewer popover. Clicking a popover row posts `openMarkdownAtLocation`, which the host routes to the `paperlink.openMarkdownAtLocation` command.

### UI surfaces contributed via package.json

- Two custom editors: `paperlink.pdfViewer` (priority `default` for `*.pdf`) and `paperlink.markdownEditor` (priority `option` for `*.md` — the scaffold, never auto-opens).
- Two tree views:
  - `paperlink.outline` in the Explorer container, visible only when `paperlink.pdfOpen` context key is true (set by `PdfEditorProvider` on focus change).
  - `paperlink.backlinks` in a dedicated activity-bar container `paperlink` (icon: `resources/sidebar.svg`). Renders two collapsible sections (`Backlinks (N)`, `Outgoing (N)`) for the active `.pdf` or `.md`. The container id must stay alphanumeric — dots are rejected by VS Code.
- Markdown preview script (`dist/markdown-preview.js`) is registered via `contributes.markdown.previewScripts` and renders `@pdf[[…]]` tokens as clickable links.

### Command surface

Commands registered in `src/extension.ts`:
- `paperlink.showAnnotations` — quick-pick over annotations of the active PDF.
- `paperlink.refreshIndex` — rebuild the whole index from scratch (use after out-of-editor renames like `git mv`).
- `paperlink.openBacklink` / `paperlink.openMarkdownAtLocation` — internal, `enablement: "false"`; invoked programmatically by the popover and the backlinks tree.
- `paperlink.openInMarkdownEditor` — opens the current `.md` in the scaffold editor.
- `paperlink.outlineGoToPage`, `paperlink.openPdfAtAnchor` — used by the outline and link provider.

### Key invariants to preserve when editing

1. **Do not read/write `index.json` outside `indexFile.ts` + `indexService.ts`.** Other modules mutate the in-memory `IndexFile` only through `IndexService` methods.
2. **`gitRoot` may be `undefined`.** When no workspace is open, the extension runs in read-only mode — `IndexService.init` is skipped and the backlinks view is not created. New code paths that depend on `gitRoot` must gate on its presence (see the conditional block at the top of `activate`).
3. **Webview has no Node types.** `tsconfig.webview.json` intentionally excludes Node lib; importing `path` or `fs` in `webview-src/` will break the browser bundle. `acquireVsCodeApi` is declared globally in `webview-src/vscode.d.ts` — do not redeclare it in each entry.
4. **Relative paths in the index are POSIX and gitRoot-relative.** Use `toPosixRelative` from `indexFile.ts`; never store absolute paths or Windows backslashes.
5. **Renames go through `planRenames`.** Do not call `vscode.workspace.applyEdit` from elsewhere for PDF/markdown moves — the single-undo-unit behaviour depends on one `WorkspaceEdit`.

### Test layout

- `test/suite/indexFile.test.ts`, `indexService.test.ts`, `fileRenameWatcher.test.ts` — unit tests that run inside the Electron test host but touch only pure logic + `fs` tmp dirs.
- `test/suite/extension.test.ts` — integration tests that open `sample.pdf` and assert activation, command registration and custom-editor behaviour.
- `test/runTest.ts` / `test/suite/index.ts` — Electron bootstrap + Mocha glob runner (`**/*.test.js`).
- `test/smoke.ts` / `test/probe-webview.ts` / `test/e2e-vscode.ts` — CDP drivers that attach to a running dev VS Code; not invoked by `npm test`.
- `test/tsconfig.json` uses `rootDir: ".."` so it compiles *both* `src/**` and `test/**` into `out/` — the test suites import host modules directly.

### Where to make changes

| Task | Files |
|---|---|
| Add a message type | `src/shared/types.ts` → handler in host + webview |
| Change highlight styling | `webview-src/pdf-viewer.ts` (`.annotation-highlight.referenced` / `.annotated` CSS) |
| Change index schema | bump `version` in `types.ts`, update `loadIndex` migration in `indexFile.ts`, add test in `indexFile.test.ts` |
| Add a command | register in `src/extension.ts`, declare in `package.json` `contributes.commands` |
| Change rename semantics | `src/index/fileRenameWatcher.ts` — keep `planRenames` pure and unit-test it |
| Touch build pipeline | `webpack.config.js` (array of 4 configs; keep `externals.vscode` on the node target) |
