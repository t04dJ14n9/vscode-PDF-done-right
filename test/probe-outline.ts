/**
 * Drive a fresh VS Code: dismiss welcome, open sample.pdf, click PaperLink
 * activity-bar icon, then probe for outline tree items.
 */
import WebSocket from 'ws';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9333;
const BASE = `http://localhost:${PORT}`;

async function getTargets(): Promise<any[]> {
  const r = await fetch(BASE + '/json');
  return await r.json() as any[];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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
  try { await steps(send); } finally { ws.close(); }
}

async function main(): Promise<void> {
  const targets = await getTargets();
  const page = targets.find(t => t.type === 'page')!;

  await driver(page.webSocketDebuggerUrl, async (send) => {
    // Dismiss welcome tabs
    for (let i = 0; i < 4; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 804, y: 525, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 804, y: 525, button: 'left', clickCount: 1 });
      await sleep(500);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 222, y: 525, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 222, y: 525, button: 'left', clickCount: 1 });
      await sleep(500);
    }
    // Open sample.pdf via Cmd+P
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', modifiers: 4, windowsVirtualKeyCode: 80 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', modifiers: 4, windowsVirtualKeyCode: 80 });
    await sleep(600);
    await send('Input.insertText', { text: 'sample.pdf' });
    await sleep(500);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  });
  await sleep(8000);

  // Run workbench.view.extension.paperlink via the command palette
  const p2 = await getTargets();
  const page2 = p2.find(t => t.type === 'page')!;
  await driver(page2.webSocketDebuggerUrl, async (send) => {
    // Cmd+Shift+P
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'P', code: 'KeyP', modifiers: 6, windowsVirtualKeyCode: 80 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', modifiers: 6, windowsVirtualKeyCode: 80 });
    await sleep(500);
    await send('Input.insertText', { text: 'View: Show PaperLink' });
    await sleep(400);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  });
  await sleep(1500);

  // Inspect sidebar: list all pane headers + tree-item labels
  const p3 = await getTargets();
  const page3 = p3.find(t => t.type === 'page')!;
  const ws = new WebSocket(page3.webSocketDebuggerUrl);
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

  const inspect = await send('Runtime.evaluate', {
    expression: `
      (function(){
        var headers = Array.from(document.querySelectorAll(".pane-header .title, .pane-header h3.title"))
          .map(h => (h.textContent||"").trim());
        var treeItems = Array.from(document.querySelectorAll(".monaco-list-row .monaco-tl-contents .label-name, .monaco-list-row .label-name"))
          .slice(0, 60)
          .map(el => (el.textContent||"").trim());
        // Also capture the explicit outline view body contents if any.
        var outlineView = document.querySelector('[id*="paperlink.outline"] .pane-body');
        var outlineItems = outlineView ? Array.from(outlineView.querySelectorAll('.monaco-list-row .label-name')).map(el => (el.textContent||"").trim()) : null;
        return JSON.stringify({ headers, treeItems, outlineItems });
      })()
    `,
    returnByValue: true,
  });
  console.log('sidebar inspect:', inspect.result.value);
  ws.close();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
