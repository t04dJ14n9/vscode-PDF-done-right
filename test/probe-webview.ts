import WebSocket from 'ws';

function cdpEval(wsUrl: string, expression: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.on('message', (data: any) => {
      const resp = JSON.parse(data.toString());
      if (resp.id === 1) {
        clearTimeout(timeout); ws.close();
        if (resp.result?.result?.value) {
          try { resolve(JSON.parse(resp.result.result.value)); } catch { resolve(resp.result.result.value); }
        } else resolve(resp.result?.result);
      }
    });
    ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
  });
}

function cdpScreenshot(wsUrl: string, path: string): Promise<void> {
  const fs = require('fs');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    ws.on('message', (data: any) => {
      const resp = JSON.parse(data.toString());
      if (resp.id === 1 && resp.result?.data) {
        clearTimeout(timeout);
        fs.writeFileSync(path, Buffer.from(resp.result.data, 'base64'));
        ws.close(); resolve();
      }
    });
    ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
  });
}

async function main() {
  const targets: any[] = await (await fetch('http://localhost:9222/json')).json();
  const paperlink = targets.find((t: any) => t.url?.includes('t04dj14n9.vscode-pdf-done-right'));
  if (!paperlink) {
    console.log('No vscode-PDF-done-right target found. Targets:');
    for (const t of targets) {
      const ext = t.url?.match(/extensionId=([^&]*)/)?.[1] || 'n/a';
      console.log('  [' + t.type + '] ext=' + ext + ' → ' + (t.title || '').slice(0, 70));
    }
    return;
  }

  const wsUrl = paperlink.webSocketDebuggerUrl;
  console.log('Found vscode-PDF-done-right webview, probing inner iframe...\n');

  const expr = [
    '(function() {',
    '  var iframe = document.querySelector("iframe");',
    '  if (!iframe || !iframe.contentDocument) return JSON.stringify({error: "no iframe access"});',
    '  var doc = iframe.contentDocument;',
    '  var canvases = doc.querySelectorAll("canvas");',
    '  var textSpans = doc.querySelectorAll(".text-layer span");',
    '  return JSON.stringify({',
    '    canvasCount: canvases.length,',
    '    canvasDims: Array.from(canvases).slice(0,3).map(function(c) { return {w:c.width, h:c.height, cssW:c.style.width, cssH:c.style.height}; }),',
    '    textSpanCount: textSpans.length,',
    '    firstSpans: Array.from(textSpans).slice(0,8).map(function(s) { return {text: (s.textContent||"").slice(0,50), left: s.style.left, top: s.style.top, width: s.style.width, height: s.style.height, fontSize: s.style.fontSize}; }),',
    '    toolbar: (doc.querySelector("#page-info") || {}).textContent || "n/a",',
    '    zoom: (doc.querySelector("#zoom-level") || {}).textContent || "n/a",',
    '    bodyLength: (doc.body || {innerHTML:""}).innerHTML.length,',
    '  });',
    '})()',
  ].join('\n');

  const info = await cdpEval(wsUrl, expr);
  console.log('=== PDF Viewer State ===');
  console.log(JSON.stringify(info, null, 2));

  // Take a screenshot of the webview
  try {
    await cdpScreenshot(wsUrl, 'test/screenshots/webview-pdf.png');
    console.log('\nScreenshot saved: test/screenshots/webview-pdf.png');
  } catch (e: any) {
    console.log('Screenshot failed:', e.message);
  }
}

main().catch(e => console.error(e));
