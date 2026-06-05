// Unit test for the qualitative-evolution logic, using the real readings seen
// in sample urinalysis panels. Run: node test/qualitative.mjs
import assert from "node:assert";
import { ordinalScaleFor, qualRuns, distinctCount, ordRank, qualDisplay, ORD_SCALES } from "../web/lib/qualitative.js";

const ABUND = ORD_SCALES[2]; // NONE SEEN..MANY
const DIP = ORD_SCALES[0];   // NEGATIVE..4+

// Build a series of {date, result_text} from a list of texts.
const series = (texts) => texts.map((t, i) => ({ date: `2026-0${(i % 5) + 1}-01`, result_text: t, report_id: i + 1 }));

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

console.log("ordinal detection:");
check("dipstick grades chart with correct ranks", () => {
  const o = ordinalScaleFor(series(["3+", "TRACE", "3+", "NEGATIVE"]));
  assert(o, "should detect ordinal");
  // ranks index into DIP: NEGATIVE=0, TRACE=1, 1+=2, 2+=3, 3+=4, 4+=5
  assert.deepEqual(o.pts.map((p) => p.value), [4, 1, 4, 0]);
  assert.deepEqual(o.levels, DIP);
});
check("abundance handles OCC/HYALINE/LPF noise", () => {
  const o = ordinalScaleFor(series(["OCC HYALINE (0-1)/LPF", "NONE SEEN", "NONE SEEN", "NONE SEEN"]));
  assert(o && o.levels === ABUND);
  assert.deepEqual(o.pts.map((p) => p.value), [2, 0, 0, 0]); // OCCASIONAL=2, NONE SEEN=0
});
check("presence scale (mucus none→present)", () => {
  const o = ordinalScaleFor(series(["NONE SEEN", "NONE SEEN", "PRESENT"]));
  assert(o, "none/present is ordinal");
  assert.deepEqual(o.pts.map((p) => p.value), [0, 0, 1]);
});
check("count ranges chart by midpoint", () => {
  const o = ordinalScaleFor(series(["0-2", "5-10", "0-2"]));
  assert(o, "count ranges are ordinal");
  assert.deepEqual(o.pts.map((p) => p.value), [1, 7.5, 1]);
});
check("RARE (0-1) maps to RARE not a count", () => {
  assert.equal(ordRank("RARE (0-1)", ABUND), 1);
});

console.log("nominal (no scale):");
check("colors are not ordinal", () => {
  assert.equal(ordinalScaleFor(series(["YELLOW", "STRAW", "YELLOW"])), null);
});
check("collection method is not ordinal", () => {
  assert.equal(ordinalScaleFor(series(["CYSTOCENTESIS", "FREE CATCH"])), null);
});

console.log("run collapsing + distinct (case-insensitive):");
check("identical readings collapse to one run", () => {
  const r = qualRuns(series(["NONE SEEN", "NONE SEEN", "NONE SEEN", "NONE SEEN"]));
  assert.equal(r.length, 1);
  assert.equal(r[0].n, 4);
});
check("YELLOW/Yellow is one value, not a change", () => {
  const qs = series(["YELLOW", "YELLOW", "Yellow", "Yellow"]);
  assert.equal(distinctCount(qs), 1);
  assert.equal(qualRuns(qs).length, 1);
  assert.equal(qualRuns(qs)[0].n, 4);
});
check("transitions produce separate runs with counts", () => {
  const r = qualRuns(series(["1+", "1+", "TRACE", "NEGATIVE", "NEGATIVE", "NEGATIVE"]));
  assert.deepEqual(r.map((x) => x.text + "×" + x.n), ["1+×2", "TRACE×1", "NEGATIVE×3"]);
});
check("trailing period is not a change (Ova & Parasites)", () => {
  const qs = series(["No ova or parasites seen.", "No ova or parasites seen", "No ova or parasites seen"]);
  assert.equal(distinctCount(qs), 1);
  assert.equal(qualRuns(qs).length, 1);
});
check("internal whitespace differences collapse", () => {
  assert.equal(distinctCount(series(["NEGATIVE", "NEGATIVE ", " negative"])), 1);
});

console.log("display casing:");
check("short boolean results uppercase consistently", () => {
  assert.equal(qualDisplay("Negative"), "NEGATIVE");
  assert.equal(qualDisplay("NEGATIVE"), "NEGATIVE");
  assert.equal(qualDisplay("none seen"), "NONE SEEN");
});
check("prose sentences keep their case (no shouting)", () => {
  assert.equal(qualDisplay("No ova or parasites seen"), "No ova or parasites seen");
});

console.log(`\n${pass} assertions passed.`);
