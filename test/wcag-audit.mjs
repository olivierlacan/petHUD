// WCAG 2.1 contrast audit for the pethud viewer.
//
// Computes the contrast ratio of every real (foreground, background) text
// pairing in style.css, in BOTH color modes, and checks it against WCAG AA
// (and reports AAA). Large text = >=24px, or >=18.66px when bold (AA 3:1 /
// AAA 4.5:1); otherwise normal text (AA 4.5:1 / AAA 7:1).
//
// Run: node test/wcag-audit.mjs
// The token tables below are copied verbatim from :root in web/style.css.

const TOKENS = {
  light: {
    bg: "#f4f6f9", "bg-2": "#ffffff", "bg-3": "#e9edf2", panel: "#ffffff",
    line: "#dde2e9", "line-2": "#c3ccd6",
    text: "#171c24", "text-dim": "#4d586a", "text-mute": "#646d7c",
    accent: "#1a63d6", "on-accent": "#ffffff",
    normal: "#1a7f37", high: "#cf222e", low: "#9a6700",
    "pillH-fg": "#b01019", "pillH-bg": "#fde0e0", "pillL-fg": "#7e5400", "pillL-bg": "#f4ecd6",
  },
  dark: {
    bg: "#0e1116", "bg-2": "#151a21", "bg-3": "#1b222b", panel: "#11161d",
    line: "#232c37", "line-2": "#2d3744",
    text: "#d7dee7", "text-dim": "#8b97a6", "text-mute": "#808a98",
    accent: "#4aa8ff", "on-accent": "#04121f",
    normal: "#3fb950", high: "#f85149", low: "#d29922",
    "pillH-fg": "#ff8d85", "pillH-bg": "#3a1a18", "pillL-fg": "#e6b342", "pillL-bg": "#322610",
  },
};

// Each usage: [label, fgToken, bgToken, px, bold?, bgOverlay?]
// bgOverlay: {color, alpha} composited over bgToken (for translucent pills).
const USAGES = [
  // -- Top bar (on bg-2 / controls on bg-3) --
  ["topbar .sub (subtitle)", "text-mute", "bg-2", 12, false],
  ["topbar .ctl label", "text-mute", "bg-2", 11, false],
  ["topbar select/input value", "text", "bg-3", 13, false],
  ["view-toggle tab (inactive)", "text-dim", "bg-3", 12, false],
  ["view-toggle tab (active)", "on-accent", "accent", 12, true],
  ["'Out of range only' check", "text-dim", "bg-2", 13, false],

  // -- Sidebar (panel) --
  ["sidebar .side-title", "text-mute", "panel", 11, false],
  ["section list item", "text-dim", "panel", 13, false],
  ["section list item (on)", "text", "panel", 13, false],
  ["section list .count", "text-mute", "panel", 11, false],
  ["side-foot '12 reports · 93 analytes'", "text-mute", "panel", 11, false],
  ["Reprocess/Clear linkbtn", "accent", "panel", 11, false],

  // -- Footer (bg-2 / pill on bg-3) --
  ["footer patient-meta", "text-mute", "bg-2", 12, false],
  ["footer patient-meta <b>", "text-dim", "bg-2", 12, true],
  ["footer Manage-pets pill", "accent", "bg-3", 12, true],

  // -- Life-stage banner (panel / chips & toggle on bg-3) --
  ["banner .ls-title", "text", "panel", 14, true],
  ["banner .ls-hook", "text-dim", "panel", 12, false],
  ["banner .ls-sub", "text-dim", "panel", 12, false],
  ["banner .ls-lbl", "text-mute", "panel", 11, false],
  ["banner .ls-chip", "text", "bg-3", 12, false],
  ["banner .ls-text / .ls-screen", "text-dim", "panel", 12, false],
  ["banner .ls-foot .note", "text-mute", "panel", 11, false],
  ["banner Details/Less toggle", "accent", "bg-3", 12, true],
  ["banner source link", "accent", "panel", 12, false],

  // -- Analyte cards (panel) --
  ["section head h2", "text", "bg", 13, true],
  ["section head .n (count)", "text-mute", "bg", 11, false],
  ["card name", "text", "panel", 12, true],
  ["card unit", "text-mute", "panel", 11, false],
  ["card value (ok)", "text", "panel", 20, true],
  ["card value (high)", "high", "panel", 20, true],
  ["card value (low)", "low", "panel", 20, true],
  ["card delta up", "high", "panel", 11, false],
  ["card delta down", "accent", "panel", 11, false],
  ["card delta flat", "text-mute", "panel", 11, false],
  ["card foot (range · pts · date)", "text-mute", "panel", 11, false],
  ["qual badge", "text-dim", "bg-3", 11, false],

  // -- Reports view (panel) --
  ["report rmeta", "text-dim", "panel", 11, false],
  ["report rmeta .k", "text-mute", "panel", 11, false],
  ["report svc (italic)", "text-dim", "panel", 11, false],
  ["flag-table name", "text-dim", "panel", 11, false],
  ["flag-table ref", "text-mute", "panel", 11, false],
  ["pill.H (flag)", "pillH-fg", "pillH-bg", 11, false],
  ["pill.L (flag)", "pillL-fg", "pillL-bg", 11, false],

  // -- Detail overlay (bg-2) --
  ["detail .sec", "text-mute", "bg-2", 12, false],
  ["detail-sub", "text-dim", "bg-2", 12, false],
  ["detail-table th", "text-mute", "bg-2", 11, false],
  ["detail-table td", "text", "bg-2", 12, false],
  ["detail-table td.dt", "text-dim", "bg-2", 12, false],
  ["chart axis-label", "text-mute", "panel", 11, false],
  ["chart gap-label", "low", "panel", 10, false],
  ["empty-state text", "text-mute", "bg", 13, false],
];

function hexToRgb(h) {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
function composite([r, g, b], [br, bg, bb], a) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}
function relLum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(fg, bg) {
  const l1 = relLum(fg), l2 = relLum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function isLarge(px, bold) { return px >= 24 || (bold && px >= 18.66); }

let failAA = 0, total = 0;
const small = [];
for (const theme of ["light", "dark"]) {
  const T = TOKENS[theme];
  console.log(`\n=== ${theme.toUpperCase()} MODE ===`);
  console.log("ratio   AA   AAA  px      element");
  for (const [label, fg, bg, px, bold, overlay] of USAGES) {
    let bgRgb = hexToRgb(T[bg]);
    if (overlay) bgRgb = composite(hexToRgb(T[overlay.color]), bgRgb, overlay.alpha);
    const ratio = contrast(hexToRgb(T[fg]), bgRgb);
    const large = isLarge(px, bold);
    const aaMin = large ? 3.0 : 4.5, aaaMin = large ? 4.5 : 7.0;
    const aa = ratio >= aaMin, aaa = ratio >= aaaMin;
    total++; if (!aa) failAA++;
    if (px < 12 && theme === "light") small.push([label, px, bold]);
    const mark = (ok) => (ok ? " ✓ " : " ✗ ");
    console.log(
      `${ratio.toFixed(2).padStart(5)}  ${mark(aa)}  ${mark(aaa)}  ${String(px).padStart(2)}px${large ? "*" : " "}  ${label}` +
      (aa ? "" : `   <-- needs ${aaMin}:1`),
    );
  }
}
console.log("\n* = qualifies as WCAG large text (laxer 3:1/4.5:1 thresholds)");
console.log(`\nSUMMARY: ${total - failAA}/${total} pass AA  (${failAA} fail)`);
console.log("\nFont sizes below 12px (readability — WCAG has no hard minimum, but small + dense is a concern):");
const seen = new Set();
for (const [label, px, bold] of small) { const k = label; if (seen.has(k)) continue; seen.add(k); console.log(`  ${String(px).padStart(2)}px${bold ? " bold" : ""}  ${label}`); }
process.exit(failAA ? 1 : 0);
