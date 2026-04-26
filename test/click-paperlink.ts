/**
 * Click the PDF Done Right activity-bar icon, take screenshot, inspect sidebar.
 */
import WebSocket from 'ws';

const PORT = 9333;

async function getTargets(): Promise<any[]> {
  const r = await fetch(`http://localhost:${PORT}/json`);
  return await r.json() as any[];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const ts = await getTargets();
  const page = ts.find(t => t.type === 'page')!;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>(r => ws.on('open', () => r()));
  let id = 1;
  const send = (method: string, params: any = {}) =>
    new Promise<any>((resolve, reject) => {
      const myId = id++;
      const onMsg = (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.id === myId) {
          ws.off('message', onMsg);
          if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  // Find the PDF Done Right activity bar icon by aria-label
  const locate = await send('Runtime.evaluate', {
    expression: `
      (function(){
        var nodes = Array.from(document.querySelectorAll('.activitybar .action-item'));
        var rows = nodes.map(n => {
          var r = n.getBoundingClientRect();
          var label = (n.getAttribute('aria-label') || n.querySelector('.action-label')?.getAttribute('aria-label') || n.textContent || '').trim();
          return { label, x: r.left + r.width/2, y: r.top + r.height/2 };
        });
        return JSON.stringify(rows);
      })()
    `,
    returnByValue: true,
  });
  const rows = JSON.parse(locate.result.value);
  console.log('activity bar items:');
  for (const r of rows) console.log(' ', r);
  const pl = rows.find((r: any) => /paperlink/i.test(r.label));
  if (!pl) { console.error('no PDF Done Right action found'); process.exit(2); }
  console.log('clicking', pl);

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pl.x, y: pl.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pl.x, y: pl.y, button: 'left', clickCount: 1 });
  await sleep(1500);

  // Inspect the now-open sidebar: headers + first 20 tree items
  const inspect = await send('Runtime.evaluate', {
    expression: `
      (function(){
        var headers = Array.from(document.querySelectorAll('.sidebar .pane-header .title'))
          .map(h => (h.textContent||'').trim());
        var labels = Array.from(document.querySelectorAll('.sidebar .monaco-list-row .label-name'))
          .slice(0, 40).map(el => (el.textContent||'').trim());
        return JSON.stringify({ headers, labels });
      })()
    `,
    returnByValue: true,
  });
  console.log('sidebar after click:', inspect.result.value);

  // Screenshot
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('test/screenshots/paperlink-sidebar.png', Buffer.from(shot.data, 'base64'));
  console.log('screenshot → test/screenshots/paperlink-sidebar.png');
  ws.close();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
