/**
 * Navigate to page 3, click the WMT highlight, verify popover lists the
 * markdown reference with the correct context line.
 */
import WebSocket from 'ws';
const PORT = 9333;

async function getTargets() { const r = await fetch(`http://localhost:${PORT}/json`); return await r.json() as any[]; }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function cdp(wsUrl: string, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', (d: any) => { const m = JSON.parse(d.toString()); if (m.id === 1) { clearTimeout(t); ws.close(); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } });
    ws.on('error', (e: any) => { clearTimeout(t); reject(e); });
  });
}

async function main() {
  const targets = await getTargets();
  const viewer = targets.filter(t => t.type === 'iframe').find(async f => {
    try {
      const r = await cdp(f.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: '(function(){var f=document.querySelector("iframe");return f&&f.contentDocument?f.contentDocument.title:"";})()',
        returnByValue: true,
      });
      return r.result.value === 'PaperLink PDF Viewer';
    } catch { return false; }
  });
  // Instead of async find, just iterate
  let vf = null;
  for (const f of targets.filter(t => t.type === 'iframe')) {
    try {
      const r = await cdp(f.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: '(function(){var f=document.querySelector("iframe");return f&&f.contentDocument?f.contentDocument.title:"";})()',
        returnByValue: true,
      });
      if (r.result.value === 'PaperLink PDF Viewer') { vf = f; break; }
    } catch {}
  }
  if (!vf) { console.error('no viewer'); process.exit(2); }

  // Scroll to page 3, click the first highlight on page 3, read popover
  const report = await cdp(vf.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `
      (async function(){
        var doc = document.querySelector("iframe").contentDocument;
        // First, list every highlight anchorKey and their pages
        var all = Array.from(doc.querySelectorAll(".annotation-highlight.referenced"));
        var groups = {};
        for (var el of all) {
          var k = el.dataset.anchorKey;
          var pageNum = el.closest(".page-wrapper")?.id.replace("page-","");
          groups[k] = groups[k] || { page: pageNum, rects: 0 };
          groups[k].rects++;
        }
        // Find the page-3 group that has the most rects (the WMT one)
        var wmt = null;
        for (var k in groups) {
          if (groups[k].page === "3" && (!wmt || groups[k].rects > groups[wmt].rects)) wmt = k;
        }
        if (!wmt) return JSON.stringify({groups, error: "no page-3 group"});

        // Hover one rect to verify coordinated hover
        var firstRect = doc.querySelector('.annotation-highlight.referenced[data-anchor-key="' + CSS.escape(wmt) + '"]');
        firstRect.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}));
        await new Promise(r => setTimeout(r, 100));
        var hoverActiveCount = doc.querySelectorAll('.annotation-highlight.referenced.hover-active').length;
        firstRect.dispatchEvent(new MouseEvent('mouseleave', {bubbles:true}));

        // Click to request popover
        firstRect.click();
        await new Promise(r => setTimeout(r, 600));
        var pop = doc.getElementById("ref-popover");
        var popItems = pop ? Array.from(pop.querySelectorAll(".ref-item")).map(r => ({
          context: (r.querySelector(".ref-context")||{}).textContent,
          path: (r.querySelector(".ref-path")||{}).textContent,
          loc: (r.querySelector(".ref-loc")||{}).textContent,
        })) : [];
        return JSON.stringify({
          groups,
          wmtGroupKey: wmt,
          wmtRectCount: groups[wmt].rects,
          hoverActiveCount: hoverActiveCount,
          popoverFound: !!pop,
          popoverHeader: pop ? (pop.querySelector(".ref-header")||{}).textContent : null,
          popoverItems: popItems,
        });
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(report.result.value);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
