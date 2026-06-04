// Copy the installed, version-pinned pdf.js build into web/vendor/ so the static
// site needs no CDN or npm at runtime. Run after `npm update pdfjs-dist` (or
// when Dependabot opens a bump PR); CI then re-runs the parity test as the gate.
//
//   npm run vendor-pdfjs

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "node_modules", "pdfjs-dist", "build");
const DST = join(ROOT, "web", "vendor");
const version = JSON.parse(readFileSync(join(ROOT, "node_modules", "pdfjs-dist", "package.json"), "utf8")).version;

mkdirSync(DST, { recursive: true });
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  copyFileSync(join(SRC, f), join(DST, f));
  console.log(`vendored ${f}`);
}
console.log(`pdfjs-dist ${version} -> web/vendor/  (run \`npm run parity\` to verify)`);
