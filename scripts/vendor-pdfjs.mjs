// Copy the installed, version-pinned pdf.js build into web/vendor/ so the static
// site needs no CDN or npm at runtime. Run after `npm update pdfjs-dist` (or
// when Dependabot opens a bump PR); CI then re-runs the parity test as the gate.
//
//   npm run vendor-pdfjs

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Use the LEGACY build: it self-polyfills recent APIs (e.g. Promise.withResolvers,
// which the modern build assumes natively → breaks Safari < 17.4) and targets a
// broader range of browsers. It's also the build the Node parity test imports,
// so browser and test stay consistent.
const SRC = join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build");
const DST = join(ROOT, "web", "vendor");
const version = JSON.parse(readFileSync(join(ROOT, "node_modules", "pdfjs-dist", "package.json"), "utf8")).version;

mkdirSync(DST, { recursive: true });
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  copyFileSync(join(SRC, f), join(DST, f));
  console.log(`vendored ${f}`);
}
console.log(`pdfjs-dist ${version} -> web/vendor/  (run \`npm run parity\` to verify)`);
