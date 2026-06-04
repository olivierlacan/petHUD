// Browser pdf.js entry point. Imports the vendored, version-pinned build and
// points it at its own (also vendored) worker for off-main-thread decoding.
// extract.js is dependency-injected with this getDocument; the Node parity test
// injects pdfjs-dist instead, so the parsing code stays environment-agnostic.

import * as pdfjsLib from "../vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;

export const getDocument = pdfjsLib.getDocument;
