// Smoke-test the web/ deploy artifact as GitHub *project* Pages would serve it:
// at a subpath (/pethud/). Confirms relative asset/config/worker paths resolve,
// the three config JSONs load, the module boots, and there are no console errors.
// Run on Node >=22:  node test/smoke-pages.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const WEB = path.resolve("web");
const PREFIX = "/pethud"; // simulate project-pages subpath
const PORT = 8791;
const types = { ".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".wasm":"application/wasm" };
const requested = new Set();
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.startsWith(PREFIX)) p = p.slice(PREFIX.length);
  if (p === "/" || p === "") p = "/index.html";
  requested.add(p);
  const fp = path.join(WEB, p);
  if (!fp.startsWith(WEB) || !fs.existsSync(fp)) { res.writeHead(404); res.end("404"); return; }
  res.writeHead(200, { "content-type": types[path.extname(fp)] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

// Override with CHROME=/path/to/chrome on non-macOS.
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9455", "--no-first-run", "--no-default-browser-check", "--user-data-dir=/tmp/cdp-smoke", "about:blank"]);
async function cdp() { for (let i = 0; i < 50; i++) { try { const l = await fetch("http://localhost:9455/json/list").then((r) => r.json()); const pg = l.find((t) => t.type === "page"); if (pg) return pg.webSocketDebuggerUrl; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("no chrome"); }
const ws = new WebSocket(await cdp()); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push("EXCEPTION: " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console.error: " + m.params.args.map((a) => a.value || a.description).join(" "));
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push("log: " + m.params.entry.text + " " + (m.params.entry.url || ""));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
await send("Page.navigate", { url: `http://localhost:${PORT}${PREFIX}/` });
await new Promise((r) => setTimeout(r, 2500));

const emptyState = await evalJs(`(document.getElementById("trends")||{}).textContent || ""`);
const themeWorks = await evalJs(`!!document.getElementById("theme-toggle")`);
const booted = /No reports yet/i.test(emptyState);
const gotConfigs = ["/knowledge.json", "/patients.json", "/analyte_aliases.json", "/app.js", "/style.css", "/lib/pdfjs.js"].filter((f) => requested.has(f));

console.log("requested config/asset paths:", gotConfigs.join(", "));
console.log("app booted (empty state rendered):", booted);
console.log("theme toggle present:", themeWorks);
console.log("console errors:", errors.length ? "\n  - " + errors.join("\n  - ") : "none");
const ok = booted && themeWorks && errors.length === 0 && gotConfigs.length >= 5;
console.log(ok ? "\nSMOKE OK ✓" : "\nSMOKE FAILED ✗");
ws.close(); chrome.kill(); server.close();
process.exit(ok ? 0 : 1);
