/* pethud viewer — vanilla JS, no framework.
   Runs fully in the browser: parses dropped IDEXX PDFs with pdf.js + lib/*,
   stores originals + parsed docs in IndexedDB, and renders the rebuilt payload.
   The Ruby CLI remains available and produces the identical data shape. */
import * as db from "./lib/db.js";
import { processPdf, looksLikePdf } from "./lib/process.js";
import { buildPayload } from "./lib/aggregate.js";

(function () {
  "use strict";

  var DATA = window.PETHUD_DATA || { patients: [], reports: [], analytes: [], series: {} };
  var patientsConfig = { patients: [] }; // aliasing rules (fetched from patients.json)
  var knowledge = null;                  // medical-context payload (knowledge.json)

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
    abnormalOnly: false
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
      out += '<text class="axis-label" x="' + s.X(ms(p.date)).toFixed(1) + '" y="' + (box.t + box.h + 16) +
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

    var box = el("div", "lifestage");
    box.innerHTML =
      '<div class="ls-head"><span class="ls-icon">' + stageIcon(stage.slug) + "</span>" +
        '<div class="ls-titlewrap"><div class="ls-title">' + escapeHtml(stage.name) + " cat · " +
          escapeHtml(p.age_text || (p.age_years + " yr")) + "</div>" +
          '<div class="ls-sub">' + escapeHtml(stage.summary || "") + "</div></div></div>" +
      (screenable.length ? '<div class="ls-watch"><span class="ls-lbl">Screen for with the labs</span><div class="ls-chips">' + screenable.map(chip).join("") + "</div></div>" : "") +
      (clinical.length ? '<div class="ls-watch"><span class="ls-lbl">Watch clinically (not on bloodwork)</span><div class="ls-chips">' + clinical.map(chip).join("") + "</div></div>" : "") +
      (textItems ? '<div class="ls-text">' + textItems + "</div>" : "") +
      (stage.screening ? '<div class="ls-screen"><b>Screening:</b> ' + escapeHtml(stage.screening) + "</div>" : "") +
      '<div class="ls-foot"><span class="src">' + srcLinks + '</span><span class="note">Educational vigilance, not a diagnosis or prediction.</span></div>';

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
        '<div class="card-top"><span class="card-name">' + a.name + '</span>' +
        '<span class="card-unit">' + (a.unit || "") + "</span></div>" +
        '<div class="card-value"><span class="v ' + fl + '">' + fmtNum(last.value) + "</span>" + deltaHtml + "</div>" +
        sparkline(num, ctx) +
        '<div class="card-foot"><span>' + refTxt + "</span>" + footMeta(num.length + " pts · " + fmtDate(last.date), last.date) + "</div>";
    } else {
      // qualitative timeline
      var qs = qualSeries(item.pts);
      var lastq = qs.length ? qs[qs.length - 1] : null;
      var badges = qs.slice(-6).map(function (p) {
        return '<span class="b" title="' + fmtDate(p.date) + '">' + escapeHtml(p.result_text) + "</span>";
      }).join("");
      c.classList.add("flag-ok");
      c.innerHTML =
        '<div class="card-top"><span class="card-name">' + a.name + "</span></div>" +
        '<div class="card-value"><span class="v ok" style="font-size:14px">' +
          (lastq ? escapeHtml(lastq.result_text) : "—") + "</span></div>" +
        '<div class="qual-badges">' + badges + "</div>" +
        '<div class="card-foot"><span>qualitative</span>' + footMeta(qs.length + " obs", lastq ? lastq.date : null) + "</div>";
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
    var pts = seriesFor(analyteId);
    var body = $("#detail-body");
    var color = SECTION_COLOR[a.section] || "#8b949e";

    var head = '<div class="detail-head"><span class="bar" style="display:inline-block;width:4px;height:18px;background:' +
      color + ';border-radius:2px"></span><h2>' + a.name + '</h2><span class="sec">' + a.section +
      (a.unit ? " · " + a.unit : "") + "</span></div>";

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
      var val = p.value != null ? (p.qualifier ? p.qualifier + " " : "") + fmtNum(p.value) : escapeHtml(p.result_text);
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
  }

  // ---- reports view -------------------------------------------------------

  function renderReports() {
    var host = $("#reports");
    host.innerHTML = "";
    var reports = DATA.reports.filter(function (r) { return r.patient_id === state.patientId; })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });
    if (!reports.length) { host.appendChild(el("div", "empty", "No reports.")); return; }

    var grid = el("div", "report-grid");
    reports.forEach(function (r) { grid.appendChild(reportCard(r)); });
    host.appendChild(grid);
  }

  function reportCard(r) {
    // collect flagged measurements for this report from the series
    var flagged = [];
    var smap = DATA.series[String(state.patientId)] || {};
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

    var c = el("div", "report-card");
    var rows = flagged.map(function (f) {
      var ref = (f.p.ref_low != null) ? fmtNum(f.p.ref_low) + "–" + fmtNum(f.p.ref_high) : "";
      return '<tr class="' + f.fl + '"><td class="name">' + f.a.name + '</td><td class="val">' +
        fmtNum(f.p.value) + '</td><td class="ref">' + ref + '</td><td><span class="pill ' + f.fl + '">' + f.fl + "</span></td></tr>";
    }).join("");

    c.innerHTML =
      "<h3>" + fmtDate(r.date) + "</h3>" +
      '<div class="rmeta"><span class="k">clinic</span> ' + escapeHtml(r.clinic_name || "—") +
      ' · <span class="k">age</span> ' + escapeHtml(r.age_text || "—") +
      (r.lab_id ? ' · <span class="k">lab</span> ' + r.lab_id : "") + "</div>" +
      (r.idexx_services ? '<div class="svc">' + escapeHtml(r.idexx_services) + "</div>" : "") +
      (flagged.length
        ? '<div class="section-tag">' + flagged.length + ' out of range</div><table class="flag-table"><tbody>' + rows + "</tbody></table>"
        : '<div class="section-tag" style="color:var(--normal)">all values within range</div>');
    return c;
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

    var p = currentPatient();
    $("#corpus-meta").innerHTML = "Generated<br>" + (DATA.generated_at ? DATA.generated_at.replace("T", " ").slice(0, 16) + " UTC" : "—") +
      "<br><br>" + DATA.reports.length + " reports · " + DATA.analytes.length + " analytes";
    var ids = (p.identities || []).map(function (i) { return escapeHtml(i.pet_name + " / " + i.owner); });
    $("#patient-meta").innerHTML = p.report_count + " reports · " +
      fmtDate(p.date_range[0]) + " → " + fmtDate(p.date_range[1]) +
      (ids.length > 1 ? "<br>aliases: " + Array.from(new Set(ids)).join(", ") : "");
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
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDetail(); });

    setupDropzone();
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
    var imported = 0, i = 0;
    function finish() {
      rebuildFromDb().then(function () {
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
        return processPdf(buf, f.name).then(function (res) {
          return Promise.all([
            db.putPdf({ sha256: res.sha, filename: f.name, blob: new Blob([buf], { type: "application/pdf" }), importedAt: new Date().toISOString() }),
            db.putReport({ sha256: res.sha, reportDoc: res.reportDoc, patientSlug: null }),
          ]);
        });
      }).then(function () { imported++; next(); })
        .catch(function (err) { toast("Failed: " + f.name + " (" + err.message + ")", "err", 5000); next(); });
    }
    next();
  }

  // Read every stored report doc and rebuild the in-memory payload.
  function rebuildFromDb() {
    return db.getAllReports().then(function (records) {
      var docs = records.map(function (r) { return r.reportDoc; });
      DATA = buildPayload(docs, { patientsConfig: patientsConfig, knowledge: knowledge, generatedAt: new Date().toISOString() });
      window.PETHUD_DATA = DATA;
    });
  }

  // Fetch the static aliasing rules + medical-context knowledge once.
  function loadStaticConfig() {
    return Promise.all([
      fetch("patients.json").then(function (r) { return r.ok ? r.json() : { patients: [] }; }).catch(function () { return { patients: [] }; }),
      fetch("knowledge.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    ]).then(function (res) { patientsConfig = res[0]; knowledge = res[1]; });
  }

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

  function boot() {
    setupTheme();
    wire(); // includes the dropzone, needed even before any data exists
    loadStaticConfig()
      .then(rebuildFromDb)
      .then(function () {
        if (!DATA.patients || !DATA.patients.length) {
          $("#trends").innerHTML = '<div class="empty">No reports yet. Drag IDEXX PDF report(s) onto this page to import them — ' +
            "everything is processed and stored locally in your browser.</div>";
          $("#patient-meta").textContent = "";
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
