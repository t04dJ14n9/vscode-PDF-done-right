/**
 * Ad-hoc probe for the three fixes:
 *   1. highlight width is proportional to the selected char range (not full item)
 *   2. popover shows markdown context line (not the PDF snippet)
 *   3. only one Outline view is visible in the Explorer sidebar
 */
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

async function getTargets(): Promise<any[]> {
  const r = await fetch(BASE + '/json');
  return await r.json() as any[];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function findViewerFrame() {
  const targets = await getTargets();
  for (const f of targets.filter(t => t.type === 'iframe')) {
    try {
      const r = await cdp(f.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: '(function(){var f=document.querySelector("iframe");if(!f||!f.contentDocument)return "";return f.contentDocument.title;})()',
        returnByValue: true,
      });
      if (r.result.value === 'PDF Done Right Viewer') return f;
    } catch { /* ignore */ }
  }
  return null;
}

async function main() {
  const viewer = await findViewerFrame();
  if (!viewer) {
    console.error('No PDF Done Right viewer iframe found — is the PDF open?');
    process.exit(2);
  }

  // ── Fix 1: highlight slice width vs text item width ──
  const geom = await cdp(viewer.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `
      (function(){
        var doc = document.querySelector("iframe").contentDocument;
        var hls = Array.from(doc.querySelectorAll(".annotation-highlight.referenced"));
        var spans = Array.from(doc.querySelectorAll(".text-layer span"));
        function rect(el){var r=el.getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height};}
        // For each highlight, find the text span whose vertical center overlaps.
        function findNearestSpan(h){
          var hr = h.getBoundingClientRect();
          var cy = hr.top + hr.height/2;
          var best = null; var bestDy = 1e9;
          for (var s of spans){
            var sr = s.getBoundingClientRect();
            if (sr.top <= cy && sr.bottom >= cy) {
              // horizontal overlap required
              if (sr.right >= hr.left && sr.left <= hr.right) {
                var dy = Math.abs((sr.top+sr.bottom)/2 - cy);
                if (dy < bestDy) { bestDy = dy; best = s; }
              }
            }
          }
          return best;
        }
        return JSON.stringify(hls.map(function(h){
          var s = findNearestSpan(h);
          return { hl: rect(h), span: s ? rect(s) : null, spanText: s ? s.textContent : null };
        }));
      })()
    `,
    returnByValue: true,
  });
  const pairs = JSON.parse(geom.result.value);
  console.log('── Fix 1: highlight slice widths vs text span widths ──');
  let fix1ok = true;
  for (const p of pairs) {
    if (!p.span) continue;
    const ratio = p.hl.w / p.span.w;
    const text = (p.spanText || '').slice(0, 40);
    console.log(`  hl.w=${p.hl.w.toFixed(1)}  span.w=${p.span.w.toFixed(1)}  ratio=${ratio.toFixed(2)}  text="${text}"`);
    // Expect each ref in notes.md is a partial highlight (len < text.length)
    if (p.spanText && p.hl.w >= p.span.w - 1) {
      console.log('    ⚠️  highlight spans the entire text item — partial-line fix not applied');
      fix1ok = false;
    }
  }
  console.log(fix1ok ? 'FIX 1 OK\n' : 'FIX 1 FAILED\n');

  // ── Fix 2: click a referenced highlight, then inspect popover ──
  console.log('── Fix 2: popover shows markdown context line ──');
  const clickRes = await cdp(viewer.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `
      (function(){
        var doc = document.querySelector("iframe").contentDocument;
        var h = doc.querySelector(".annotation-highlight.referenced");
        if (!h) return "NO_HIGHLIGHT";
        h.click();
        return "CLICKED";
      })()
    `,
    returnByValue: true,
  });
  console.log('  click:', clickRes.result.value);
  await sleep(700);

  const pop = await cdp(viewer.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `
      (function(){
        var doc = document.querySelector("iframe").contentDocument;
        var p = doc.getElementById("ref-popover");
        if (!p) return JSON.stringify({found:false});
        var items = Array.from(p.querySelectorAll(".ref-item")).map(function(r){
          return {
            context: (r.querySelector(".ref-context")||{}).textContent || null,
            path: (r.querySelector(".ref-path")||{}).textContent || null,
            loc: (r.querySelector(".ref-loc")||{}).textContent || null,
            tooltip: r.title || null,
          };
        });
        return JSON.stringify({found:true, header:(p.querySelector(".ref-header")||{}).textContent || "", items: items});
      })()
    `,
    returnByValue: true,
  });
  const popInfo = JSON.parse(pop.result.value);
  console.log('  popover:', JSON.stringify(popInfo, null, 2));
  let fix2ok = popInfo.found && popInfo.items.length > 0 &&
    popInfo.items.every((it: any) => it.context && !/^".*"$/.test(it.context || ''));
  console.log(fix2ok ? 'FIX 2 OK\n' : 'FIX 2 FAILED\n');

  // ── Fix 3: only one "Outline" view in the window ──
  const targets = await getTargets();
  const mainPage = targets.find(t => t.type === 'page');
  const outlineCount = await cdp(mainPage!.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `
      (function(){
        // Collect all text nodes inside VS Code's sidebar title areas.
        var headers = Array.from(document.querySelectorAll(".pane-header .title, .pane-header h3.title"));
        var titles = headers.map(function(h){return (h.textContent||"").trim().toUpperCase();});
        var outlineMatches = titles.filter(function(t){return t==="OUTLINE";});
        var pdfOutlineMatches = titles.filter(function(t){return t==="PDF OUTLINE";});
        return JSON.stringify({
          allTitles: titles,
          outlineCount: outlineMatches.length,
          pdfOutlineCount: pdfOutlineMatches.length,
        });
      })()
    `,
    returnByValue: true,
  });
  const oi = JSON.parse(outlineCount.result.value);
  console.log('── Fix 3: one outline panel ──');
  console.log('  all sidebar section titles:', oi.allTitles);
  console.log(`  "OUTLINE" appears ${oi.outlineCount} time(s); "PDF OUTLINE" ${oi.pdfOutlineCount} time(s)`);
  const fix3ok = oi.outlineCount <= 1;
  console.log(fix3ok ? 'FIX 3 OK\n' : 'FIX 3 FAILED (duplicate Outline headers)\n');

  if (!fix1ok || !fix2ok || !fix3ok) process.exit(1);
  console.log('All three fixes verified.');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
