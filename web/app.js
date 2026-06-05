/* PetHUD viewer — vanilla JS, no framework.
   Runs fully in the browser: parses dropped IDEXX PDFs with pdf.js + lib/*,
   stores originals + parsed docs in IndexedDB, and renders the rebuilt payload.
   The Ruby CLI remains available and produces the identical data shape. */
import * as db from "./lib/db.js";
import { processPdf, looksLikePdf } from "./lib/process.js";
import { buildPayload } from "./lib/aggregate.js";
import { givenName } from "./lib/resolver.js";
import { ordinalScaleFor, qualRuns, qualKey, qualDisplay } from "./lib/qualitative.js";

(function () {
  "use strict";

  var DATA = window.PETHUD_DATA || { patients: [], reports: [], analytes: [], series: {} };
  var patientsConfig = { patients: [] }; // static aliasing rules (patients.json)
  var userConfig = { patients: [] };     // user overrides (renames/merges, in IndexedDB)
  var knowledge = null;                  // medical-context payload (knowledge.json)
  var analyteAliases = null;             // analyte-name aliases (analyte_aliases.json)
  var journal = {};                      // owner-entered weight + events, keyed by patient slug

  var SECTION_ORDER = ["Hematology", "Chemistry", "Urinalysis", "Urine Chemistry",
    "Endocrinology", "Serology", "Immunology", "Parasitology", "Microbiology",
    "Cytology", "Coagulation", "Infectious Disease"];

  var SECTION_COLOR = {
    Hematology: "#e06c9f", Chemistry: "#4aa8ff", Urinalysis: "#d29922",
    "Urine Chemistry": "#caa14a", Endocrinology: "#a371f7", Serology: "#3fb950",
    Immunology: "#56c8b0", Parasitology: "#db8b4f", Microbiology: "#8b949e",
    Cytology: "#bc8cff", Coagulation: "#f0883e", "Infectious Disease": "#6e7681"
  };

  var state = {
    patientId: null,
    view: "trends",
    search: "",
    hiddenSections: {},
    abnormalOnly: false,
    // Compact the age/vigilance banner by default — the full per-condition
    // detail lives in the Conditions view; persisted so the choice sticks.
    lsCollapsed: (function () {
      try { return localStorage.getItem("pethud-ls") !== "open"; } catch (e) { return true; }
    })()
  };

  var $ = function (sel) { return document.querySelector(sel); };
  var el = function (tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  // ---- formatting helpers -------------------------------------------------

  function fmtNum(v) {
    if (v == null) return "—";
    var s = (Math.round(v * 1000) / 1000).toString();
    return s;
  }
  function fmtDate(iso) {
    if (!iso) return "?";
    var p = iso.split("-");
    var mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return mon[+p[1] - 1] + " " + (+p[2]) + " '" + p[0].slice(2);
  }
  function fmtDateShort(iso) {
    var p = iso.split("-");
    return p[1] + "/" + p[2] + "/" + p[0].slice(2);
  }
  function ms(iso) { return Date.parse(iso + "T00:00:00Z"); }

  function flagOf(point) {
    if (point.flag === "H" || point.flag === "L") return point.flag;
    if (point.value != null) {
      if (point.ref_low != null && point.value < point.ref_low) return "L";
      if (point.ref_high != null && point.value > point.ref_high) return "H";
    }
    return "ok";
  }

  // One numeric point per date (collapse reprints of the same order); keep the
  // point from the most recently imported report when a date repeats.
  function numericSeries(points) {
    var byDate = {};
    points.forEach(function (p) {
      if (p.value == null) return;
      var cur = byDate[p.date];
      if (!cur || p.report_id > cur.report_id) byDate[p.date] = p;
    });
    return Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
  }

  function qualSeries(points) {
    // Keep one per date, prefer non-empty textual result.
    var byDate = {};
    points.forEach(function (p) {
      var txt = (p.result_text || "").trim();
      if (!txt) return;
      var cur = byDate[p.date];
      if (!cur || p.report_id > cur.report_id) byDate[p.date] = p;
    });
    return Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
  }

  // ---- qualitative evolution ---------------------------------------------
  // Ordinal detection + run collapsing live in ./lib/qualitative.js (pure,
  // unit-tested). qualSpark renders the ordinal series and stays here because
  // it depends on the app's scale/svg helpers.

  // Stepped sparkline for an ordinal qualitative series (HV steps = discrete
  // states). `levels` low->high becomes the chart's <title> for context.
  function qualSpark(pts, ctx, levels) {
    var W = 208, H = 46, box = { l: 2, t: 6, w: W - 4, h: H - 12 };
    var firstMs = ms(pts[0].date), lastMs = ms(pts[pts.length - 1].date);
    var domainMax = ctx ? Math.max(lastMs, ctx.latestMs || lastMs) : lastMs;
    var gaps = ctx ? ctx.missingDates.filter(function (d) { return d >= firstMs && d <= domainMax; }) : [];
    var s = scales(pts, box, null, null, gaps.concat([domainMax]));
    var out = svgEl(W, H, "spark");
    out += "<title>" + escapeHtml(levels.join(" → ")) + "</title>";
    gaps.forEach(function (d) {
      var gx = s.X(d).toFixed(1);
      out += '<line class="gap-line" x1="' + gx + '" y1="' + box.t + '" x2="' + gx + '" y2="' + (box.t + box.h) + '"/>';
    });
    if (pts.length > 1) {
      var d = "M" + s.X(ms(pts[0].date)).toFixed(1) + " " + s.Y(pts[0].value).toFixed(1);
      for (var i = 1; i < pts.length; i++) {
        var x = s.X(ms(pts[i].date)).toFixed(1);
        d += " L" + x + " " + s.Y(pts[i - 1].value).toFixed(1) + " L" + x + " " + s.Y(pts[i].value).toFixed(1);
      }
      out += '<path class="series-line" d="' + d + '"/>';
    }
    pts.forEach(function (p, i) {
      out += '<circle class="qpt" cx="' + s.X(ms(p.date)).toFixed(1) + '" cy="' + s.Y(p.value).toFixed(1) + '" r="' + (i === pts.length - 1 ? 3 : 2) + '"/>';
    });
    return out + "</svg>";
  }

  // ---- scales -------------------------------------------------------------

  function scales(pts, box, refLow, refHigh, extraX) {
    var xs = pts.map(function (p) { return ms(p.date); });
    (extraX || []).forEach(function (t) { if (t != null) xs.push(t); });
    var vs = pts.map(function (p) { return p.value; });
    if (refLow != null) vs.push(refLow);
    if (refHigh != null) vs.push(refHigh);
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var vmin = Math.min.apply(null, vs), vmax = Math.max.apply(null, vs);
    if (xmin === xmax) { xmin -= 1; xmax += 1; }
    var span = (vmax - vmin) || Math.abs(vmax) || 1;
    vmin -= span * 0.12; vmax += span * 0.12;
    var X = function (t) { return box.l + (box.w) * (t - xmin) / (xmax - xmin); };
    var Y = function (v) { return box.t + box.h - (box.h) * (v - vmin) / (vmax - vmin); };
    return { X: X, Y: Y, xmin: xmin, xmax: xmax, vmin: vmin, vmax: vmax };
  }

  function svgEl(w, h, cls) {
    return '<svg class="' + cls + '" viewBox="0 0 ' + w + ' ' + h +
      '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">';
  }

  // Latest reference range across the series (band shading uses this).
  function latestRef(pts) {
    for (var i = pts.length - 1; i >= 0; i--) {
      if (pts[i].ref_low != null || pts[i].ref_high != null) {
        return { low: pts[i].ref_low, high: pts[i].ref_high };
      }
    }
    return { low: null, high: null };
  }

  // ---- sparkline ----------------------------------------------------------

  function sparkline(pts, ctx) {
    var W = 208, H = 46;
    if (pts.length === 0) return svgEl(W, H, "spark") + "</svg>";
    var ref = latestRef(pts);
    var box = { l: 2, t: 4, w: W - 4, h: H - 8 };
    var firstMs = ms(pts[0].date), lastMs = ms(pts[pts.length - 1].date);
    // Extend the time axis to the latest report so a trailing gap is visible.
    var domainMax = ctx ? Math.max(lastMs, ctx.latestMs || lastMs) : lastMs;
    var gaps = ctx ? ctx.missingDates.filter(function (d) { return d >= firstMs && d <= domainMax; }) : [];
    var s = scales(pts, box, ref.low, ref.high, gaps.concat([domainMax]));
    var out = svgEl(W, H, "spark");

    if (ref.low != null && ref.high != null) {
      var yTop = s.Y(ref.high), yBot = s.Y(ref.low);
      out += '<rect class="ref-band" x="' + box.l + '" y="' + yTop.toFixed(1) +
        '" width="' + box.w + '" height="' + Math.max(0, yBot - yTop).toFixed(1) + '"/>';
    }
    // gaps: reports where this analyte wasn't measured
    gaps.forEach(function (d) {
      var gx = s.X(d).toFixed(1);
      out += '<line class="gap-line" x1="' + gx + '" y1="' + box.t + '" x2="' + gx + '" y2="' + (box.t + box.h) + '"/>';
    });
    // owner events (meds/diet/symptoms) within the chart's time span
    patientEventMarks().forEach(function (m) {
      if (m.ms < s.xmin || m.ms > s.xmax) return;
      out += '<line class="event-line" x1="' + s.X(m.ms).toFixed(1) + '" y1="' + box.t + '" x2="' + s.X(m.ms).toFixed(1) +
        '" y2="' + (box.t + box.h) + '"><title>' + escapeHtml(m.label) + "</title></line>";
    });
    if (pts.length > 1) {
      var d = pts.map(function (p, i) {
        return (i ? "L" : "M") + s.X(ms(p.date)).toFixed(1) + " " + s.Y(p.value).toFixed(1);
      }).join(" ");
      out += '<path class="series-line" d="' + d + '"/>';
    }
    pts.forEach(function (p, i) {
      var r = i === pts.length - 1 ? 3 : 2;
      out += '<circle class="pt ' + flagOf(p) + '" cx="' + s.X(ms(p.date)).toFixed(1) +
        '" cy="' + s.Y(p.value).toFixed(1) + '" r="' + r + '"/>';
    });
    return out + "</svg>";
  }

  // ---- big detail chart with axes + hover --------------------------------

  function bigChart(pts, ctx) {
    var W = 820, H = 280;
    var box = { l: 52, t: 16, w: W - 70, h: H - 52 };
    var ref = latestRef(pts);
    var firstMs = ms(pts[0].date), lastMs = ms(pts[pts.length - 1].date);
    var domainMax = ctx ? Math.max(lastMs, ctx.latestMs || lastMs) : lastMs;
    var gaps = ctx ? ctx.missingDates.filter(function (d) { return d >= firstMs && d <= domainMax; }) : [];
    var s = scales(pts, box, ref.low, ref.high, gaps.concat([domainMax]));
    var out = svgEl(W, H, "bigchart");

    // y gridlines + labels
    var ticks = niceTicks(s.vmin, s.vmax, 5);
    ticks.forEach(function (tv) {
      var y = s.Y(tv).toFixed(1);
      out += '<line class="grid-line" x1="' + box.l + '" y1="' + y + '" x2="' + (box.l + box.w) + '" y2="' + y + '"/>';
      out += '<text class="axis-label" x="' + (box.l - 6) + '" y="' + (+y + 3) + '" text-anchor="end">' + fmtNum(tv) + "</text>";
    });

    // reference band
    if (ref.low != null && ref.high != null) {
      var yTop = s.Y(ref.high), yBot = s.Y(ref.low);
      out += '<rect class="ref-band" x="' + box.l + '" y="' + yTop.toFixed(1) + '" width="' + box.w + '" height="' + Math.max(0, yBot - yTop).toFixed(1) + '"/>';
      out += '<line class="ref-edge" x1="' + box.l + '" y1="' + yTop.toFixed(1) + '" x2="' + (box.l + box.w) + '" y2="' + yTop.toFixed(1) + '"/>';
      out += '<line class="ref-edge" x1="' + box.l + '" y1="' + yBot.toFixed(1) + '" x2="' + (box.l + box.w) + '" y2="' + yBot.toFixed(1) + '"/>';
    }

    // gaps: dashed verticals where a report exists but didn't include this
    // analyte (with a hollow tick at the baseline).
    gaps.forEach(function (gd) {
      var gx = s.X(gd).toFixed(1);
      out += '<line class="gap-line" x1="' + gx + '" y1="' + box.t + '" x2="' + gx + '" y2="' + (box.t + box.h) + '"/>';
      out += '<circle class="gap-pt" cx="' + gx + '" cy="' + (box.t + box.h) + '" r="2.5"/>';
    });
    // owner events (meds/diet/symptoms): a marked vertical line with a top flag
    patientEventMarks().forEach(function (m) {
      if (m.ms < s.xmin || m.ms > s.xmax) return;
      var ex = s.X(m.ms).toFixed(1);
      out += '<line class="event-line" x1="' + ex + '" y1="' + box.t + '" x2="' + ex + '" y2="' + (box.t + box.h) + '"><title>' + escapeHtml(m.label) + "</title></line>";
      out += '<circle class="event-pt" cx="' + ex + '" cy="' + box.t + '" r="3"><title>' + escapeHtml(m.label) + "</title></circle>";
    });
    // when meaningfully stale, label the latest report so the trailing gap reads
    if (ctx && ctx.staleFlag && ctx.latestMs > lastMs) {
      out += '<text class="axis-label gap-label" x="' + s.X(ctx.latestMs).toFixed(1) + '" y="' + (box.t - 5) +
        '" text-anchor="end">latest report · not tested</text>';
    }

    // x labels — thinned so clustered dates don't overlap. Anchor on the most
    // recent point (walk right-to-left) so the latest date always reads clean.
    var label = {}, prevX = 1e9;
    for (var k = pts.length - 1; k >= 0; k--) {
      var lx = s.X(ms(pts[k].date));
      if (prevX - lx >= 60 || k === pts.length - 1) { label[k] = true; prevX = lx; }
    }
    pts.forEach(function (p, i) {
      if (!label[i]) return;
      var anchor = i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle";
      var vx = s.X(ms(p.date)).toFixed(1);
      // subtle vertical gridline so each labelled date traces up to its points
      out += '<line class="grid-line vgrid" x1="' + vx + '" y1="' + box.t + '" x2="' + vx + '" y2="' + (box.t + box.h) + '"/>';
      out += '<text class="axis-label" x="' + vx + '" y="' + (box.t + box.h + 16) +
        '" text-anchor="' + anchor + '">' + fmtDateShort(p.date) + "</text>";
    });
    if (ctx && ctx.staleFlag && ctx.latestMs > lastMs) {
      out += '<text class="axis-label gap-label" x="' + s.X(ctx.latestMs).toFixed(1) + '" y="' + (box.t + box.h + 16) +
        '" text-anchor="end">' + fmtDateShort(ctx.latestDate) + "</text>";
    }

    if (pts.length > 1) {
      var d = pts.map(function (p, i) {
        return (i ? "L" : "M") + s.X(ms(p.date)).toFixed(1) + " " + s.Y(p.value).toFixed(1);
      }).join(" ");
      out += '<path class="series-line" d="' + d + '"/>';
    }
    pts.forEach(function (p) {
      out += '<circle class="pt ' + flagOf(p) + '" data-date="' + p.date + '" data-v="' + p.value +
        '" cx="' + s.X(ms(p.date)).toFixed(1) + '" cy="' + s.Y(p.value).toFixed(1) + '" r="3.5"/>';
    });
    return out + "</svg>";
  }

  function niceTicks(min, max, count) {
    var span = max - min;
    if (span <= 0) return [min];
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = (count * step) / span;
    if (err <= 0.15) step *= 10; else if (err <= 0.35) step *= 5; else if (err <= 0.75) step *= 2;
    var ticks = [];
    var start = Math.ceil(min / step) * step;
    for (var v = start; v <= max + step * 0.5; v += step) ticks.push(Math.round(v / step) * step);
    return ticks;
  }

  // ---- data access --------------------------------------------------------

  function currentPatient() {
    return DATA.patients.find(function (p) { return p.id === state.patientId; }) || DATA.patients[0];
  }
  function seriesFor(analyteId) {
    var byPatient = DATA.series[String(state.patientId)] || {};
    return byPatient[String(analyteId)] || [];
  }
  function patientAnalytes() {
    return DATA.analytes.filter(function (a) { return a.patient_ids.indexOf(state.patientId) >= 0; });
  }
  function lastNumeric(a) {
    var n = numericSeries(seriesFor(a.id));
    return n.length ? n[n.length - 1] : null;
  }

  // Which of the patient's reports did/didn't include this analyte. Used to draw
  // gaps on charts and to flag a metric whose latest value predates the most
  // recent report (i.e. it wasn't re-checked and may be outdated).
  function reportContext(analyteId) {
    var reports = DATA.reports.filter(function (r) { return r.patient_id === state.patientId; })
      .slice().sort(function (a, b) { return a.date.localeCompare(b.date) || a.id - b.id; });
    var present = {};
    var measured = [];
    seriesFor(analyteId).forEach(function (p) { present[p.report_id] = true; measured.push(p.date); });
    measured.sort();
    var lastMeasured = measured.length ? measured[measured.length - 1] : null;
    var missing = reports.filter(function (r) { return !present[r.id]; });
    var latest = reports[reports.length - 1];
    // how many reports are newer than the last time this analyte was measured
    var newerCount = lastMeasured ? reports.filter(function (r) { return r.date > lastMeasured; }).length : 0;
    return {
      reports: reports,
      missingDates: missing.map(function (r) { return ms(r.date); }),
      latestDate: latest ? latest.date : null,
      latestMs: latest ? ms(latest.date) : null,
      lastMeasured: lastMeasured,
      newerCount: newerCount,
      // chart gaps always show; the prominent "stale" flag (card tag, detail note,
      // chart trailing label) fires only when the value is meaningfully behind —
      // ≥2 newer reports skipped it, so it's not just a one-off partial recheck.
      stale: latest ? !present[latest.id] : false,
      staleFlag: newerCount >= 2
    };
  }

  // ---- knowledge base access ----------------------------------------------
  // Rebuilt on every render so a live import refresh stays consistent.
  var analyteByKey = {};
  function buildIndexes() {
    analyteByKey = {};
    DATA.analytes.forEach(function (a) { analyteByKey[a.section + " / " + a.name] = a; });
  }
  function KB() { return DATA.knowledge || {}; }
  function aKey(a) { return a.section + " / " + a.name; }
  function kbAnalyte(a) { return (KB().analytes || {})[aKey(a)]; }
  function kbSource(id) { return (KB().sources || {})[id]; }
  function relatedEdges(key) {
    return (KB().relationships || []).filter(function (e) {
      return e.between && e.between.indexOf(key) >= 0;
    }).map(function (e) {
      var other = e.between[0] === key ? e.between[1] : e.between[0];
      return { key: other, reason: e.reason, source: e.source };
    });
  }
  // Pick the life stage for an age (stage with the greatest min_years ≤ age).
  function lifeStageFor(ageYears) {
    if (ageYears == null) return null;
    var stages = KB().life_stages || [];
    var best = null;
    stages.forEach(function (s) {
      if (ageYears >= (s.min_years || 0)) best = s;
    });
    return best;
  }
  function conditionBySlug(slug) {
    return (KB().conditions || []).find(function (c) { return c.slug === slug; });
  }

  // Pick the staging band a value falls in (band with the greatest min ≤ v).
  function stageFor(v, bands) {
    if (v == null) return null;
    var best = null;
    bands.forEach(function (b) {
      var lo = b.min != null ? b.min : -Infinity;
      if (v >= lo) best = b;
    });
    return best;
  }

  // ---- trends view --------------------------------------------------------

  // Age-aware vigilance banner: the patient's current life stage and the
  // conditions worth watching for at that age (linking to the condition panels).
  function lifeStageBanner() {
    var p = currentPatient();
    var stage = lifeStageFor(p.age_years);
    if (!stage) return null;

    var watch = stage.watch || [];
    var conditionItems = watch.filter(function (w) { return w.condition; });
    var chip = function (w) {
      var c = conditionBySlug(w.condition);
      return '<span class="ls-chip" data-cond="' + w.condition + '" title="' + escapeHtml(w.note || "") + '">' +
        escapeHtml(c ? c.name : w.condition) + "</span>";
    };
    // Split by whether the condition is screenable from the IDEXX report itself.
    var screenable = conditionItems.filter(function (w) { var c = conditionBySlug(w.condition); return c && c.screenable; });
    var clinical = conditionItems.filter(function (w) { var c = conditionBySlug(w.condition); return c && !c.screenable; });
    var textItems = watch.filter(function (w) { return !w.condition && w.text; })
      .map(function (w) { return escapeHtml(w.text); }).join(" ");
    var srcLinks = (stage.sources || []).map(function (id) {
      var s = kbSource(id);
      return s ? '<a class="src-link" href="' + s.url + '" target="_blank" rel="noopener">' + escapeHtml(s.name) + "</a>" : "";
    }).filter(Boolean).join(" · ");

    // Compact hook shown when collapsed: the headline conditions to screen for.
    var hookNames = screenable.map(function (w) { var c = conditionBySlug(w.condition); return c ? c.name : w.condition; });
    var hook = hookNames.length
      ? "Screen for " + escapeHtml(hookNames.slice(0, 3).join(", ")) + (hookNames.length > 3 ? " +" + (hookNames.length - 3) : "")
      : escapeHtml((stage.summary || "").split(". ")[0]);

    var box = el("div", "lifestage" + (state.lsCollapsed ? " collapsed" : ""));
    box.innerHTML =
      '<button class="ls-head" type="button" aria-expanded="' + (state.lsCollapsed ? "false" : "true") + '">' +
        '<span class="ls-icon">' + stageIcon(stage.slug) + "</span>" +
        '<div class="ls-titlewrap"><div class="ls-title">' + escapeHtml(stage.name) + " cat · " +
          escapeHtml(p.age_text || (p.age_years + " yr")) + "</div>" +
          '<div class="ls-hook">' + hook + "</div>" +
          '<div class="ls-sub">' + escapeHtml(stage.summary || "") + "</div></div>" +
        '<span class="ls-toggle"><span class="ls-toggle-lbl"></span><span class="ls-chev" aria-hidden="true">▾</span></span>' +
      "</button>" +
      '<div class="ls-body">' +
        (screenable.length ? '<div class="ls-watch"><span class="ls-lbl">Screen for with the labs</span><div class="ls-chips">' + screenable.map(chip).join("") + "</div></div>" : "") +
        (clinical.length ? '<div class="ls-watch"><span class="ls-lbl">Watch clinically (not on bloodwork)</span><div class="ls-chips">' + clinical.map(chip).join("") + "</div></div>" : "") +
        (textItems ? '<div class="ls-text">' + textItems + "</div>" : "") +
        (stage.screening ? '<div class="ls-screen"><b>Screening:</b> ' + escapeHtml(stage.screening) + "</div>" : "") +
        '<div class="ls-foot"><span class="src">' + srcLinks + '</span><span class="note">Educational vigilance, not a diagnosis or prediction.</span></div>' +
      "</div>";

    box.querySelector(".ls-head").addEventListener("click", function () {
      state.lsCollapsed = !state.lsCollapsed;
      try { localStorage.setItem("pethud-ls", state.lsCollapsed ? "closed" : "open"); } catch (e) { /* private mode */ }
      box.classList.toggle("collapsed", state.lsCollapsed);
      box.querySelector(".ls-head").setAttribute("aria-expanded", String(!state.lsCollapsed));
    });
    box.querySelectorAll(".ls-chip[data-cond]").forEach(function (ch) {
      ch.addEventListener("click", function () { goToCondition(ch.getAttribute("data-cond")); });
    });
    return box;
  }

  function stageIcon(slug) {
    // small inline glyphs; purely decorative
    return { kitten: "🐱", "young-adult": "🐈", "mature-adult": "🐈", senior: "🐈‍⬛" }[slug] || "🐾";
  }

  function goToCondition(slug) {
    state.view = "conditions";
    state.conditionSlug = slug;
    Array.prototype.forEach.call($("#view-toggle").children, function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === "conditions");
    });
    renderAll();
  }

  function renderTrends() {
    var host = $("#trends");
    host.innerHTML = "";
    var banner = lifeStageBanner();
    if (banner) host.appendChild(banner);
    var wc = weightCard();
    if (wc) host.appendChild(wc);
    var analytes = patientAnalytes();
    var q = state.search.toLowerCase();

    var bySection = {};
    analytes.forEach(function (a) {
      if (state.hiddenSections[a.section]) return;
      if (q && a.name.toLowerCase().indexOf(q) < 0) return;
      var pts = seriesFor(a.id);
      var num = numericSeries(pts);
      var hasFlag = num.some(function (p) { return flagOf(p) !== "ok"; });
      if (state.abnormalOnly && !hasFlag) return;
      (bySection[a.section] || (bySection[a.section] = [])).push({ a: a, pts: pts, num: num });
    });

    var sections = Object.keys(bySection).sort(function (x, y) {
      return SECTION_ORDER.indexOf(x) - SECTION_ORDER.indexOf(y);
    });

    if (sections.length === 0) {
      host.appendChild(el("div", "empty", "No analytes match the current filters."));
      return;
    }

    sections.forEach(function (sec) {
      var color = SECTION_COLOR[sec] || "#8b949e";
      var block = el("div", "section-block");
      var head = el("div", "section-head");
      head.innerHTML = '<span class="bar" style="background:' + color + '"></span>' +
        "<h2>" + sec + '</h2><span class="n">' + bySection[sec].length + "</span>";
      block.appendChild(head);
      var grid = el("div", "grid");
      bySection[sec].forEach(function (item) { grid.appendChild(card(item)); });
      block.appendChild(grid);
      host.appendChild(block);
    });

    host.appendChild(trendsLegend());
  }

  // Key explaining the sparkline glyphs (the dashed "gap" line especially isn't
  // self-evident). Swatches reuse the real chart classes so they always match.
  function trendsLegend() {
    var box = function (vb, inner) { return '<svg class="lg-swatch" viewBox="0 0 ' + vb + '">' + inner + "</svg>"; };
    var item = function (svg, label) { return '<span class="lg-item">' + svg + "<span>" + label + "</span></span>"; };
    var dot = function (cls) { return box("14 14", '<circle class="pt ' + cls + '" cx="7" cy="7" r="3.5"/>'); };
    var bandTrend = box("26 14", '<rect class="ref-band" x="0" y="3" width="26" height="8"/>' +
      '<path class="series-line" d="M0 9 L9 6 L17 7 L26 5"/>');
    var gap = box("14 16", '<line class="gap-line" x1="7" y1="1" x2="7" y2="15"/><circle class="gap-pt" cx="7" cy="14" r="2"/>');
    var lg = el("div", "trends-legend");
    lg.innerHTML = '<span class="lg-title">Chart key</span>' +
      item(bandTrend, "Reference range &amp; trend") +
      item(dot("ok"), "In range") +
      item(dot("H"), "Above range") +
      item(dot("L"), "Below range") +
      item(gap, "Report had no result for this test");
    return lg;
  }

  // The unit is redundant when the analyte name already carries it (e.g.
  // "% Neutrophils" with unit "%") — then we omit it.
  function unitRedundant(name, unit) {
    if (!unit) return true;
    var n = String(name || "").toLowerCase().replace(/\s+/g, "");
    return n.indexOf(String(unit).toLowerCase().replace(/\s+/g, "")) >= 0;
  }
  // Inline unit chip shown right after the name (frees the top-right for the
  // info icon), or "" when redundant/absent.
  function unitChip(a) {
    return unitRedundant(a.name, a.unit) ? "" : '<span class="card-unit">' + escapeHtml(a.unit) + "</span>";
  }

  function card(item) {
    var a = item.a, num = item.num;
    var c = el("div", "card");
    c.setAttribute("data-analyte", a.id);
    var ctx = reportContext(a.id);
    if (ctx.staleFlag) c.classList.add("stale");

    // footer right cell: point/obs count + date, or a stale "not re-checked" tag
    var footMeta = function (countText, lastDate) {
      if (ctx.staleFlag && lastDate) {
        var title = "Last measured " + fmtDate(lastDate) + "; the most recent report (" +
          fmtDate(ctx.latestDate) + ") did not include this test";
        return '<span class="stale-tag" title="' + title + '">&#8635; last ' + fmtDate(lastDate) + "</span>";
      }
      return "<span>" + countText + "</span>";
    };

    if (a.numeric && num.length) {
      var last = num[num.length - 1];
      var fl = flagOf(last);
      c.classList.add("flag-" + (fl === "ok" ? "ok" : fl));
      var prev = num.length > 1 ? num[num.length - 2] : null;
      var deltaHtml = "";
      if (prev) {
        var dv = last.value - prev.value;
        var dir = dv > 0 ? "up" : dv < 0 ? "down" : "flat";
        var arrow = dv > 0 ? "▲" : dv < 0 ? "▼" : "▬";
        deltaHtml = '<span class="delta ' + dir + '">' + arrow + " " + fmtNum(Math.abs(dv)) + "</span>";
      }
      var ref = latestRef(num);
      var refTxt = (ref.low != null && ref.high != null) ? (fmtNum(ref.low) + "–" + fmtNum(ref.high)) : "—";
      c.innerHTML =
        '<div class="card-top"><span class="card-name">' + a.name + "</span>" + unitChip(a) + "</div>" +
        '<div class="card-value"><span class="v ' + fl + '">' + fmtNum(last.value) + "</span>" + deltaHtml + "</div>" +
        sparkline(num, ctx) +
        '<div class="card-foot"><span>' + refTxt + "</span>" + footMeta(num.length + " pts · " + fmtDate(last.date), last.date) + "</div>";
    } else {
      // qualitative: chart ordinal scales (direction matters), otherwise show a
      // run-length "change timeline" so stable values don't repeat as noise.
      var qs = qualSeries(item.pts);
      var lastq = qs.length ? qs[qs.length - 1] : null;
      c.classList.add("flag-ok");
      var nDistinct = Object.keys(qs.reduce(function (m, p) { m[qualKey(p.result_text)] = 1; return m; }, {})).length;
      var mid;
      var ord = nDistinct > 1 ? ordinalScaleFor(qs) : null;
      if (ord) {
        var ranks = ord.pts.map(function (p) { return p.value; });
        if (Math.max.apply(null, ranks) === Math.min.apply(null, ranks)) ord = null; // flat → no chart
      }
      if (ord) {
        mid = qualSpark(ord.pts, ctx, ord.levels);
      } else if (nDistinct <= 1) {
        // every reading identical: the big value already says it, so don't
        // repeat it as a chip — just note the consistency.
        mid = qs.length > 1
          ? '<div class="qual-note">Unchanged · ' + qs.length + " reports</div>"
          : "";
      } else {
        var rs = qualRuns(qs), MAXR = 7, trimmed = rs.length > MAXR;
        var chips = rs.slice(-MAXR).map(function (run, idx) {
          var span = run.from === run.to ? fmtDate(run.to) : fmtDate(run.from) + " – " + fmtDate(run.to);
          var x = run.n > 1 ? ' <span class="x">×' + run.n + "</span>" : "";
          return (idx ? '<span class="qual-sep">›</span>' : "") +
            '<span class="b" title="' + span + '">' + escapeHtml(qualDisplay(run.text)) + x + "</span>";
        }).join("");
        mid = '<div class="qual-badges">' + (trimmed ? '<span class="qual-sep">…</span>' : "") + chips + "</div>";
      }
      c.innerHTML =
        '<div class="card-top"><span class="card-name">' + a.name + "</span></div>" +
        '<div class="card-value"><span class="v ok" style="font-size:14px">' +
          (lastq ? escapeHtml(qualDisplay(lastq.result_text)) : "—") + "</span></div>" +
        mid +
        '<div class="card-foot"><span></span>' + footMeta(qs.length + " obs", lastq ? lastq.date : null) + "</div>";
    }

    if (kbAnalyte(a)) c.appendChild(el("span", "kbadge", "&#9432;")); // ⓘ: sourced context available
    c.addEventListener("click", function () { openDetail(a.id); });
    return c;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  // ---- detail overlay -----------------------------------------------------

  function openDetail(analyteId) {
    var a = DATA.analytes.find(function (x) { return x.id === analyteId; });
    if (!a) return;
    state.openAnalyte = analyteId; // track for arrow-key cycling + deep-link reopen
    var pts = seriesFor(analyteId);
    var body = $("#detail-body");
    var color = SECTION_COLOR[a.section] || "#8b949e";

    var head = '<div class="detail-head"><span class="bar" style="display:inline-block;width:4px;height:18px;background:' +
      color + ';border-radius:2px"></span><h2>' + a.name + '</h2><span class="sec">' + a.section +
      (a.unit ? " · " + a.unit : "") + "</span>" +
      '<span class="detail-nav-hint" title="Use ← / → to browse analytes">←&nbsp;→ browse</span></div>';

    var num = numericSeries(pts);
    var ctx = reportContext(analyteId);
    var staleNote = "";
    if (ctx.staleFlag && (num.length || qualSeries(pts).length)) {
      var lastDate = num.length ? num[num.length - 1].date : qualSeries(pts).slice(-1)[0].date;
      staleNote = '<div class="stale-note"><span class="ic">&#8635;</span><span>Last measured <b>' +
        fmtDate(lastDate) + "</b> — the " + ctx.newerCount + " most recent report(s) didn't include this test (latest: " +
        fmtDate(ctx.latestDate) + "). Treat the latest point as historical and recheck if it matters.</span></div>";
    }

    var chartHtml, sub;
    if (a.numeric && num.length) {
      var ref = latestRef(num);
      var vals = num.map(function (p) { return p.value; });
      sub = '<div class="detail-sub">' + num.length + " points · range " +
        fmtNum(Math.min.apply(null, vals)) + "–" + fmtNum(Math.max.apply(null, vals)) +
        (ref.low != null ? " · reference " + fmtNum(ref.low) + "–" + fmtNum(ref.high) : "") + "</div>";
      chartHtml = bigChart(num, ctx);
    } else {
      sub = '<div class="detail-sub">qualitative observations</div>';
      chartHtml = "";
    }

    body.innerHTML = head + sub + staleNote + contextPanel(a, num) + chartHtml + detailTable(pts, a);
    $("#detail").hidden = false;

    // related-metric chips navigate to that metric's detail
    body.querySelectorAll(".chip[data-go]").forEach(function (ch) {
      ch.addEventListener("click", function () { openDetail(+ch.getAttribute("data-go")); });
    });

    if (a.numeric && num.length) attachHover(body.querySelector("svg.bigchart"), num, a);
  }

  // Sourced clinical context shown above the chart. Conservative + cited; the
  // "interpret in isolation" caveat is highlighted whenever the latest value is
  // out of range, because that's exactly when over-reading one number is a risk.
  function contextPanel(a, num) {
    var k = kbAnalyte(a);
    var latest = num && num.length ? num[num.length - 1] : null;
    var fl = latest ? flagOf(latest) : "ok";
    var html = "";

    if (k) {
      html += '<div class="context">';
      if (k.summary) html += "<p>" + escapeHtml(k.summary) + "</p>";
      var meaning = fl === "H" ? k.high : fl === "L" ? k.low : null;
      if (meaning) {
        html += '<p class="meaning"><b>' + (fl === "H" ? "Elevated" : "Low") + ":</b> " + escapeHtml(meaning) + "</p>";
      }
      if (k.isolation) {
        if (fl !== "ok") {
          html += '<div class="isolation"><span class="ic">⚠</span><span class="tx"><b>Read in context.</b> ' +
            escapeHtml(k.isolation) + "</span></div>";
        } else {
          html += '<p class="meaning" style="font-size:12px">' + escapeHtml(k.isolation) + "</p>";
        }
      }
      html += "</div>";
    }

    // How this value moves and how fast — confounders + monitoring cadence.
    if (k && k.dynamics) {
      var d = k.dynamics;
      html += '<div class="dynamics">';
      if (d.confounders) html += '<div class="dyn"><span class="dyn-lbl">What moves this value</span><p>' + escapeHtml(d.confounders) + "</p></div>";
      if (d.monitoring) html += '<div class="dyn"><span class="dyn-lbl">Pace &amp; monitoring</span><p>' + escapeHtml(d.monitoring) + "</p></div>";
      html += "</div>";
    }

    var rel = relatedEdges(aKey(a)).filter(function (r) {
      var o = analyteByKey[r.key];
      return o && o.patient_ids.indexOf(state.patientId) >= 0;
    });
    if (rel.length) {
      html += '<div class="related"><div class="lbl">Related metrics — read together</div><div class="chips">';
      rel.forEach(function (r) {
        var o = analyteByKey[r.key];
        var col = SECTION_COLOR[o.section] || "#8b949e";
        var op = lastNumeric(o);
        var ofl = op ? flagOf(op) : "ok";
        html += '<span class="chip flag-' + ofl + '" data-go="' + o.id + '" title="' + escapeHtml(r.reason) + '">' +
          '<span class="cdot" style="background:' + col + '"></span>' + escapeHtml(o.name) + "</span>";
      });
      html += "</div></div>";
    }

    // Global primer on why one value (or one dip) is often not meaningful.
    var interp = KB().interpretation;
    if (k && interp) {
      html += '<details class="primer"><summary>' + escapeHtml(interp.title || "Reading changes over time") + "</summary>" +
        "<p>" + escapeHtml(interp.text) + "</p>" +
        (interp.sources ? sourcesRow(interp.sources, "Sources") : "") + "</details>";
    }

    if (k) {
      // citations behind both the context and the dynamics, de-duplicated
      var allSrc = (k.sources || []).slice();
      if (k.dynamics && k.dynamics.sources) {
        k.dynamics.sources.forEach(function (s) { if (allSrc.indexOf(s) < 0) allSrc.push(s); });
      }
      if (allSrc.length) html += sourcesRow(allSrc, "Learn more");
    }
    // Only show the disclaimer when there's actual medical context above it,
    // so metrics without context don't get an orphan notice before the chart.
    if (k && KB().disclaimer) html += '<div class="disclaimer">' + escapeHtml(KB().disclaimer) + "</div>";
    return html;
  }

  function sourcesRow(ids, label) {
    var links = ids.map(function (id) {
      var s = kbSource(id);
      if (!s) return "";
      return '<a class="src-link" href="' + s.url + '" target="_blank" rel="noopener">' +
        escapeHtml(s.name) + '<span class="tier">' + escapeHtml(s.tier || "") + "</span></a>";
    }).join("");
    return '<div class="sources-row"><div class="lbl">' + (label || "Sources") + '</div><div class="links">' + links + "</div></div>";
  }

  function detailTable(pts, a) {
    var rows = pts.slice().sort(function (x, y) {
      return y.date.localeCompare(x.date) || y.report_id - x.report_id;
    });
    var seen = {};
    var html = '<table class="detail-table"><thead><tr><th>Date</th><th>Result</th><th>Reference</th><th>Flag</th></tr></thead><tbody>';
    rows.forEach(function (p) {
      if (seen[p.date]) return; // one row per date
      seen[p.date] = true;
      var fl = flagOf(p);
      var ref = (p.ref_low != null && p.ref_high != null) ? fmtNum(p.ref_low) + "–" + fmtNum(p.ref_high) : (p.ref_low != null || p.ref_high != null ? "" : "");
      var val = p.value != null ? (p.qualifier ? p.qualifier + " " : "") + fmtNum(p.value) : escapeHtml(qualDisplay(p.result_text));
      var flBadge = fl === "ok" ? "" : '<span class="pill ' + fl + '">' + fl + "</span>";
      html += '<tr class="' + fl + '"><td class="dt">' + fmtDate(p.date) + '</td><td class="value">' + val +
        (p.unit ? " " + p.unit : "") + '</td><td>' + ref + "</td><td>" + flBadge + "</td></tr>";
    });
    return html + "</tbody></table>";
  }

  // Hover crosshair + tooltip on the detail chart.
  function attachHover(svg, num, a) {
    if (!svg) return;
    var tip = el("div", "tooltip");
    tip.style.display = "none";
    document.body.appendChild(tip);
    var circles = Array.prototype.slice.call(svg.querySelectorAll("circle.pt"));

    function move(ev) {
      var rect = svg.getBoundingClientRect();
      var sx = (ev.clientX - rect.left) / rect.width * 820; // viewBox space
      var best = null, bd = Infinity;
      circles.forEach(function (c) {
        var cx = +c.getAttribute("cx");
        var d = Math.abs(cx - sx);
        if (d < bd) { bd = d; best = c; }
      });
      if (!best) return;
      circles.forEach(function (c) { c.setAttribute("r", c === best ? 5 : 3.5); });
      var date = best.getAttribute("data-date");
      var p = num.find(function (q) { return q.date === date; });
      tip.innerHTML = fmtDate(date) + " &nbsp; <b>" + fmtNum(p.value) + (a.unit ? " " + a.unit : "") + "</b>" +
        (flagOf(p) !== "ok" ? ' <span style="color:var(--' + (flagOf(p) === "H" ? "high" : "low") + ')">' + flagOf(p) + "</span>" : "");
      tip.style.display = "block";
      tip.style.left = (ev.clientX + 12) + "px";
      tip.style.top = (ev.clientY - 10) + "px";
    }
    svg.addEventListener("mousemove", move);
    svg.addEventListener("mouseleave", function () {
      tip.style.display = "none";
      circles.forEach(function (c) { c.setAttribute("r", 3.5); });
    });
    // clean up tooltip when overlay closes
    $("#detail").addEventListener("close-detail", function () { tip.remove(); }, { once: true });
  }

  function closeDetail() {
    var d = $("#detail");
    d.dispatchEvent(new Event("close-detail"));
    d.hidden = true;
    $("#detail-body").innerHTML = "";
    state.openAnalyte = null;
  }

  // Analyte ids in the order they appear on the Trends page (same section sort
  // and search/section/abnormal filters), so arrow-key browsing matches what's
  // on screen.
  function visibleAnalyteOrder() {
    var q = state.search.toLowerCase();
    var bySection = {};
    patientAnalytes().forEach(function (a) {
      if (state.hiddenSections[a.section]) return;
      if (q && a.name.toLowerCase().indexOf(q) < 0) return;
      if (state.abnormalOnly) {
        var num = numericSeries(seriesFor(a.id));
        if (!num.some(function (p) { return flagOf(p) !== "ok"; })) return;
      }
      (bySection[a.section] || (bySection[a.section] = [])).push(a.id);
    });
    var ids = [];
    Object.keys(bySection)
      .sort(function (x, y) { return SECTION_ORDER.indexOf(x) - SECTION_ORDER.indexOf(y); })
      .forEach(function (sec) { ids.push.apply(ids, bySection[sec]); });
    return ids;
  }

  // Step to the previous/next analyte's detail (wraps around). Falls back to the
  // full patient analyte order if the current one is filtered out of the view.
  function cycleDetail(dir) {
    if (state.openAnalyte == null) return;
    var order = visibleAnalyteOrder();
    var i = order.indexOf(state.openAnalyte);
    if (i < 0) {
      order = patientAnalytes().map(function (a) { return a.id; });
      i = order.indexOf(state.openAnalyte);
    }
    if (i < 0 || order.length < 2) return;
    openDetail(order[(i + dir + order.length) % order.length]);
  }

  // ---- reports view -------------------------------------------------------

  function monthsAgo(iso) {
    var a = new Date(iso + "T00:00:00"), b = new Date();
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  }

  // Forward-looking, patient-level prompts for the next visit: recheck timing
  // (with the relevant monitoring cadence) + questions drawn from the latest
  // report's condition patterns and any values out of range across visits.
  function vetVisitCard() {
    var reps = DATA.reports.filter(function (r) { return r.patient_id === state.patientId; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
    if (!reps.length) return null;
    var latest = reps[reps.length - 1], prev = reps.length > 1 ? reps[reps.length - 2] : null;
    var flagged = flaggedFor(latest), patterns = conditionPatterns(flagged);
    var smap = DATA.series[String(state.patientId)] || {};
    var persistent = flagged.filter(function (f) {
      if (!prev) return false;
      var p = (smap[String(f.a.id)] || []).find(function (x) { return x.report_id === prev.id; });
      return p && flagOf(p) !== "ok";
    });
    var months = monthsAgo(latest.date);

    var questions = [];
    patterns.forEach(function (h) {
      questions.push('About <span class="rs-cond" data-cond="' + h.slug + '">' + escapeHtml(h.name) + "</span>: " +
        joinNames(h.set, 3) + " are out of range together — ask about a monitoring plan" +
        (h.slug === "chronic-kidney-disease" ? " and IRIS staging" : "") + ".");
    });
    if (persistent.length) {
      questions.push(joinNames(persistent.map(function (f) { return f.a.name; }), 3) + " " +
        (persistent.length > 1 ? "have" : "has") + " stayed out of range across visits — is the trend worth acting on?");
    }
    questions = questions.slice(0, 4);
    if (!questions.length && months < 6) return null; // nothing actionable, recent visit

    var cadence = "";
    if (patterns.length) {
      var m0 = (conditionBySlug(patterns[0].slug).metrics || [])[0];
      var ka = m0 && (KB().analytes || {})[m0.analyte];
      if (ka && ka.dynamics && ka.dynamics.monitoring) cadence = " " + escapeHtml(ka.dynamics.monitoring);
    }
    var timing = "Last report was " + fmtDate(latest.date) + " (" +
      (months <= 0 ? "this month" : months + " month" + (months > 1 ? "s" : "") + " ago") + ").";
    var box = el("div", "vet-visit");
    box.innerHTML =
      '<div class="vv-head">For your next vet visit</div>' +
      '<p class="vv-timing">' + timing + cadence + "</p>" +
      (questions.length ? '<div class="vv-lbl">Questions to consider asking</div><ul class="vv-q">' +
        questions.map(function (q) { return "<li>" + q + "</li>"; }).join("") + "</ul>" : "") +
      '<p class="rs-disclaimer">Conversation starters, not medical advice — your veterinarian decides what to test and when.</p>';
    box.querySelectorAll(".rs-cond[data-cond]").forEach(function (e) {
      e.addEventListener("click", function () { goToCondition(e.getAttribute("data-cond")); });
    });
    return box;
  }

  function renderReports() {
    var host = $("#reports");
    host.innerHTML = "";
    var reports = DATA.reports.filter(function (r) { return r.patient_id === state.patientId; })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });
    if (!reports.length) { host.appendChild(el("div", "empty", "No reports.")); return; }

    var vv = vetVisitCard();
    if (vv) host.appendChild(vv);
    var grid = el("div", "report-grid");
    reports.forEach(function (r) { grid.appendChild(reportCard(r)); });
    host.appendChild(grid);
  }

  // analyte "Section / Name" -> [{slug,name,screenable}] it belongs to, from KB.
  var _condMap = null;
  function analyteConditionsMap() {
    if (_condMap) return _condMap;
    _condMap = {};
    (KB().conditions || []).forEach(function (c) {
      // metric order encodes priority: the first ~2 are the primary screen
      // markers, the rest are supporting/context (idx kept so the summary only
      // names a condition when one of ITS primary markers is actually off).
      (c.metrics || []).forEach(function (m, i) {
        (_condMap[m.analyte] || (_condMap[m.analyte] = [])).push({ slug: c.slug, name: c.name, screenable: c.screenable, idx: i });
      });
    });
    return _condMap;
  }
  function joinNames(arr, n) {
    var u = arr.filter(function (x, i) { return arr.indexOf(x) === i; });
    if (u.length <= n) return u.length <= 1 ? (u[0] || "") : u.slice(0, -1).join(", ") + " and " + u[u.length - 1];
    return u.slice(0, n).join(", ") + " +" + (u.length - n);
  }

  // Out-of-range measurements for one report (sorted by section, then name).
  function flaggedFor(r) {
    var flagged = [], smap = DATA.series[String(state.patientId)] || {};
    DATA.analytes.forEach(function (a) {
      (smap[String(a.id)] || []).forEach(function (p) {
        if (p.report_id !== r.id) return;
        var fl = flagOf(p);
        if (fl !== "ok") flagged.push({ a: a, p: p, fl: fl });
      });
    });
    flagged.sort(function (x, y) {
      return SECTION_ORDER.indexOf(x.a.section) - SECTION_ORDER.indexOf(y.a.section) || x.a.name.localeCompare(y.a.name);
    });
    return flagged;
  }

  // Conditions whose multi-marker pattern is suggested by a flagged set: a
  // condition's primary marker (first ~2 metrics) must be off, ≥2 of its metrics
  // flagged, and its markers not a subset of a wider kept condition.
  function conditionPatterns(flagged) {
    var cm = analyteConditionsMap(), hits = {};
    flagged.forEach(function (f) {
      (cm[f.a.section + " / " + f.a.name] || []).forEach(function (c) {
        var h = hits[c.slug] || (hits[c.slug] = { slug: c.slug, name: c.name, screenable: c.screenable, names: [], primary: false });
        h.names.push(f.a.name);
        if (c.idx <= 1) h.primary = true;
      });
    });
    var uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); };
    var candidates = Object.keys(hits).map(function (s) { return hits[s]; })
      .filter(function (h) { return uniq(h.names).length >= 2 && h.primary; })
      .sort(function (a, b) { return (b.screenable === a.screenable ? 0 : b.screenable ? 1 : -1) || (uniq(b.names).length - uniq(a.names).length); });
    var patterns = [];
    candidates.forEach(function (h) {
      h.set = uniq(h.names);
      var subsumed = patterns.some(function (k) { return h.set.every(function (n) { return k.set.indexOf(n) >= 0; }); });
      if (!subsumed) patterns.push(h);
    });
    return patterns.slice(0, 2);
  }

  // Plain-language synthesis for one report: how many values are off, what
  // changed since last visit, and which multi-marker patterns are worth raising.
  function reportSummary(r, flagged) {
    var pid = String(state.patientId), smap = DATA.series[pid] || {};
    var total = 0;
    DATA.analytes.forEach(function (a) {
      (smap[String(a.id)] || []).forEach(function (p) { if (p.report_id === r.id && p.numeric && p.value != null) total++; });
    });
    var reps = DATA.reports.filter(function (x) { return x.patient_id === state.patientId; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
    var idx = -1; reps.forEach(function (x, i) { if (x.id === r.id) idx = i; });
    var prev = idx > 0 ? reps[idx - 1] : null;
    var pt = function (aid, repId) { return (smap[String(aid)] || []).find(function (p) { return p.report_id === repId; }) || null; };

    var newly = [], persistent = [], improved = [];
    flagged.forEach(function (f) {
      var pp = prev ? pt(f.a.id, prev.id) : null;
      if (pp && flagOf(pp) !== "ok") persistent.push(f.a.name); else if (prev) newly.push(f.a.name);
    });
    if (prev) DATA.analytes.forEach(function (a) {
      var pp = pt(a.id, prev.id), cur = pt(a.id, r.id);
      if (pp && cur && flagOf(pp) !== "ok" && flagOf(cur) === "ok") improved.push(a.name);
    });

    var patterns = conditionPatterns(flagged);

    var out = '<div class="report-summary">';
    out += total === 0
      ? '<p class="rs-head">No numeric values in this report.</p>'
      : (flagged.length === 0
        ? '<p class="rs-head"><b>All ' + total + ' values within range.</b></p>'
        : '<p class="rs-head"><b>' + flagged.length + " of " + total + " values</b> outside the reference range.</p>");
    if (prev) {
      var parts = [];
      if (newly.length) parts.push(newly.length + " newly out of range (" + joinNames(newly, 3) + ")");
      if (persistent.length) parts.push(persistent.length + " still out from last visit");
      if (improved.length) parts.push(improved.length + " back in range (" + joinNames(improved, 3) + ")");
      if (parts.length) out += '<p class="rs-change">vs ' + fmtDate(prev.date) + ": " + parts.join("; ") + ".</p>";
    }
    patterns.forEach(function (h) {
      out += '<p class="rs-pattern">' + joinNames(h.names, 3) + " out of range together — a pattern that can relate to " +
        '<span class="rs-cond" data-cond="' + h.slug + '">' + escapeHtml(h.name) + "</span>" +
        (h.screenable ? ", which this bloodwork helps screen for" : "") + ". Worth raising with your vet.</p>";
    });
    if (flagged.length === 1) {
      out += '<p class="rs-note">A single, mildly out-of-range value is often not meaningful on its own — a trend across visits matters more than one reading.</p>';
    }
    out += '<p class="rs-disclaimer">Plain-language summary, not a diagnosis — discuss results with your veterinarian.</p>';
    return out + "</div>";
  }

  function reportCard(r) {
    var flagged = flaggedFor(r);
    var c = el("div", "report-card");
    var rows = flagged.map(function (f) {
      var ref = (f.p.ref_low != null) ? fmtNum(f.p.ref_low) + "–" + fmtNum(f.p.ref_high) : "";
      return '<tr class="' + f.fl + '"><td class="name">' + f.a.name + '</td><td class="val">' +
        fmtNum(f.p.value) + '</td><td class="ref">' + ref + '</td><td><span class="pill ' + f.fl + '">' + f.fl + "</span></td></tr>";
    }).join("");

    c.innerHTML =
      '<button class="report-del" title="Delete this report from your browser" aria-label="Delete report">&times;</button>' +
      "<h3>" + fmtDate(r.date) + "</h3>" +
      '<div class="rmeta"><span class="k">clinic</span> ' + escapeHtml(r.clinic_name || "—") +
      ' · <span class="k">age</span> ' + escapeHtml(r.age_text || "—") +
      (r.lab_id ? ' · <span class="k">lab</span> ' + r.lab_id : "") + "</div>" +
      (r.idexx_services ? '<div class="svc">' + escapeHtml(r.idexx_services) + "</div>" : "") +
      reportSummary(r, flagged) +
      (flagged.length
        ? '<div class="section-tag">' + flagged.length + ' out of range</div><table class="flag-table"><tbody>' + rows + "</tbody></table>"
        : '<div class="section-tag" style="color:var(--normal)">all values within range</div>');
    if (r.sha256) {
      c.querySelector(".report-del").addEventListener("click", function () {
        deleteReport(r.sha256, r.source_file || fmtDate(r.date));
      });
    }
    c.querySelectorAll(".rs-cond[data-cond]").forEach(function (el) {
      el.addEventListener("click", function () { goToCondition(el.getAttribute("data-cond")); });
    });
    return c;
  }

  // ---- local data management (browser build) ------------------------------

  function deleteReport(sha, label) {
    if (!window.confirm("Delete the report “" + label + "” from this browser?")) return;
    db.deleteReport(sha).then(rebuildFromDb).then(function () {
      ensurePatient(); renderAll(); toast("Report deleted.", null, 2500);
    });
  }

  function clearAllData() {
    if (!window.confirm("Delete ALL imported reports from this browser? This can't be undone (your original PDF files are untouched).")) return;
    db.clearAll().then(rebuildFromDb).then(function () {
      ensurePatient(); renderAll(); toast("All local data cleared.", null, 3000);
    });
  }

  // Re-parse every stored PDF with the current parser (e.g. after a parser fix),
  // updating the stored report docs in place. Uses the originals retained in
  // IndexedDB, so no re-dropping is needed.
  function reprocessAll() {
    return db.getAllPdfs().then(function (pdfs) {
      if (!pdfs.length) { toast("No stored PDFs to reprocess.", null, 2500); return; }
      toast("Reprocessing " + pdfs.length + " report(s)…", null, 60000);
      var chain = Promise.resolve();
      pdfs.forEach(function (rec) {
        chain = chain.then(function () {
          return rec.blob.arrayBuffer()
            .then(function (buf) { return processPdf(buf, rec.filename); })
            .then(function (res) { return db.putReport({ sha256: res.sha, reportDoc: res.reportDoc, patientSlug: null }); });
        });
      });
      return chain.then(rebuildFromDb).then(function () {
        ensurePatient(); renderAll(); toast("Reprocessed " + pdfs.length + " report(s).", "ok", 3000);
      });
    });
  }

  // ---- pets & aliases manager --------------------------------------------

  // A patient's identifying keys (external ids + given names) for matching.
  function patientMatchData(patient) {
    var ext = new Set(), names = new Set();
    (patient.identities || []).forEach(function (i) {
      if (i.external_id) ext.add(String(i.external_id));
      var gn = givenName(i.pet_name, i.owner);
      if (gn) names.add(gn.toUpperCase());
    });
    return { external_ids: Array.from(ext), names: Array.from(names) };
  }

  function upsertUserRule(slug, mutate) {
    userConfig.patients = userConfig.patients || [];
    var rule = userConfig.patients.find(function (p) { return p.slug === slug; });
    if (!rule) { rule = { slug: slug, match: { names: [], external_ids: [] } }; userConfig.patients.push(rule); }
    rule.match = rule.match || { names: [], external_ids: [] };
    mutate(rule);
  }

  function applyRename(patient, newName) {
    var md = patientMatchData(patient);
    upsertUserRule(patient.slug, function (rule) {
      rule.name = newName;
      rule.species = rule.species || patient.species;
      rule.match.names = unionArr(rule.match.names, md.names);
      rule.match.external_ids = unionArr(rule.match.external_ids, md.external_ids);
    });
    saveUserConfig().then(rebuildAndRerenderPets);
  }

  // Make target's rule also match source's identities, so source's reports move
  // under target (source patient then disappears).
  function applyMerge(source, target) {
    var sm = patientMatchData(source), tm = patientMatchData(target);
    upsertUserRule(target.slug, function (rule) {
      rule.name = rule.name || target.name;
      rule.species = rule.species || target.species;
      rule.match.names = unionArr(unionArr(rule.match.names, tm.names), sm.names);
      rule.match.external_ids = unionArr(unionArr(rule.match.external_ids, tm.external_ids), sm.external_ids);
    });
    saveUserConfig().then(rebuildAndRerenderPets);
  }

  function resetOverrides() {
    if (!window.confirm("Reset all pet renames and merges to the defaults?")) return;
    userConfig = { patients: [] };
    saveUserConfig().then(rebuildAndRerenderPets);
  }

  function rebuildAndRerenderPets() {
    return rebuildFromDb().then(function () { ensurePatient(); renderAll(); renderPetsManager(); });
  }

  function openPetsManager() { $("#pets").hidden = false; renderPetsManager(); }
  function closePetsManager() { $("#pets").hidden = true; }

  // ---- owner journal: weight + events (meds/diet/symptoms) ----------------
  // Stored per patient slug in IndexedDB settings; never leaves the browser.
  function currentJournal() {
    var p = currentPatient(), j = p ? journal[p.slug] : null;
    return { weights: (j && j.weights) || [], events: (j && j.events) || [] };
  }
  function loadJournal() { return db.getSetting("journal").then(function (v) { journal = v || {}; }); }
  function saveJournal() { return db.putSetting("journal", journal); }
  function mutateJournal(fn) {
    var p = currentPatient(); if (!p) return;
    fn(journal[p.slug] || (journal[p.slug] = { weights: [], events: [] }));
    saveJournal().then(function () { renderAll(); renderJournal(); });
  }
  // Event date+label markers for charts (vertical lines).
  function patientEventMarks() {
    return currentJournal().events.map(function (e) { return { ms: ms(e.date), label: e.kind + ": " + e.label }; });
  }

  function openJournal() { $("#journal").hidden = false; renderJournal(); }
  function closeJournal() { $("#journal").hidden = true; }
  function renderJournal() {
    var body = $("#journal-body"); if (!body || $("#journal").hidden) return;
    var p = currentPatient();
    if (!p) { body.innerHTML = '<div class="empty">Add a report first.</div>'; return; }
    var j = currentJournal();
    var weights = j.weights.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
    var events = j.events.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
    var today = new Date().toISOString().slice(0, 10);
    var wList = weights.length ? weights.map(function (w) {
      return '<li><span class="jr-d">' + fmtDate(w.date) + '</span><span class="jr-v">' + fmtNum(w.kg) + " kg</span>" +
        '<button class="jr-del" data-kind="weight" data-date="' + w.date + '" aria-label="Delete">&times;</button></li>';
    }).join("") : '<li class="jr-empty">No weights yet.</li>';
    var eList = events.length ? events.map(function (e) {
      return '<li><span class="jr-d">' + fmtDate(e.date) + '</span><span class="jr-kind ' + e.kind + '">' + e.kind + "</span>" +
        '<span class="jr-label">' + escapeHtml(e.label) + "</span>" +
        '<button class="jr-del" data-kind="event" data-date="' + e.date + '" data-label="' + escapeHtml(e.label) + '" aria-label="Delete">&times;</button></li>';
    }).join("") : '<li class="jr-empty">No events yet.</li>';
    body.innerHTML =
      '<p class="jr-intro">Your own observations for <b>' + escapeHtml(p.name) + "</b>. Weight is charted on its own; events " +
      "(medication, diet, symptoms) appear as markers on every chart so you can see what changed and when. Stored only in this browser.</p>" +
      '<div class="jr-grid"><div class="jr-col"><h4>Weight</h4>' +
        '<form id="jr-weight-form" class="jr-form"><input type="date" id="jrw-date" value="' + today + '" max="' + today + '" required>' +
        '<input type="number" id="jrw-val" step="0.01" min="0" placeholder="weight" required>' +
        '<select id="jrw-unit"><option value="kg">kg</option><option value="lb">lb</option></select>' +
        '<button type="submit" class="jr-add">Add</button></form><ul class="jr-list">' + wList + "</ul></div>" +
      '<div class="jr-col"><h4>Events</h4>' +
        '<form id="jr-event-form" class="jr-form"><input type="date" id="jre-date" value="' + today + '" max="' + today + '" required>' +
        '<select id="jre-kind"><option value="med">Medication</option><option value="diet">Diet</option><option value="symptom">Symptom</option><option value="note">Note</option></select>' +
        '<input type="text" id="jre-label" placeholder="e.g. started methimazole" maxlength="60" required>' +
        '<button type="submit" class="jr-add">Add</button></form><ul class="jr-list">' + eList + "</ul></div></div>";

    $("#jr-weight-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var date = $("#jrw-date").value, val = parseFloat($("#jrw-val").value), unit = $("#jrw-unit").value;
      if (!date || !(val > 0)) return;
      var kg = unit === "lb" ? val * 0.453592 : val;
      mutateJournal(function (jj) { jj.weights = jj.weights.filter(function (w) { return w.date !== date; }); jj.weights.push({ date: date, kg: Math.round(kg * 100) / 100 }); });
    });
    $("#jr-event-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var date = $("#jre-date").value, kind = $("#jre-kind").value, label = $("#jre-label").value.trim();
      if (!date || !label) return;
      mutateJournal(function (jj) { jj.events.push({ date: date, kind: kind, label: label }); });
    });
    body.querySelectorAll(".jr-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var kind = btn.getAttribute("data-kind"), date = btn.getAttribute("data-date"), label = btn.getAttribute("data-label");
        mutateJournal(function (jj) {
          if (kind === "weight") jj.weights = jj.weights.filter(function (w) { return w.date !== date; });
          else jj.events = jj.events.filter(function (e) { return !(e.date === date && e.label === label); });
        });
      });
    });
  }

  // Weight trend as its own card at the top of Trends (from the owner journal).
  function weightCard() {
    var w = currentJournal().weights.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    if (!w.length) return null;
    var pts = w.map(function (p) { return { date: p.date, value: p.kg, numeric: true, ref_low: null, ref_high: null }; });
    var last = pts[pts.length - 1], prev = pts.length > 1 ? pts[pts.length - 2] : null;
    var deltaHtml = "";
    if (prev) {
      var dv = last.value - prev.value, dir = dv > 0 ? "up" : dv < 0 ? "down" : "flat", arrow = dv > 0 ? "▲" : dv < 0 ? "▼" : "▬";
      deltaHtml = '<span class="delta ' + dir + '">' + arrow + " " + fmtNum(Math.abs(dv)) + " kg</span>";
    }
    var c = el("div", "card weight-card flag-ok");
    c.innerHTML =
      '<div class="card-top"><span class="card-name">Weight</span><span class="card-unit">kg · your log</span></div>' +
      '<div class="card-value"><span class="v ok">' + fmtNum(last.value) + "</span>" + deltaHtml + "</div>" +
      sparkline(pts, null) +
      '<div class="card-foot"><span></span><span>' + pts.length + " entr" + (pts.length === 1 ? "y" : "ies") + " · " + fmtDate(last.date) + "</span></div>";
    var wrap = el("div", "section-block");
    var head = el("div", "section-head");
    head.innerHTML = '<span class="bar" style="background:var(--accent)"></span><h2>Your log</h2>';
    wrap.appendChild(head);
    var grid = el("div", "grid"); grid.appendChild(c); wrap.appendChild(grid);
    return wrap;
  }

  function renderPetsManager() {
    var body = $("#pets-body");
    if (!DATA.patients.length) { body.innerHTML = '<div class="empty">No pets yet — import a report first.</div>'; return; }
    var rows = DATA.patients.map(function (p) {
      var others = DATA.patients.filter(function (q) { return q.slug !== p.slug; });
      var mergeOpts = others.map(function (q) { return '<option value="' + q.slug + '">' + escapeHtml(q.name) + "</option>"; }).join("");
      var idsTxt = Array.from(new Set((p.identities || []).map(function (i) {
        return i.pet_name + (i.external_id ? " #" + i.external_id : "");
      }))).map(escapeHtml).join(" · ");
      return '<div class="pet-row" data-slug="' + escapeHtml(p.slug) + '">' +
        '<div class="pet-main"><div><span class="pet-name">' + escapeHtml(p.name) + '</span> ' +
          '<span class="pet-sub">' + p.report_count + " reports · " + escapeHtml(p.species || "") + "</span></div>" +
          '<div class="pet-ids">' + idsTxt + "</div></div>" +
        '<div class="pet-actions"><button class="pet-rename linkbtn">Rename</button>' +
          (others.length ? '<select class="pet-merge"><option value="">Merge into…</option>' + mergeOpts + "</select>" : "") +
        "</div></div>";
    }).join("");
    body.innerHTML = '<p class="pets-intro">Reports are grouped into pets automatically. Rename a pet, or merge one into another if they\'re the same animal. Changes are saved in this browser.</p>' +
      '<div class="pets-list">' + rows + "</div>" +
      '<div class="pets-foot"><button id="pets-reset" class="linkbtn">Reset all customizations</button></div>';

    body.querySelectorAll(".pet-row").forEach(function (row) {
      var patient = DATA.patients.find(function (p) { return p.slug === row.getAttribute("data-slug"); });
      row.querySelector(".pet-rename").addEventListener("click", function () {
        var nn = window.prompt("New name for this pet:", patient.name);
        if (nn && nn.trim() && nn.trim() !== patient.name) applyRename(patient, nn.trim());
      });
      var sel = row.querySelector(".pet-merge");
      if (sel) sel.addEventListener("change", function () {
        if (!sel.value) return;
        var target = DATA.patients.find(function (p) { return p.slug === sel.value; });
        if (window.confirm("Merge “" + patient.name + "” into “" + target.name + "”? Its reports will move under " + target.name + ".")) applyMerge(patient, target);
        else sel.value = "";
      });
    });
    $("#pets-reset").addEventListener("click", resetOverrides);
  }

  // ---- conditions view ----------------------------------------------------

  function renderConditions() {
    var host = $("#conditions");
    host.innerHTML = "";
    var conds = KB().conditions || [];
    if (!conds.length) { host.appendChild(el("div", "empty", "No condition data available.")); return; }
    if (!state.conditionSlug || !conds.some(function (c) { return c.slug === state.conditionSlug; })) {
      state.conditionSlug = conds[0].slug;
    }

    var stage = lifeStageFor(currentPatient().age_years);
    var ageSlugs = stage ? (stage.watch || []).filter(function (w) { return w.condition; })
      .map(function (w) { return w.condition; }) : [];

    var tabs = el("div", "cond-tabs");
    conds.forEach(function (c) {
      var relevant = ageSlugs.indexOf(c.slug) >= 0;
      var dot = relevant ? '<span class="age-dot" title="Worth watching at this cat\'s life stage"></span>' : "";
      var b = el("button", "cond-tab" + (c.slug === state.conditionSlug ? " active" : ""), dot + escapeHtml(c.name));
      b.addEventListener("click", function () { state.conditionSlug = c.slug; renderConditions(); });
      tabs.appendChild(b);
    });
    host.appendChild(tabs);

    var cond = conds.find(function (c) { return c.slug === state.conditionSlug; });
    var head = el("div", "cond-head");
    head.innerHTML = "<h2>" + escapeHtml(cond.name) + '</h2><div class="summary">' + escapeHtml(cond.summary || "") + "</div>";
    host.appendChild(head);

    var panels = el("div", "cond-panels");
    var left = el("div", "");
    if (cond.staging) left.appendChild(stagingBlock(cond));

    var grid = el("div", "grid");
    var shown = 0;
    (cond.metrics || []).forEach(function (m) {
      var a = analyteByKey[m.analyte];
      if (!a || a.patient_ids.indexOf(state.patientId) < 0) return;
      shown++;
      var c = card({ a: a, pts: seriesFor(a.id), num: numericSeries(seriesFor(a.id)) });
      if (m.role) c.appendChild(el("div", "role", escapeHtml(m.role)));
      grid.appendChild(c);
    });
    if (!shown) {
      var hasMetrics = cond.metrics && cond.metrics.length;
      grid.appendChild(el("div", "empty", hasMetrics
        ? "None of this panel's metrics are present for this patient."
        : "This condition isn't assessed by routine bloodwork — see the signs and how it's diagnosed."));
    }
    left.appendChild(grid);
    panels.appendChild(left);

    var side = el("div", "cond-side");
    if (cond.signs && cond.signs.length) {
      var sg = el("div", "sidecard");
      sg.innerHTML = "<h4>Signs to watch at home</h4><ul>" +
        cond.signs.map(function (x) { return "<li>" + escapeHtml(x) + "</li>"; }).join("") + "</ul>";
      side.appendChild(sg);
    }
    if (cond.missing_markers && cond.missing_markers.length) {
      var mc = el("div", "sidecard");
      var mcTitle = (cond.metrics && cond.metrics.length) ? "Not in these reports" : "How it's diagnosed";
      mc.innerHTML = "<h4>" + mcTitle + "</h4><ul>" +
        cond.missing_markers.map(function (x) { return "<li>" + escapeHtml(x) + "</li>"; }).join("") + "</ul>";
      side.appendChild(mc);
    }
    if (cond.sources && cond.sources.length) {
      var sc = el("div", "sidecard");
      sc.innerHTML = "<h4>Learn more</h4>" + cond.sources.map(function (id) {
        var s = kbSource(id);
        return s ? '<a class="src-link" href="' + s.url + '" target="_blank" rel="noopener">' + escapeHtml(s.name) + "</a>" : "";
      }).join("");
      side.appendChild(sc);
    }
    var dc = el("div", "sidecard");
    dc.innerHTML = '<div class="note-text">' + escapeHtml(KB().disclaimer || "") + "</div>";
    side.appendChild(dc);
    panels.appendChild(side);
    host.appendChild(panels);
  }

  // IRIS staging orientation strip for the CKD panel (creatinine + SDMA).
  function stagingBlock(cond) {
    var st = cond.staging;
    var box = el("div", "sidecard staging-card");
    var html = '<h4>IRIS staging orientation</h4><div class="staging">';
    [["creatinine", "Chemistry / Creatinine", "Creat"], ["sdma", "Chemistry / IDEXX SDMA", "SDMA"]].forEach(function (row) {
      var spec = st[row[0]];
      if (!spec) return;
      var a = analyteByKey[row[1]];
      var latest = a ? lastNumeric(a) : null;
      var here = latest ? stageFor(latest.value, spec.bands) : null;
      html += '<div class="srow"><span class="name">' + row[2] + '</span><div class="stage-bar">';
      spec.bands.forEach(function (b) {
        var on = here && here.stage === b.stage;
        html += '<div class="stage-seg' + (on ? " here" : "") + '" title="Stage ' + b.stage + (b.label ? " — " + b.label : "") + '">' + b.stage + "</div>";
      });
      html += "</div></div>";
      if (latest) {
        html += '<div class="note latest">Latest ' + fmtNum(latest.value) + " " + spec.unit +
          (here ? " → Stage " + here.stage + (here.label ? " (" + here.label + ")" : "") : "") + "</div>";
      }
    });
    html += '<div class="note">' + escapeHtml(st.note || "") + "</div></div>";
    box.innerHTML = html;
    return box;
  }

  // ---- sidebar / chrome ---------------------------------------------------

  function renderSidebar() {
    var ul = $("#section-filter");
    ul.innerHTML = "";
    var counts = {};
    patientAnalytes().forEach(function (a) { counts[a.section] = (counts[a.section] || 0) + 1; });
    Object.keys(counts).sort(function (x, y) {
      return SECTION_ORDER.indexOf(x) - SECTION_ORDER.indexOf(y);
    }).forEach(function (sec) {
      var li = el("li", state.hiddenSections[sec] ? "off" : "on");
      var color = SECTION_COLOR[sec] || "#8b949e";
      li.innerHTML = '<span class="label"><span class="dot" style="background:' + color + '"></span>' + sec +
        '</span><span class="count">' + counts[sec] + "</span>";
      li.addEventListener("click", function () {
        state.hiddenSections[sec] = !state.hiddenSections[sec];
        renderSidebar(); renderTrends();
      });
      ul.appendChild(li);
    });

    // Bulk show/hide: one button that flips every visible section at once.
    var sections = Object.keys(counts);
    var allVisible = sections.every(function (sec) { return !state.hiddenSections[sec]; });
    var tBtn = $("#toggle-sections");
    if (tBtn) {
      tBtn.textContent = allVisible ? "Hide all" : "Show all";
      tBtn.onclick = function () {
        sections.forEach(function (sec) { state.hiddenSections[sec] = allVisible; });
        renderSidebar(); renderTrends();
      };
    }

    var p = currentPatient();
    $("#corpus-meta").innerHTML = DATA.reports.length + " reports · " + DATA.analytes.length + " analytes" +
      '<br><button id="reprocess" class="linkbtn">Reprocess all</button>' +
      '<br><button id="clear-all" class="linkbtn">Clear all data…</button>';
    var reBtn = $("#reprocess");
    if (reBtn) reBtn.addEventListener("click", reprocessAll);
    var clearBtn = $("#clear-all");
    if (clearBtn) clearBtn.addEventListener("click", clearAllData);
    var ids = (p.identities || []).map(function (i) { return escapeHtml(i.pet_name + " / " + i.owner); });
    $("#patient-meta").innerHTML = "<b>" + escapeHtml(p.name) + "</b> · " + p.report_count + " reports · " +
      fmtDate(p.date_range[0]) + " → " + fmtDate(p.date_range[1]) +
      (ids.length > 1 ? " · aliases: " + Array.from(new Set(ids)).join(", ") : "");
  }

  function renderPatientSelect() {
    var sel = $("#patient");
    sel.innerHTML = "";
    DATA.patients.forEach(function (p) {
      var o = el("option");
      o.value = p.id;
      o.textContent = p.name + " (" + p.species + ", " + p.report_count + ")";
      sel.appendChild(o);
    });
    sel.value = state.patientId;
  }

  function renderAll() {
    // No data (fresh, or just cleared) → the welcome screen, not empty panels.
    if (!DATA.patients || !DATA.patients.length) {
      // renderSidebar() assumes a current patient (it reads p.identities), and the
      // sidebar is hidden by the .is-empty CSS anyway — so skip it here.
      ["conditions", "reports"].forEach(function (v) { $("#" + v).hidden = true; });
      $("#trends").hidden = false;
      renderPatientSelect(); // clears the (now hidden) patient dropdown
      renderWelcome();
      return;
    }
    document.body.classList.remove("is-empty");
    buildIndexes();
    renderPatientSelect();
    renderSidebar();
    ["trends", "conditions", "reports"].forEach(function (v) { $("#" + v).hidden = v !== state.view; });
    if (state.view === "trends") renderTrends();
    else if (state.view === "conditions") renderConditions();
    else renderReports();
  }

  // ---- events -------------------------------------------------------------

  function wire() {
    $("#patient").addEventListener("change", function (e) {
      state.patientId = +e.target.value; renderAll();
    });
    $("#view-toggle").addEventListener("click", function (e) {
      if (e.target.tagName !== "BUTTON") return;
      state.view = e.target.getAttribute("data-view");
      Array.prototype.forEach.call(this.children, function (b) { b.classList.toggle("active", b === e.target); });
      renderAll();
    });
    var searchTimer;
    $("#search").addEventListener("input", function (e) {
      clearTimeout(searchTimer);
      var v = e.target.value;
      searchTimer = setTimeout(function () { state.search = v; renderTrends(); }, 120);
    });
    $("#abnormal-only").addEventListener("change", function (e) {
      state.abnormalOnly = e.target.checked; renderTrends();
    });
    $("#detail-close").addEventListener("click", closeDetail);
    $("#detail").addEventListener("click", function (e) { if (e.target === this) closeDetail(); });
    $("#manage-pets").addEventListener("click", openPetsManager);
    $("#open-journal").addEventListener("click", openJournal);
    $("#journal-close").addEventListener("click", closeJournal);
    $("#journal").addEventListener("click", function (e) { if (e.target === this) closeJournal(); });
    $("#pets-close").addEventListener("click", closePetsManager);
    $("#pets").addEventListener("click", function (e) { if (e.target === this) closePetsManager(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeDetail(); closePetsManager(); closeJournal(); return; }
      // ← / → browse analytes while the detail modal is open.
      if (!$("#detail").hidden && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        cycleDetail(e.key === "ArrowRight" ? 1 : -1);
      }
    });

    // File-picker import (works on touch, where drag-drop doesn't). The hidden
    // <input> is triggered by the footer button and the welcome-screen button.
    var fileInput = $("#file-input");
    fileInput.addEventListener("change", function () {
      var files = Array.prototype.slice.call(this.files).filter(function (f) {
        return f.name.toLowerCase().endsWith(".pdf");
      });
      if (files.length) importFiles(files);
      this.value = ""; // allow re-picking the same file
    });
    $("#import-reports").addEventListener("click", function () { fileInput.click(); });
    // Delegated so it works for the dynamically-rendered welcome screen too.
    document.addEventListener("click", function (e) {
      if (e.target.closest("#welcome-choose")) fileInput.click();
    });

    setupDropzone();
  }

  // Friendly first-run screen (no reports imported yet). Touch-friendly: the
  // primary action is a real file picker, with drag-drop offered as a hint.
  function renderWelcome() {
    document.body.classList.add("is-empty");
    $("#patient-meta").textContent = "";
    $("#trends").innerHTML =
      '<div class="welcome">' +
        '<div class="welcome-mark" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
            '<circle cx="12" cy="12" r="5"></circle>' +
            '<path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"></path>' +
            '<path d="M5 16l3-4 3 3 4-6 4 5" stroke-linejoin="round"></path>' +
          '</svg>' +
        '</div>' +
        '<h1 class="welcome-h">Welcome to Pet<span class="hud">HUD</span></h1>' +
        '<p class="welcome-lead">Drop in your pet’s IDEXX VetConnect PLUS bloodwork PDFs and ' +
          'see them as clear trends over time, with plain-language context and a head start ' +
          'on your next vet visit.</p>' +
        '<div class="welcome-actions">' +
          '<button class="welcome-btn" id="welcome-choose" type="button">Choose PDF reports</button>' +
          '<span class="welcome-or">or drag &amp; drop them anywhere on this page</span>' +
        '</div>' +
        '<ul class="welcome-points">' +
          '<li><span class="wp-ic">🔒</span> Private by design — parsed and stored only in your browser, never uploaded</li>' +
          '<li><span class="wp-ic">📈</span> Trends, condition screening, IRIS kidney staging and visit prep</li>' +
          '<li><span class="wp-ic">⚡</span> Works offline · free &amp; open source</li>' +
        '</ul>' +
        '<p class="welcome-foot">New to bloodwork? <a href="about/">See how PetHUD works →</a></p>' +
      '</div>';
  }

  // ---- drag & drop import -------------------------------------------------

  function setupDropzone() {
    var zone = $("#dropzone");
    var depth = 0;
    window.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth++; zone.hidden = false;
    });
    window.addEventListener("dragover", function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("dragleave", function (e) {
      depth--; if (depth <= 0) { depth = 0; zone.hidden = true; }
    });
    window.addEventListener("drop", function (e) {
      e.preventDefault(); depth = 0; zone.hidden = true;
      var files = Array.prototype.slice.call(e.dataTransfer.files).filter(function (f) {
        return f.name.toLowerCase().endsWith(".pdf");
      });
      if (files.length) importFiles(files);
    });
  }
  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0;
  }

  // Parse dropped PDFs entirely in the browser, persist them, and rebuild.
  function importFiles(files) {
    var imported = 0, i = 0, lastSha = null;
    function finish() {
      rebuildFromDb().then(function () {
        // Jump to the patient whose report was just imported, so a dropped
        // report for a different pet is visible immediately.
        if (lastSha) {
          var rep = DATA.reports.find(function (r) { return r.sha256 === lastSha; });
          if (rep) state.patientId = rep.patient_id;
        }
        ensurePatient();
        renderAll();
        toast(imported + " report(s) imported.", imported ? "ok" : null, 3500);
      });
    }
    function next() {
      if (i >= files.length) return finish();
      var f = files[i++];
      toast("Importing " + f.name + "…", null, 60000);
      f.arrayBuffer().then(function (buf) {
        if (!looksLikePdf(buf)) throw new Error("not a PDF");
        // Store the original File directly: pdf.js transfers (detaches) the
        // ArrayBuffer to its worker during processPdf, so a Blob made from `buf`
        // afterward would be empty. The File is independent of that.
        return processPdf(buf, f.name).then(function (res) {
          lastSha = res.sha;
          return Promise.all([
            db.putPdf({ sha256: res.sha, filename: f.name, blob: f, importedAt: new Date().toISOString() }),
            db.putReport({ sha256: res.sha, reportDoc: res.reportDoc, patientSlug: null }),
          ]);
        });
      }).then(function () { imported++; next(); })
        .catch(function (err) {
          console.error("PetHUD import failed for " + f.name, err); // full stack in the console
          toast("Failed: " + f.name + " (" + err.message + ")", "err", 5000);
          next();
        });
    }
    next();
  }

  // Read every stored report doc and rebuild the in-memory payload, applying the
  // static rules plus the user's renames/merges.
  function rebuildFromDb() {
    return db.getAllReports().then(function (records) {
      var docs = records.map(function (r) { return r.reportDoc; });
      DATA = buildPayload(docs, { patientsConfig: mergedPatientsConfig(), knowledge: knowledge, analyteAliases: analyteAliases, generatedAt: new Date().toISOString() });
      window.PETHUD_DATA = DATA;
    });
  }

  // Fetch the static aliasing rules + medical-context knowledge + analyte
  // aliases once.
  function loadStaticConfig() {
    return Promise.all([
      fetch("patients.json").then(function (r) { return r.ok ? r.json() : { patients: [] }; }).catch(function () { return { patients: [] }; }),
      fetch("knowledge.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch("analyte_aliases.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    ]).then(function (res) { patientsConfig = res[0]; knowledge = res[1]; analyteAliases = res[2]; });
  }

  function loadUserConfig() {
    return db.getSetting("patientConfig").then(function (v) { userConfig = v || { patients: [] }; });
  }
  function saveUserConfig() { return db.putSetting("patientConfig", userConfig); }

  // Combine static rules with user overrides: same slug -> union match arrays and
  // override name/species; new slug -> appended.
  function mergedPatientsConfig() {
    var bySlug = {};
    (patientsConfig.patients || []).forEach(function (p) { bySlug[p.slug] = clone(p); });
    (userConfig.patients || []).forEach(function (u) {
      var s = bySlug[u.slug];
      if (!s) { bySlug[u.slug] = clone(u); return; }
      if (u.name) s.name = u.name;
      if (u.species) s.species = u.species;
      if (u.notes) s.notes = u.notes;
      s.match = s.match || {}; u.match = u.match || {};
      s.match.names = unionArr(s.match.names, u.match.names);
      s.match.external_ids = unionArr(s.match.external_ids, u.match.external_ids);
    });
    return { patients: Object.keys(bySlug).map(function (k) { return bySlug[k]; }) };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function unionArr(a, b) { return Array.from(new Set([].concat(a || [], b || []))); }

  var toastTimer;
  function toast(msg, kind, ttl) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    if (ttl) toastTimer = setTimeout(function () { t.hidden = true; }, ttl);
  }

  function ensurePatient() {
    if (!DATA.patients.length) { state.patientId = null; return; }
    if (!DATA.patients.some(function (p) { return p.id === state.patientId; })) {
      state.patientId = DATA.patients[0].id;
    }
  }

  // ---- boot ---------------------------------------------------------------

  // ---- theme (auto / light / dark) ---------------------------------------

  function setupTheme() {
    var tt = $("#theme-toggle");
    if (!tt) return;
    var current = document.documentElement.getAttribute("data-theme") || "auto";
    paintTheme(current);
    tt.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-theme-set]");
      if (!btn) return;
      var mode = btn.getAttribute("data-theme-set");
      document.documentElement.setAttribute("data-theme", mode);
      try { localStorage.setItem("pethud-theme", mode); } catch (err) { /* private mode */ }
      paintTheme(mode);
    });
  }
  function paintTheme(mode) {
    Array.prototype.forEach.call($("#theme-toggle").querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-theme-set") === mode);
    });
  }

  // One-time copy of pre-rename localStorage keys (pethud-* -> pethud-*), so a
  // returning user keeps their theme and sidebar state. The IndexedDB data is
  // migrated separately in db.js.
  function migrateLegacyPrefs() {
    try {
      [["pethud-theme", "indexx-theme"], ["pethud-ls", "indexx-ls"]].forEach(function (pair) {
        if (localStorage.getItem(pair[0]) == null) {
          var old = localStorage.getItem(pair[1]);
          if (old != null) localStorage.setItem(pair[0], old);
        }
      });
    } catch (e) { /* private mode */ }
  }

  function boot() {
    migrateLegacyPrefs();
    setupTheme();
    wire(); // includes the dropzone, needed even before any data exists
    loadStaticConfig()
      .then(loadUserConfig)
      .then(loadJournal)
      .then(rebuildFromDb)
      .then(function () {
        if (!DATA.patients || !DATA.patients.length) {
          renderWelcome();
          return;
        }
        ensurePatient();
        applyHash();
        renderAll();
        if (state.openAnalyte != null) openDetail(state.openAnalyte);
      })
      .catch(function (err) {
        $("#trends").innerHTML = '<div class="empty">Failed to start: ' + escapeHtml(err.message) + "</div>";
      });
  }

  // Optional deep links: #reports, #trends, #a=<analyteId> (open a detail).
  function applyHash() {
    var h = (location.hash || "").replace(/^#/, "");
    if (!h) return;
    if (h === "reports" || h === "trends" || h === "conditions") {
      state.view = h;
      Array.prototype.forEach.call($("#view-toggle").children, function (b) {
        b.classList.toggle("active", b.getAttribute("data-view") === h);
      });
    } else if (/^a=(\d+)$/.test(h)) {
      state.openAnalyte = +RegExp.$1;
    } else if (/^c=([a-z0-9-]+)$/.test(h)) {
      state.view = "conditions";
      state.conditionSlug = RegExp.$1;
      Array.prototype.forEach.call($("#view-toggle").children, function (b) {
        b.classList.toggle("active", b.getAttribute("data-view") === "conditions");
      });
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
