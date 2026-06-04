// Port of lib/pethud/report_parser.rb — turns extracted Lines into a structured
// per-report document. Pure (no pdf.js, no DOM), so it runs identically in the
// browser, a Web Worker, and Node (parity test). The Ruby pipeline stays
// canonical; test/parity.mjs pins this port to its committed output.
//
// The one part that isn't a 1:1 port is the header: Ruby uses `pdftotext
// -layout` prose, which pdf.js has no equivalent for. We reconstruct a
// layout-like spaced string from the page-1 words (1 space within a cell, wider
// gaps between columns) so the original header regexes apply unchanged.

import { lineText } from "./extract.js";

const SECTIONS = [
  "Hematology", "Chemistry", "Urinalysis", "Urine Chemistry",
  "Endocrinology", "Serology", "Immunology", "Parasitology",
  "Microbiology", "Cytology", "Coagulation", "Infectious Disease",
];
const SECTION_RE = new RegExp(`^(${SECTIONS.map(escapeRegex).join("|")})(?:\\s*\\(continued\\))?$`);

const NOISE_RE = /PET\sOWNER:|DATE\sOF\sRESULT:|LAB\sID:|Generated\sby\sVetConnect|Page\s\d+\sof\s\d+|^1\s8\d\d|^\d{3}-\d{3}-\d{4}$/;
const NOTE_NAME_RE = /^\*|Clinical History|INFO NEEDED|Fecal Note|^Other$|^Note\b|^Key\b/i;

const NAME_ANCHOR_SLACK = 48;
const CONT_GAP = 16.0;
const NUMBER = "-?\\d+(?:\\.\\d+)?";

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// --- entry point ----------------------------------------------------------

// lines: Array<{page, y, words:[{x,y,w,text}]}> from extract.js
// opts: { sourceFile, fileSha256 }
export function parseReport(lines, opts = {}) {
  const meta = parseHeader(lines);
  const sections = parseSections(lines, meta);
  return {
    source_file: opts.sourceFile ?? null,
    file_sha256: opts.fileSha256 ?? null,
    meta,
    sections,
  };
}

// --- header ----------------------------------------------------------------

function parseHeader(lines) {
  const page1 = lines.filter((l) => l.page === 1).sort((a, b) => a.y - b.y);
  const layoutLines = page1.map(reconstructLine);
  const text = layoutLines.join("\n");

  const meta = {};
  meta.pet_name = petNameFromLines(layoutLines);
  meta.pet_owner = field(text, "PET OWNER");
  meta.species = field(text, "SPECIES");
  meta.breed = field(text, "BREED");
  meta.gender = field(text, "GENDER");
  meta.age_text = field(text, "AGE");
  meta.patient_external_id = field(text, "PATIENT ID");
  meta.lab_id = tokenField(text, "LAB ID");
  meta.order_id = tokenField(text, "ORDER ID");
  meta.account_number = tokenField(text, "ACCOUNT #");
  meta.attending_vet = field(text, "ATTENDING VET");
  meta.collection_date = normalizeDate(tokenField(text, "COLLECTION DATE"));
  meta.received_date = normalizeDate(tokenField(text, "DATE OF RECEIPT"));
  meta.result_date = normalizeDate(tokenField(text, "DATE OF RESULT"));
  meta.age_years = parseAgeYears(meta.age_text);
  meta.clinic = parseClinic(layoutLines);
  meta.idexx_services = parseServices(text);
  return meta;
}

// Reconstruct one layout-like text line from positioned words: a single space
// within a cell, 3 spaces across a column gap. The gap distribution is bimodal
// (tight within a value, wide between columns), so a fixed threshold separates
// them cleanly and the original header regexes (which key off 2+ spaces) apply.
function reconstructLine(line) {
  let s = "";
  let prevRight = null;
  for (const w of line.words) {
    if (prevRight === null) s = w.text;
    else s += (w.x - prevRight > 15 ? "   " : " ") + w.text;
    prevRight = w.x + w.w;
  }
  return s;
}

// Pet name = the header title (line just above "PET OWNER:"). Apostrophe- and
// graph-label-proof, unlike regex-hunting an all-caps line.
function petNameFromLines(layoutLines) {
  const ownerIdx = layoutLines.findIndex((l) => /PET OWNER:/.test(l));
  if (ownerIdx > 0) {
    for (let i = ownerIdx - 1; i >= 0; i--) {
      const t = layoutLines[i].trim();
      if (t && /[A-Za-z]/.test(t) && !/^[\d(]/.test(t)) return t;
    }
  }
  const m = layoutLines.find((l) => /^[A-Z][A-Z .'’-]+$/.test(l.trim()));
  return m ? m.trim() : null;
}

function field(text, label) {
  const m = text.match(new RegExp(`${escapeRegex(label)}:\\s*(\\S.*?)(?:\\s{2,}|\\n|$)`));
  return m ? m[1].trim() : null;
}

function tokenField(text, label) {
  const m = text.match(new RegExp(`${escapeRegex(label)}:\\s*(\\S+)`));
  const v = m ? m[1].trim() : null;
  return v ? v : null;
}

function parseClinic(layoutLines) {
  const row = layoutLines.find((l) => /PET OWNER:/.test(l));
  if (!row) return { name: null };
  let chunks = row.split(/\s{2,}/).filter((c) => c.length);
  let mid = chunks.filter((c) => !/^(PET OWNER:|LAB ID:|\d+)/.test(c));
  if (mid[0] && !/[a-z]/.test(mid[0]) && mid.length > 1) mid = mid.slice(1);
  return { name: mid[0] ?? null };
}

function parseServices(text) {
  const m = text.match(/IDEXX Services:\s*(.+)/);
  return m ? m[1].trim() : null;
}

function parseAgeYears(ageText) {
  if (!ageText) return null;
  let m = ageText.match(/(\d+)\s*Year/i);
  if (m) return parseInt(m[1], 10);
  m = ageText.match(/(\d+)\s*Month/i);
  if (m) return Math.round((parseInt(m[1], 10) / 12) * 10) / 10;
  return null;
}

// --- sections & measurements ----------------------------------------------

function parseSections(lines, meta) {
  const sections = [];
  let current = null, cols = null, inTable = false, lastMeasurement = null, lastY = null;

  for (const line of lines) {
    const txt = lineText(line).trim();
    if (!txt) continue;

    const sec = txt.match(SECTION_RE);
    if (sec) {
      const name = sec[1];
      current = sections.find((s) => s.name === name);
      if (!current) { current = { name, measurements: [] }; sections.push(current); }
      inTable = false; cols = null; lastMeasurement = null;
      continue;
    }

    if (NOISE_RE.test(txt) || txt === meta.pet_name) { inTable = false; continue; }
    if (!current) continue;

    const c = detectColumns(line);
    if (c) { cols = c; inTable = true; lastMeasurement = null; lastY = line.y; continue; }

    if (/\(Order Received\)|\(Last Updated\)/.test(txt)) { captureSectionDates(current, txt); continue; }

    if (!inTable || !cols) continue;

    const row = classifyRow(line, cols);
    if (row.type === "noise") continue;

    const prevValued = lastMeasurement && (lastMeasurement.result_text || "").trim() !== "";
    const continuation = !row.has_value && prevValued && lastY != null && (line.y - lastY) <= CONT_GAP;

    if (continuation) {
      lastMeasurement.name = `${lastMeasurement.name} ${row.name}`.trim();
    } else {
      const m = buildMeasurement(row);
      if (isNote(m.name, m.result_text)) {
        (current.notes ||= []).push({ name: m.name, text: m.result_text });
        lastMeasurement = null;
      } else {
        current.measurements.push(m);
        lastMeasurement = m;
      }
    }
    lastY = line.y;
  }

  return sections.filter((s) => s.measurements.length > 0 || (s.notes && s.notes.length > 0));
}

function isNote(name, resultText) {
  if (NOTE_NAME_RE.test(name)) return true;
  if (name.endsWith(":") && (resultText || "").trim() === "") return true;
  // Prose, not an analyte — caught whether the words land in the name column or
  // the result column (extractors group tight-spaced rows differently). No real
  // analyte name runs 7+ words.
  if (name.split(/\s+/).filter(Boolean).length >= 7) return true;
  return (resultText || "").split(/\s+/).filter(Boolean).length >= 7;
}

function detectColumns(line) {
  const result = line.words.find((w) => w.text === "RESULT");
  if (!result) return null;
  const test = line.words.find((w) => w.text === "TEST");
  // pdf.js emits the header cell "REFERENCE VALUE" as one run, so match by
  // prefix (its left x equals where pdftotext put the "REFERENCE" word).
  const reference = line.words.find((w) => /^REFERENCE\b/.test(w.text));

  const nameX = test ? test.x : 27.0;
  const resultX = result.x;
  const refX = reference ? reference.x : null;
  const priorLo = Math.max((refX ?? resultX) + 230.0, 440.0);
  return {
    name_x: nameX,
    name_hi: resultX - 8.0,
    result_lo: resultX - 8.0,
    result_hi: refX != null ? refX - 8.0 : priorLo,
    ref_lo: refX != null ? refX - 8.0 : null,
    ref_hi: priorLo,
    prior_lo: priorLo,
  };
}

function classifyRow(line, cols) {
  const leftmost = line.words[0];
  if (!leftmost || leftmost.x > cols.name_x + NAME_ANCHOR_SLACK) return { type: "noise" };
  if (/^[a-z]$/.test(leftmost.text)) return { type: "noise" }; // footnote marker

  const nameWords = line.words.filter((w) => w.x < cols.name_hi);
  const resultWords = line.words.filter((w) => w.x >= cols.result_lo && w.x < cols.result_hi);
  const refWords = cols.ref_lo != null ? line.words.filter((w) => w.x >= cols.ref_lo && w.x < cols.ref_hi) : [];

  const name = nameWords.map((w) => w.text).join(" ").trim();
  if (!name) return { type: "noise" };

  let flag = null;
  const refKept = refWords.filter((w) => {
    if (w.text === "H" || w.text === "L") { flag = w.text; return false; }
    return true;
  });

  const result = resultWords.map((w) => w.text).join(" ").trim();
  const reference = refKept.map((w) => w.text).join(" ").trim();
  const meaningfulRef = /[0-9A-Za-z%]/.test(reference);

  return {
    type: "row",
    name,
    result,
    reference: meaningfulRef ? reference : "",
    flag,
    has_value: result !== "" || meaningfulRef,
  };
}

function buildMeasurement(row) {
  const resultText = row.result;
  const [value, qualifier] = parseValue(resultText);
  const [refLow, refHigh, unit] = parseReference(row.reference);
  let flag = row.flag;
  if (flag == null && value != null) flag = deriveFlag(value, refLow, refHigh);

  return {
    name: row.name,
    result_text: resultText,
    value,
    qualifier,
    unit,
    ref_low: refLow,
    ref_high: refHigh,
    ref_text: row.reference === "" ? null : row.reference,
    flag,
    numeric: value != null,
  };
}

function parseValue(text) {
  if (!text) return [null, null];
  const s = text.trim();
  let m = s.match(new RegExp(`^([<>])\\s*(${NUMBER})$`));
  if (m) return [parseFloat(m[2]), m[1]];
  if (new RegExp(`^${NUMBER}$`).test(s)) return [parseFloat(s), null];
  return [null, null];
}

function parseReference(text) {
  if (!text || text.trim() === "") return [null, null, null];
  const s = text.trim();
  const m = s.match(new RegExp(`^(${NUMBER})\\s*-\\s*(${NUMBER})\\s*(.*)$`));
  if (m) {
    const unit = m[3].trim();
    return [parseFloat(m[1]), parseFloat(m[2]), unit === "" ? null : unit];
  }
  return [null, null, s];
}

function deriveFlag(value, low, high) {
  if (value == null) return null;
  if (low != null && value < low) return "L";
  if (high != null && value > high) return "H";
  return null;
}

function captureSectionDates(section, txt) {
  const m = txt.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
  const iso = normalizeDate(m ? m[0] : null);
  if (/\(Order Received\)/.test(txt)) section.order_received ||= iso;
  else if (/\(Last Updated\)/.test(txt)) section.last_updated ||= iso;
}

// Port of Date.strptime for the three observed formats. Returns ISO YYYY-MM-DD
// or null. Two-digit years follow POSIX %y (00-68 -> 2000s, 69-99 -> 1900s).
function normalizeDate(str) {
  if (!str || str.trim() === "") return null;
  const s = str.trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    let [_, mo, d, y] = m;
    let year = parseInt(y, 10);
    if (y.length === 2) year = year < 69 ? 2000 + year : 1900 + year;
    return isoIfValid(year, parseInt(mo, 10), parseInt(d, 10));
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return isoIfValid(+m[1], +m[2], +m[3]);
  return null;
}

function isoIfValid(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${year}-${p(month)}-${p(day)}`;
}
