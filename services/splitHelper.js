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

/**
 * Formats locked and auto-distributed months into the standard [Split] string.
 *
 * @param {string[]} months - Array of month labels (e.g. ["Jan-26", "Feb-26"])
 * @param {Object.<string, number>} validLocked - Object of locked month amounts { "jan-26": 4000 }
 * @param {number} evenSplit - Current auto-spread amount for unlocked months
 * @returns {string} - Formatted string, e.g. "[Split],Jan-26:4000,Feb-26:2000(auto)"
 */
export function formatSplitString(months, validLocked, evenSplit) {
  if (!months || months.length === 0) return "";
  let str = "[Split]";
  months.forEach((m) => {
    const mKey = m.toLowerCase();
    const isLocked = validLocked[mKey] !== undefined;
    const val = isLocked ? validLocked[mKey] : evenSplit;
    const cleanVal = Number.isInteger(val) ? val : Math.round(val * 100) / 100;

    if (isLocked) {
      str += `,${m}:${cleanVal}`;
    } else {
      str += `,${m}:${cleanVal}(auto)`;
    }
  });
  return str;
}
