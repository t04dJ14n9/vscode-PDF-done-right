/// <reference path="./vscode.d.ts" />
/**
 * PDFDR Markdown Editor — CodeMirror 6 based Obsidian-style editor.
 *
 * Protocol (Extension host ⇄ Webview):
 *   host → webview:
 *     { type: 'setText'; text: string }          — set entire document content
 *     { type: 'reveal'; line: number; col: number } — scroll to position
 *     { type: 'setSettings'; settings: Partial<EditorSettings> } — update settings
 *   webview → host:
 *     { type: 'ready' }
 *     { type: 'edit'; text: string }             — full document replacement
 *     { type: 'save' }
 *     { type: 'openFile'; path: string }
 *     { type: 'openCodeRef'; path: string; startLine?: number; endLine?: number }
 *     { type: 'openPdfRef'; pdfPath: string; anchor: string }
 *     { type: 'openImage'; path: string }
 *     { type: 'openExternal'; url: string }
 */

// Global error handler — log to both console and host
window.onerror = (msg, src, line, col, err) => {
  console.error('[PDFDR MD] Uncaught error:', msg, src, line, col, err);
  try {
    const vscodeApi = acquireVsCodeApi();
    vscodeApi.postMessage({ type: 'error', message: String(msg), source: String(src), line, col });
  } catch { /* ignore */ }
};
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[PDFDR MD] Unhandled rejection:', ev.reason);
  try {
    const vscodeApi = acquireVsCodeApi();
    vscodeApi.postMessage({ type: 'error', message: `Unhandled rejection: ${ev.reason}` });
  } catch { /* ignore */ }
});

import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, ViewPlugin, Decoration, ViewUpdate } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintKeymap } from '@codemirror/lint';
import { vim } from '@replit/codemirror-vim';

import { wikiLink, wikiLinkCompletion, WikiLinkConfig } from './extensions/wikiLink';
import { cmdClickLink, CmdClickLinkConfig } from './extensions/cmdClickLink';
import { hybridRendering, getHybridDebugStats, resetHybridDebugStats } from './extensions/hybridRendering';
import { codeFenceHiding } from './extensions/codeFenceHiding';
// ─── Settings ───────────────────────────────────────────────────────────────

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  lineNumbers: boolean;
  wordWrap: boolean;
  tabSize: number;
  spellcheck: boolean;
  vimMode: boolean;
  editorTheme: 'inherit' | 'light' | 'dark';
  hybridRendering: boolean;
  codeFenceHiding: boolean;
  syntaxHighlighting: boolean;
  bracketPairColorization: boolean;
}

const defaultSettings: EditorSettings = {
  fontFamily: 'JetBrains Mono, Menlo, Monaco, Courier New, monospace',
  fontSize: 14,
  lineHeight: 1.6,
  lineNumbers: true,
  wordWrap: true,
  tabSize: 2,
  spellcheck: true,
  vimMode: false,
  editorTheme: 'inherit',
  hybridRendering: true,
  codeFenceHiding: true,
  syntaxHighlighting: true,
  bracketPairColorization: true,
};

let settings: EditorSettings = { ...defaultSettings };

// ─── Compartments for dynamic settings ──────────────────────────────────────

const tabSizeCompartment = new Compartment();
const lineNumbersCompartment = new Compartment();
const wordWrapCompartment = new Compartment();
const spellcheckCompartment = new Compartment();
const vimModeCompartment = new Compartment();
const hybridRenderingCompartment = new Compartment();
const codeFenceHidingCompartment = new Compartment();
const syntaxHighlightingCompartment = new Compartment();
const editorThemeCompartment = new Compartment();
const bracketMatchingCompartment = new Compartment();

// ─── VS Code API ────────────────────────────────────────────────────────────

const vscodeApi = acquireVsCodeApi();

let imageRequestSeq = 0;
const imageDataCache = new Map<string, string | null>();
const pendingImageRequests = new Map<string, { path: string; resolve: (value: string | null) => void; timeout: number }>();

function requestImageData(path: string): Promise<string | null> {
  const key = path.trim();
  if (!key) return Promise.resolve(null);
  if (imageDataCache.has(key)) return Promise.resolve(imageDataCache.get(key) ?? null);

  const requestId = `img-${Date.now()}-${imageRequestSeq++}`;
  return new Promise<string | null>((resolve) => {
    const timeout = window.setTimeout(() => {
      pendingImageRequests.delete(requestId);
      imageDataCache.set(key, null);
      resolve(null);
    }, 5000);

    pendingImageRequests.set(requestId, { path: key, resolve, timeout });
    vscodeApi.postMessage({ type: 'requestImageData', requestId, path: key });
  });
}

// ─── Callbacks for extensions ───────────────────────────────────────────────

const wikiLinkConfig: WikiLinkConfig = {
  resolveNote: (name: string) => null,
  openNote: (filePath: string, _section?: string) => {
    vscodeApi.postMessage({ type: 'openFile', path: filePath });
  },
  onOpenCodeRef: (href: string, startLine?: number, endLine?: number) => {
    console.log('[PDFDR MD] onOpenCodeRef:', href, startLine, endLine);
    vscodeApi.postMessage({ type: 'openCodeRef', path: href, startLine, endLine });
  },
  onOpenPdfRef: (pdfPath: string, anchor: string) => {
    console.log('[PDFDR MD] onOpenPdfRef:', pdfPath, anchor);
    vscodeApi.postMessage({ type: 'openPdfRef', pdfPath, anchor });
  },
  resolveImageSrc: (imagePath: string) => requestImageData(imagePath),
  onOpenImage: (imagePath: string) => {
    vscodeApi.postMessage({ type: 'openImage', path: imagePath });
  },
};

const cmdClickConfig: CmdClickLinkConfig = {
  onOpenExternal: (url: string) => {
    vscodeApi.postMessage({ type: 'openExternal', url });
  },
  onOpenFile: (filePath: string) => {
    vscodeApi.postMessage({ type: 'openFile', path: filePath });
  },
  currentFilePath: () => '',
};

// ─── Theme ──────────────────────────────────────────────────────────────────

function getAppearance(): 'dark' | 'light' {
  if (settings.editorTheme !== 'inherit') return settings.editorTheme;
  return document.body.classList.contains('vscode-light') ? 'light' : 'dark';
}

function createEditorTheme() {
  return EditorView.theme({
    '&': {
      height: '100%',
      fontSize: `${settings.fontSize}px`,
      fontFamily: settings.fontFamily,
    },
    '.cm-scroller': {
      fontFamily: settings.fontFamily,
      overflow: 'auto',
    },
    '.cm-content': {
      caretColor: 'var(--vscode-editorCursor-foreground, #aeafad)',
      lineHeight: String(settings.lineHeight),
      padding: '8px 0',
    },
    '.cm-cursor': {
      borderLeftColor: 'var(--vscode-editorCursor-foreground, #aeafad)',
      borderLeftWidth: '2px',
    },
    '.cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'var(--vscode-editor-inactiveSelectionBackground, rgba(38, 79, 120, 0.55)) !important',
    },
    '.cm-focused .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'var(--vscode-editor-selectionBackground, #264f78) !important',
    },
    '.cm-focused .cm-activeLine .cm-selectionBackground': {
      backgroundColor: 'var(--vscode-editor-selectionBackground, #264f78) !important',
    },
    '.cm-content ::selection': {
      backgroundColor: 'var(--vscode-editor-selectionBackground, #264f78) !important',
    },
    '.cm-line ::selection': {
      backgroundColor: 'var(--vscode-editor-selectionBackground, #264f78) !important',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--vscode-editorGutter-background, #1e1e1e)',
      color: 'var(--vscode-editorGutter-foreground, #858585)',
      borderRight: '1px solid var(--vscode-editorGutter-border, #3e3e42)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--vscode-editorIndentGuide-background1, #2a2d2e)',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--vscode-editor-lineHighlightBackground, rgba(42, 45, 46, 0.45)) 45%, transparent)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
  }, { dark: getAppearance() === 'dark' });
}

// ─── Save keymap ────────────────────────────────────────────────────────────

const saveKeymap = keymap.of([{
  key: 'Mod-s',
  run: () => {
    vscodeApi.postMessage({ type: 'save' });
    return true;
  },
  preventDefault: true,
}]);

function surroundSelections(left: string, right = left) {
  return (view: EditorView): boolean => {
    const range = view.state.selection.main;
    const selected = view.state.sliceDoc(range.from, range.to);

    view.dispatch({
      changes: { from: range.from, to: range.to, insert: `${left}${selected}${right}` },
      selection: {
        anchor: range.from + left.length,
        head: range.to + left.length,
      },
      scrollIntoView: true,
    });
    return true;
  };
}

function toggleTaskOnSelectedLines(view: EditorView): boolean {
  const lines = new Map<number, { from: number; to: number; text: string }>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) {
      const line = view.state.doc.line(n);
      lines.set(n, { from: line.from, to: line.to, text: line.text });
    }
  }

  if (lines.size === 0) return false;

  const taskRegex = /^(\s*(?:[-+*]|\d+\.)\s+)\[(?: |x|X|1)\]/;
  const listRegex = /^(\s*(?:[-+*]|\d+\.)\s+)(?!\[)/;
  const changes: Array<{ from: number; to: number; insert: string }> = [];

  for (const [, line] of [...lines.entries()].sort((a, b) => b[0] - a[0])) {
    const taskMatch = taskRegex.exec(line.text);
    if (taskMatch) {
      const prefix = taskMatch[1] ?? '';
      const markerStart = line.from + prefix.length;
      const markerEnd = markerStart + 3;
      const current = line.text.slice(prefix.length, prefix.length + 3).toLowerCase();
      const next = current === '[x]' || current === '[1]' ? '[ ]' : '[x]';
      changes.push({ from: markerStart, to: markerEnd, insert: next });
      continue;
    }

    const listMatch = listRegex.exec(line.text);
    if (listMatch) {
      const prefix = listMatch[1] ?? '';
      const markerPos = line.from + prefix.length;
      changes.push({ from: markerPos, to: markerPos, insert: '[ ] ' });
      continue;
    }

    const insertPos = line.from;
    const leadingWhitespace = /^\s*/.exec(line.text)?.[0] ?? '';
    changes.push({ from: insertPos + leadingWhitespace.length, to: insertPos + leadingWhitespace.length, insert: '- [ ] ' });
  }

  if (changes.length === 0) return false;

  view.dispatch({ changes, scrollIntoView: true });
  return true;
}

const obsidianMarkdownKeymap = keymap.of([
  {
    key: 'Mod-b',
    run: surroundSelections('**'),
    preventDefault: true,
  },
  {
    key: 'Mod-i',
    run: surroundSelections('*'),
    preventDefault: true,
  },
  {
    key: 'Mod-Shift-s',
    run: surroundSelections('~~'),
    preventDefault: true,
  },
  {
    key: 'Mod-e',
    run: surroundSelections('`'),
    preventDefault: true,
  },
  {
    key: 'Mod-Enter',
    run: toggleTaskOnSelectedLines,
    preventDefault: true,
  },
]);

const obsidianCodeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--paperlink-code-keyword, #c792ea)' },
  { tag: [t.className, t.typeName, t.namespace], color: 'var(--paperlink-code-type, #ffcb6b)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--paperlink-code-function, #82aaff)' },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: 'var(--paperlink-code-name, #b0bec5)' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: 'var(--paperlink-code-literal, #f78c6c)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--paperlink-code-string, #c3e88d)' },
  { tag: [t.comment], color: 'var(--paperlink-code-comment, #7f848e)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation], color: 'var(--paperlink-code-operator, #89ddff)' },
]);

function getSyntaxHighlightExtensions() {
  if (!settings.syntaxHighlighting) return [];
  return [
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    syntaxHighlighting(obsidianCodeHighlightStyle),
  ];
}

// Prevent arrow-key events from bubbling to the host workbench keybindings.
// CM should still handle these keys normally (move cursor by one line/column).
const isolateArrowKeys = EditorView.domEventHandlers({
  keydown: (event: KeyboardEvent) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.stopPropagation();
    }
    return false;
  },
});

const pasteImageHandler = EditorView.domEventHandlers({
  paste: (event: ClipboardEvent) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return false;
    const imageItem = Array.from(clipboard.items).find(item => item.type.startsWith('image/'));
    if (!imageItem) return false;
    const file = imageItem.getAsFile();
    if (!file) return false;

    event.preventDefault();
    event.stopPropagation();

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) return;
      vscodeApi.postMessage({
        type: 'pasteImage',
        mimeType: file.type || imageItem.type || 'image/png',
        dataUrl,
      });
    };
    reader.readAsDataURL(file);
    return true;
  },
});

const activeLineDecoration = Decoration.line({ class: 'cm-activeLine' });

function buildActiveLineDecorations(view: EditorView): DecorationSet {
  if (view.state.selection.ranges.some(range => !range.empty)) {
    return Decoration.none;
  }

  const decorations = view.state.selection.ranges.map(range => {
    const line = view.state.doc.lineAt(range.head);
    return activeLineDecoration.range(line.from);
  });
  return Decoration.set(decorations, true);
}

function selectionAwareActiveLine() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildActiveLineDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildActiveLineDecorations(update.view);
        }
      }
    },
    {
      decorations: plugin => plugin.decorations,
    },
  );
}

// ─── Build extensions ───────────────────────────────────────────────────────

function buildExtensions() {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlightingCompartment.of(getSyntaxHighlightExtensions()),
    bracketMatchingCompartment.of(settings.bracketPairColorization ? bracketMatching() : []),
    closeBrackets(),
    autocompletion({
      override: [wikiLinkCompletion(wikiLinkConfig)],
    }),
    foldGutter(),
    selectionAwareActiveLine(),
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    rectangularSelection(),
    crosshairCursor(),
    lineNumbersCompartment.of(settings.lineNumbers ? lineNumbers() : []),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    tabSizeCompartment.of(EditorState.tabSize.of(settings.tabSize)),
    wordWrapCompartment.of(settings.wordWrap ? EditorView.lineWrapping : []),
    spellcheckCompartment.of(
      EditorView.contentAttributes.of({ spellcheck: String(settings.spellcheck) })
    ),
    keymap.of([
      ...markdownKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    isolateArrowKeys,
    pasteImageHandler,
    obsidianMarkdownKeymap,
    saveKeymap,
    cmdClickLink(cmdClickConfig),
    wikiLink(wikiLinkConfig),
    hybridRenderingCompartment.of(settings.hybridRendering ? hybridRendering() : []),
    codeFenceHidingCompartment.of(settings.codeFenceHiding ? codeFenceHiding() : []),
    vimModeCompartment.of(settings.vimMode ? [vim()] : []),
    editorThemeCompartment.of(createEditorTheme()),
  ];
}

// ─── Create editor ──────────────────────────────────────────────────────────

let view: EditorView;
let settingVersion = 0;

function createEditor(parent: HTMLElement, text: string): void {
  view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: buildExtensions(),
    }),
    parent,
    dispatch: (tr) => {
      view.update([tr]);
      if (tr.docChanged) {
        vscodeApi.postMessage({ type: 'edit', text: view.state.doc.toString() });
      }
    },
  });

  // Focus the editor
  view.focus();
}

// ─── Apply settings dynamically ─────────────────────────────────────────────

function applySettings(newSettings: Partial<EditorSettings>): void {
  const prev = { ...settings };
  Object.assign(settings, newSettings);
  settingVersion++;

  const effects: any[] = [];

  if (prev.tabSize !== settings.tabSize) {
    effects.push(tabSizeCompartment.reconfigure(EditorState.tabSize.of(settings.tabSize)));
  }
  if (prev.lineNumbers !== settings.lineNumbers) {
    effects.push(lineNumbersCompartment.reconfigure(settings.lineNumbers ? lineNumbers() : []));
  }
  if (prev.wordWrap !== settings.wordWrap) {
    effects.push(wordWrapCompartment.reconfigure(settings.wordWrap ? EditorView.lineWrapping : []));
  }
  if (prev.spellcheck !== settings.spellcheck) {
    effects.push(spellcheckCompartment.reconfigure(
      EditorView.contentAttributes.of({ spellcheck: String(settings.spellcheck) })
    ));
  }
  if (prev.vimMode !== settings.vimMode) {
    effects.push(vimModeCompartment.reconfigure(settings.vimMode ? [vim()] : []));
  }
  if (prev.hybridRendering !== settings.hybridRendering) {
    effects.push(hybridRenderingCompartment.reconfigure(settings.hybridRendering ? hybridRendering() : []));
  }
  if (prev.codeFenceHiding !== settings.codeFenceHiding) {
    effects.push(codeFenceHidingCompartment.reconfigure(settings.codeFenceHiding ? codeFenceHiding() : []));
  }
  if (prev.syntaxHighlighting !== settings.syntaxHighlighting) {
    effects.push(syntaxHighlightingCompartment.reconfigure(getSyntaxHighlightExtensions()));
  }
  if (prev.bracketPairColorization !== settings.bracketPairColorization) {
    effects.push(bracketMatchingCompartment.reconfigure(settings.bracketPairColorization ? bracketMatching() : []));
  }
  if (
    prev.fontFamily !== settings.fontFamily
    || prev.fontSize !== settings.fontSize
    || prev.lineHeight !== settings.lineHeight
    || prev.editorTheme !== settings.editorTheme
  ) {
    effects.push(editorThemeCompartment.reconfigure(createEditorTheme()));
  }

  if (effects.length > 0 && view) {
    view.dispatch({ effects });
  }
}

// ─── Message handler ────────────────────────────────────────────────────────

const editorContainer = document.getElementById('editor');

window.addEventListener('message', ev => {
  const msg = ev.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case 'setText': {
      const text = (msg.text as string) ?? '';
      if (view) {
        // Only set if content differs (avoid clobbering during typing)
        const current = view.state.doc.toString();
        if (current !== text) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
          });
        }
      } else if (editorContainer) {
        createEditor(editorContainer, text);
      }
      break;
    }
    case 'reveal': {
      if (view) {
        const line = Math.max(0, (msg.line as number) ?? 0);
        const col = Math.max(0, (msg.col as number) ?? 0);
        const pos = view.state.doc.line(line + 1).from + col;
        view.dispatch({
          selection: { anchor: pos },
          scrollIntoView: true,
        });
        view.focus();
      }
      break;
    }
    case 'setSettings': {
      if (msg.settings) {
        applySettings(msg.settings as Partial<EditorSettings>);
      }
      break;
    }
    case 'insertText': {
      if (view) {
        const text = (msg.text as string) ?? '';
        const range = view.state.selection.main;
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: text },
          selection: { anchor: range.from + text.length },
          scrollIntoView: true,
        });
        view.focus();
      }
      break;
    }
    case 'imageData': {
      const requestId = String(msg.requestId ?? '');
      const pending = pendingImageRequests.get(requestId);
      if (pending) {
        window.clearTimeout(pending.timeout);
        pendingImageRequests.delete(requestId);
        const dataUrl = typeof msg.dataUrl === 'string' ? msg.dataUrl : null;
        imageDataCache.set(pending.path, dataUrl);
        pending.resolve(dataUrl);
      }
      break;
    }
    case 'diagnostic': {
      // Host requests diagnostic info about the editor state
      const diag: any = {
        type: 'diagnostic',
        viewExists: !!view,
      };
      if (view) {
        const doc = view.state.doc;
        diag.docLength = doc.length;
        diag.docLines = doc.lines;
        diag.docText = doc.toString().slice(0, 500);
        diag.selections = view.state.selection.ranges.map(r => ({ from: r.from, to: r.to }));

        // Check for wiki/pdf/code link widgets in the DOM
        const pdfLinks = document.querySelectorAll('.cm-pdf-link');
        const codeLinks = document.querySelectorAll('.cm-code-link');
        const wikiLinks = document.querySelectorAll('.cm-wiki-link');
        const imageLinks = document.querySelectorAll('.cm-image-wiki');
        diag.pdfLinkCount = pdfLinks.length;
        diag.codeLinkCount = codeLinks.length;
        diag.wikiLinkCount = wikiLinks.length;
        diag.imageLinkCount = imageLinks.length;

        // Check if pdf links have data attributes
        if (pdfLinks.length > 0) {
          const first = pdfLinks[0] as HTMLElement;
          diag.firstPdfLink = {
            pdfPath: first.dataset.pdfPath,
            anchor: first.dataset.anchor,
            className: first.className,
            innerHTML: first.innerHTML.slice(0, 200),
          };
        }

        if (imageLinks.length > 0) {
          const first = imageLinks[0] as HTMLElement;
          const img = first.querySelector('img') as HTMLImageElement | null;
          const rect = first.getBoundingClientRect();
          const imgRect = img?.getBoundingClientRect();
          const lineRect = first.closest('.cm-line')?.getBoundingClientRect();
          diag.firstImageLink = {
            imagePath: first.dataset.imagePath,
            textContent: first.textContent?.slice(0, 200),
            visible: rect.width > 0 && rect.height > 0,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            imgTop: imgRect?.top,
            lineTop: lineRect?.top,
            imgTopDeltaFromLine: imgRect && lineRect ? imgRect.top - lineRect.top : undefined,
            imgDisplay: img?.style.display,
            imgComplete: img?.complete,
            imgNaturalWidth: img?.naturalWidth,
            imgSrcPrefix: img?.src?.slice(0, 30),
          };
        }

        // Simulate a click on the first pdf link to test the handler
        if (pdfLinks.length > 0) {
          const first = pdfLinks[0] as HTMLElement;
          // Check if the element has an event listener by testing getBoundingClientRect
          const rect = first.getBoundingClientRect();
          diag.firstPdfLinkPosition = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
          diag.firstPdfLinkVisible = rect.width > 0 && rect.height > 0;
        }

        // Check hybrid rendering decorations (DOM viewport only — CM6 virtual rendering)
        const hybridDecos = {
          bold: document.querySelectorAll('.cm-hybrid-bold').length,
          italic: document.querySelectorAll('.cm-hybrid-italic').length,
          strikethrough: document.querySelectorAll('.cm-hybrid-strikethrough').length,
          inlineCode: document.querySelectorAll('.cm-hybrid-inline-code').length,
          headings: document.querySelectorAll('.cm-hybrid-heading-line').length,
          blockquotes: document.querySelectorAll('.cm-hybrid-blockquote-line').length,
          bullets: document.querySelectorAll('.cm-hybrid-bullet').length,
          numbers: document.querySelectorAll('.cm-hybrid-number').length,
          taskCheckboxes: document.querySelectorAll('.cm-hybrid-task-checkbox').length,
          images: document.querySelectorAll('.cm-hybrid-image').length,
          horizontalRules: document.querySelectorAll('.cm-hybrid-hr').length,
          codeBlockContentLines: document.querySelectorAll('.cm-code-block-content-line').length,
        };
        diag.hybridRendering = hybridDecos;

        // DOM viewport info
        const allLines = document.querySelectorAll('.cm-line');
        diag.totalLines = allLines.length;
        diag.firstLineText = allLines[0]?.textContent?.slice(0, 50);

        // Debug: check if bold/italic/strikethrough text exists in viewport
        const boldLine = Array.from(allLines).find(l => l.textContent?.includes('Bold text'));
        diag.boldLineFound = !!boldLine;
        diag.boldLineText = boldLine?.textContent?.slice(0, 50);
        diag.boldLineHTML = boldLine?.innerHTML?.slice(0, 500);

        const italicLine = Array.from(allLines).find(l => l.textContent?.includes('Italic text'));
        diag.italicLineHTML = italicLine?.innerHTML?.slice(0, 500);

        const strikeLine = Array.from(allLines).find(l => l.textContent?.includes('Strikethrough'));
        diag.strikeLineHTML = strikeLine?.innerHTML?.slice(0, 500);

        // Check the actual doc text around the bold area
        if (view) {
          const doc = view.state.doc;
          diag.docAroundBold = doc.sliceString(310, 370);

          // Check which lines are active (cursor lines)
          const activeLines = new Set<number>();
          for (const range of view.state.selection.ranges) {
            const startLine = doc.lineAt(range.from).number;
            const endLine = doc.lineAt(range.to).number;
            for (let l = startLine; l <= endLine; l++) {
              activeLines.add(l);
            }
          }
          diag.activeLines = Array.from(activeLines);
          diag.totalDocLines = doc.lines;

          // Hybrid rendering debug stats
          const hybridDebug = getHybridDebugStats();
          diag.hybridDebug = hybridDebug;
        }

        // Debug: check syntax tree for emphasis nodes
        if (view) {
          const tree = syntaxTree(view.state);
          let emphasisCount = 0;
          let emphasisMarks = 0;
          const markDetails: any[] = [];
          tree.iterate({
            enter(node) {
              if (node.name === 'Emphasis') emphasisCount++;
              if (node.name === 'EmphasisMark') {
                emphasisMarks++;
                const text = view.state.sliceDoc(node.from, node.to);
                markDetails.push({ text, from: node.from, to: node.to });
              }
            },
          });
          diag.syntaxTreeEmphasis = emphasisCount;
          diag.syntaxTreeEmphasisMarks = emphasisMarks;
          diag.markDetails = markDetails.slice(0, 10);
        }

        // Sample some DOM content for verification
        const firstHeading = document.querySelector('.cm-hybrid-heading-line');
        if (firstHeading) {
          diag.firstHeadingText = firstHeading.textContent?.slice(0, 50);
        }
        const firstBullet = document.querySelector('.cm-hybrid-bullet');
        if (firstBullet) {
          diag.firstBulletText = firstBullet.textContent;
        }
        const firstInlineCode = document.querySelector('.cm-hybrid-inline-code');
        if (firstInlineCode) {
          diag.firstInlineCodeText = firstInlineCode.textContent?.slice(0, 30);
        }

        diag.errors = [];
      }
      vscodeApi.postMessage(diag);
      break;
    }
    case 'imageDoubleClickTest': {
      const result: any = { type: 'imageDoubleClickTest' };
      const imageLinks = document.querySelectorAll('.cm-image-wiki');
      if (imageLinks.length === 0) {
        result.error = 'No .cm-image-wiki elements found in DOM';
      } else {
        const first = imageLinks[0] as HTMLElement;
        result.imagePath = first.dataset.imagePath;
        const event = new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          view: window,
        });
        result.dispatched = first.dispatchEvent(event);
      }
      vscodeApi.postMessage(result);
      break;
    }
    case 'imagePasteTest': {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/luz3WQAAAABJRU5ErkJggg==';
      vscodeApi.postMessage({ type: 'pasteImage', mimeType: 'image/png', dataUrl });
      vscodeApi.postMessage({ type: 'imagePasteTest', dispatched: true });
      break;
    }
    case 'imageCursorLineTest': {
      const result: any = { type: 'imageCursorLineTest' };
      if (!view) {
        result.error = 'No editor view';
        vscodeApi.postMessage(result);
        break;
      }

      const docText = view.state.doc.toString();
      const match = /!\[\[[^\]]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\|[^\]]*)?\]\]/i.exec(docText);
      if (!match) {
        result.error = 'No image embed found';
        vscodeApi.postMessage(result);
        break;
      }

      view.dispatch({
        selection: { anchor: match.index + 2 },
        scrollIntoView: true,
      });
      window.setTimeout(() => {
        try {
          const image = document.querySelector('.cm-image-wiki') as HTMLElement | null;
          const img = image?.querySelector('img') as HTMLImageElement | null;
          const imageRect = image?.getBoundingClientRect();
          const imgRect = img?.getBoundingClientRect();
          const lineRect = image?.closest('.cm-line')?.getBoundingClientRect();
          result.imagePath = image?.dataset.imagePath;
          result.className = image?.className;
          result.firstLineText = image?.closest('.cm-line')?.textContent?.slice(0, 100);
          result.imgTopDeltaFromLine = imgRect && lineRect ? imgRect.top - lineRect.top : undefined;
          result.visible = !!imageRect && imageRect.width > 0 && imageRect.height > 0;
          result.imgNaturalWidth = img?.naturalWidth;
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
        }
        vscodeApi.postMessage(result);
      }, 50);
      break;
    }
    case 'clickTest': {
      // Host requests: simulate clicking the first @pdf link
      const result: any = { type: 'clickTest' };
      const pdfLinks = document.querySelectorAll('.cm-pdf-link');
      if (pdfLinks.length === 0) {
        result.error = 'No .cm-pdf-link elements found in DOM';
      } else {
        const first = pdfLinks[0] as HTMLElement;
        result.pdfPath = first.dataset.pdfPath;
        result.anchor = first.dataset.anchor;

        // Instead of dispatching a synthetic click (which CM6 may ignore),
        // directly call the callback that the click handler would invoke
        if (first.dataset.pdfPath && first.dataset.anchor) {
          result.callingCallback = true;
          // The wikiLink click handler calls config.onOpenPdfRef
          // We can't access the config from here, but we can dispatch a real click
          // which should trigger the domEventHandlers
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
          });
          const dispatched = first.dispatchEvent(clickEvent);
          result.dispatched = dispatched;
        } else {
          result.error = 'PDF link missing data attributes';
        }
      }
      vscodeApi.postMessage(result);
      break;
    }
  }
});

// Signal ready
console.log('[PDFDR MD] Editor script loaded, posting ready');
vscodeApi.postMessage({ type: 'ready' });
