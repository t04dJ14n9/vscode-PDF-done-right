# PaperLink: Bidirectional Markdown ↔ PDF Linking for VS Code

<div align="center">

**Link Markdown notes to PDF passages. Navigate between them. Annotate without leaving your editor.**

[![Build](https://img.shields.io/badge/build-passing-brightgreen)]() 
[![Version](https://img.shields.io/badge/version-0.1.0-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

[📚 Quick Start](#quick-start) • [🏗️ Architecture](#architecture) • [👨‍💻 Development](#development) • [📖 Full Docs](#documentation)

</div>

---

## 🎯 What is PaperLink?

PaperLink is a VS Code extension that creates **seamless bidirectional links** between your Markdown notes and PDF documents. 

### Key Features
- ✅ **PDF Links in Markdown** — Reference PDFs with special syntax: `@pdf[[path/to/paper.pdf#page=5|"snippet"]]`
- ✅ **Click to Navigate** — Click links in Markdown to jump to exact locations in PDFs
- ✅ **Text Selection** — Select text in PDFs and copy/insert links back to Markdown
- ✅ **Annotations** — Create highlighted annotations in PDFs linked to specific Markdown notes
- ✅ **PDF Outlines** — Browse PDF bookmarks in VS Code sidebar
- ✅ **Markdown Preview** — PDF links render beautifully in markdown preview
- ✅ **Persistent Storage** — Annotations stored as sidecar JSON files alongside PDFs

---

## 📦 Tech Stack

| Component | Technology |
|-----------|-----------|
| **Extension Host** | Node.js, VS Code API, TypeScript |
| **PDF Rendering** | PDFium via EmbedPDF (WASM) |
| **Frontend** | Browser/WASM sandbox with DOM APIs |
| **Build** | Webpack 5 (3 parallel targets) |
| **Testing** | Mocha + @vscode/test-electron |
| **Markup** | Markdown with custom syntax |

---

## 🚀 Quick Start

### Installation

1. **Clone the repository**
   ```bash
   git clone <repo-url>
   cd paper-link
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the extension**
   ```bash
   npm run compile
   ```

4. **Run in debug mode** (VS Code)
   - Press `F5` to open extension in new VS Code window
   - Or use `npm run watch` for live reloading

### Basic Usage

1. **Open a PDF** in VS Code — it opens in a custom viewer
2. **Select text** in the PDF viewer
3. **Copy link** using the toolbar button
4. **Paste into Markdown** — creates clickable link
5. **Click link** in editor to return to PDF

---

## 📚 Documentation

This project includes comprehensive documentation:

### 📖 **For Quick Orientation**
Start here if you're new to the project:
- **[DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)** — Quick start, common tasks, debugging tips (15 min read)
- **[PROJECT_STATUS.md](./PROJECT_STATUS.md)** — Current status, feature checklist, known issues (10 min read)

### 🏗️ **For Architecture Understanding**
Deep dive into how the system works:
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Visual diagrams, data flows, message protocols (20 min read)
- **[CODEBASE_SUMMARY.md](./CODEBASE_SUMMARY.md)** — Module-by-module breakdown with code excerpts (15 min read)

### 📑 **For Code Navigation**
Find where things are:
- **[CODEBASE_MAP.md](./CODEBASE_MAP.md)** — Complete file inventory with line counts and purposes (5 min read)

---

## 🏗️ Architecture

### Three-Tier System
```
┌─────────────────────────────────┐
│      VS Code Core               │
│  (Commands, Editors, Events)    │
└────────────┬────────────────────┘
             │
┌────────────▼────────────────────┐
│   Extension Host (Node.js)      │
│  • File I/O                     │
│  • Message routing              │
│  • Persistence                  │
└────────────┬────────────────────┘
             │ postMessage
┌────────────▼────────────────────┐
│   Webview (Browser/WASM)        │
│  • PDF rendering                │
│  • User interaction             │
│  • Text selection               │
└─────────────────────────────────┘
```

### Message Protocol
- **Extension → Webview**: `loadPdf`, `goToAnchor`, `highlightAnnotations`, `setTheme`
- **Webview → Extension**: `ready`, `copyLinkToClipboard`, `requestInsertLink`, `annotationClicked`, etc.

### Data Storage
- **Sidecar Files**: `{pdfname}.paperlink.json` stored alongside PDFs
- **Format**: JSON with versioning, annotations array, metadata
- **Caching**: In-memory cache for performance

---

## 👨‍💻 Development

### Prerequisites
- Node.js 18+
- VS Code
- Git

### Common Tasks

**Development with live reload:**
```bash
npm run watch        # Terminal 1: Watch for changes
# Press F5 in VS Code for debug mode
```

**Run tests:**
```bash
npm test             # Full test suite
npm run compile-tests && npm test  # Or compile then test
```

**Build VSIX package:**
```bash
npm run package      # Creates paper-link-0.1.0.vsix
```

**Add a new feature:**
1. Design message protocol changes if needed (see ARCHITECTURE.md)
2. Update `src/shared/types.ts` with new types
3. Implement in extension host (`src/`)
4. Implement in webview (`webview-src/`)
5. Add tests to `test/suite/extension.test.ts`
6. Update documentation if architecture changes

**Debug mode:**
- **Extension Host**: Set breakpoints in `src/` files, use Debug Console
- **Webview**: Press Ctrl+Shift+P → "Developer: Open Webview Developer Tools"

### Project Structure
```
paper-link/
├── src/                          # Extension host (Node.js)
│   ├── extension.ts              # Entry point & command registration
│   ├── pdfEditorProvider.ts       # Custom editor & webview lifecycle
│   ├── annotationService.ts       # Annotation storage & persistence
│   ├── pdfLinkProvider.ts         # Markdown link detection
│   ├── pdfOutlineProvider.ts      # PDF outline tree view
│   ├── markdownPlugin.ts          # Markdown preview rendering
│   └── shared/
│       └── types.ts              # Shared types & message protocol
├── webview-src/                  # Webview (Browser/WASM)
│   ├── pdf-viewer.ts             # PDF rendering & interaction
│   └── markdown-preview.ts       # Link handling in preview
├── test/                         # Test suite
│   ├── suite/extension.test.ts   # Integration tests
│   ├── runTest.ts                # Test harness
│   └── tsconfig.json             # Test configuration
├── dist/                         # Build output (generated)
├── package.json                  # Extension metadata & scripts
├── webpack.config.js             # Build configuration
├── tsconfig.json                 # Host TypeScript config
└── tsconfig.webview.json         # Webview TypeScript config
```

---

## 🧪 Testing

### Test Suite
- **Framework**: Mocha + @vscode/test-electron
- **Coverage**: 8 integration tests covering core functionality
- **Run**: `npm test`

### Test Areas
- ✅ Extension activation
- ✅ PDF link detection in Markdown
- ✅ Custom editor registration
- ✅ Command registration
- ✅ Sidecar file handling
- ✅ Markdown editor integration

---

## 🐛 Known Issues & Limitations

### Current
1. **Text Layer Mapping**: Complex PDFs with unusual text ordering may have selection accuracy issues
2. **Performance**: Large PDFs (500+ pages) may have rendering performance considerations
3. **WASM Loading**: PDFium WASM module (~4.4 MB) is always included, no lazy loading

### Potential Future Improvements
- [ ] Full-text search within PDFs
- [ ] Annotation export to Markdown/JSON
- [ ] PDF form filling
- [ ] Collaborative annotation sharing
- [ ] Lazy WASM loading

---

## 🔗 Quick Reference

### Command Line
```bash
npm run compile      # Production build
npm run watch        # Development watch mode
npm run compile-tests # Compile tests
npm test             # Run test suite
npm run package      # Create VSIX package
npm run lint         # Lint source code
```

### Keyboard Shortcuts (in debug mode)
- `F5` — Start debugging
- `Ctrl+Shift+P` → "Developer: Open Webview Developer Tools" — Debug webview
- `Ctrl+R` — Reload webview (while debugging)

### File Modification Locations

| Want to do | File |
|-----------|------|
| Add a command | `src/extension.ts` |
| Add message type | `src/shared/types.ts` |
| Fix PDF rendering | `webview-src/pdf-viewer.ts` |
| Fix annotation storage | `src/annotationService.ts` |
| Fix markdown links | `src/pdfLinkProvider.ts` |
| Change UI styling | `src/pdfEditorProvider.ts` |
| Add keyboard shortcut | `package.json` |

---

## 📋 Getting Help

### Troubleshooting
- **Extension won't activate?** → Check `activationEvents` in package.json
- **Build fails?** → Run `npm install && npm run compile`
- **Tests timeout?** → Increase timeout in test file
- **Webview is blank?** → Open Webview DevTools, check console

### Need More Info?
- **Quick answers** → See [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- **How things work** → See [ARCHITECTURE.md](./ARCHITECTURE.md)
- **File locations** → See [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- **Current status** → See [PROJECT_STATUS.md](./PROJECT_STATUS.md)

---

## 📞 About

**PaperLink** brings the power of Roam Research and Obsidian-style linking to VS Code's PDF integration, enabling researchers and note-takers to work directly in their favorite editor without context-switching.

### Version
- **Current**: 0.1.0 (feat/pdfium-wasm branch)
- **Status**: Active development
- **Last Updated**: April 18, 2026

### Technologies Used
- VS Code API
- PDFium (WASM)
- TypeScript
- Webpack
- Mocha

---

<div align="center">

**Start exploring:** [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md) • [ARCHITECTURE.md](./ARCHITECTURE.md) • [PROJECT_STATUS.md](./PROJECT_STATUS.md)

Made with ❤️ for researchers and note-takers

</div>
