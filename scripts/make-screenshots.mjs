// Generate the About-page feature screenshots from the committed demo data, so
// the showcase stays in sync with the app. Seeds the browser build with the
// Willow (CKD) demo reports + an owner journal, drives each view in headless
// Chrome, and writes web/about/img/*.png.
//
//   node scripts/make-screenshots.mjs        (needs Node >=22 + Chrome)
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractLines } from "../web/lib/extract.js";
import { parseReport } from "../web/lib/parser.js";

const ROOT = path.resolve(".");
const WEB = path.join(ROOT, "web");
const OUT = path.join(WEB, "about", "img");
const FONTS = path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts/");
const PORT = 8797;
fs.mkdirSync(OUT, { recursive: true });

// --- parse the committed Willow demo PDFs into report docs ---
const willow = fs.readdirSync(path.join(ROOT, "samples")).filter((f) => /^demo-willow-.*\.pdf$/.test(f)).sort();
const records = [];
for (const f of willow) {
  const { lines } = await extractLines(new Uint8Array(fs.readFileSync(path.join(ROOT, "samples", f))), getDocument, { standardFontDataUrl: FONTS });
  const doc = parseReport(lines, { sourceFile: f, fileSha256: f });
  records.push({ sha256: f, reportDoc: doc, patientSlug: null });
}
// owner journal: declining weight + a diet-change event (slug "willow")
const journal = { willow: {
  weights: [["2024-02-14", 4.8], ["2024-08-20", 4.5], ["2025-02-26", 4.1], ["2025-09-03", 3.7]].map(([date, kg]) => ({ date, kg })),
  events: [{ date: "2025-02-26", kind: "diet", label: "started renal diet" }],
} };

const types = { ".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".png":"image/png" };
const server = http.createServer((q, s) => { let p = decodeURIComponent(q.url.split("?")[0]); if (p === "/") p = "/index.html"; const fp = path.join(WEB, p); if (!fp.startsWith(WEB) || !fs.existsSync(fp)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { "content-type": types[path.extname(fp)] || "application/octet-stream" }); fs.createReadStream(fp).pipe(s); });
await new Promise((r) => server.listen(PORT, r));

const chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9460", "--no-first-run", "--no-default-browser-check", "--user-data-dir=/tmp/cdp-shots-" + Date.now(), "--force-color-profile=srgb", "about:blank"]);
async function cdp() { for (let i = 0; i < 60; i++) { try { const l = await fetch("http://localhost:9460/json/list").then((r) => r.json()); const pg = l.find((t) => t.type === "page"); if (pg) return pg.webSocketDebuggerUrl; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("no chrome"); }
const ws = new WebSocket(await cdp()); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (mtd, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mtd, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) console.error("ERR", JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result?.result?.value; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (x, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(x)) return true; await wait(100); } return false; };
await send("Page.enable"); await send("Runtime.enable");
// Two viewport widths: wide for context views, narrow so text-dense cards reflow
// taller (legible thumbnails, roughly square rather than wide thin strips).
const VW_WIDE = 1000, VW_MID = 780, VW_NARROW = 600, VH = 1180;
const setW = (w) => send("Emulation.setDeviceMetricsOverride", { width: w, height: VH, deviceScaleFactor: 2, mobile: false });
await setW(VW_WIDE);

await send("Page.navigate", { url: `http://localhost:${PORT}/` });
await wait(1200);
await ev(`new Promise((res,rej)=>{const o=indexedDB.open("pethud",2);o.onupgradeneeded=()=>{const db=o.result;["pdfs","reports","settings"].forEach(s=>{if(!db.objectStoreNames.contains(s))db.createObjectStore(s,{keyPath:s==="settings"?"key":"sha256"});});};o.onsuccess=()=>{const db=o.result;const tx=db.transaction(["reports","settings"],"readwrite");${JSON.stringify(records)}.forEach(r=>tx.objectStore("reports").put(r));tx.objectStore("settings").put({key:"journal",value:${JSON.stringify(journal)}});tx.oncomplete=()=>res(1);tx.onerror=()=>rej(tx.error);};o.onerror=()=>rej(o.error);})`);
await send("Page.reload");
await waitFor(`document.querySelectorAll('.card[data-analyte]').length > 0`);
await ev(`document.querySelector('[data-theme-set="dark"]').click()`); // signature dark look
await wait(300);
// Neutralise the sticky top bar (and raise overlays above it) for the duration
// of screenshotting, so scrolling an element to the top never leaves the nav
// floating over the captured region. Layout is otherwise unchanged.
await ev(`(function(){var s=document.createElement('style');s.id='shot-style';s.textContent='.topbar{position:static!important}.overlay{z-index:300!important}';document.head.appendChild(s);})()`);

// Capture a single element by its absolute page position (scroll reset to 0 so
// page coords are exact). captureBeyondViewport renders the whole page, and the
// nav is non-sticky (above), so the clip is exactly the element — no overlap,
// no empty band, wherever the element sits.
async function shot(name, selector, maxH = 99999, pad = 0) {
  await ev(`window.scrollTo(0, 0)`);
  await wait(140);
  const raw = await ev(`(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return "null";var r=el.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height});})()`);
  if (raw === "null") { console.log("MISSING", name, selector); return; }
  const r = JSON.parse(raw);
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: Math.min(r.h + pad * 2, maxH), scale: 2 };
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(s.result.data, "base64"));
  console.log("wrote about/img/" + name + ".png  " + Math.round(clip.width) + "x" + Math.round(clip.height));
}

// Establishing shot: the whole app top (toolbar + sidebar + content) from y=0.
async function shotApp(name, width, height) {
  await ev(`window.scrollTo(0, 0)`);
  await wait(160);
  const s = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 2 } });
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(s.result.data, "base64"));
  console.log("wrote about/img/" + name + ".png  " + width + "x" + height + " (full app)");
}

// ----- WIDE views: toolbar / sidebar context reads well wide -----
// 1. establishing shot: whole app — toolbar, sidebar, your-log weight card, cards
await shotApp("trends", VW_WIDE, 740);

// 2. analyte detail — cited context + chart with the diet-change marker
await ev(`(function(){var c=[...document.querySelectorAll('.card[data-analyte]')].find(x=>/^Creatinine/.test(x.querySelector('.card-name').textContent));c&&c.click();})()`);
await waitFor(`document.querySelector('#detail svg.bigchart') !== null`);
await wait(250);
await shot("detail", "#detail .overlay-card", 660, 0);
await ev(`document.getElementById("detail-close").click()`); await wait(150);

// 3. conditions — CKD panel + IRIS staging
await ev(`document.querySelector('#view-toggle [data-view="conditions"]').click()`);
await wait(200);
await ev(`(function(){var t=[...document.querySelectorAll('.cond-tab')].find(x=>/Kidney/.test(x.textContent));t&&t.click();})()`);
await wait(250);
await shot("conditions", "#conditions", 680, 6);

// ----- MID width: the life-stage banner (wide chip rows) -----
await setW(VW_MID); await wait(450);
await ev(`document.querySelector('#view-toggle [data-view="trends"]').click()`); await wait(200);
await ev(`(function(){var b=document.querySelector(".lifestage.collapsed .ls-head");if(b)b.click();})()`);
await wait(220);
await shot("lifestage", ".lifestage", 9999, 4);
await ev(`(function(){var b=document.querySelector(".lifestage:not(.collapsed) .ls-head");if(b)b.click();})()`); await wait(120);

// ----- NARROW: text-dense cards/forms reflow taller (legible, ~square) -----
await setW(VW_NARROW); await wait(450);

// 5 & 6. reports — vet-visit + per-report summary
await ev(`document.querySelector('#view-toggle [data-view="reports"]').click()`);
await waitFor(`document.querySelector('.report-card .report-summary') !== null`);
await wait(200);
await shot("vetvisit", ".vet-visit", 9999, 0);
await shot("summary", ".report-card", 620, 0);

// 7. owner journal manager (grid collapses to one column at this width)
await ev(`document.getElementById("open-journal").click()`);
await waitFor(`document.getElementById("jr-weight-form") !== null`);
await wait(250);
await shot("journal", "#journal .overlay-card", 9999, 0);

ws.close(); chrome.kill(); server.close();
console.log("\nScreenshots written to web/about/img/");
