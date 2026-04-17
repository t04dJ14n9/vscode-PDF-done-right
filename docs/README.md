# PaperLink

**Bidirectional links between PDF annotations and Markdown notes.**

PaperLink is a VS Code extension that turns your editor into a research reading environment. Open a PDF, select any passage, and insert a clickable link into your markdown notes. Click the link later to jump back to the exact paragraph in the PDF.

## Features

- **PDF Viewer** -- Opens `.pdf` files in a custom editor powered by PDFium (Chrome's PDF engine) via WebAssembly, with sharp HiDPI rendering
- **Text Selection & Anchoring** -- Select text in a PDF to generate a stable anchor (page, text item index, character offset) that survives re-renders
- **Bidirectional Links** -- `@pdf[[file.pdf#page=5&idx=12&off=5&len=40|"quoted text"]]` syntax in markdown, clickable in both the editor and the preview
- **PDF Outline** -- Bookmarks/table of contents displayed in the Explorer sidebar; click to navigate
- **Annotation Storage** -- Sidecar `.paperlink.json` files next to each PDF; no database, fully portable
- **Selection Toolbar** -- "Copy Link" and "Insert in Note" buttons appear when you select text in the PDF

## Quick Start

```bash
git clone https://github.com/t04dJ14n9/vscode-PDFWeave.git
cd vscode-PDFWeave
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host, or:

```bash
code --extensionDevelopmentPath=. /path/to/your/papers
```

Open any `.pdf` file -- it opens in the PaperLink viewer. Select text, click **"Insert in Note"**, and a link is inserted at your cursor in the active markdown editor.

## Usage

### Creating a PDF Link

1. Open a PDF and a markdown file side by side
2. Select text in the PDF
3. A toolbar appears above the selection:
   - **Copy Link** -- copies the `@pdf[[...]]` link to your clipboard
   - **Insert in Note** -- inserts the link at your cursor position in the active markdown editor

### Link Syntax

```markdown
@pdf[[papers/attention.pdf#page=5&idx=12&off=5&len=40|"self-attention mechanism"]]
```

| Part | Meaning |
|------|---------|
| `papers/attention.pdf` | Relative path to the PDF from workspace root |
| `page=5` | 1-based page number |
| `idx=12` | Text item index on that page |
| `off=5` | Character offset within the text item |
| `len=40` | Number of characters in the selection |
| `"self-attention mechanism"` | Human-readable snippet (for display) |

### Navigating Links

- **In the editor**: Links are underlined and clickable (via `DocumentLinkProvider`). Click to open the PDF at the exact location.
- **In markdown preview**: Links render as styled badges. Click to navigate.
- **In the PDF**: Annotated regions are highlighted. Click a highlight to jump to the linked markdown note.

### PDF Outline

When a PDF has bookmarks, they appear in the **PDF Outline** panel in the Explorer sidebar. Click any bookmark to navigate to that page.

## Commands

| Command | Description |
|---------|-------------|
| `PaperLink: Copy PDF Link to Clipboard` | Copy an `@pdf[[...]]` link for the current selection |
| `PaperLink: Insert PDF Link at Cursor` | Insert a link directly into the active markdown editor |
| `PaperLink: Show All Annotations for Current PDF` | Quick-pick list of all annotations; select one to jump |

## Configuration

To make PaperLink the default PDF viewer in your workspace, add to `.vscode/settings.json`:

```json
{
  "workbench.editorAssociations": {
    "*.pdf": "paperlink.pdfViewer"
  }
}
```

## Development

See [docs/architecture.md](docs/architecture.md) for the full technical reference.

```bash
npm run compile     # Production build
npm run watch       # Incremental dev build
npm test            # Run all 8 integration tests
npm run package     # Create .vsix for distribution
```

## License

MIT
