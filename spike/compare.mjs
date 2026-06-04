// Throwaway spike: does pdf.js getTextContent() reproduce the per-word
// coordinates that report_parser.rb's column logic depends on?
//
// For each sample PDF, we extract words two ways — pdf.js and `pdftotext -tsv`
// — group both into lines, find the "TEST / RESULT / REFERENCE VALUE" header to
// get column anchors, and check whether DATA ROWS keep the name / result /
// reference / flag in separate tokens at the expected x bands. We also report
// coordinate drift and where pdf.js emits multi-word "runs".
//
// Run: ~/.nvm/versions/node/v22.21.1/bin/node compare.mjs

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dir, "..", "samples");
const STD_FONTS = join(__dir, "node_modules", "pdfjs-dist", "standard_fonts/");
const LINE_TOL = 3.0; // matches pdf_extractor.rb LINE_TOLERANCE

// ---- pdf.js extraction → words {page, x, yTop, w, text} -------------------
async function pdfjsWords(path) {
  const data = new Uint8Array(readFileSync(path));
  const doc = await getDocument({ data, standardFontDataUrl: STD_FONTS, verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const h = page.getViewport({ scale: 1 }).height;
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const s = it.str;
      if (!s || !s.trim()) continue;
      const t = it.transform; // [a,b,c,d,e,f]; e=x, f=baseline-y (bottom-left origin)
      out.push({ page: p, x: t[4], yTop: h - t[5], w: it.width, text: s });
    }
  }
  return out;
}

// ---- pdftotext -tsv → words {page, x, y, w, text} -------------------------
function tsvWords(path) {
  const tsv = execFileSync("pdftotext", ["-tsv", "-nopgbrk", path, "-"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const out = [];
  for (const row of tsv.split("\n")) {
    const c = row.split("\t");
    if (c[0] !== "5") continue;
    const text = (c[11] || "").trim();
    if (!text) continue;
    out.push({ page: +c[1], x: +c[6], y: +c[7], w: +c[8], text });
  }
  return out;
}

// ---- group words into visual lines (port of group_lines) ------------------
function groupLines(words) {
  const byPage = {};
  for (const w of words) (byPage[w.page] ||= []).push(w);
  const lines = [];
  for (const page of Object.keys(byPage).sort((a, b) => a - b)) {
    const ws = byPage[page].slice().sort((a, b) => (a.yTop ?? a.y) - (b.yTop ?? b.y) || a.x - b.x);
    let cur = [], cy = null;
    for (const w of ws) {
      const y = w.yTop ?? w.y;
      if (cy === null || Math.abs(y - cy) <= LINE_TOL) { cur.push(w); cy ??= y; }
      else { lines.push(cur.sort((a, b) => a.x - b.x)); cur = [w]; cy = y; }
    }
    if (cur.length) lines.push(cur.sort((a, b) => a.x - b.x));
  }
  return lines;
}

const lineText = (l) => l.map((w) => w.text).join(" ");

// ---- analysis -------------------------------------------------------------
function analyze(name, pjs, tsv) {
  const pjsLines = groupLines(pjs);
  const tsvLines = groupLines(tsv);

  // multi-word runs in pdf.js (items containing internal spaces)
  const runs = pjs.filter((w) => /\S\s+\S/.test(w.text));

  // coordinate drift: match each tsv word to the nearest pdf.js item that STARTS
  // it (same leading token, x within 4pt) and record |dx|
  const drift = [];
  for (const tw of tsv) {
    const cand = pjs.find((pw) => Math.abs(pw.x - tw.x) < 4 && (pw.text === tw.text || pw.text.startsWith(tw.text + " ") || pw.text.startsWith(tw.text)));
    if (cand) drift.push(Math.abs(cand.x - tw.x));
  }
  const maxDrift = drift.length ? Math.max(...drift) : null;
  const meanDrift = drift.length ? drift.reduce((a, b) => a + b, 0) / drift.length : null;

  // find every "RESULT" column header and verify the data rows under it keep
  // the result value as a token separate from the name token.
  let headerCount = 0, rowsChecked = 0, rowsWithSeparateResult = 0;
  let refMergedOk = 0; // reference cell present as run/token at ref-x
  const samples = [];
  for (let i = 0; i < pjsLines.length; i++) {
    const L = pjsLines[i];
    const result = L.find((w) => w.text === "RESULT");
    if (!result) continue;
    headerCount++;
    const test = L.find((w) => w.text === "TEST");
    const reference = L.find((w) => /^REFERENCE/.test(w.text)); // may be "REFERENCE VALUE" run
    const nameX = test ? test.x : 27.0;
    const resultX = result.x;
    const refX = reference ? reference.x : null;
    // scan following lines as data rows until the next header/blank-ish
    for (let j = i + 1; j < pjsLines.length && j < i + 40; j++) {
      const R = pjsLines[j];
      if (R.find((w) => w.text === "RESULT")) break; // next table
      const lead = R[0];
      if (!lead || lead.x > nameX + 48) continue; // not a measurement row (NAME_ANCHOR_SLACK)
      // does this row have a token in the RESULT band?
      const resTok = R.find((w) => w.x >= resultX - 8 && w.x < (refX ? refX - 8 : resultX + 60));
      const nameTok = R.find((w) => w.x < resultX - 8);
      if (nameTok && resTok && resTok !== nameTok) {
        rowsChecked++; rowsWithSeparateResult++;
        if (refX) { const r = R.find((w) => w.x >= refX - 8); if (r) refMergedOk++; }
        if (samples.length < 3) samples.push(R.map((w) => `${w.text}@${w.x.toFixed(0)}`).join("  "));
      } else if (nameTok) {
        rowsChecked++;
      }
    }
  }

  return { name, pjsCount: pjs.length, tsvCount: tsv.length, runs: runs.length,
    maxDrift, meanDrift, headerCount, rowsChecked, rowsWithSeparateResult, refMergedOk, samples };
}

// ---- main -----------------------------------------------------------------
const files = readdirSync(SAMPLES).filter((f) => f.endsWith(".pdf")).sort();
console.log(`Comparing pdf.js vs pdftotext on ${files.length} samples\n`);
let totalRows = 0, totalSep = 0;
for (const f of files) {
  const path = join(SAMPLES, f);
  const [pjs, tsv] = [await pdfjsWords(path), tsvWords(path)];
  const a = analyze(f, pjs, tsv);
  totalRows += a.rowsChecked; totalSep += a.rowsWithSeparateResult;
  console.log(`### ${a.name}`);
  console.log(`  words: pdfjs=${a.pjsCount} tsv=${a.tsvCount}  runs(pdfjs multi-word)=${a.runs}`);
  console.log(`  x-drift vs tsv: mean=${a.meanDrift?.toFixed(2)} max=${a.maxDrift?.toFixed(2)} pts`);
  console.log(`  result-column headers found: ${a.headerCount}`);
  console.log(`  data rows: ${a.rowsChecked}, with separate result token: ${a.rowsWithSeparateResult}, ref-cell present: ${a.refMergedOk}`);
  if (a.samples[0]) console.log(`  sample row: ${a.samples[0]}`);
  console.log();
}
console.log(`TOTAL data rows checked: ${totalRows}, with separate result token: ${totalSep} (${(100 * totalSep / totalRows).toFixed(1)}%)`);
