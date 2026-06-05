// Tests for analyte-name aliasing: the pure index/lookup, and that buildPayload
// folds fragmented names into one canonical analyte while leaving the raw
// per-report measurements and unrelated analytes alone.
// Run: node test/aliases.mjs
import assert from "node:assert";
import fs from "node:fs";
import { aliasIndex, canonicalName } from "../web/lib/aliases.js";
import { buildPayload } from "../web/lib/aggregate.js";

const config = JSON.parse(fs.readFileSync(new URL("../config/analyte_aliases.json", import.meta.url)));
let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

console.log("alias index (section-scoped):");
const idx = aliasIndex(config);
check("fragments map to canonical within their section", () => {
  assert.equal(canonicalName(idx, "Urinalysis", "Blood /"), "Blood / Hemoglobin");
  assert.equal(canonicalName(idx, "Urinalysis", "Hemoglobin"), "Blood / Hemoglobin");
  assert.equal(canonicalName(idx, "Urinalysis", "White Blood"), "White Blood Cells");
  assert.equal(canonicalName(idx, "Hematology", "% Reticulocyte"), "% Reticulocytes");
});
check("Hematology Hemoglobin (real CBC) is NOT aliased", () => {
  assert.equal(canonicalName(idx, "Hematology", "Hemoglobin"), "Hemoglobin");
});
check("ambiguous 'Cells' is left alone", () => {
  assert.equal(canonicalName(idx, "Urinalysis", "Cells"), "Cells");
});

// --- integration through buildPayload ---
const meta = (date) => ({ result_date: date, pet_name: "IRIS REED", pet_owner: "REED", patient_external_id: "1", species: "Feline" });
const ua = (name, text) => ({ name, result_text: text, value: null, unit: null, numeric: false });
const docs = [
  { source_file: "a.pdf", file_sha256: "a", meta: meta("2023-09-13"),
    sections: [
      { name: "Hematology", measurements: [{ name: "% Reticulocyte", value: 0.3, unit: "%", numeric: true }, { name: "Hemoglobin", value: 12.9, unit: "g/dL", numeric: true }], notes: [] },
      { name: "Urinalysis", measurements: [ua("Blood /", null), ua("Hemoglobin", null), ua("White Blood", null), ua("Cells", null), ua("Collection", "CYSTOCENTESIS")], notes: [] },
    ] },
  { source_file: "b.pdf", file_sha256: "b", meta: meta("2024-08-30"),
    sections: [
      { name: "Hematology", measurements: [{ name: "% Reticulocytes", value: 0.3, unit: "%", numeric: true }, { name: "Hemoglobin", value: 14.0, unit: "g/dL", numeric: true }], notes: [] },
      { name: "Urinalysis", measurements: [ua("Blood / Hemoglobin", null), ua("White Blood Cells", null), ua("Collection Method", "CYSTOCENTESIS")], notes: [] },
    ] },
];
const payload = buildPayload(docs, { patientsConfig: { patients: [] }, analyteAliases: config });
const names = payload.analytes.filter((a) => a.section !== "Hematology" || true).map((a) => `${a.section} / ${a.name}`);

console.log("buildPayload catalog:");
check("fragments are gone, canonical present", () => {
  for (const gone of ["Urinalysis / Blood /", "Urinalysis / Hemoglobin", "Urinalysis / White Blood", "Urinalysis / Collection", "Hematology / % Reticulocyte"]) {
    assert(!names.includes(gone), `should not contain ${gone}`);
  }
  for (const keep of ["Urinalysis / Blood / Hemoglobin", "Urinalysis / White Blood Cells", "Urinalysis / Collection Method", "Hematology / % Reticulocytes"]) {
    assert(names.includes(keep), `should contain ${keep}`);
  }
});
check("each canonical appears exactly once (merged across reports)", () => {
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dup, [], `unexpected duplicates: ${dup}`);
});
check("Hematology Hemoglobin kept separate and numeric", () => {
  const hgb = payload.analytes.filter((a) => a.section === "Hematology" && a.name === "Hemoglobin");
  assert.equal(hgb.length, 1);
  assert.equal(hgb[0].numeric, true);
});
check("merged % Reticulocytes has both reports' points", () => {
  const a = payload.analytes.find((x) => x.section === "Hematology" && x.name === "% Reticulocytes");
  const pid = payload.patients[0].id;
  assert.equal(payload.series[pid][a.id].length, 2);
});

console.log(`\n${pass} assertions passed.`);
