// Parity test: the JS browser parser must reproduce the canonical Ruby output.
//
// For each samples/*.pdf, extract with pdf.js + web/lib/extract.js, parse with
// web/lib/parser.js, and deep-compare the per-report document against the
// committed exports/reports/<name>.json (the Ruby pipeline's output). The Ruby
// parser stays canonical; this pins the JS port to it without Ruby in CI.
//
// Run with Node >= 22.13:  node test/parity.mjs

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { extractLines } from "../web/lib/extract.js";
import { parseReport } from "../web/lib/parser.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = join(ROOT, "samples");
// Frozen snapshots of the canonical Ruby per-report output. Regenerate with
// `bin/pethud export` then copy exports/reports/<sample>.json here when the
// Ruby parser intentionally changes.
const EXPORTS = join(ROOT, "test", "fixtures");
const STD_FONTS = join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts/");

// map exports `report` fields -> our meta fields
const META_MAP = {
  pet_name: "pet_name", pet_owner: "pet_owner", species: "species", breed: "breed",
  gender: "gender", age_text: "age_text", age_years: "age_years",
  external_id: "patient_external_id", lab_id: "lab_id", order_id: "order_id",
  account_number: "account_number", attending_vet: "attending_vet",
  idexx_services: "idexx_services", collection_date: "collection_date",
  received_date: "received_date", result_date: "result_date",
};
// Fields that drive the charts/display — JS must reproduce these exactly.
const CHARTED = ["value", "ref_low", "ref_high", "unit", "flag", "numeric"];
// Fields where JS capturing more (a "<" qualifier, fuller result text) is an
// improvement, not a regression — informational only.
const INFO = ["result_text", "qualifier", "ref_text"];

function eq(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === "number" || typeof b === "number") {
    const na = a == null ? null : Number(a), nb = b == null ? null : Number(b);
    if (na == null || nb == null) return na === nb;
    return Math.abs(na - nb) < 1e-9;
  }
  return a === b;
}

function compare(file, got, want) {
  const diffs = [];
  // meta (always must-match)
  for (const [exp, mine] of Object.entries(META_MAP)) {
    if (!eq(got.meta[mine], want.report[exp])) diffs.push({ kind: "num", msg: `meta.${mine}: got ${JSON.stringify(got.meta[mine])} want ${JSON.stringify(want.report[exp])}` });
  }
  if (!eq(got.meta.clinic?.name, want.report.clinic_name)) diffs.push({ kind: "num", msg: `clinic_name: got ${JSON.stringify(got.meta.clinic?.name)} want ${JSON.stringify(want.report.clinic_name)}` });

  // Sections by name; measurements matched by name (not index), so a wrap
  // difference in one qualitative row doesn't cascade. We separate diffs into
  // numeric (the charted data — must match) and qualitative/structural (where
  // pdf.js and pdftotext can legitimately group tight-spaced rows differently).
  const gotSec = new Map(got.sections.map((s) => [s.name, s]));
  const wantSec = new Map(want.sections.map((s) => [s.name, s]));
  for (const name of new Set([...gotSec.keys(), ...wantSec.keys()])) {
    const g = gotSec.get(name), w = wantSec.get(name);
    if (!g) { diffs.push({ kind: "qual", msg: `section ${name}: missing in JS output` }); continue; }
    if (!w) { diffs.push({ kind: "qual", msg: `section ${name}: extra in JS output` }); continue; }
    const jsM = new Map(g.measurements.map((m) => [m.name, m]));   // got = JS
    const rbM = new Map(w.measurements.map((m) => [m.name, m]));   // want = Ruby
    for (const mn of new Set([...jsM.keys(), ...rbM.keys()])) {
      const a = jsM.get(mn), b = rbM.get(mn);
      // Ruby had it, JS doesn't: a real regression only if Ruby's was numeric.
      if (!a) { diffs.push({ kind: b.numeric ? "num" : "qual", msg: `${name}: "${mn}" only in Ruby${b.numeric ? " — JS LOST a numeric value" : ""}` }); continue; }
      // JS captured an extra row — not a regression.
      if (!b) { diffs.push({ kind: "qual", msg: `${name}: "${mn}" only in JS` }); continue; }
      // JS-ahead: Ruby's extraction captured no value for this analyte but JS did
      // (some layouts right-align the result onto a line pdftotext splits away but
      // pdf.js keeps together). Capturing more is an improvement, not a regression
      // — same principle as the INFO fields — so don't fail the charted check on it.
      // The reverse (JS null where Ruby has a value) and genuine value mismatches
      // are still hard failures.
      const jsAhead = b.value == null && a.value != null;
      for (const f of CHARTED) {
        if (!eq(a[f], b[f])) diffs.push({ kind: jsAhead ? "qual" : "num", msg: `${name} "${mn}".${f}: got ${JSON.stringify(a[f])} want ${JSON.stringify(b[f])}${jsAhead ? " (JS ahead)" : ""}` });
      }
      for (const f of INFO) {
        if (!eq(a[f], b[f])) diffs.push({ kind: "qual", msg: `${name} "${mn}".${f}: got ${JSON.stringify(a[f])} want ${JSON.stringify(b[f])}` });
      }
    }
  }
  return diffs;
}

// samples/ and test/fixtures/ are gitignored (they hold real reports), so a
// fresh clone / CI has none. Skip cleanly rather than crash; run locally where
// the PDFs and fixtures are present.
const files = (existsSync(SAMPLES) ? readdirSync(SAMPLES) : []).filter((f) => f.endsWith(".pdf")).sort();
if (files.length === 0) {
  console.log("No local sample PDFs (samples/*.pdf is gitignored) — parity skipped.");
  console.log("Add your IDEXX PDFs to samples/ and fixtures to test/fixtures/ to run it.");
  process.exit(0);
}
let pass = 0, fail = 0;
for (const f of files) {
  const expPath = join(EXPORTS, basename(f, ".pdf") + ".json");
  if (!existsSync(expPath)) { console.log(`SKIP ${f} (no fixture)`); continue; }
  const want = JSON.parse(readFileSync(expPath, "utf8"));
  const data = new Uint8Array(readFileSync(join(SAMPLES, f)));
  const { lines } = await extractLines(data, getDocument, { standardFontDataUrl: STD_FONTS });
  const got = parseReport(lines, { sourceFile: f });
  const diffs = compare(f, got, want);
  const numDiffs = diffs.filter((d) => d.kind === "num");
  const qualDiffs = diffs.filter((d) => d.kind === "qual");
  if (numDiffs.length === 0) {
    pass++;
    console.log(`PASS ${f}${qualDiffs.length ? `  (${qualDiffs.length} benign qualitative diff${qualDiffs.length > 1 ? "s" : ""})` : ""}`);
    for (const d of qualDiffs) console.log(`   · ${d.msg}`);
  } else {
    fail++;
    console.log(`FAIL ${f}  (${numDiffs.length} numeric/meta diffs, ${qualDiffs.length} qualitative)`);
    for (const d of numDiffs.slice(0, 25)) console.log(`   ✗ ${d.msg}`);
    for (const d of qualDiffs.slice(0, 10)) console.log(`   · ${d.msg}`);
  }
}
console.log(`\n${pass} passed (numeric+meta exact), ${fail} failed of ${pass + fail}`);
process.exit(fail ? 1 : 0);
