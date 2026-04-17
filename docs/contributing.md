# Contributing

## Prerequisites

- Node.js >= 18
- VS Code >= 1.85
- npm >= 9

## Setup

```bash
git clone https://github.com/t04dJ14n9/vscode-PDFWeave.git
cd vscode-PDFWeave
npm install
npm run compile
```

## Development Workflow

### Build

```bash
npm run compile    # One-shot production build (3 webpack targets)
npm run watch      # Incremental dev build with file watching
```

The build produces:
- `dist/extension.js` -- Extension host bundle (Node.js)
- `dist/pdf-viewer.js` -- Webview bundle (browser, ~350 KB)
- `dist/markdown-preview.js` -- Markdown preview script
- `dist/pdfium.wasm` -- PDFium engine (4.4 MB, copied from node_modules)

### Run

Press **F5** in VS Code to launch the Extension Development Host. Or from the terminal:

```bash
code --extensionDevelopmentPath=. /path/to/test/workspace
```

If another PDF extension (like `tomoki1207.pdf`) takes priority, add this to the workspace's `.vscode/settings.json`:

```json
{
  "workbench.editorAssociations": {
    "*.pdf": "paperlink.pdfViewer"
  }
}
```

### Test

```bash
npm test
```

This runs `webpack --mode production`, compiles tests with `tsc`, then launches a headless VS Code instance with `@vscode/test-electron` to run 8 Mocha integration tests. The first run downloads VS Code (~200 MB) into `.vscode-test/`.

### Package

```bash
npm run package   # Creates paper-link-0.1.0.vsix
```

Install the VSIX:

```bash
code --install-extension paper-link-0.1.0.vsix
```

## Project Structure

```
src/                      Extension host (Node.js)
  extension.ts            Entry: registers providers, commands, views
  pdfEditorProvider.ts    CustomReadonlyEditorProvider + webview HTML
  annotationService.ts    Sidecar .paperlink.json CRUD
  pdfLinkProvider.ts      DocumentLinkProvider for @pdf[[...]] in markdown
  pdfOutlineProvider.ts   TreeDataProvider for PDF bookmarks panel
  markdownPlugin.ts       markdown-it plugin for preview rendering
  shared/types.ts         Shared types, anchor format, message protocol

webview-src/              Webview (browser sandbox)
  pdf-viewer.ts           PdfViewer class using PDFium WASM
  markdown-preview.ts     Click handler for preview links
  vscode.d.ts             VS Code webview API type stubs

test/                     Integration tests
  runTest.ts              @vscode/test-electron launcher
  suite/index.ts          Mocha config
  suite/extension.test.ts 8 integration tests
```

## Key Concepts

### Adding a New Command

1. Add the command to `contributes.commands` in `package.json`
2. Register it in `src/extension.ts` with `vscode.commands.registerCommand()`
3. Add it to `context.subscriptions` for cleanup

### Adding a New Message Type

1. Add the type to the union in `src/shared/types.ts`:
   - `ExtensionToWebviewMessage` for extension → webview
   - `WebviewToExtensionMessage` for webview → extension
2. Handle it in the `switch` statement in `pdfEditorProvider.ts` (host side) or `pdf-viewer.ts` (webview side)

### Modifying the Text Layer

The text layer is built in `pdf-viewer.ts` method `renderPage()`. Each `PdfTextRectObject` from PDFium's `getPageTextRects()` becomes a positioned `<span>`. Coordinates are in device space (top-left origin) and just need to be multiplied by the scale factor.

### Modifying the Webview HTML

The HTML template is a template literal in `pdfEditorProvider.ts` method `getHtml()`. It includes inline CSS and script tags. Changes to CSS or the script loading order go here.

### Adding a New PDF Engine API Call

1. Check `@embedpdf/models` for the `PdfEngine` interface -- it has 60+ methods
2. Call it in `pdf-viewer.ts` as `engine.methodName(doc, page, ...).toPromise()`
3. All engine methods return `PdfTask<T>` which is converted to a Promise with `.toPromise()`

## Dependencies

### Runtime

| Package | Version | Purpose |
|---------|---------|---------|
| `@embedpdf/engines` | ^2.14 | PDFium engine orchestrator (task scheduling, image conversion) |
| `@embedpdf/pdfium` | ^2.14 | PDFium compiled to WebAssembly (4.4 MB) |
| `@embedpdf/models` | ^2.14 | TypeScript type definitions for the engine API |

### Dev

| Package | Purpose |
|---------|---------|
| `webpack` + `ts-loader` + `copy-webpack-plugin` | Multi-target bundling |
| `typescript` | Type checking |
| `@types/vscode` | VS Code API types |
| `@vscode/test-electron` + `mocha` | Integration testing |

## Common Issues

### "Extension not activating when I open a PDF"

Another PDF extension has higher priority. Use `workbench.editorAssociations` setting, or right-click the PDF > "Open With..." > "PaperLink PDF Viewer" > set as default.

### "WASM compilation blocked by CSP"

The webview's CSP must include `'wasm-unsafe-eval'` in `script-src`. This is already configured in `pdfEditorProvider.ts`.

### "Text selection doesn't work"

Check that the `.text-layer` div has `left:0; top:0; right:0; bottom:0` positioning (not explicit width/height) and that the spans have `pointer-events: all`.

### "Blank page / PDF doesn't render"

Open the webview developer tools (Command Palette > "Developer: Open Webview Developer Tools") and check the console for errors. Common causes:
- WASM fetch failed (check `connect-src` in CSP)
- PDF binary was not sent (check `loadPdf` message in message log)
