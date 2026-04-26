/**
 * E2E test for PDF Done Right: connects to VS Code via CDP, opens sample.pdf,
 * then inspects the webview to verify rendering.
 */

import { chromium } from 'playwright';
import WebSocket from 'ws';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Send a CDP command over raw WebSocket and get the response */
function cdpEval(wsUrl: string, expression: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }));
    });

    ws.on('message', (data: any) => {
      try {
        const resp = JSON.parse(data.toString());
        if (resp.id === 1) {
          clearTimeout(timeout);
          ws.close();
          if (resp.result?.result?.value) {
            try { resolve(JSON.parse(resp.result.result.value)); }
            catch { resolve(resp.result.result.value); }
          } else if (resp.result?.exceptionDetails) {
            reject(new Error(resp.result.exceptionDetails.text));
          } else {
            resolve(resp.result?.result);
          }
        }
      } catch {}
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Take a screenshot via CDP */
function cdpScreenshot(wsUrl: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
    const fs = require('fs');

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Page.captureScreenshot',
        params: { format: 'png' },
      }));
    });

    ws.on('message', (data: any) => {
      try {
        const resp = JSON.parse(data.toString());
        if (resp.id === 1 && resp.result?.data) {
          clearTimeout(timeout);
          fs.writeFileSync(path, Buffer.from(resp.result.data, 'base64'));
          ws.close();
          resolve();
        }
      } catch {}
    });

    ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
  });
}

async function main() {
  console.log('Connecting to VS Code via CDP on localhost:9222...\n');

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const vscodePage = browser.contexts()[0].pages()[0];
  console.log(`Main window: "${await vscodePage.title()}"\n`);

  // Step 1: Dismiss any overlays
  console.log('--- Step 1: Dismiss overlays ---');
  await vscodePage.keyboard.press('Escape');
  await sleep(300);
  await vscodePage.keyboard.press('Escape');
  await sleep(500);

  // Step 2: Open sample.pdf via Quick Open
  console.log('--- Step 2: Open sample.pdf ---');
  await vscodePage.keyboard.press('Meta+p');
  await sleep(800);
  await vscodePage.keyboard.type('sample.pdf', { delay: 30 });
  await sleep(500);
  await vscodePage.keyboard.press('Enter');
  console.log('Waiting for PDF to load...');
  await sleep(6000);

  await vscodePage.screenshot({ path: 'test/screenshots/01-pdf-opened.png' });
  console.log('Screenshot: 01-pdf-opened.png');

  // Step 3: Get CDP targets and find our webview
  console.log('\n--- Step 3: Find PDF Done Right webview ---');
  const resp = await fetch('http://localhost:9222/json');
  const targets: any[] = await resp.json();

  console.log('Targets:');
  for (const t of targets) {
    const ext = t.url?.match(/extensionId=([^&]*)/)?.[1] || 'n/a';
    console.log(`  [${t.type}] ext="${ext}" → ${t.title?.slice(0, 70)}`);
  }

  // Find webview targets that aren't CodeBuddy or Tencent
  const candidateTargets = targets.filter(t =>
    t.type === 'iframe' &&
    !t.url?.includes('CodeBuddy') &&
    !t.url?.includes('Tencent-Cloud') &&
    !t.url?.includes('coding-copilot')
  );

  console.log(`\nCandidate webview targets: ${candidateTargets.length}`);

  for (const target of candidateTargets) {
    const wsUrl = target.webSocketDebuggerUrl;
    if (!wsUrl) continue;

    console.log(`\nProbing: "${target.title?.slice(0, 60)}"`);

    try {
      const info = await cdpEval(wsUrl, `JSON.stringify({
        url: window.location.href.slice(0, 100),
        hasCanvas: !!document.querySelector('canvas'),
        hasPdfContainer: !!document.querySelector('.pdf-container'),
        hasPageContainer: !!document.querySelector('.page-container'),
        hasTextLayer: !!document.querySelector('.text-layer'),
        textSpanCount: document.querySelectorAll('.text-layer span').length,
        canvasCount: document.querySelectorAll('canvas').length,
        bodyLength: document.body?.innerHTML?.length || 0,
        iframeCount: document.querySelectorAll('iframe').length,
        iframeSrcs: Array.from(document.querySelectorAll('iframe')).map(f => f.src?.slice(0, 120)),
      })`);

      console.log('  Info:', JSON.stringify(info, null, 2));

      // VS Code webviews have a nested iframe — the actual content is inside
      if (info.iframeCount > 0) {
        console.log('  → Has nested iframe(s), checking inner content...');

        // Get the inner iframe's URL — we need to find its CDP target
        for (const src of info.iframeSrcs) {
          // Find the CDP target for this inner iframe
          const innerTarget = targets.find((t: any) =>
            t.url?.includes(src?.split('?')[0]) && t.id !== target.id
          );
          if (innerTarget?.webSocketDebuggerUrl) {
            console.log(`  → Found inner target: ${innerTarget.title?.slice(0, 60)}`);
            const innerInfo = await cdpEval(innerTarget.webSocketDebuggerUrl, `JSON.stringify({
              hasCanvas: !!document.querySelector('canvas'),
              hasPdfContainer: !!document.querySelector('.pdf-container'),
              bodyLength: document.body?.innerHTML?.length || 0,
            })`);
            console.log('  Inner info:', JSON.stringify(innerInfo));
          }
        }

        // The inner iframe might not be in the targets list.
        // Let's check if we can eval inside it via the outer frame.
        try {
          const innerCheck = await cdpEval(wsUrl, `
            (function() {
              const iframe = document.querySelector('iframe');
              if (!iframe || !iframe.contentDocument) return JSON.stringify({error: 'no access to inner iframe'});
              const doc = iframe.contentDocument;
              return JSON.stringify({
                innerUrl: iframe.src?.slice(0, 100),
                hasCanvas: !!doc.querySelector('canvas'),
                hasPdfContainer: !!doc.querySelector('.pdf-container'),
                hasPageContainer: !!doc.querySelector('.page-container'),
                hasTextLayer: !!doc.querySelector('.text-layer'),
                textSpanCount: doc.querySelectorAll('.text-layer span').length,
                canvasCount: doc.querySelectorAll('canvas').length,
                bodyLength: doc.body?.innerHTML?.length || 0,
                bodyPreview: doc.body?.innerHTML?.slice(0, 300) || '',
              });
            })()
          `);
          console.log('\n  Inner iframe content:', JSON.stringify(innerCheck, null, 2));

          if (innerCheck.hasPdfContainer || innerCheck.hasCanvas) {
            console.log('\n  🎉 FOUND PDF Done Right PDF viewer inside inner iframe!');

            // Get detailed rendering info
            const detail = await cdpEval(wsUrl, `
              (function() {
                const doc = document.querySelector('iframe').contentDocument;
                const canvases = doc.querySelectorAll('canvas');
                const textSpans = doc.querySelectorAll('.text-layer span');
                const pages = doc.querySelectorAll('.page-container');

                return JSON.stringify({
                  pageCount: pages.length,
                  canvasCount: canvases.length,
                  canvasDims: Array.from(canvases).slice(0, 3).map(c => ({
                    w: c.width, h: c.height,
                    cssW: c.style.width, cssH: c.style.height,
                  })),
                  textSpanCount: textSpans.length,
                  firstSpans: Array.from(textSpans).slice(0, 8).map(s => ({
                    text: s.textContent?.slice(0, 60),
                    left: s.style.left,
                    top: s.style.top,
                    width: s.style.width,
                    height: s.style.height,
                    fontSize: s.style.fontSize,
                  })),
                });
              })()
            `);

            console.log('\n  === PDF Viewer State ===');
            console.log(JSON.stringify(detail, null, 2));

            // Screenshot the webview
            await cdpScreenshot(wsUrl, 'test/screenshots/02-webview.png');
            console.log('\n  Screenshot: 02-webview.png');
          }

        } catch (e: any) {
          console.log(`  Inner iframe eval failed: ${e.message?.slice(0, 80)}`);
        }
      }

      if (info.hasPdfContainer || info.hasCanvas) {
        console.log('\n  🎉 FOUND PDF Done Right PDF viewer (direct, no nesting)!');
        await cdpScreenshot(wsUrl, 'test/screenshots/02-webview-direct.png');
      }

    } catch (e: any) {
      console.log(`  Probe failed: ${e.message?.slice(0, 80)}`);
    }
  }

  // Final main window screenshot
  await vscodePage.screenshot({ path: 'test/screenshots/03-final.png' });
  console.log('\nScreenshot: 03-final.png');

  await browser.close();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
