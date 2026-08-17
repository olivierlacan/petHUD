// Browser pipeline: one PDF's bytes -> { sha, filename, reportDoc }. Mirrors the
// Ruby Importer's parse step. pdf.js does PDF decoding in its own worker, so
// this stays responsive without a custom Web Worker; parseReport is fast pure JS.
//
// Every failure raised here is an ImportError carrying the filename, the stage
// it failed in, and a cause the report's owner can act on — a batch import must
// never leave you knowing only that "a PDF" failed.

import { getDocument } from "./pdfjs.js";
import { extractLines } from "./extract.js";
import { parseReport } from "./parser.js";
import { looksLikeReport, reportWarnings } from "./diagnose.js";

export class ImportError extends Error {
  // code: stable machine tag; stage: where it broke; cause: the original error.
  constructor(code, message, { filename = null, stage = null, cause = null } = {}) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.filename = filename;
    this.stage = stage;
    this.cause = cause;
  }
}

export async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Validate the magic bytes before handing to pdf.js (matches the server guard).
export function looksLikePdf(arrayBuffer) {
  const head = new Uint8Array(arrayBuffer.slice(0, 5));
  return String.fromCharCode(...head) === "%PDF-";
}

// pdf.js throws named exception classes (PasswordException, InvalidPDFException,
// …). Translate them into a cause the owner of the PDF can act on, since
// "Invalid PDF structure." on its own tells them nothing about what to do.
export function classifyPdfError(err) {
  const name = err?.name || "";
  const msg = String(err?.message || err || "");
  if (name === "PasswordException" || /password/i.test(msg)) {
    return { code: "encrypted", message: "the PDF is password-protected — save an unlocked copy and import that" };
  }
  if (name === "InvalidPDFException" || /invalid pdf/i.test(msg)) {
    return { code: "corrupt", message: "the file isn't a readable PDF (truncated or corrupted download?)" };
  }
  if (name === "MissingPDFException" || name === "UnexpectedResponseException") {
    return { code: "unreadable", message: "the PDF could not be read back from disk" };
  }
  if (/worker/i.test(msg)) {
    return { code: "worker-failed", message: "the PDF reader failed to start (try reloading the page)" };
  }
  return { code: "pdf-read-failed", message: "the PDF reader failed: " + msg };
}

// Parse one PDF. Resolves to { sha, filename, reportDoc, warnings }; rejects
// with an ImportError naming this file.
export async function processPdf(arrayBuffer, filename) {
  const sha = await sha256Hex(arrayBuffer); // before pdf.js, which may detach the buffer
  const fail = (code, message, stage, cause) =>
    new ImportError(code, message, { filename, stage, cause });

  if (!looksLikePdf(arrayBuffer)) {
    throw fail("not-a-pdf", "the file doesn't start with a PDF header — it isn't a PDF", "read");
  }

  let lines;
  try {
    ({ lines } = await extractLines(new Uint8Array(arrayBuffer), getDocument));
  } catch (err) {
    const c = classifyPdfError(err);
    throw fail(c.code, c.message, "pdf", err);
  }

  if (!lines.length) {
    throw fail("no-text",
      "the PDF has no selectable text — it's probably a scan or photo of a report, which can't be parsed",
      "extract");
  }

  let reportDoc;
  try {
    reportDoc = parseReport(lines, { sourceFile: filename, fileSha256: sha });
  } catch (err) {
    throw fail("parse-failed", "the report layout could not be parsed: " + (err?.message || err), "parse", err);
  }

  if (!looksLikeReport(reportDoc)) {
    throw fail("not-a-report",
      "no IDEXX report header or result sections were found — this doesn't look like a VetConnect PLUS report",
      "parse");
  }

  // Thin but usable (e.g. no date, no values): import it and let the caller
  // surface the warning against this filename rather than dropping it silently.
  return { sha, filename, reportDoc, warnings: reportWarnings(reportDoc) };
}
