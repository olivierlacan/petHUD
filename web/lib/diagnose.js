// Report-document health checks, shared by the import path (process.js), the
// aggregator (aggregate.js) and the viewer.
//
// Two distinct questions, deliberately kept apart:
//
//   docShapeError(doc)  — can buildPayload consume this document at all? A "no"
//                         is fatal: the document is excluded rather than allowed
//                         to throw halfway through a corpus-wide rebuild, where
//                         the exception carries no clue which file caused it.
//   reportWarnings(doc) — the document is structurally fine but thin (no result
//                         date, no measurements, no pet name). Those import, but
//                         are surfaced per-file so a bad PDF can be found and
//                         removed instead of silently degrading the corpus.
//
// Every finding names the file it came from; that is the whole point of this
// module.

// Structural contract buildPayload relies on. Returns a human-readable reason
// string, or null when the document is usable.
export function docShapeError(doc) {
  if (doc == null) return "no parsed report stored for this file (empty database record)";
  if (typeof doc !== "object") return "stored report is not an object (got " + typeof doc + ")";
  if (doc.meta == null || typeof doc.meta !== "object") return "stored report has no meta block";
  if (!Array.isArray(doc.sections)) return "stored report has no sections list";
  for (const sec of doc.sections) {
    if (sec == null || typeof sec !== "object") return "stored report contains an invalid section entry";
    if (!Array.isArray(sec.measurements)) {
      return 'section "' + (sec.name ?? "?") + '" has no measurements list';
    }
  }
  return null;
}

export function measurementCount(doc) {
  if (docShapeError(doc)) return 0;
  return doc.sections.reduce((n, s) => n + s.measurements.length, 0);
}

// Non-fatal findings, worst first. `code` is stable for the UI; `message` is
// what a report owner reads.
export function reportWarnings(doc) {
  const out = [];
  if (docShapeError(doc)) return out;
  const meta = doc.meta;
  const measurements = measurementCount(doc);

  if (!doc.sections.length) {
    out.push({
      code: "no-sections",
      message: "no recognizable result sections (Hematology, Chemistry, Urinalysis, …) were found",
    });
  } else if (measurements === 0) {
    out.push({ code: "no-measurements", message: "result sections were found but no values could be read from them" });
  }
  if (!meta.result_date && !meta.collection_date) {
    out.push({ code: "undated", message: "no result or collection date could be read, so it can't be placed on a trend line" });
  } else if (!meta.result_date) {
    out.push({ code: "no-result-date", message: "no result date could be read (falling back to the collection date)" });
  }
  if (!meta.pet_name) {
    out.push({ code: "no-pet-name", message: "no pet name could be read from the header, so it can't be matched to a pet" });
  }
  return out;
}

// Does this document carry anything at all that identifies it as an IDEXX
// report? Used by the import path to reject a PDF outright (a bank statement, a
// scanned photo) instead of storing a ghost report that pollutes the corpus.
export function looksLikeReport(doc) {
  if (docShapeError(doc)) return false;
  const meta = doc.meta;
  return Boolean(
    doc.sections.length ||
    meta.pet_name || meta.pet_owner || meta.lab_id || meta.result_date || meta.collection_date
  );
}

// One-line summary for a problem row: "3 warnings" collapses badly, the
// specific reason does not.
export function summarizeWarnings(warnings) {
  return warnings.map((w) => w.message).join("; ");
}
