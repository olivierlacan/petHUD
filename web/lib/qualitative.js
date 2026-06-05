// Qualitative-result evolution helpers (pure, no DOM/app deps so they're unit
// testable). Qualitative readings are either ORDINAL (a natural order — dipstick
// grades, sediment abundance, count ranges) where direction over time is
// meaningful and chartable, or NOMINAL (Color, Clarity, Collection) where only
// the changes matter. ordinalScaleFor() detects the former; qualRuns() collapses
// consecutive repeats for the latter.

export const ORD_SCALES = [
  ["NEGATIVE", "TRACE", "1+", "2+", "3+", "4+"],
  ["NEGATIVE", "TRACE", "SMALL", "MODERATE", "LARGE"],
  ["NONE SEEN", "RARE", "OCCASIONAL", "FEW", "MODERATE", "MANY"],
  ["NONE SEEN", "PRESENT"],
];

// Synonyms normalised to a scale term (longest keys first so "NONE SEEN" isn't
// shadowed by "NONE").
const ORD_SYN = [
  ["NOT SEEN", "NONE SEEN"], ["NONE", "NONE SEEN"],
  ["OCCASIONALLY", "OCCASIONAL"], ["OCCAS", "OCCASIONAL"], ["OCC", "OCCASIONAL"],
  ["MODERATELY", "MODERATE"], ["MOD", "MODERATE"],
  ["NUMEROUS", "MANY"], ["MARKED", "MANY"],
  ["NEG", "NEGATIVE"], ["TR", "TRACE"], ["SML", "SMALL"], ["LRG", "LARGE"], ["LG", "LARGE"],
];

export function ordNorm(text) {
  let v = String(text || "").toUpperCase().replace(/[().,;:]/g, " ")
    .replace(/\b(HPF|LPF|HP|LP|RBCS?|WBCS?|HYALINE|GRANULAR)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  for (const [k, val] of ORD_SYN) {
    if (v === k || v.indexOf(k + " ") === 0) { v = (val + v.slice(k.length)).trim(); break; }
  }
  return v.replace(/\s+/g, " ").trim();
}

// Index of the scale term the reading begins with (longest match), or -1.
export function ordRank(text, scale) {
  const v = ordNorm(text);
  let best = -1, bestLen = -1;
  for (let j = 0; j < scale.length; j++) {
    const t = scale[j];
    const hit = v === t || v.indexOf(t + " ") === 0 ||
      (v.indexOf(t) === 0 && !/[A-Z0-9]/.test(v.charAt(t.length)));
    if (hit && t.length > bestLen) { best = j; bestLen = t.length; }
  }
  return best;
}

// A count or count-range like "0-2", "5–10", "<5", "10/HPF" -> a midpoint.
export function parseCountRange(text) {
  const v = String(text || "").replace(/\/?\b(HPF|LPF|HP|LP)\b/gi, "").trim();
  let m = v.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/);
  if (m) return (parseFloat(m[1]) + parseFloat(m[2])) / 2;
  m = v.match(/^[<>]?\s*(\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]);
  return null;
}

// If every reading fits one ordinal interpretation, return charted points
// ({date, value:rank, label}) plus the ordered level list for context; else null.
export function ordinalScaleFor(qs) {
  const texts = qs.map((p) => p.result_text);
  for (const sc of ORD_SCALES) {
    if (texts.every((t) => ordRank(t, sc) >= 0)) {
      return {
        levels: sc,
        pts: qs.map((p) => ({ date: p.date, value: ordRank(p.result_text, sc), report_id: p.report_id, label: p.result_text })),
      };
    }
  }
  const mids = texts.map(parseCountRange);
  if (mids.every((m) => m != null)) {
    const order = Array.from(new Set(texts)).sort((a, b) => parseCountRange(a) - parseCountRange(b));
    return {
      levels: order,
      pts: qs.map((p, k) => ({ date: p.date, value: mids[k], report_id: p.report_id, label: p.result_text })),
    };
  }
  return null;
}

export function qualKey(text) { return String(text || "").trim().toUpperCase(); }

// Collapse consecutive identical readings into runs (case-insensitive), for the
// nominal change-timeline.
export function qualRuns(qs) {
  const r = [];
  for (const p of qs) {
    const key = qualKey(p.result_text), last = r[r.length - 1];
    if (last && last.key === key) { last.n++; last.to = p.date; }
    else r.push({ key, text: p.result_text, n: 1, from: p.date, to: p.date });
  }
  return r;
}

// Distinct reading count (case-insensitive).
export function distinctCount(qs) {
  return new Set(qs.map((p) => qualKey(p.result_text))).size;
}
