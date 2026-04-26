/**
 * Smoke-test driver for PDF Done Right.
 *
 * Prerequisites: a dev VS Code instance running at `--remote-debugging-port=$PORT`
 * with the `vscode-PDF-done-right/test-workspace` folder opened. (See README.)
 *
 * Usage: `PORT=9333 node out/test/smoke.js` after `npx tsc -p test/tsconfig.json`.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9333;
const BASE = `http://localhost:${PORT}`;

async function cdp(wsUrl: string, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('cdp timeout: ' + method)); }, 10000);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', (d: any) => {
      const m = JSON.parse(d.toString());
      if (m.id === 1) {
        clearTimeout(timer);
        ws.close();
        if (m.error) reject(new Error(m.error.message || String(m.error)));
        else resolve(m.result);
      }
    });
    ws.on('error', (e: any) => { clearTimeout(timer); reject(e); });
  });
}

async function getTargets() {
  const r = await fetch(BASE + '/json');
  return await r.json() as any[];
}

async function driver(pageWs: string, steps: (send: (m: string, p?: any) => Promise<any>) => Promise<void>): Promise<void> {
  const ws = new WebSocket(pageWs);
  await new Promise<void>(r => ws.on('open', () => r()));
  let id = 1;
  const send = (method: string, params: any = {}) =>
    new Promise<any>((resolve, reject) => {
      const myId = id++;
      const onMsg = (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.id === myId) {
          ws.off('message', onMsg);
          if (m.error) reject(new Error(m.error.message || String(m.error)));
          else resolve(m.result);
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  try {
    await steps(send);
  } finally {
    ws.close();
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log(`Connecting to VS Code at ${BASE}...`);

  const fails: string[] = [];
  function expect(cond: unknown, msg: string) {
    if (!cond) {
      console.error('FAIL:', msg);
      fails.push(msg);
    } else {
      console.log('OK:  ', msg);
    }
  }

  // 1. Dismiss welcome, open sample.pdf
  let targets = await getTargets();
  const pageTarget = targets.find(t => t.type === 'page');
  if (!pageTarget) throw new Error('No VS Code page target');

  await driver(pageTarget.webSocketDebuggerUrl, async (send) => {
    // Dismiss the "Welcome to VS Code" sign-in modal if present.
    // The modal has 3 pages; click "Continue without Signing In" / Skip
    // several times to cover all of them.
    for (let i = 0; i < 4; i++) {
      // Continue-without-sign-in button (right side)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 804, y: 525, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 804, y: 525, button: 'left', clickCount: 1 });
      await sleep(700);
      // Skip button (left side)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 222, y: 525, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 222, y: 525, button: 'left', clickCount: 1 });
      await sleep(700);
    }
    // Escape anything lingering
    for (let i = 0; i < 3; i++) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(200);
    }
    // Cmd+P sample.pdf
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', modifiers: 4, windowsVirtualKeyCode: 80 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 4, windowsVirtualKeyCode: 80 });
    await sleep(600);
    await send('Input.insertText', { text: 'sample.pdf' });
    await sleep(500);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  });
  await sleep(8000);

  // 2. Probe every iframe for the PDF Done Right viewer
  targets = await getTargets();
  const iframes = targets.filter(t => t.type === 'iframe');
  let pdfInfo: any = null;
  const probeExpr =
    '(function(){var f=document.querySelector("iframe");if(!f||!f.contentDocument)return JSON.stringify({noInner:true});var d=f.contentDocument;return JSON.stringify({title:d.title,canvas:d.querySelectorAll("canvas").length,pageWrappers:d.querySelectorAll(".page-wrapper").length,textSpans:d.querySelectorAll(".text-layer span").length,highlights:d.querySelectorAll(".annotation-highlight").length,referenced:d.querySelectorAll(".annotation-highlight.referenced").length,annotated:d.querySelectorAll(".annotation-highlight.annotated").length,pageInfo:(d.querySelector("#page-info")||{}).textContent||""});})()';

  for (const f of iframes) {
    try {
      const r = await cdp(f.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: probeExpr,
        returnByValue: true,
      });
      const info = JSON.parse(r.result.value);
      if (info.title === 'PDF Done Right Viewer') {
        pdfInfo = info;
        console.log('Found PDF Done Right viewer:', JSON.stringify(info));
      }
    } catch { /* ignore */ }
  }

  expect(pdfInfo, 'PDF Done Right PDF viewer iframe exists');
  if (pdfInfo) {
    expect(pdfInfo.canvas >= 1, `canvas count >= 1 (got ${pdfInfo.canvas})`);
    expect(pdfInfo.pageWrappers >= 1, `pageWrappers >= 1 (got ${pdfInfo.pageWrappers})`);
    expect(pdfInfo.textSpans >= 1, `textSpans >= 1 (got ${pdfInfo.textSpans})`);
    expect(pdfInfo.highlights >= 1, `highlights >= 1 (got ${pdfInfo.highlights}) — references from notes.md should be drawn`);
    expect(pdfInfo.referenced >= 1, `referenced highlights >= 1 (got ${pdfInfo.referenced})`);
  }

  // 3. Verify index.json was written somewhere under the repo
  const repoRoot = join(__dirname, '..', '..');
  const idxCandidates = [
    join(repoRoot, '.paperlink', 'index.json'),
    join(repoRoot, 'test-workspace', '.paperlink', 'index.json'),
  ];
  let idxFound = false;
  for (const p of idxCandidates) {
    try {
      const raw = readFileSync(p, 'utf8');
      const data = JSON.parse(raw);
      console.log(`index.json at ${p}:`);
      console.log(`  version=${data.version} annotations=${data.annotations.length} references=${data.references.length}`);
      for (const r of data.references) {
        console.log(`  ref: ${r.source} L${r.sourceLine} → ${r.pdf} (${r.anchor})`);
      }
      idxFound = true;
      expect(data.version === 2, 'index.json version is 2');
      expect(data.references.length >= 1, `index.json has at least one reference`);
      break;
    } catch { /* ignore */ }
  }
  expect(idxFound, 'index.json was produced');

  // 4. Screenshot the window for visual inspection
  targets = await getTargets();
  const page = targets.find(t => t.type === 'page')!;
  const shot = await cdp(page.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' });
  const shotPath = join(__dirname, '..', '..', 'test', 'screenshots', 'smoke-full.png');
  writeFileSync(shotPath, Buffer.from(shot.data as string, 'base64'));
  console.log(`screenshot → ${shotPath}`);

  if (fails.length > 0) {
    console.error(`\n${fails.length} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
