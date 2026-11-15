/**
 * splitHelper.js
 * 
 * Provides unified serialization and parsing for uneven revenue splits across:
 * - PMA Jobs View (UnevenSplitModal.jsx)
 * - PMA Add Job Modal (JobsNewJobModal.jsx)
 * - Pulse Portal Jobs View (PortalJobsView.jsx)
 * 
 * Auto-spread months are preserved with the "(auto)" suffix in the serialized string,
 * e.g. "[Split],Jan-26:4000,Feb-26:2000(auto),Mar-26:2000(auto)".
 * This guarantees that:
 * 1. Financial calculation engines (deepDiveHelper, cashflow) read the exact numeric values via parseMoney.
 * 2. Editing interfaces retain locked vs. auto status when re-opening jobs.
 */

/**
 * Parses an uneven split string into an object of locked months { [monthKey]: lockedAmount }.
 * Unlocked / auto months are NOT included in the returned locked object.
 *
 * @param {string} splitStr - The serialized split string from column AE (e.g. "[Split],Jan-26:4000,Feb-26:2000(auto)")
 * @param {string[]} months - Array of month keys for this job (e.g. ["Jan-26", "Feb-26", "Mar-26"])
 * @param {number} totalRev - Total job revenue
 * @returns {Object.<string, number>} - Object mapping lowercase month key (e.g. "jan-26") to locked float amount
 */
export function parseSplitString(splitStr, months = [], totalRev = 0) {
  if (!splitStr || !String(splitStr).toLowerCase().trim().startsWith("[split]")) {
    return {};
  }

  const rawParts = String(splitStr).split(",");
  const parsed = {};
  let hasAnyAutoTag = false;

  rawParts.forEach((p) => {
    const match = p.match(/([a-zA-Z]{3}-\d{2})\s*:\s*([^,]+)/);
    if (match) {
      const mKey = match[1].toLowerCase().trim();
      const valRaw = String(match[2]).trim();

      if (valRaw.toLowerCase().includes("auto")) {
        hasAnyAutoTag = true;
        // Auto month: explicitly do not lock
      } else {
        const num = parseFloat(valRaw.replace(/[^0-9.-]/g, ""));
        if (!isNaN(num)) {
          parsed[mKey] = num;
        }
      }
    }
  });

  // If the serialized split string explicitly used "(auto)" tags, respect it directly
  if (hasAnyAutoTag) {
    return parsed;
  }

  // Fallback for legacy splits saved without "(auto)" tags where all months were serialized:
  // If all job months are present in parsed, detect if a subset of months share identical
  // values that equal the auto-spread of the remaining revenue.
  if (months.length > 0 && totalRev > 0) {
    const monthKeys = months.map((m) => m.toLowerCase());
    const allPresent = monthKeys.every((k) => parsed[k] !== undefined);

    if (allPresent) {
      // Check if all months are completely identical (i.e. even split throughout)
      const uniqueVals = new Set(monthKeys.map((k) => Math.round(parsed[k] * 100) / 100));
      if (uniqueVals.size === 1) {
        // All months are even - none were manually locked!
        return {};
      }

      // Check for a group of identical remaining values matching the auto-distribution
      const valCounts = {};
      monthKeys.forEach((k) => {
        const rounded = Math.round(parsed[k] * 100) / 100;
        valCounts[rounded] = (valCounts[rounded] || 0) + 1;
      });

      for (const [valStr, count] of Object.entries(valCounts)) {
        if (count >= 2 && count < monthKeys.length) {
          const candidateVal = parseFloat(valStr);
          let otherSum = 0;
          monthKeys.forEach((k) => {
            if (Math.round(parsed[k] * 100) / 100 !== candidateVal) {
              otherSum += parsed[k];
            }
          });

          const rem = totalRev - otherSum;
          const expectedAuto = Math.round((rem / count) * 100) / 100;
          if (Math.abs(expectedAuto - candidateVal) < 0.05) {
            // These candidate months were the auto-distributed ones
            const cleaned = { ...parsed };
            monthKeys.forEach((k) => {
              if (Math.round(parsed[k] * 100) / 100 === candidateVal) {
                delete cleaned[k];
              }
            });
            return cleaned;
          }
        }
      }
    }
  }

  return parsed;
}

const SPLIT_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Parses a month/date string ("Feb-27", "2027-02", "15-Feb-27", "2027-02-15") into { year, monthIdx, label: "Mmm-YY" }.
 */
export function parseMonthLabel(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let m = s.match(/^(?:(\d{1,2})[-/\s])?([A-Za-z]{3})[-/\s](\d{2,4})$/);
  if (m) {
    const mIdx = SPLIT_MONTH_NAMES.findIndex((nm) => nm.toLowerCase() === m[2].toLowerCase());
    if (mIdx >= 0) {
      const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
      return { year: yr, monthIdx: mIdx, label: `${SPLIT_MONTH_NAMES[mIdx]}-${String(yr).slice(-2)}` };
    }
  }

  m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) {
    const yr = parseInt(m[1], 10);
    const mIdx = parseInt(m[2], 10) - 1;
    if (mIdx >= 0 && mIdx < 12) {
      return { year: yr, monthIdx: mIdx, label: `${SPLIT_MONTH_NAMES[mIdx]}-${String(yr).slice(-2)}` };
    }
  }

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const mIdx = parseInt(m[2], 10) - 1;
    const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    if (mIdx >= 0 && mIdx < 12) {
      return { year: yr, monthIdx: mIdx, label: `${SPLIT_MONTH_NAMES[mIdx]}-${String(yr).slice(-2)}` };
    }
  }

  const d = raw instanceof Date ? raw : null;
  if (d && !isNaN(d.getTime())) {
    const yr = d.getFullYear();
    const mIdx = d.getMonth();
    return { year: yr, monthIdx: mIdx, label: `${SPLIT_MONTH_NAMES[mIdx]}-${String(yr).slice(-2)}` };
  }
  return null;
}

/**
 * Extracts ordered month entries [{ month, mKey, amount }] from a "[Split],Feb-27:1500,..." string.
 */
export function extractSplitMonths(splitStr) {
  if (!splitStr || !String(splitStr).toLowerCase().trim().startsWith("[split]")) {
    return [];
  }
  const results = [];
  for (const part of String(splitStr).split(",")) {
    const match = part.match(/([A-Za-z]{3}-\d{2})\s*:\s*([^,]+)/);
    if (!match) continue;
    const parsed = parseMonthLabel(match[1]);
    const label = parsed ? parsed.label : match[1].trim();
    const num = parseFloat(String(match[2]).replace(/[^0-9.-]/g, ""));
    results.push({
      month: label,
      mKey: label.toLowerCase(),
      amount: Number.isFinite(num) ? Math.round(num * 100) / 100 : 0,
    });
  }
  return results;
}

/**
 * Generates an inclusive list of "Mmm-YY" month labels between startVal and endOrCount (label or count).
 */
export function generateMonthSpan(startVal, endOrCount = 2) {
  const start = parseMonthLabel(startVal) || parseMonthLabel(new Date());
  if (!start) return [];

  const startIdx = start.year * 12 + start.monthIdx;
  let totalMonths = 2;
  if (typeof endOrCount === "number" && Number.isFinite(endOrCount)) {
    totalMonths = Math.max(1, Math.min(36, Math.round(endOrCount)));
  } else {
    const end = parseMonthLabel(endOrCount);
    if (end) {
      const endIdx = end.year * 12 + end.monthIdx;
      totalMonths = Math.max(1, Math.min(36, (endIdx - startIdx) + 1));
    }
  }

  const months = [];
  for (let i = 0; i < totalMonths; i++) {
    const d = new Date(start.year, start.monthIdx + i, 1);
    months.push(`${SPLIT_MONTH_NAMES[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`);
  }
  return months;
}

/**
 * Formats locked and auto-distributed months into the standard [Split] string.
 *
 * @param {string[]} months - Array of month labels (e.g. ["Jan-26", "Feb-26"])
 * @param {Object.<string, number>} validLocked - Object of locked month amounts { "jan-26": 4000 }
 * @param {number} evenSplit - Current auto-spread amount for unlocked months
 * @param {{ omitAutoTag?: boolean }} [options]
 * @returns {string} - Formatted string, e.g. "[Split],Jan-26:4000,Feb-26:2000(auto)"
 */
export function formatSplitString(months, validLocked, evenSplit, { omitAutoTag = false } = {}) {
  if (!months || months.length === 0) return "";
  let str = "[Split]";
  months.forEach((m) => {
    const mKey = m.toLowerCase();
    const isLocked = validLocked[mKey] !== undefined;
    const val = isLocked ? validLocked[mKey] : evenSplit;
    const cleanVal = Number.isInteger(val) ? val : Math.round(val * 100) / 100;

    if (isLocked || omitAutoTag) {
      str += `,${m}:${cleanVal}`;
    } else {
      str += `,${m}:${cleanVal}(auto)`;
    }
  });
  return str;
}
