/**
 * PULSE NATIVE MGMTREP CHART RENDERER (SVG)
 *
 * Generates high-precision vector SVG charts directly from MgmtRep data grids,
 * matching the 6 visual chart archetypes used across Pulse Management Reports:
 *  1. SPARKLINE            — Smooth blue trend sparklines (Month & Quarter Snapshots)
 *  2. PIE_3D               — Tilted 3D extruded pie chart with leader callouts & slice values
 *  3. STACKED_COLUMN       — Stacked column chart with bar totals & right-hand legend
 *  4. CLUSTERED_COLUMN     — Grouped 2-series column chart (Targets vs Actual)
 *  5. REVENUE_TREND_LINE   — Smooth 3-series line chart with linear least-squares trendlines
 *  6. CASHFLOW_LINE        — Solid Actual + Dashed Forecast (excl/incl pipeline) line chart
 */

const PULSE_CHART_PALETTE = [
  "#4472c4", // 0: Royal blue
  "#ed7d31", // 1: Orange
  "#a5a5a5", // 2: Medium grey
  "#ffc000", // 3: Amber / Gold
  "#5b9bd5", // 4: Sky blue
  "#70ad47", // 5: Green
  "#f4b183", // 6: Peach
  "#b4c7e7", // 7: Soft periwinkle blue
  "#a9d18e", // 8: Soft sage green
  "#8faadc", // 9: Cornflower blue
  "#ffd966", // 10: Warm yellow
  "#c9c9c9", // 11: Silver grey
  "#f8cbad", // 12: Light apricot
  "#264478", // 13: Deep navy
  "#9e480e", // 14: Rust orange
];

const UPPERCASE_ACRONYMS = new Set([
  "UCL", "NHS", "UK", "US", "USA", "UAE", "EU", "UN", "BBC", "ITV", "LSE", "KCL",
  "QMUL", "SOAS", "UAL", "UWE", "MIT", "PLOS", "BMJ", "NIHR", "UKRI", "MRC",
  "EPSRC", "ESRC", "AHRC", "BBSRC", "STFC", "NERC", "CRUK", "BHF", "GOSH", "RSA",
  "RIBA", "RICS", "CIPD", "CIM", "ACCA", "ICAEW", "CIMA", "FCA", "HMRC", "PAYE",
  "VAT", "B2B", "B2C", "D2C", "PR", "HR", "IT", "AI", "VR", "AR", "UI", "UX",
  "SEO", "PPC", "CRM", "ERP", "API", "PLC", "LLP", "LLC", "CIC", "CEO", "CFO",
  "COO", "CTO", "CMO", "MD", "VP", "R&D", "P&L", "YTD", "MTD", "QTD", "FY",
  "Q1", "Q2", "Q3", "Q4", "H1", "H2", "ROI", "KPI", "OKR", "SLA", "SME", "VC",
  "PE", "IP", "ESG", "CSR", "EDI", "DEI", "NGO", "WHO", "OECD", "NATO", "DEFRA",
  "DSIT", "DCMS", "DHSC", "DFE", "DFT", "DWP", "MOD", "MOJ", "FCDO", "GLA", "TFL",
  "HS2", "CBI", "FSB",
]);

const LOWERCASE_CONNECTORS = new Set([
  "and", "of", "the", "for", "in", "on", "to", "at", "by", "from", "with", "into", "per", "via",
]);

/**
 * Cleans up Google Sheets =PROPER() capitalisation artifacts in client & source names:
 * - "Natasha'S Foundation" -> "Natasha's Foundation"
 * - "Ucl" -> "UCL", "Oxford Health Nhs Foundation Trust" -> "Oxford Health NHS Foundation Trust"
 * - "Cardiff And Vale University..." -> "Cardiff and Vale University..."
 * - "Public Library Of Science (Plos)" -> "Public Library of Science (PLOS)"
 */
export function normalizeReportLabel(raw) {
  if (raw === null || raw === undefined) return "";
  let s = String(raw).trim();
  if (!s) return "";

  // 1. Fix apostrophe suffixes mangled by PROPER() (e.g. 'S -> 's, 'T -> 't, 'Ll -> 'll)
  s = s.replace(/(['’])([A-Z][a-z]*)\b/g, (match, apos, suffix) => {
    const lower = suffix.toLowerCase();
    if (["s", "t", "ll", "ve", "re", "d", "m"].includes(lower)) {
      return `${apos}${lower}`;
    }
    return match;
  });

  // 2. Restore uppercase acronyms & lowercase mid-phrase connectors
  let wordIndex = 0;
  s = s.replace(/(^|[\s(\[/,-]+)([A-Za-z0-9&]+)/g, (match, prefix, word) => {
    const currentIdx = wordIndex++;
    const upper = word.toUpperCase();
    if (UPPERCASE_ACRONYMS.has(upper)) {
      return `${prefix}${upper}`;
    }
    const lower = word.toLowerCase();
    const isAfterPunctuation = /[:(\[-]\s*$/.test(prefix);
    if (currentIdx > 0 && !isAfterPunctuation && LOWERCASE_CONNECTORS.has(lower)) {
      return `${prefix}${lower}`;
    }
    return `${prefix}${word}`;
  });

  return s;
}

function wrapLabelLines(text, maxCharsPerLine = 27, maxLines = 3) {
  const clean = String(text || "").trim();
  if (!clean) return [""];
  if (clean.length <= maxCharsPerLine) return [clean];

  const words = clean.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    kept.push(lines.slice(maxLines - 1).join(" "));
    return kept;
  }
  return lines;
}

function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function parseChartNumber(val) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  const s = String(val).trim();
  if (!s || s === "-" || s === "—" || s.startsWith("#") || s === "!!!") return null;
  const isNeg = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
  const cleaned = s.replace(/[£$€,\s()%]/g, "");
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return isNeg ? -Math.abs(num) : num;
}

export function formatGBP(num) {
  if (num === null || num === undefined || !Number.isFinite(num)) return "£0";
  const rounded = Math.round(num);
  if (rounded < 0) return `-£${Math.abs(rounded).toLocaleString("en-GB")}`;
  return `£${rounded.toLocaleString("en-GB")}`;
}

function darkenHex(hex, factor = 0.72) {
  const clean = String(hex || "#4472c4").replace("#", "");
  if (clean.length !== 6) return hex;
  const r = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(0, 2), 16) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(2, 4), 16) * factor)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(4, 6), 16) * factor)));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function computeNiceAxisScale(minVal, maxVal, forceZero = true) {
  let lo = forceZero ? Math.min(0, minVal) : minVal;
  let hi = forceZero ? Math.max(0, maxVal) : maxVal;
  if (hi === lo) {
    hi = lo + 1000;
  }
  const rawSpan = hi - lo;
  const roughStep = rawSpan / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, roughStep))));
  const residual = roughStep / mag;
  let step;
  if (residual <= 1) step = 1 * mag;
  else if (residual <= 2) step = 2 * mag;
  else if (residual <= 2.5) step = 2.5 * mag;
  else if (residual <= 5) step = 5 * mag;
  else step = 10 * mag;

  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.001; v += step) {
    ticks.push(Math.round(v));
  }
  return { min: niceMin, max: niceMax, step, ticks };
}

/**
 * Builds a smooth Catmull-Rom cubic bezier SVG path through a list of {x, y} points.
 */
function buildSmoothSplinePath(points, tension = 0.22) {
  if (!points || points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * 1. SPARKLINE RENDERER (128x50 miniature smooth line chart)
 */
export function renderSparklineSvg({ values = [], width = 220, height = 76, color = "#4472c4" }) {
  const nums = values.map(parseChartNumber).filter((v) => v !== null);
  if (nums.length < 2) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="#ffffff"/>
    </svg>`;
  }
  const minV = Math.min(...nums);
  const maxV = Math.max(...nums);
  const span = maxV - minV || 1;
  const padX = 12;
  const padY = 10;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const pts = nums.map((v, i) => ({
    x: padX + (i / (nums.length - 1)) * plotW,
    y: padY + plotH - ((v - minV) / span) * plotH,
  }));

  const pathD = buildSmoothSplinePath(pts, 0.2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/**
 * 2. 3D TILTED PIE CHART WITH LEADER CALLOUTS & SLICE VALUES
 */
export function renderPie3DSvg({
  items = [], // [{ label, value, color? }]
  width = 880,
  height = 540,
  labelColor = "#1a1a1a",
}) {
  const valid = items
    .map((it, idx) => ({
      label: normalizeReportLabel(it.label),
      value: parseChartNumber(it.value) || 0,
      color: it.color || PULSE_CHART_PALETTE[idx % PULSE_CHART_PALETTE.length],
    }))
    .filter((it) => it.label && it.value > 0);

  const total = valid.reduce((acc, it) => acc + it.value, 0);
  if (total <= 0 || valid.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="#ffffff"/>
      <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="14" fill="#888">No data for period</text>
    </svg>`;
  }

  // Exact same pie dimensions as the original Google Sheets chart (rx=246, ry=156 on 880x540)
  const cx = width / 2;
  const cy = height / 2 - 10;
  const rx = 246;
  const ry = 156;
  const depth = 30;

  // Helper: exact horizontal half-width of the 3D extruded pie at vertical coordinate y
  const getPieHalfWidthAtY = (y) => {
    let maxW = 0;
    const dyTop = (y - cy) / ry;
    if (Math.abs(dyTop) <= 1) {
      maxW = Math.max(maxW, rx * Math.sqrt(Math.max(0, 1 - dyTop * dyTop)));
    }
    const dyBot = (y - (cy + depth)) / ry;
    if (Math.abs(dyBot) <= 1 && y >= cy) {
      maxW = Math.max(maxW, rx * Math.sqrt(Math.max(0, 1 - dyBot * dyBot)));
    }
    if (y >= cy && y <= cy + depth) {
      maxW = Math.max(maxW, rx);
    }
    return maxW;
  };

  const getPieHalfWidthInBand = (yMin, yMax) => {
    let maxW = 0;
    for (let y = yMin; y <= yMax; y += 4) {
      maxW = Math.max(maxW, getPieHalfWidthAtY(y));
    }
    maxW = Math.max(maxW, getPieHalfWidthAtY(yMin), getPieHalfWidthAtY(yMax));
    return maxW;
  };

  // Start at top (-PI/2) and go clockwise
  let currAngle = -Math.PI / 2;
  const slices = valid.map((it) => {
    const frac = it.value / total;
    const sweep = frac * Math.PI * 2;
    const startAngle = currAngle;
    const endAngle = currAngle + sweep;
    const midAngle = startAngle + sweep / 2;
    currAngle = endAngle;
    return {
      ...it,
      frac,
      pctText: `${(frac * 100).toFixed(1)}%`,
      valText: formatGBP(it.value),
      startAngle,
      endAngle,
      midAngle,
    };
  });

  // 1. Build 3D side extrusion walls for any slice overlapping the front half [0, PI]
  const sidePaths = [];
  for (const s of slices) {
    const intervals = [
      [s.startAngle, s.endAngle],
      [s.startAngle + Math.PI * 2, s.endAngle + Math.PI * 2],
    ];
    for (const [a0, a1] of intervals) {
      const visStart = Math.max(0, a0);
      const visEnd = Math.min(Math.PI, a1);
      if (visEnd > visStart + 0.001) {
        const x1 = cx + rx * Math.cos(visStart);
        const y1 = cy + ry * Math.sin(visStart);
        const x2 = cx + rx * Math.cos(visEnd);
        const y2 = cy + ry * Math.sin(visEnd);
        const largeArc = visEnd - visStart > Math.PI ? 1 : 0;
        const d = [
          `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
          `A ${rx} ${ry} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
          `L ${x2.toFixed(2)} ${(y2 + depth).toFixed(2)}`,
          `A ${rx} ${ry} 0 ${largeArc} 0 ${x1.toFixed(2)} ${(y1 + depth).toFixed(2)}`,
          "Z",
        ].join(" ");
        sidePaths.push(`<path d="${d}" fill="${darkenHex(s.color, 0.72)}" stroke="none"/>`);
      }
    }
  }

  // 2. Build top elliptical wedges
  const topPaths = [];
  for (const s of slices) {
    if (s.frac >= 0.9999) {
      topPaths.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${s.color}"/>`);
    } else {
      const x1 = cx + rx * Math.cos(s.startAngle);
      const y1 = cy + ry * Math.sin(s.startAngle);
      const x2 = cx + rx * Math.cos(s.endAngle);
      const y2 = cy + ry * Math.sin(s.endAngle);
      const largeArc = s.endAngle - s.startAngle > Math.PI ? 1 : 0;
      const d = [
        `M ${cx} ${cy}`,
        `L ${x1.toFixed(2)} ${y1.toFixed(2)}`,
        `A ${rx} ${ry} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
        "Z",
      ].join(" ");
      topPaths.push(`<path d="${d}" fill="${s.color}" stroke="${s.color}" stroke-width="0.4"/>`);
    }
  }

  // 3. Slice interior value labels (italic £X,XXX) + Exterior callout leader lines
  const valueLabels = [];
  const leftCallouts = [];
  const rightCallouts = [];
  const marginX = 20;

  const computeCalloutWrapAtY = (label, y) => {
    // Determine how wide the 3D pie is in the text band above y
    const pieHalfW = getPieHalfWidthInBand(y - 30, y + 2);
    const availPx = cx - marginX - pieHalfW - 14; // 14px minimum gap between text and pie edge
    const maxChars = Math.max(24, Math.min(38, Math.floor(availPx / 6.0)));
    const lines = wrapLabelLines(label, maxChars, 3);
    const topExtent = 4 + (lines.length - 1) * 13.5 + 12;
    const bottomExtent = 15;
    return { lines, topExtent, bottomExtent };
  };

  for (const s of slices) {
    const cosM = Math.cos(s.midAngle);
    const sinM = Math.sin(s.midAngle);

    // Interior currency value if slice >= 4.5%
    if (s.frac >= 0.045) {
      const vx = cx + rx * 0.62 * cosM;
      const vy = cy + ry * 0.62 * sinM + 4;
      valueLabels.push(
        `<text x="${vx.toFixed(1)}" y="${vy.toFixed(1)}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="11.5" font-style="italic" fill="#000000">${escapeXml(s.valText)}</text>`
      );
    }

    // Callout anchor inside the outer ring of the slice
    const anchorX = cx + rx * 0.85 * cosM;
    const anchorY = cy + ry * 0.85 * sinM;
    const wrapInfo = computeCalloutWrapAtY(s.label, anchorY);
    const item = {
      ...s,
      ...wrapInfo,
      anchorX,
      anchorY,
      targetY: anchorY,
    };
    if (cosM >= 0) {
      rightCallouts.push(item);
    } else {
      leftCallouts.push(item);
    }
  }

  // Sort callouts top-to-bottom and enforce compact multi-line vertical separation
  const resolveCalloutCollisions = (list) => {
    if (list.length === 0) return;
    list.sort((a, b) => a.anchorY - b.anchorY);

    for (let iter = 0; iter < 40; iter++) {
      // Re-evaluate ellipse-aware line wrapping at each item's current targetY
      for (const item of list) {
        const w = computeCalloutWrapAtY(item.label, item.targetY);
        item.lines = w.lines;
        item.topExtent = w.topExtent;
        item.bottomExtent = w.bottomExtent;
      }

      let moved = false;
      for (let i = 1; i < list.length; i++) {
        const minGap = list[i - 1].bottomExtent + list[i].topExtent + 3;
        const diff = list[i].targetY - list[i - 1].targetY;
        if (diff < minGap - 0.1) {
          const push = (minGap - diff) / 2;
          list[i - 1].targetY -= push;
          list[i].targetY += push;
          moved = true;
        }
      }
      const minTopY = 16 + list[0].topExtent;
      if (list[0].targetY < minTopY) {
        list[0].targetY = minTopY;
      }
      const maxBottomY = height - 20;
      if (list[list.length - 1].targetY > maxBottomY) {
        list[list.length - 1].targetY = maxBottomY;
      }
      if (!moved) break;
    }

    // Final forward pass to guarantee strict non-overlap
    for (let i = 1; i < list.length; i++) {
      const minGap = list[i - 1].bottomExtent + list[i].topExtent + 3;
      if (list[i].targetY - list[i - 1].targetY < minGap) {
        list[i].targetY = list[i - 1].targetY + minGap;
      }
    }
    for (const item of list) {
      const w = computeCalloutWrapAtY(item.label, item.targetY);
      item.lines = w.lines;
      item.topExtent = w.topExtent;
      item.bottomExtent = w.bottomExtent;
    }
  };

  resolveCalloutCollisions(leftCallouts);
  resolveCalloutCollisions(rightCallouts);

  const calloutEls = [];
  const leftMarginX = marginX;
  const rightMarginX = width - marginX;

  const renderCalloutItem = (c, isRight) => {
    const edgeX = isRight ? rightMarginX : leftMarginX;
    const align = isRight ? "end" : "start";
    const lineY = c.targetY;
    const pieHalfWAtLine = getPieHalfWidthAtY(lineY);

    let polyPoints;
    if (Math.abs(lineY - c.anchorY) < 4) {
      polyPoints = `${c.anchorX.toFixed(1)},${lineY.toFixed(1)} ${edgeX},${lineY.toFixed(1)}`;
    } else {
      const elbowX = isRight
        ? Math.max(c.anchorX + 14, cx + pieHalfWAtLine + 14)
        : Math.min(c.anchorX - 14, cx - pieHalfWAtLine - 14);
      polyPoints = `${c.anchorX.toFixed(1)},${c.anchorY.toFixed(1)} ${elbowX.toFixed(1)},${lineY.toFixed(1)} ${edgeX},${lineY.toFixed(1)}`;
    }

    calloutEls.push(
      `<polyline points="${polyPoints}" fill="none" stroke="#999999" stroke-width="1.2"/>`,
      `<circle cx="${c.anchorX.toFixed(1)}" cy="${c.anchorY.toFixed(1)}" r="2.4" fill="#999999"/>`
    );

    // Render full wrapped label lines above the horizontal leader line
    const lineCount = c.lines.length;
    c.lines.forEach((lineText, idx) => {
      const offsetFromBottomLine = (lineCount - 1 - idx) * 13.5;
      const textY = lineY - 5 - offsetFromBottomLine;
      calloutEls.push(
        `<text x="${edgeX}" y="${textY.toFixed(1)}" text-anchor="${align}" font-family="Roboto, Arial, sans-serif" font-size="11.5" font-weight="bold" fill="${labelColor}">${escapeXml(lineText)}</text>`
      );
    });

    // Percentage below the horizontal leader line
    calloutEls.push(
      `<text x="${edgeX}" y="${(lineY + 13.5).toFixed(1)}" text-anchor="${align}" font-family="Roboto, Arial, sans-serif" font-size="11.5" font-weight="bold" fill="#888888">${escapeXml(c.pctText)}</text>`
    );
  };

  leftCallouts.forEach((c) => renderCalloutItem(c, false));
  rightCallouts.forEach((c) => renderCalloutItem(c, true));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${sidePaths.join("\n    ")}
    ${topPaths.join("\n    ")}
    ${valueLabels.join("\n    ")}
    ${calloutEls.join("\n    ")}
  </svg>`;
}

/**
 * 3. STACKED COLUMN CHART WITH BAR TOTALS & RIGHT-HAND LEGEND
 */
export function renderStackedColumnSvg({
  categories = [], // ["Jan 26", "Feb 26", ...]
  series = [], // [{ name, values: [...], color? }]
  width = 1048,
  height = 543,
  showAxisCurrency = true,
  showZeroBarTotals = false,
}) {
  // Filter to series that have at least one positive value (or keep all if <= 6 series)
  const activeSeries = series
    .map((s, idx) => ({
      name: normalizeReportLabel(s.name),
      values: (s.values || []).map((v) => Math.max(0, parseChartNumber(v) || 0)),
      color: s.color || PULSE_CHART_PALETTE[idx % PULSE_CHART_PALETTE.length],
    }))
    .filter((s) => s.name && (series.length <= 6 || s.values.some((v) => v > 0)));

  const colCount = categories.length;
  const colTotals = categories.map((_, cIdx) =>
    activeSeries.reduce((sum, s) => sum + (s.values[cIdx] || 0), 0)
  );
  const maxTotal = Math.max(1000, ...colTotals);
  const scale = computeNiceAxisScale(0, maxTotal * 1.08, true);

  const padLeft = showAxisCurrency ? 82 : 44;
  const padRight = 275;
  const padTop = 36;
  const padBottom = 56;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const yForVal = (v) => padTop + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;

  // Gridlines & Y-axis labels
  const gridEls = [];
  for (const tick of scale.ticks) {
    const y = yForVal(tick);
    const isZero = Math.abs(tick) < 0.001;
    gridEls.push(
      `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${padLeft + plotW}" y2="${y.toFixed(1)}" stroke="${isZero ? "#333333" : "#cccccc"}" stroke-width="${isZero ? "1.3" : "1"}"/>`
    );
    if (showAxisCurrency) {
      gridEls.push(
        `<text x="${padLeft - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(formatGBP(tick))}</text>`
      );
    }
  }

  // Stacked bars & totals
  const barEls = [];
  const slotW = plotW / Math.max(1, colCount);
  const barW = Math.min(54, slotW * 0.62);

  for (let cIdx = 0; cIdx < colCount; cIdx++) {
    const cx = padLeft + slotW * (cIdx + 0.5);
    const x = cx - barW / 2;
    let runningVal = 0;

    // Find top-most non-zero series index for rounded top corners
    let topSeriesIdx = -1;
    for (let sIdx = activeSeries.length - 1; sIdx >= 0; sIdx--) {
      if ((activeSeries[sIdx].values[cIdx] || 0) > 0) {
        topSeriesIdx = sIdx;
        break;
      }
    }

    for (let sIdx = 0; sIdx < activeSeries.length; sIdx++) {
      const val = activeSeries[sIdx].values[cIdx] || 0;
      if (val <= 0) continue;
      const yBottom = yForVal(runningVal);
      const yTop = yForVal(runningVal + val);
      const h = Math.max(1, yBottom - yTop);
      const rx = sIdx === topSeriesIdx ? 2 : 0;
      barEls.push(
        `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${rx}" fill="${activeSeries[sIdx].color}"/>`
      );
      runningVal += val;
    }

    // Total label above bar
    const totalVal = colTotals[cIdx] || 0;
    if (totalVal > 0 || showZeroBarTotals) {
      const yTop = yForVal(totalVal);
      barEls.push(
        `<text x="${cx.toFixed(1)}" y="${(yTop - 10).toFixed(1)}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#666666">${escapeXml(formatGBP(totalVal))}</text>`
      );
    }

    // X-axis label (split "Nov 2025" into 2 lines if 4-digit year)
    const rawCat = String(categories[cIdx] || "").trim();
    const parts = rawCat.split(/\s+/);
    if (parts.length === 2 && parts[1].length === 4) {
      barEls.push(
        `<text x="${cx.toFixed(1)}" y="${padTop + plotH + 19}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(parts[0])}</text>`,
        `<text x="${cx.toFixed(1)}" y="${padTop + plotH + 35}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(parts[1])}</text>`
      );
    } else {
      barEls.push(
        `<text x="${cx.toFixed(1)}" y="${padTop + plotH + 22}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(rawCat)}</text>`
      );
    }
  }

  // Right-hand legend (displayed in reverse stack order so top of legend matches top of bar)
  const legendEls = [];
  const legendX = padLeft + plotW + 24;
  let legendY = padTop + 4;
  const reversedSeries = [...activeSeries].reverse();
  for (const s of reversedSeries) {
    // Wrap long legend labels onto 2 lines if > 32 chars
    const words = s.name.split(/\s+/);
    const lines = [];
    let curr = "";
    for (const w of words) {
      if ((curr + " " + w).trim().length > 32 && curr) {
        lines.push(curr);
        curr = w;
      } else {
        curr = (curr + " " + w).trim();
      }
    }
    if (curr) lines.push(curr);

    legendEls.push(
      `<rect x="${legendX}" y="${legendY - 10}" width="13" height="13" rx="1.5" fill="${s.color}"/>`
    );
    lines.slice(0, 2).forEach((ln, lIdx) => {
      legendEls.push(
        `<text x="${legendX + 21}" y="${legendY + lIdx * 15}" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(ln)}</text>`
      );
    });
    legendY += lines.length > 1 ? 35 : 24;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${gridEls.join("\n    ")}
    ${barEls.join("\n    ")}
    ${legendEls.join("\n    ")}
  </svg>`;
}

/**
 * 4. CLUSTERED (GROUPED) COLUMN CHART (Targets vs Actual)
 */
export function renderClusteredColumnSvg({
  categories = [],
  series = [], // [{ name: "Target", values: [...] }, { name: "Actual", values: [...] }]
  width = 1048,
  height = 500,
}) {
  const activeSeries = series.map((s, idx) => ({
    name: String(s.name || "").trim(),
    values: (s.values || []).map((v) => Math.max(0, parseChartNumber(v) || 0)),
    color: s.color || PULSE_CHART_PALETTE[idx % PULSE_CHART_PALETTE.length],
  }));

  const allVals = activeSeries.flatMap((s) => s.values);
  const maxVal = Math.max(1000, ...allVals);
  const scale = computeNiceAxisScale(0, maxVal * 1.05, true);

  const padLeft = 82;
  const padRight = 140;
  const padTop = 34;
  const padBottom = 48;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const yForVal = (v) => padTop + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;

  const gridEls = [];
  for (const tick of scale.ticks) {
    const y = yForVal(tick);
    const isZero = Math.abs(tick) < 0.001;
    gridEls.push(
      `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${padLeft + plotW}" y2="${y.toFixed(1)}" stroke="${isZero ? "#222222" : "#666666"}" stroke-width="${isZero ? "1.3" : "0.9"}"/>`,
      `<text x="${padLeft - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(formatGBP(tick))}</text>`
    );
  }

  const colCount = categories.length;
  const slotW = plotW / Math.max(1, colCount);
  const groupW = Math.min(62, slotW * 0.64);
  const gap = 3;
  const singleBarW = (groupW - gap * (activeSeries.length - 1)) / Math.max(1, activeSeries.length);

  const barEls = [];
  for (let cIdx = 0; cIdx < colCount; cIdx++) {
    const cx = padLeft + slotW * (cIdx + 0.5);
    const startX = cx - groupW / 2;

    activeSeries.forEach((s, sIdx) => {
      const val = s.values[cIdx] || 0;
      if (val <= 0) return;
      const bx = startX + sIdx * (singleBarW + gap);
      const yTop = yForVal(val);
      const yBottom = yForVal(0);
      const h = Math.max(1, yBottom - yTop);
      barEls.push(
        `<rect x="${bx.toFixed(1)}" y="${yTop.toFixed(1)}" width="${singleBarW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.color}"/>`
      );
    });

    barEls.push(
      `<text x="${cx.toFixed(1)}" y="${padTop + plotH + 22}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(categories[cIdx] || "")}</text>`
    );
  }

  const legendEls = [];
  const legendX = padLeft + plotW + 24;
  activeSeries.forEach((s, idx) => {
    const ly = padTop + 10 + idx * 26;
    legendEls.push(
      `<rect x="${legendX}" y="${ly - 11}" width="13" height="13" rx="1.5" fill="${s.color}"/>`,
      `<text x="${legendX + 21}" y="${ly}" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(s.name)}</text>`
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${gridEls.join("\n    ")}
    ${barEls.join("\n    ")}
    ${legendEls.join("\n    ")}
  </svg>`;
}

/**
 * 5. REVENUE & PROFIT OVER TIME (Smooth 3-Line + Linear Trendlines)
 */
export function renderRevenueTrendLineSvg({
  categories = [], // ["Jan 24", "Feb 24", ...]
  series = [], // [{ name: "Total revenue", values: [...] }, { name: "Gross profit", ... }, { name: "Operating profit", ... }]
  width = 1048,
  height = 510,
}) {
  const colors = ["#4472c4", "#ed7d31", "#a5a5a5"];
  const activeSeries = series.map((s, idx) => ({
    name: String(s.name || "").trim(),
    values: (s.values || []).map(parseChartNumber),
    color: s.color || colors[idx % colors.length],
  }));

  const allNums = activeSeries.flatMap((s) => s.values.filter((v) => v !== null));
  const minVal = Math.min(0, ...allNums);
  const maxVal = Math.max(1000, ...allNums);
  const scale = computeNiceAxisScale(minVal, maxVal, true);

  const padLeft = 86;
  const padRight = 28;
  const padTop = 28;
  const padBottom = 86;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const yForVal = (v) => padTop + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const xForIdx = (i) =>
    padLeft + ((i + 0.5) / Math.max(1, categories.length)) * plotW;

  const gridEls = [];
  for (const tick of scale.ticks) {
    const y = yForVal(tick);
    const isZero = Math.abs(tick) < 0.001;
    gridEls.push(
      `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${padLeft + plotW}" y2="${y.toFixed(1)}" stroke="${isZero ? "#222222" : "#cccccc"}" stroke-width="${isZero ? "1.3" : "1"}"/>`,
      `<text x="${padLeft - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(formatGBP(tick))}</text>`
    );
  }

  // X-axis month labels
  const xEls = [];
  categories.forEach((cat, i) => {
    const x = xForIdx(i);
    const parts = String(cat || "").trim().split(/\s+/);
    if (parts.length === 2) {
      xEls.push(
        `<text x="${x.toFixed(1)}" y="${padTop + plotH + 19}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="11.5" fill="#222222">${escapeXml(parts[0])}</text>`,
        `<text x="${x.toFixed(1)}" y="${padTop + plotH + 34}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="11.5" fill="#222222">${escapeXml(parts[1])}</text>`
      );
    } else {
      xEls.push(
        `<text x="${x.toFixed(1)}" y="${padTop + plotH + 20}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="11.5" fill="#222222">${escapeXml(cat)}</text>`
      );
    }
  });

  // Trendlines + Smooth curves
  const trendEls = [];
  const lineEls = [];

  for (const s of activeSeries) {
    const pts = [];
    s.values.forEach((v, i) => {
      if (v !== null) {
        pts.push({ i, v, x: xForIdx(i), y: yForVal(v) });
      }
    });
    if (pts.length >= 2) {
      // Linear least-squares regression over (i, v)
      const n = pts.length;
      const sumX = pts.reduce((a, p) => a + p.i, 0);
      const sumY = pts.reduce((a, p) => a + p.v, 0);
      const sumXY = pts.reduce((a, p) => a + p.i * p.v, 0);
      const sumXX = pts.reduce((a, p) => a + p.i * p.i, 0);
      const denom = n * sumXX - sumX * sumX;
      const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
      const intercept = (sumY - slope * sumX) / n;

      const yStart = yForVal(intercept + slope * (-0.5));
      const yEnd = yForVal(intercept + slope * (categories.length - 0.5));
      trendEls.push(
        `<line x1="${padLeft}" y1="${yStart.toFixed(1)}" x2="${padLeft + plotW}" y2="${yEnd.toFixed(1)}" stroke="${s.color}" stroke-width="1.8" stroke-opacity="0.42"/>`
      );

      const d = buildSmoothSplinePath(pts, 0.22);
      lineEls.push(
        `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
  }

  // Bottom centered legend
  const legendEls = [];
  const itemW = 148;
  const totalLegendW = activeSeries.length * itemW;
  const startLX = (width - totalLegendW) / 2 + 20;
  const legendY = height - 18;

  activeSeries.forEach((s, idx) => {
    const lx = startLX + idx * itemW;
    legendEls.push(
      `<line x1="${lx}" y1="${legendY - 4}" x2="${lx + 14}" y2="${legendY - 4}" stroke="${s.color}" stroke-width="4"/>`,
      `<text x="${lx + 22}" y="${legendY}" font-family="Roboto, Arial, sans-serif" font-size="12" fill="#222222">${escapeXml(s.name)}</text>`
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${gridEls.join("\n    ")}
    ${trendEls.join("\n    ")}
    ${lineEls.join("\n    ")}
    ${xEls.join("\n    ")}
    ${legendEls.join("\n    ")}
  </svg>`;
}

/**
 * 6. CASHFLOW FORECAST LINE CHART (Solid Actual + Dashed Excl/Incl Pipeline)
 */
export function renderCashflowLineSvg({
  categories = [], // ["Jul 2026", ..., "Jun 2027"]
  series = [], // [Actual, Forecast excl pipeline, Forecast incl pipeline]
  width = 1048,
  height = 480,
}) {
  const defaultStyles = [
    { color: "#4472c4", dashed: false },
    { color: "#ff9900", dashed: true },
    { color: "#9900ff", dashed: true },
  ];
  const activeSeries = series.map((s, idx) => ({
    name: String(s.name || "").trim(),
    values: (s.values || []).map(parseChartNumber),
    color: s.color || defaultStyles[idx % defaultStyles.length].color,
    dashed: s.dashed !== undefined ? s.dashed : defaultStyles[idx % defaultStyles.length].dashed,
  }));

  const allNums = activeSeries.flatMap((s) => s.values.filter((v) => v !== null));
  const minVal = Math.min(-20000, ...allNums);
  const maxVal = Math.max(20000, ...allNums);
  const scale = computeNiceAxisScale(minVal, maxVal, true);

  const padLeft = 86;
  const padRight = 28;
  const padTop = 28;
  const padBottom = 80;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const yForVal = (v) => padTop + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const xForIdx = (i) =>
    padLeft + (i / Math.max(1, categories.length - 1)) * plotW;

  const gridEls = [];
  // Vertical gridlines
  categories.forEach((cat, i) => {
    const x = xForIdx(i);
    gridEls.push(
      `<line x1="${x.toFixed(1)}" y1="${padTop}" x2="${x.toFixed(1)}" y2="${padTop + plotH}" stroke="#dddddd" stroke-width="1"/>`
    );
    if (i < categories.length - 1 || categories.length <= 12) {
      gridEls.push(
        `<text x="${x.toFixed(1)}" y="${padTop + plotH + 22}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12.5" fill="#111111">${escapeXml(cat)}</text>`
      );
    }
  });

  // Horizontal gridlines
  for (const tick of scale.ticks) {
    const y = yForVal(tick);
    const isZero = Math.abs(tick) < 0.001;
    gridEls.push(
      `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${padLeft + plotW}" y2="${y.toFixed(1)}" stroke="${isZero ? "#333333" : "#dddddd"}" stroke-width="${isZero ? "1.2" : "1"}"/>`,
      `<text x="${padLeft - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="Arial, sans-serif" font-size="12.5" fill="#111111">${escapeXml(formatGBP(tick))}</text>`
    );
  }

  const lineEls = [];
  for (const s of activeSeries) {
    const pts = [];
    s.values.forEach((v, i) => {
      if (v !== null) {
        pts.push(`${xForIdx(i).toFixed(1)},${yForVal(v).toFixed(1)}`);
      }
    });
    if (pts.length >= 2) {
      const dashAttr = s.dashed ? ` stroke-dasharray="10,7"` : "";
      lineEls.push(
        `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="3.2"${dashAttr} stroke-linejoin="round"/>`
      );
    }
  }

  // Bottom legend
  const legendEls = [];
  const legendY = height - 16;
  const itemsLayout = [
    { x: width / 2 - 220, series: activeSeries[0] },
    { x: width / 2 - 130, series: activeSeries[1] },
    { x: width / 2 + 55, series: activeSeries[2] },
  ];
  for (const item of itemsLayout) {
    if (!item.series) continue;
    const dashAttr = item.series.dashed ? ` stroke-dasharray="7,5"` : "";
    legendEls.push(
      `<line x1="${item.x}" y1="${legendY - 4}" x2="${item.x + 24}" y2="${legendY - 4}" stroke="${item.series.color}" stroke-width="3.5"${dashAttr}/>`,
      `<text x="${item.x + 31}" y="${legendY}" font-family="Arial, sans-serif" font-size="12.5" fill="#222222">${escapeXml(item.series.name)}</text>`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${gridEls.join("\n    ")}
    ${lineEls.join("\n    ")}
    ${legendEls.join("\n    ")}
  </svg>`;
}

/**
 * Extracts all standard Management Report chart definitions & renders SVGs from a 2D MgmtRep display grid.
 */
export function renderMgmtRepChartsFromGrid(mgmtGrid = []) {
  const cell = (r1, c1) => mgmtGrid[r1 - 1]?.[c1 - 1] ?? "";
  const rowSlice = (r1, cStart1, cEnd1) => {
    const out = [];
    for (let c = cStart1; c <= cEnd1; c++) out.push(cell(r1, c));
    return out;
  };

  // Determine active columns in AB18:BZ18 (where row 18 has month headers like "Jan 24" .. "Oct 26")
  const trendMonths = [];
  const trendColIndices1 = [];
  for (let c = 29; c <= 76; c++) {
    const hdr = String(cell(18, c) || "").trim();
    const revCell = String(cell(20, c) || "").trim();
    if (hdr && revCell !== "") {
      trendMonths.push(hdr);
      trendColIndices1.push(c);
    }
  }

  const extractTrendRow = (r1) => trendColIndices1.map((c) => cell(r1, c));

  // 1. Month Snapshot 5 Sparklines (Slide 2)
  const sparkRevenue = renderSparklineSvg({ values: extractTrendRow(20) });
  const sparkGrossProfit = renderSparklineSvg({ values: extractTrendRow(24) });
  const sparkGrossMargin = renderSparklineSvg({ values: extractTrendRow(25) });
  const sparkOpProfit = renderSparklineSvg({ values: extractTrendRow(29) });
  const sparkOpMargin = renderSparklineSvg({ values: extractTrendRow(30) });

  // 2. Slide 4: Income by client for the month (A1450:D1475)
  const monthClientItems = [];
  for (let r = 1450; r <= 1475; r++) {
    const label = String(cell(r, 1) || "").trim();
    const val = parseChartNumber(cell(r, 4));
    if (label && label.toLowerCase() !== "client" && val && val > 0) {
      monthClientItems.push({ label, value: val });
    }
  }
  const chartIncomeByClientMonth = renderPie3DSvg({
    items: monthClientItems,
    labelColor: "#0b5394",
  });

  // 3. Slide 8: YTD revenue breakdown by client Pie (G1450:J1650)
  const ytdClientItems = [];
  for (let r = 1450; r <= 1650; r++) {
    const label = String(cell(r, 7) || "").trim();
    const val = parseChartNumber(cell(r, 10));
    if (label && label.toLowerCase() !== "client" && val && val > 0) {
      ytdClientItems.push({ label, value: val });
    }
  }
  const chartYtdRevenuePie = renderPie3DSvg({
    items: ytdClientItems,
    labelColor: "#1a1a1a",
  });

  // 4. Slide 9: YTD revenue breakdown by client Stacked Column (A1679:M1693)
  const ytdColMonths = [];
  const ytdColIndices = [];
  for (let c = 2; c <= 13; c++) {
    const m = String(cell(1679, c) || "").trim();
    if (m) {
      ytdColMonths.push(m);
      ytdColIndices.push(c);
    }
  }
  const ytdClientSeries = [];
  for (let r = 1680; r <= 1710; r++) {
    const name = String(cell(r, 1) || "").trim();
    if (!name) continue;
    ytdClientSeries.push({
      name,
      values: ytdColIndices.map((c) => cell(r, c)),
    });
  }
  const chartYtdRevenueStacked = renderStackedColumnSvg({
    categories: ytdColMonths,
    series: ytdClientSeries,
    showAxisCurrency: true,
    showZeroBarTotals: false,
  });

  // 5. Slide 11: Revenue and profit over time (AB18:AX29)
  const chartRevenueProfitTrend = renderRevenueTrendLineSvg({
    categories: trendMonths,
    series: [
      { name: String(cell(20, 28) || "Total revenue"), values: extractTrendRow(20), color: "#4472c4" },
      { name: String(cell(24, 28) || "Gross profit"), values: extractTrendRow(24), color: "#ed7d31" },
      { name: String(cell(29, 28) || "Operating profit"), values: extractTrendRow(29), color: "#a5a5a5" },
    ],
  });

  // 6. Slide 12: Targets vs Actual (A801:N803)
  const targetMonths = [];
  const targetColIndices = [];
  for (let c = 2; c <= 14; c++) {
    const m = String(cell(801, c) || "").trim();
    const tVal = parseChartNumber(cell(802, c));
    const aVal = parseChartNumber(cell(803, c));
    if (m && ((tVal && tVal > 0) || (aVal && aVal > 0))) {
      targetMonths.push(m);
      targetColIndices.push(c);
    }
  }
  const chartTargetsVsActual = renderClusteredColumnSvg({
    categories: targetMonths,
    series: [
      { name: String(cell(802, 1) || "Target"), values: targetColIndices.map((c) => cell(802, c)), color: "#4472c4" },
      { name: String(cell(803, 1) || "Actual"), values: targetColIndices.map((c) => cell(803, c)), color: "#ed7d31" },
    ],
  });

  // 7. Slide 13: Cashflow forecast (AC831:AO835)
  const cashMonths = rowSlice(831, 30, 41).map((m) => String(m || "").trim()).filter(Boolean);
  const chartCashflow = renderCashflowLineSvg({
    categories: cashMonths,
    series: [
      { name: String(cell(833, 29) || "Actual"), values: rowSlice(833, 30, 29 + cashMonths.length), color: "#4472c4", dashed: false },
      { name: String(cell(834, 29) || "Forecast excl pipeline"), values: rowSlice(834, 30, 29 + cashMonths.length), color: "#ff9900", dashed: true },
      { name: String(cell(835, 29) || "Forecast incl pipeline"), values: rowSlice(835, 30, 29 + cashMonths.length), color: "#9900ff", dashed: true },
    ],
  });

  // 8. Slide 14 & 15: Bookings per month & by source (12m: A1963:N2004)
  const bookingsMonths = rowSlice(1963, 2, 13).map((m) => String(m || "").trim()).filter(Boolean);
  const bookingsSeries = [];
  const bookingsPieItems = [];
  for (let r = 1964; r <= 2004; r++) {
    const name = String(cell(r, 1) || "").trim();
    if (!name || name.toUpperCase() === "TOTAL") continue;
    const vals = rowSlice(r, 2, 1 + bookingsMonths.length);
    const total12m = parseChartNumber(cell(r, 14)) || 0;
    const color = PULSE_CHART_PALETTE[(r - 1964) % PULSE_CHART_PALETTE.length];
    bookingsSeries.push({ name, values: vals, color });
    if (total12m > 0) {
      bookingsPieItems.push({ label: name, value: total12m, color });
    }
  }
  const chartBookingsPerMonth = renderStackedColumnSvg({
    categories: bookingsMonths,
    series: bookingsSeries,
    showAxisCurrency: false,
    showZeroBarTotals: true,
  });
  const chartBookingsBySource = renderPie3DSvg({
    items: bookingsPieItems,
    labelColor: "#1a1a1a",
  });

  // 9. Slide 16 & 17: Pipeline additions per month & by source (12m: A2269:N2310)
  const pipelineMonths = rowSlice(2269, 2, 13).map((m) => String(m || "").trim()).filter(Boolean);
  const pipelineSeries = [];
  const pipelinePieItems = [];
  for (let r = 2270; r <= 2310; r++) {
    const name = String(cell(r, 1) || "").trim();
    if (!name || name.toUpperCase() === "TOTAL") continue;
    const vals = rowSlice(r, 2, 1 + pipelineMonths.length);
    const total12m = parseChartNumber(cell(r, 14)) || 0;
    const color = PULSE_CHART_PALETTE[(r - 2270) % PULSE_CHART_PALETTE.length];
    pipelineSeries.push({ name, values: vals, color });
    if (total12m > 0) {
      pipelinePieItems.push({ label: name, value: total12m, color });
    }
  }
  const chartPipelinePerMonth = renderStackedColumnSvg({
    categories: pipelineMonths,
    series: pipelineSeries,
    showAxisCurrency: false,
    showZeroBarTotals: true,
  });
  const chartPipelineBySource = renderPie3DSvg({
    items: pipelinePieItems,
    labelColor: "#1a1a1a",
  });

  return [
    {
      id: "sparklines_month",
      slideNumber: 2,
      title: "Month snapshot sparklines",
      chartIds: [1308389059, 207153163, 1552264321, 223244050, 135522675],
      svg: sparkRevenue,
      subSparklines: [
        { label: "Total revenue", chartId: 1308389059, svg: sparkRevenue },
        { label: "Gross profit", chartId: 207153163, svg: sparkGrossProfit },
        { label: "Gross margin %", chartId: 223244050, svg: sparkGrossMargin },
        { label: "Operating profit", chartId: 1552264321, svg: sparkOpProfit },
        { label: "Operating margin %", chartId: 135522675, svg: sparkOpMargin },
      ],
    },
    {
      id: "income_by_client_month",
      slideNumber: 4,
      title: "Income by client for the month",
      chartIds: [937912976, 1438387325],
      svg: chartIncomeByClientMonth,
    },
    {
      id: "ytd_revenue_pie",
      slideNumber: 8,
      title: "YTD revenue breakdown",
      chartIds: [2003233270, 1905480407],
      svg: chartYtdRevenuePie,
    },
    {
      id: "ytd_revenue_by_client_stacked",
      slideNumber: 9,
      title: "YTD revenue breakdown by client",
      chartIds: [218419526, 1233192146],
      svg: chartYtdRevenueStacked,
    },
    {
      id: "revenue_profit_trend",
      slideNumber: 11,
      title: "Revenue and profit over time",
      chartIds: [891278136],
      svg: chartRevenueProfitTrend,
    },
    {
      id: "targets_vs_actual",
      slideNumber: 12,
      title: "Targets vs actual",
      chartIds: [1834105746],
      svg: chartTargetsVsActual,
    },
    {
      id: "cashflow_forecast",
      slideNumber: 13,
      title: "Cashflow forecast",
      chartIds: [1922083043],
      svg: chartCashflow,
    },
    {
      id: "bookings_per_month",
      slideNumber: 14,
      title: "Bookings per month (12m)",
      chartIds: [854929283, 1363474944],
      svg: chartBookingsPerMonth,
    },
    {
      id: "bookings_by_source",
      slideNumber: 15,
      title: "Bookings by source (12m)",
      chartIds: [1829375263, 1167679858],
      svg: chartBookingsBySource,
    },
    {
      id: "pipeline_per_month",
      slideNumber: 16,
      title: "Pipeline additions per month (12m)",
      chartIds: [591554962, 93709752],
      svg: chartPipelinePerMonth,
    },
    {
      id: "pipeline_by_source",
      slideNumber: 17,
      title: "Pipeline additions by source (12m)",
      chartIds: [1403245524, 1524589640],
      svg: chartPipelineBySource,
    },
  ];
}

/**
 * Builds a complete Map<number, { chartId, id, title, svg }> covering all 61 MgmtRep chartIds
 * (including Quarter Snapshot sparklines, 6m/3m/1m Bookings & Pipeline variants, and Retainer/Product line variants)
 * for direct replacement on any client's Google Slides presentation.
 */
export function buildMgmtRepChartIdMapFromGrid(mgmtGrid = []) {
  const map = new Map();
  const cell = (r1, c1) => mgmtGrid[r1 - 1]?.[c1 - 1] ?? "";
  const rowSlice = (r1, cStart1, cEnd1) => {
    const out = [];
    for (let c = cStart1; c <= cEnd1; c++) out.push(cell(r1, c));
    return out;
  };

  // 1. Populate all primary charts & month sparklines
  const mainCharts = renderMgmtRepChartsFromGrid(mgmtGrid);
  for (const ch of mainCharts) {
    if (Array.isArray(ch.subSparklines) && ch.subSparklines.length > 0) {
      for (const sp of ch.subSparklines) {
        map.set(Number(sp.chartId), {
          chartId: Number(sp.chartId),
          id: `${ch.id}_${sp.chartId}`,
          title: sp.label,
          svg: sp.svg,
        });
      }
    } else {
      for (const cid of ch.chartIds || []) {
        map.set(Number(cid), {
          chartId: Number(cid),
          id: ch.id,
          title: ch.title,
          svg: ch.svg,
        });
      }
    }
  }

  // 2. Quarter Snapshot sparklines (rows 35, 39, 40, 44, 45 across cols 29..58)
  const qtrColIndices1 = [];
  for (let c = 29; c <= 58; c++) {
    const hdr = String(cell(33, c) || "").trim();
    const revCell = String(cell(35, c) || "").trim();
    if (hdr && revCell !== "") qtrColIndices1.push(c);
  }
  const extractQtrRow = (r1) => qtrColIndices1.map((c) => cell(r1, c));
  const qtrSparkMap = [
    { chartId: 531345867, label: "Quarterly total revenue", row: 35 },
    { chartId: 478763476, label: "Quarterly gross profit", row: 39 },
    { chartId: 1246520464, label: "Quarterly gross margin %", row: 40 },
    { chartId: 717707403, label: "Quarterly operating profit", row: 44 },
    { chartId: 1026686269, label: "Quarterly operating margin %", row: 45 },
  ];
  for (const qsp of qtrSparkMap) {
    map.set(qsp.chartId, {
      chartId: qsp.chartId,
      id: `sparkline_qtr_${qsp.chartId}`,
      title: qsp.label,
      svg: renderSparklineSvg({ values: extractQtrRow(qsp.row) }),
    });
  }

  // 3. Helper for Bookings & Pipeline 6m / 3m / 1m sub-tables (rows 2057..2098 & 2363..2404)
  const buildSourceSubBlockCharts = ({ headerRow1, startRow1, endRow1, labelCol1, monthStartCol1, monthEndCol1, totalCol1 }) => {
    const months = rowSlice(headerRow1, monthStartCol1, monthEndCol1).map((m) => String(m || "").trim()).filter(Boolean);
    const series = [];
    const pieItems = [];
    for (let r = startRow1; r <= endRow1; r++) {
      const name = String(cell(r, labelCol1) || "").trim();
      if (!name || name.toUpperCase() === "TOTAL") continue;
      const vals = rowSlice(r, monthStartCol1, monthStartCol1 + months.length - 1);
      const tot = parseChartNumber(cell(r, totalCol1)) || 0;
      const color = PULSE_CHART_PALETTE[(r - startRow1) % PULSE_CHART_PALETTE.length];
      series.push({ name, values: vals, color });
      if (tot > 0) pieItems.push({ label: name, value: tot, color });
    }
    return {
      pieSvg: renderPie3DSvg({ items: pieItems, labelColor: "#1a1a1a" }),
      colSvg: renderStackedColumnSvg({ categories: months, series, showAxisCurrency: false, showZeroBarTotals: true }),
    };
  };

  // Bookings 6m (A2057:H2098), 3m (J2057:N2098), 1m (P2057:R2098)
  const b6 = buildSourceSubBlockCharts({ headerRow1: 2057, startRow1: 2058, endRow1: 2098, labelCol1: 1, monthStartCol1: 2, monthEndCol1: 7, totalCol1: 8 });
  for (const cid of [1757937705, 1082681895]) map.set(cid, { chartId: cid, id: "bookings_by_source_6m", title: "Bookings by source (6m)", svg: b6.pieSvg });
  for (const cid of [661522736, 488277794]) map.set(cid, { chartId: cid, id: "bookings_per_month_6m", title: "Bookings per month (6m)", svg: b6.colSvg });

  const b3 = buildSourceSubBlockCharts({ headerRow1: 2057, startRow1: 2058, endRow1: 2098, labelCol1: 10, monthStartCol1: 11, monthEndCol1: 13, totalCol1: 14 });
  for (const cid of [905909944, 81087259]) map.set(cid, { chartId: cid, id: "bookings_by_source_3m", title: "Bookings by source (3m)", svg: b3.pieSvg });
  for (const cid of [757133711, 1765203311]) map.set(cid, { chartId: cid, id: "bookings_per_month_3m", title: "Bookings per month (3m)", svg: b3.colSvg });

  const b1 = buildSourceSubBlockCharts({ headerRow1: 2057, startRow1: 2058, endRow1: 2098, labelCol1: 16, monthStartCol1: 17, monthEndCol1: 17, totalCol1: 18 });
  for (const cid of [1102489229, 1041696950]) map.set(cid, { chartId: cid, id: "bookings_by_source_1m", title: "Bookings by source (1m)", svg: b1.pieSvg });
  for (const cid of [1748368202, 1954004281]) map.set(cid, { chartId: cid, id: "bookings_per_month_1m", title: "Bookings per month (1m)", svg: b1.colSvg });

  // Pipeline 6m (A2363:H2404), 3m (J2363:N2404), 1m (P2363:R2404)
  const p6 = buildSourceSubBlockCharts({ headerRow1: 2363, startRow1: 2364, endRow1: 2404, labelCol1: 1, monthStartCol1: 2, monthEndCol1: 7, totalCol1: 8 });
  for (const cid of [612915003, 1518952767]) map.set(cid, { chartId: cid, id: "pipeline_by_source_6m", title: "Pipeline additions by source (6m)", svg: p6.pieSvg });
  for (const cid of [1243978213, 212713062]) map.set(cid, { chartId: cid, id: "pipeline_per_month_6m", title: "Pipeline additions per month (6m)", svg: p6.colSvg });

  const p3 = buildSourceSubBlockCharts({ headerRow1: 2363, startRow1: 2364, endRow1: 2404, labelCol1: 10, monthStartCol1: 11, monthEndCol1: 13, totalCol1: 14 });
  for (const cid of [80464875, 1098535954]) map.set(cid, { chartId: cid, id: "pipeline_by_source_3m", title: "Pipeline additions by source (3m)", svg: p3.pieSvg });
  for (const cid of [289470252, 853215774]) map.set(cid, { chartId: cid, id: "pipeline_per_month_3m", title: "Pipeline additions per month (3m)", svg: p3.colSvg });

  const p1 = buildSourceSubBlockCharts({ headerRow1: 2363, startRow1: 2364, endRow1: 2404, labelCol1: 16, monthStartCol1: 17, monthEndCol1: 17, totalCol1: 18 });
  for (const cid of [488146559, 1285453777]) map.set(cid, { chartId: cid, id: "pipeline_by_source_1m", title: "Pipeline additions by source (1m)", svg: p1.pieSvg });
  for (const cid of [107213514, 339779597]) map.set(cid, { chartId: cid, id: "pipeline_per_month_1m", title: "Pipeline additions per month (1m)", svg: p1.colSvg });

  return map;
}
