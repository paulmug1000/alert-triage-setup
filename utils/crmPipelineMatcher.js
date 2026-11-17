/**
 * Shared blank-Project-code matching helper for linking CRM deals (Excel, Google Sheet,
 * or external CRMs) to pre-existing Client Sheet Pipeline rows without creating duplicates.
 *
 * Matching invariants:
 * - Only Pipeline parent rows with a strictly blank Project code are eligible.
 * - Client AND Job must both qualify (never Client-only), corroborated by Revenue / Dates
 *   when names are fuzzy rather than exact.
 * - Automatic linking ("clear") requires strict 1-to-1 uniqueness (no close tie on
 *   either the CRM deal or the Pipeline row).
 */

const LEGAL_SUFFIX_RE = /\b(ltd|limited|inc|incorporated|llc|llp|corp|corporation|plc|company|co\.?\s*ltd)\b$/g;

const MONTHS_MAP = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

export function normalizeMatchText(str) {
  return String(str ?? "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeCompactKey(str) {
  return normalizeMatchText(str).replace(/\s+/g, "");
}

export function normalizeClientKey(str) {
  let cleaned = normalizeMatchText(str);
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(LEGAL_SUFFIX_RE, "").trim();
  } while (cleaned !== prev);
  return cleaned.replace(/\s+/g, "");
}

export function parseComparableNumber(val) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  const str = String(val).trim();
  if (!str) return null;
  if (/[a-z]/i.test(str.replace(/\b(gbp|usd|eur|k|m)\b/gi, ""))) return null;
  const cleaned = str.replace(/[£$€,\s]/g, "");
  if (!/^[-+]?\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function parseComparableLikelihood(val) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return null;
    return val > 1 && val <= 100 ? val / 100 : val;
  }
  const str = String(val).trim();
  if (!str) return null;
  const hasPct = str.includes("%");
  const num = parseComparableNumber(str.replace(/%/g, ""));
  if (num === null) return null;
  if (hasPct || (num > 1 && num <= 100)) return num / 100;
  return num;
}

export function parseComparableDateYmd(val) {
  if (val === null || val === undefined || val === "") return null;
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === "number" && val > 20000 && val < 70000) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(val) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  if (!str) return null;
  if (/^\d{5}(\.\d+)?$/.test(str)) {
    const n = Number(str);
    if (n > 20000 && n < 70000) {
      const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
      return new Date(ms).toISOString().slice(0, 10);
    }
  }
  const iso = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  }
  const dMonY = str.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{2,4})$/);
  if (dMonY) {
    const mIdx = MONTHS_MAP[dMonY[2].toLowerCase()];
    if (mIdx !== undefined) {
      let yr = parseInt(dMonY[3], 10);
      if (dMonY[3].length === 2) yr += yr > 50 ? 1900 : 2000;
      const day = String(parseInt(dMonY[1], 10)).padStart(2, "0");
      return `${yr}-${String(mIdx + 1).padStart(2, "0")}-${day}`;
    }
  }
  const dmy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (dmy) {
    let yr = parseInt(dmy[3], 10);
    if (dmy[3].length === 2) yr += yr > 50 ? 1900 : 2000;
    const p1 = parseInt(dmy[1], 10);
    const p2 = parseInt(dmy[2], 10);
    // UK DD/MM/YYYY default unless second part > 12
    const day = p2 > 12 ? p2 : p1;
    const mon = p2 > 12 ? p1 : p2;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return `${yr}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function tokenJaccard(textA, textB) {
  const tokensA = new Set(textA.split(" ").filter((t) => t.length >= 2));
  const tokensB = new Set(textB.split(" ").filter((t) => t.length >= 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let inter = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) inter++;
  }
  const union = tokensA.size + tokensB.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Scores a CRM deal against a blank-Project-code Pipeline row.
 * Returns null if Client or Job fail to qualify.
 */
export function scoreCrmPipelinePair(crmDeal, pipeRow) {
  const cText1 = normalizeMatchText(crmDeal?.client);
  const cText2 = normalizeMatchText(pipeRow?.client);
  const cKey1 = normalizeClientKey(crmDeal?.client);
  const cKey2 = normalizeClientKey(pipeRow?.client);

  let clientPoints = 0;
  let exactClient = false;
  if (cText1 && cText2 && cText1 === cText2) {
    clientPoints = 3;
    exactClient = true;
  } else if (cKey1 && cKey2 && cKey1 === cKey2) {
    clientPoints = 2;
  } else {
    return null;
  }

  const jText1 = normalizeMatchText(crmDeal?.job);
  const jText2 = normalizeMatchText(pipeRow?.job);
  const jCompact1 = normalizeCompactKey(crmDeal?.job);
  const jCompact2 = normalizeCompactKey(pipeRow?.job);

  let jobPoints = 0;
  let exactJob = false;
  if (jCompact1 && jCompact2 && jCompact1 === jCompact2) {
    jobPoints = 5;
    exactJob = true;
  } else if (jText1 && jText2) {
    const minLen = Math.min(jText1.length, jText2.length);
    const contains = minLen >= 4 && (jText1.includes(jText2) || jText2.includes(jText1));
    const jaccard = tokenJaccard(jText1, jText2);
    if (contains || jaccard >= 0.75) {
      jobPoints = 3;
    } else {
      return null;
    }
  } else {
    return null;
  }

  const reasons = [
    exactClient ? "Exact client" : "Fuzzy client",
    exactJob ? "Exact job" : "Similar job",
  ];

  let score = clientPoints + jobPoints;
  let matchedRevenue = false;
  let matchedStartDate = false;

  const rev1 = parseComparableNumber(crmDeal?.revenue);
  const rev2 = parseComparableNumber(pipeRow?.revenue);
  if (rev1 !== null && rev2 !== null && rev1 > 0 && rev2 > 0 && Math.abs(rev1 - rev2) <= 1) {
    score += 3;
    matchedRevenue = true;
    reasons.push("Revenue matches");
  }

  const start1 = parseComparableDateYmd(crmDeal?.startDate);
  const start2 = parseComparableDateYmd(pipeRow?.startDate);
  if (start1 && start2 && start1 === start2) {
    score += 2;
    matchedStartDate = true;
    reasons.push("Start date matches");
  }

  const end1 = parseComparableDateYmd(crmDeal?.endDate);
  const end2 = parseComparableDateYmd(pipeRow?.endDate);
  if (end1 && end2 && end1 === end2) {
    score += 1;
    reasons.push("End date matches");
  }

  const like1 = parseComparableLikelihood(crmDeal?.likelihood);
  const like2 = parseComparableLikelihood(pipeRow?.likelihood);
  if (like1 !== null && like2 !== null && Math.abs(like1 - like2) < 0.01) {
    score += 1;
    reasons.push("Likelihood matches");
  }

  const isClearQualifying =
    (exactClient && exactJob && score >= 8) ||
    (!exactJob && (matchedRevenue || matchedStartDate) && score >= 7) ||
    (!exactClient && exactJob && (matchedRevenue || matchedStartDate) && score >= 7);

  return {
    score,
    exactClient,
    exactJob,
    matchedRevenue,
    matchedStartDate,
    isClearQualifying,
    reasons,
  };
}

/**
 * Matches unlinked CRM deals against Pipeline parent rows that have blank Project codes.
 * Classifies unambiguous high-confidence 1-to-1 pairs into `clearMatches` and
 * lower-confidence or tied candidates into `possibleMatches`.
 */
export function findBlankCodePipelineMatches({ crmDeals = [], pipelineRows = [] }) {
  const existingCodes = new Set(
    pipelineRows
      .map((r) => String(r?.projectCode || "").trim().toUpperCase())
      .filter(Boolean)
  );

  const alreadyLinked = [];
  const eligibleCrm = [];
  for (const d of crmDeals) {
    const code = String(d?.projectCode || "").trim();
    if (!code) continue;
    if (existingCodes.has(code.toUpperCase())) {
      alreadyLinked.push(d);
    } else {
      eligibleCrm.push(d);
    }
  }

  const eligiblePipe = pipelineRows.filter(
    (r) => !String(r?.projectCode || "").trim() && (String(r?.client || "").trim() || String(r?.job || "").trim())
  );

  const scoredPairs = [];
  for (let cIdx = 0; cIdx < eligibleCrm.length; cIdx++) {
    for (let pIdx = 0; pIdx < eligiblePipe.length; pIdx++) {
      const detail = scoreCrmPipelinePair(eligibleCrm[cIdx], eligiblePipe[pIdx]);
      if (detail) {
        scoredPairs.push({ cIdx, pIdx, ...detail });
      }
    }
  }

  scoredPairs.sort((a, b) => b.score - a.score);

  const matchedCrm = new Set();
  const matchedPipe = new Set();
  const clearMatches = [];
  const possibleMatches = [];

  for (const pair of scoredPairs) {
    if (matchedCrm.has(pair.cIdx) || matchedPipe.has(pair.pIdx)) continue;

    // Check competing unassigned candidates within 2 points on either side
    const competingCrmSide = scoredPairs.some(
      (other) =>
        other !== pair &&
        other.cIdx === pair.cIdx &&
        !matchedPipe.has(other.pIdx) &&
        other.score >= pair.score - 2
    );
    const competingPipeSide = scoredPairs.some(
      (other) =>
        other !== pair &&
        other.pIdx === pair.pIdx &&
        !matchedCrm.has(other.cIdx) &&
        other.score >= pair.score - 2
    );

    const isUnique = !competingCrmSide && !competingPipeSide;
    matchedCrm.add(pair.cIdx);
    matchedPipe.add(pair.pIdx);

    const entry = {
      crmDeal: eligibleCrm[pair.cIdx],
      pipelineRow: eligiblePipe[pair.pIdx],
      score: pair.score,
      confidence: pair.isClearQualifying && isUnique ? "clear" : isUnique ? "possible" : "ambiguous",
      reasons: isUnique ? pair.reasons : [...pair.reasons, "Multiple similar jobs found"],
    };

    if (entry.confidence === "clear") {
      clearMatches.push(entry);
    } else {
      possibleMatches.push(entry);
    }
  }

  const unmatchedCrmDeals = eligibleCrm.filter((_, idx) => !matchedCrm.has(idx));

  return {
    alreadyLinked,
    clearMatches,
    possibleMatches,
    unmatchedCrmDeals,
    eligiblePipeCount: eligiblePipe.length,
  };
}
