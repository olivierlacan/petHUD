// PDF text extraction — the browser replacement for poppler `pdftotext -tsv`.
//
// pdf.js getTextContent() yields text items with a transform matrix and width.
// The Phase-0 spike confirmed these reproduce pdftotext's per-word coordinates
// to sub-pixel accuracy, and that items are cell-aligned (a reference range like
// "7.12 - 11.46 M/µL" comes as one item at the reference x, the H/L flag as its
// own item), so we feed items straight in as Words — no splitting needed.
//
// pdf.js is dependency-injected (`getDocument`) so the same code runs in the
// browser (vendored pdf.js), in a Web Worker, and in Node (parity test).

export const LINE_TOLERANCE = 3.0; // matches pdf_extractor.rb

// A Word: { page, x, y, w, h, text }. y is top-down (origin top-left) to match
// the Ruby/pdftotext pipeline; pdf.js gives a bottom-left baseline, so we flip:
// y = pageHeight - baselineY. The offset vs pdftotext's glyph-top is constant,
// which is fine — all downstream logic is relative (tolerance grouping, gaps).
export function itemsToWords(textContent, pageHeight, page) {
  const out = [];
  for (const it of textContent.items) {
    const s = it.str;
    if (!s || !s.trim()) continue;
    const t = it.transform; // [a, b, c, d, e, f]
    out.push({ page, x: t[4], y: pageHeight - t[5], w: it.width || 0, h: it.height || 0, text: normalizeText(s) });
  }
  return out;
}

// pdf.js emits some glyphs with different codepoints than poppler's pdftotext.
// Normalize the ones that appear in IDEXX reports so output matches the Ruby
// pipeline byte-for-byte (the parity oracle). Most important: the micro sign in
// units (µL, µg/dL) comes out as Greek mu (U+03BC) from pdf.js.
function normalizeText(s) {
  return s.replace(/μ/g, "µ"); // Greek small letter mu -> micro sign
}

// A Line: { page, y, words[] }. Group words sharing a baseline (within
// LINE_TOLERANCE), sorted top-to-bottom then left-to-right. Port of group_lines.
export function groupLines(words) {
  const byPage = new Map();
  for (const w of words) {
    if (!byPage.has(w.page)) byPage.set(w.page, []);
    byPage.get(w.page).push(w);
  }
  const lines = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const pageWords = byPage.get(page).slice().sort((a, b) => a.y - b.y || a.x - b.x);
    let current = [], currentY = null;
    for (const w of pageWords) {
      if (currentY === null || Math.abs(w.y - currentY) <= LINE_TOLERANCE) {
        current.push(w);
        if (currentY === null) currentY = w.y;
      } else {
        lines.push(buildLine(page, current));
        current = [w];
        currentY = w.y;
      }
    }
    if (current.length) lines.push(buildLine(page, current));
  }
  return lines;
}

function buildLine(page, words) {
  const sorted = words.slice().sort((a, b) => a.x - b.x);
  return { page, y: Math.min(...words.map((w) => w.y)), words: sorted };
}

export function lineText(line) {
  return line.words.map((w) => w.text).join(" ");
}

// Extract all pages of a PDF (ArrayBuffer/Uint8Array) into { lines, words }.
// `getDocument` is pdf.js's getDocument (injected). `docOptions` lets callers
// pass standardFontDataUrl etc.
export async function extractLines(data, getDocument, docOptions = {}) {
  const doc = await getDocument({ data, verbosity: 0, ...docOptions }).promise;
  let words = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const pageHeight = page.getViewport({ scale: 1 }).height;
    const tc = await page.getTextContent();
    words = words.concat(itemsToWords(tc, pageHeight, p));
  }
  return { lines: groupLines(words), words, numPages: doc.numPages };
}
