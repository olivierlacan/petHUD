// Tests for per-file failure attribution: a bad PDF (or a bad stored report)
// must be identifiable by name, and must never take the rest of the corpus with
// it. Covers the diagnosis rules, pdf.js error classification, and the
// fault-isolating aggregator.
// Run: node test/import-errors.mjs
import assert from "node:assert";
import { docShapeError, reportWarnings, looksLikeReport, measurementCount } from "../web/lib/diagnose.js";
import { classifyPdfError, looksLikePdf } from "../web/lib/process.js";
import { buildPayload } from "../web/lib/aggregate.js";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

const meta = (over = {}) => ({
  pet_name: "IRIS REED", pet_owner: "MAYA REED", patient_external_id: "42",
  species: "Feline", result_date: "2025-01-10", collection_date: "2025-01-09", ...over,
});
const doc = (over = {}) => ({
  source_file: "iris.pdf", file_sha256: "aaa", meta: meta(),
  sections: [{ name: "Chemistry", measurements: [{ name: "BUN", value: 22, unit: "mg/dL", numeric: true }], notes: [] }],
  ...over,
});

console.log("document shape (what buildPayload requires):");
check("a well-formed document passes", () => {
  assert.equal(docShapeError(doc()), null);
  assert.equal(measurementCount(doc()), 1);
});
check("every malformed shape is reported, not thrown", () => {
  assert.match(docShapeError(null), /no parsed report stored/);
  assert.match(docShapeError({ source_file: "x.pdf", sections: [] }), /no meta block/);
  assert.match(docShapeError({ meta: {} }), /no sections list/);
  assert.match(docShapeError({ meta: {}, sections: [{ name: "Chemistry" }] }), /no measurements list/);
  assert.match(docShapeError("nope"), /not an object/);
});

console.log("\nper-report warnings:");
check("a clean report has none", () => assert.deepEqual(reportWarnings(doc()), []));
check("a report with no date is flagged", () => {
  const w = reportWarnings(doc({ meta: meta({ result_date: null, collection_date: null }) }));
  assert.ok(w.some((x) => x.code === "undated"));
});
check("a missing result date alone is a softer warning", () => {
  const w = reportWarnings(doc({ meta: meta({ result_date: null }) }));
  assert.ok(w.some((x) => x.code === "no-result-date"));
  assert.ok(!w.some((x) => x.code === "undated"));
});
check("a report with sections but no values is flagged", () => {
  const w = reportWarnings(doc({ sections: [{ name: "Chemistry", measurements: [] }] }));
  assert.ok(w.some((x) => x.code === "no-measurements"));
});
check("a report with no sections at all is flagged", () => {
  const w = reportWarnings(doc({ sections: [] }));
  assert.ok(w.some((x) => x.code === "no-sections"));
});
check("a nameless pet is flagged", () => {
  const w = reportWarnings(doc({ meta: meta({ pet_name: null }) }));
  assert.ok(w.some((x) => x.code === "no-pet-name"));
});

console.log("\nis this an IDEXX report at all:");
check("a parsed report is", () => assert.equal(looksLikeReport(doc()), true));
check("a header-only report (sections lost) still is", () => {
  assert.equal(looksLikeReport(doc({ sections: [] })), true);
});
check("an empty document (blank/scanned/other PDF) is not", () => {
  assert.equal(looksLikeReport({ source_file: "invoice.pdf", meta: {}, sections: [] }), false);
});

console.log("\npdf.js error classification:");
check("password-protected PDFs say so", () => {
  const e = new Error("No password given"); e.name = "PasswordException";
  assert.equal(classifyPdfError(e).code, "encrypted");
});
check("corrupt PDFs say so", () => {
  const e = new Error("Invalid PDF structure."); e.name = "InvalidPDFException";
  assert.equal(classifyPdfError(e).code, "corrupt");
});
check("anything else keeps its message", () => {
  assert.match(classifyPdfError(new Error("boom")).message, /boom/);
});
check("magic-byte check", () => {
  assert.equal(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n").buffer), true);
  assert.equal(looksLikePdf(new TextEncoder().encode("<html>ohno").buffer), false);
});

console.log("\naggregate fault isolation (one bad report must not hide the rest):");
const good = doc();
const broken = { source_file: "broken.pdf", file_sha256: "bbb", sections: [] }; // no meta
check("a malformed document is quarantined, by filename", () => {
  const p = buildPayload([good, broken], { patientsConfig: { patients: [] } });
  assert.equal(p.reports.length, 1);
  assert.equal(p.reports[0].source_file, "iris.pdf");
  const prob = p.problems.find((x) => x.kind === "unreadable");
  assert.equal(prob.source_file, "broken.pdf");
  assert.equal(prob.sha256, "bbb");
  assert.match(prob.message, /no meta block/);
});
check("every malformed shape is survivable", () => {
  const bad = [null, { meta: {} }, { meta: {}, sections: [{ name: "C" }] }, { meta: {}, sections: {} }];
  for (const b of bad) {
    const p = buildPayload([good, b], { patientsConfig: { patients: [] } });
    assert.equal(p.reports.length, 1, "good report survived alongside " + JSON.stringify(b));
    assert.equal(p.problems.filter((x) => x.kind === "unreadable").length, 1);
  }
});
check("a thin-but-usable report imports and is reported as degraded", () => {
  const thin = doc({ source_file: "thin.pdf", file_sha256: "ccc", sections: [] });
  const p = buildPayload([good, thin], { patientsConfig: { patients: [] } });
  assert.equal(p.reports.length, 2);
  const prob = p.problems.find((x) => x.kind === "degraded");
  assert.equal(prob.source_file, "thin.pdf");
  const rep = p.reports.find((r) => r.sha256 === "ccc");
  assert.ok(rep.warnings.some((w) => w.code === "no-sections"));
});
check("a clean corpus reports no problems", () => {
  assert.deepEqual(buildPayload([good], { patientsConfig: { patients: [] } }).problems, []);
});

console.log("\nundated reports (the crash that named no file):");
check("a report with no result date falls back to the collection date", () => {
  const d = doc({ source_file: "nodate.pdf", file_sha256: "ddd", meta: meta({ result_date: null }) });
  const p = buildPayload([d], { patientsConfig: { patients: [] } });
  assert.equal(p.reports[0].date, "2025-01-09");
  assert.equal(p.series[1][1][0].date, "2025-01-09");
});
check("a fully undated report still builds and sorts", () => {
  const d = doc({ source_file: "undated.pdf", file_sha256: "eee", meta: meta({ result_date: null, collection_date: null }) });
  const p = buildPayload([good, d], { patientsConfig: { patients: [] } });
  assert.equal(p.reports.length, 2);
  assert.equal(p.reports.find((r) => r.sha256 === "eee").date, null);
  // the dated report still defines the patient's range
  assert.deepEqual(p.patients[0].date_range, ["2025-01-10", "2025-01-10"]);
});
check("a patient rule with no name doesn't break the patient sort", () => {
  const p = buildPayload([good], { patientsConfig: { patients: [{ slug: "iris", match: { names: ["IRIS"] } }] } });
  assert.equal(p.patients.length, 1);
});

console.log(`\n${pass} assertions passed.`);
