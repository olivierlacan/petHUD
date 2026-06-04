// Browser pipeline: one PDF's bytes -> { sha, filename, reportDoc }. Mirrors the
// Ruby Importer's parse step. pdf.js does PDF decoding in its own worker, so
// this stays responsive without a custom Web Worker; parseReport is fast pure JS.

import { getDocument } from "./pdfjs.js";
import { extractLines } from "./extract.js";
import { parseReport } from "./parser.js";

export async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Validate the magic bytes before handing to pdf.js (matches the server guard).
export function looksLikePdf(arrayBuffer) {
  const head = new Uint8Array(arrayBuffer.slice(0, 5));
  return String.fromCharCode(...head) === "%PDF-";
}

export async function processPdf(arrayBuffer, filename) {
  const sha = await sha256Hex(arrayBuffer); // before pdf.js, which may detach the buffer
  const { lines } = await extractLines(new Uint8Array(arrayBuffer), getDocument);
  const reportDoc = parseReport(lines, { sourceFile: filename, fileSha256: sha });
  return { sha, filename, reportDoc };
}
