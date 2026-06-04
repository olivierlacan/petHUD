# Spike findings: pdf.js vs pdftotext (Phase 0)

**Question:** Can browser-side pdf.js (`getTextContent()`) reproduce the per-word
coordinates that `report_parser.rb`'s column logic depends on, well enough to parse
IDEXX reports entirely in the browser?

**Answer: YES — decisive pass.** Run `node compare.mjs` (Node ≥ 22.13; pdfjs-dist 6.x)
to reproduce.

## Evidence (all 10 samples)

- **x-coordinate accuracy is sub-pixel.** Mean drift vs `pdftotext -tsv` was ~0.01 pt,
  max 1.4 pt (one 3.34 pt outlier) across thousands of words. Column anchoring is safe.
- **Table columns are fully preserved.** Representative rows, straight from pdf.js:
  - `RBC@27  8.63@136  7.12 - 11.46 M/µL@224  9.74@479` (name / result / reference / prior)
  - `Glucose@27  76@136  71 - 159 mg/dL@224  112@479  103@541` (Catalyst, two prior columns)
  - `IDEXX Cystatin@27  <@130  50@136  0 - 99 ng/mL@224` (`< 50` splits like pdftotext)
- **H/L flags stay separate tokens.** `ALT "ALT"@27 "26"@136 "27 - 158 U/L"@224 "L"@312 "37"@479`
  — the flag sits at x≈312 exactly where `classify_row` pulls it from the reference band.
- **Header tokens isolate.** `RESULT` is a discrete token (one per section table);
  `TEST` and `REFERENCE`/`REFERENCE VALUE` are findable for `detect_columns`.

## Granularity note (important, and favorable)

pdf.js emits ~220 "runs" per report (multi-word items), but **runs are whole cells and
never cross column boundaries**: a reference like `7.12 - 11.46 M/µL` arrives as one item
at the reference x — which is exactly what `parse_reference` wants. The result `< 50`
arrives as two items in the result band, joined by `classify_row` just like pdftotext.

**Chosen normalization path: span-based / left-edge, NO splitting.** Feed pdf.js items
directly as `Word{ x = transform[4], yTop = pageHeight - transform[5], w = item.width,
text = item.str }`. `classify_row`'s existing "assign by word.x" logic works unchanged.
(The originally-anticipated split-and-apportion is unnecessary.)

## Caveats / notes for the full build

- **Y is baseline-based** (pdf.js `f`), ~11 pt below pdftotext's glyph-top. This is a
  *consistent* offset; line grouping (3 pt tolerance) and the relative gap logic
  (`CONT_GAP=16`, row pitch ~17.4) are unaffected. Don't compare pdf.js Y to pdftotext Y
  absolutely.
- **Header parsing** still needs the positional port (no `-layout` in pdf.js); label runs
  like `"PET OWNER:"` come as single tokens, which actually helps.
- The 71.9% "rows with a separate result token" in `compare.mjs` is **not** an accuracy
  figure — the crude row counter includes section date sub-headers, footnotes, and
  qualitative/empty urinalysis rows that legitimately lack a numeric result. True accuracy
  is measured by the Phase 2 **parity test** against `exports/reports/*.json`.
- **Runtime:** pdfjs-dist 6.x requires Node ≥ 22.13 for the tooling/parity test; the
  browser build is unaffected. Pin an exact version (see plan, Phase 5).

## Recommendation

**GO.** Proceed to the full build (Phases 1-5). The existential risk is retired; the port
is slightly simpler than planned (no item-splitting needed).
