/// <reference path="./vscode.d.ts" />
/**
 * Placeholder webview script for the future Obsidian-style markdown editor.
 * Today: just mirrors the host's `setText` into a <pre> preview element so
 * the contract is exercised end-to-end.
 */

const vscode = acquireVsCodeApi();
const preview = document.getElementById('preview') as HTMLPreElement | null;

window.addEventListener('message', ev => {
  const msg = ev.data;
  if (msg?.type === 'setText' && preview) {
    preview.textContent = (msg.text as string) ?? '';
  }
});

vscode.postMessage({ type: 'ready' });
