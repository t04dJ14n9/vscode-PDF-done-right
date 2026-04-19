# PaperLink Developer Quick Start Guide

This guide helps you get up and running with PaperLink development quickly.

---

## ⚡ Quick Setup

### Prerequisites
- Node.js 18+ with npm
- VS Code (for testing the extension)
- Git

### Initial Setup
```bash
# Clone and install
git clone <repo-url>
cd vscode-PDF-done-right
npm install

# Verify build works
npm run compile

# Run tests
npm test
```

---

## 🔧 Development Workflow

### 1. **Daily Development**

```bash
# Terminal 1: Watch for changes
npm run watch

# Terminal 2: Open extension in debug mode
# Press F5 in VS Code (launch config already configured)
```

### 2. **Testing Changes**

```bash
# Run full test suite
npm test

# Or run specific test
npm run compile-tests && npm run test
```

### 3. **Building for Distribution**

```bash
# Create VSIX package
npm run package

# Output: vscode-PDF-done-right-0.1.0.vsix
```

---

## 🎯 Common Development Tasks

### Adding a New Command

**File**: `src/extension.ts`

```typescript
// In activate() function:
context.subscriptions.push(
  vscode.commands.registerCommand('paperlink.myNewCommand', async () => {
    // Command logic here
    vscode.window.showInformationMessage('Command executed!');
  })
);
```

Then add to `package.json` in `contributes.commands`:
```json
{
  "command": "paperlink.myNewCommand",
  "title": "PaperLink: My New Command",
  "category": "PaperLink"
}
```

### Adding a New Message Type

**File**: `src/shared/types.ts`

```typescript
// Add to WebviewToExtensionMessage type:
export type WebviewToExtensionMessage = 
  | { type: 'ready' }
  | { type: 'myNewMessage'; payload: string }
  // ... other types

// Add handler in src/pdfEditorProvider.ts:
case 'myNewMessage':
  console.log('Received:', msg.payload);
  break;
```

### Modifying PDF Viewer UI

**File**: `src/pdfEditorProvider.ts` (HTML template)

The HTML is embedded in the `getHtml()` method. CSS variables for theming:
- `--bg`: Background color
- `--text`: Text color
- `--btn-bg`: Button background
- `--highlight`: Highlight color

### Adding a New Test

**File**: `test/suite/extension.test.ts`

```typescript
test('My new feature works', async () => {
  const result = await myFeatureFunction();
  assert.strictEqual(result, expectedValue);
});
```

Then compile and run:
```bash
npm run compile-tests && npm test
```

---

## 🐛 Debugging Guide

### Debug Extension Host (Node.js)

1. **Add breakpoints** in `src/**/*.ts` files
2. **Press F5** in VS Code to start debugging
3. **Use Debug Console** to inspect variables
4. **Step through** code with F10/F11

### Debug Webview (Browser)

1. When extension is running, press **Ctrl+Shift+P** (Cmd+Shift+P on Mac)
2. Run command: **Developer: Open Webview Developer Tools**
3. Inspect HTML, CSS, console, and network
4. Set breakpoints in webview code

### View Console Logs

**Extension Host**:
- Debug Console in VS Code shows all console.log() from extension

**Webview**:
- Use "Webview Developer Tools" (see above)
- Or use `vscode.postMessage()` to send logs to host

---

## 📊 Project File Map

### Core Extension Logic
```
src/extension.ts                    Main entry point (84 lines)
src/pdfEditorProvider.ts            PDF viewer lifecycle (429 lines)
src/annotationService.ts            Storage & persistence (120 lines)
src/pdfLinkProvider.ts              Markdown link detection (45 lines)
src/pdfOutlineProvider.ts           Outline tree view (62 lines)
src/markdownPlugin.ts               Markdown HTML rendering (72 lines)
src/shared/types.ts                 Type definitions (92 lines)
```

### Webview (Browser/WASM)
```
webview-src/pdf-viewer.ts           PDF rendering & interaction (524 lines)
webview-src/markdown-preview.ts     Link handling in preview (27 lines)
```

### Configuration
```
package.json                        Extension metadata & scripts
tsconfig.json                       Host TypeScript config
tsconfig.webview.json              Webview TypeScript config
webpack.config.js                   Build configuration
```

### Testing
```
test/runTest.ts                     Test harness
test/suite/extension.test.ts        Integration tests (103 lines)
test/tsconfig.json                  Test TypeScript config
```

---

## 🔍 Understanding Message Flow

### User clicks PDF link in Markdown → PDF opens at location

```
[User clicks link in markdown]
           ↓
PdfLinkProvider.provideDocumentLinks() [detects @pdf[...] pattern]
           ↓
VS Code executes command: paperlink.openPdfAtAnchor
           ↓
extension.ts registers command handler
           ↓
PdfEditorProvider.openPdfAtAnchor(path, anchor)
           ↓
Open PDF file with custom editor
           ↓
Send message to webview: { type: 'goToAnchor', anchor: {...} }
           ↓
Webview receives and PdfViewer.goToAnchor() executes
           ↓
PDF page scrolls and text is highlighted temporarily
```

### User selects text in PDF → link copied to clipboard

```
[User selects text in PDF]
           ↓
PdfViewer.handleTextSelection() [maps text to anchor]
           ↓
Shows toolbar with "Copy Link" button
           ↓
[User clicks "Copy Link"]
           ↓
Webview sends: { type: 'copyLinkToClipboard', anchor: {...} }
           ↓
Extension handler receives message
           ↓
formatPdfLink(relativePath, anchor) creates: @pdf[[path#page=5&idx=12]]
           ↓
vscode.env.clipboard.writeText(link)
           ↓
Success message shown to user
```

---

## 🚀 Performance Tips

### For Development Speed

1. **Use `npm run watch`** to avoid recompiling for each change
2. **Reload webview** with Ctrl+R instead of restarting whole extension
3. **Use breakpoints** instead of console.log for debugging
4. **Check bundle size** with `npm run compile` warnings

### For Runtime Performance

1. **Lazy render pages** - Only render visible pages (already implemented via IntersectionObserver)
2. **Cache annotations** - Sidecar files cached in memory (AnnotationService)
3. **Minimize WASM calls** - Batch PDF operations when possible
4. **Optimize regex** - PDF_LINK_REGEX is used frequently, keep it simple

---

## 🧪 Testing Best Practices

### Write Isolated Tests

```typescript
test('Feature works in isolation', async () => {
  // Arrange
  const input = prepareTestData();
  
  // Act
  const result = await functionUnderTest(input);
  
  // Assert
  assert.strictEqual(result, expected);
});
```

### Test Integration Points

- Extension activation
- Message passing between host/webview
- File system operations
- Command registration

### Avoid

- Hardcoded timeouts (use proper async/await)
- Tests that depend on other tests
- Tests that modify workspace permanently

---

## 📚 Key Concepts

### Custom Editor Provider
- Implements `vscode.CustomReadonlyEditorProvider`
- Manages webview lifecycle
- Handles message routing between host and webview
- See: `src/pdfEditorProvider.ts`

### DocumentLinkProvider
- Detects links in markdown text
- Returns array of `vscode.DocumentLink` objects
- VS Code renders them underlined/clickable
- See: `src/pdfLinkProvider.ts`

### Sidecar File Pattern
- Annotations stored in `{pdfname}.paperlink.json`
- Stays alongside PDF for portability
- In-memory cache for performance
- See: `src/annotationService.ts`

### Message Protocol
- Host ↔ Webview communicate via `postMessage()`
- Strictly typed with union types
- 11 total message types defined
- See: `src/shared/types.ts`

---

## ❓ Troubleshooting

### Build fails with "pdfium.wasm not found"
```bash
# Solution: Reinstall and rebuild
npm install
npm run compile
```

### Tests timeout
```bash
# Increase timeout or fix async/await
// In test:
this.timeout(10000); // Increase to 10 seconds
```

### Webview shows blank/error
1. Check Browser DevTools (Webview Developer Tools)
2. Check console.log output
3. Verify PDF file exists and is valid
4. Check file permissions

### Extension doesn't activate
1. Verify `activationEvents` in package.json
2. Check that you're opening a `.pdf` file
3. Look at Extension Output panel for errors

---

## 📖 Further Reading

- **Architecture Details** → See `ARCHITECTURE.md`
- **File Inventory** → See `CODEBASE_MAP.md`
- **Project Status** → See `PROJECT_STATUS.md`
- **VS Code API** → https://code.visualstudio.com/api
- **Webpack Docs** → https://webpack.js.org/

---

**Last Updated**: April 18, 2026

