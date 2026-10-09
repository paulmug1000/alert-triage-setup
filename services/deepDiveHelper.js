/**
 * deepDiveHelper.js
 * Universal Math Engine & Deep Dive Aggregation matching client-GAS-scripts/WebApp.html
 */

export function getCurrencySymbol(customSymbol) {
  if (customSymbol && typeof customSymbol === "string" && customSymbol.trim()) return customSymbol.trim();
  if (typeof window !== "undefined") {
    return window.currencySymbol || (function () {
      try { return localStorage.getItem("pulse_currency_symbol"); } catch {} return null;
    })() || "£";
  }
  return "£";
}

export function getThousandsSeparator(customSeparator) {
  if (customSeparator && typeof customSeparator === "string" && customSeparator.trim()) return customSeparator.trim();
  if (typeof window !== "undefined") {
    return window.thousandsSeparator || (function () {
      try { return localStorage.getItem("pulse_thousands_separator"); } catch {} return null;
    })() || ",";
  }
  return ",";
}

export function parseMoney(val, customThousandsSep) {
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  if (!val && val !== 0) return 0;
  const rawStr = String(val).trim();
  if (!rawStr || rawStr === "—" || rawStr === "–" || rawStr === "-") return 0;

  const isNeg = rawStr.includes("-") || (rawStr.startsWith("(") && rawStr.endsWith(")"));
  let str = rawStr.replace(/[^0-9.,]/g, ""); // Keep only digits and potential separators
  if (!str) return 0;

  const thousandsSep = customThousandsSep || getThousandsSeparator();
  const lastComma = str.lastIndexOf(",");
  const lastDot = str.lastIndexOf(".");

  let result = 0;

  // Case 1: Both comma and dot exist -> the last one is always the decimal separator
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastDot > lastComma) {
      // UK/US standard: 1,234.56 or 10,970.83333 -> comma is thousands, dot is decimal
      const wholePart = str.substring(0, lastDot).replace(/,/g, "");
      const decPart = str.substring(lastDot + 1);
      result = parseFloat(wholePart + "." + decPart) || 0;
    } else {
      // European standard: 1.234,56 -> dot is thousands, comma is decimal
      const wholePart = str.substring(0, lastComma).replace(/\./g, "");
      const decPart = str.substring(lastComma + 1);
      result = parseFloat(wholePart + "." + decPart) || 0;
    }
  } else if (lastDot !== -1) {
    // Case 2: Only dot exists
    const dotCount = (str.match(/\./g) || []).length;
    if (dotCount > 1) {
      // Multiple dots: e.g. 1.000.000 -> thousands separator
      result = parseFloat(str.replace(/\./g, "")) || 0;
    } else {
      const charsAfter = str.length - 1 - lastDot;
      // Single dot: e.g. 10970.83333 -> decimal point unless explicitly European '.' separator with exactly 3 digits
      if (thousandsSep === "." && charsAfter === 3) {
        result = parseFloat(str.replace(/\./g, "")) || 0;
      } else {
        result = parseFloat(str) || 0;
      }
    }
  } else if (lastComma !== -1) {
    // Case 3: Only comma exists
    const commaCount = (str.match(/,/g) || []).length;
    if (commaCount > 1) {
      result = parseFloat(str.replace(/,/g, "")) || 0;
    } else {
      const charsAfter = str.length - 1 - lastComma;
      if (thousandsSep === "." || charsAfter === 1 || charsAfter === 2) {
        const wholePart = str.substring(0, lastComma);
        const decPart = str.substring(lastComma + 1);
        result = parseFloat(wholePart + "." + decPart) || 0;
      } else {
        result = parseFloat(str.replace(/,/g, "")) || 0;
      }
    }
  } else {
    // Case 4: No separators
    result = parseFloat(str) || 0;
  }

  return isNeg ? -Math.abs(result) : result;
}

export function formatMoney(val, decimals = 0, customSymbol, customSeparator) {
  const sym = getCurrencySymbol(customSymbol);
  const sep = getThousandsSeparator(customSeparator);
  if (val === null || val === undefined || val === "" || val === "—") return `${sym}0`;
  const num = typeof val === "number" ? val : parseMoney(val, sep);
  if (isNaN(num)) return `${sym}0`;

  const sign = num < 0 ? "-" : "";
  const absNum = Math.abs(num);
  const decimalSep = sep === "." ? "," : ".";
  const parts = (decimals > 0 ? absNum.toFixed(decimals) : Math.round(absNum).toString()).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return `${sign}${sym}${parts.join(decimalSep)}`;
}

/**
 * Universal Currency Interceptor matching client-GAS-scripts/WebApp.html (lines 10181, 12450, 15082)
 * If the spreadsheet sends a raw currency string (e.g. "£49,257", "£48,500.00", "-£1,000", "(£2,500)"),
 * intercepts and converts it to the tenant's chosen currency symbol and thousands separator.
 */
export function formatCurrencyString(val, decimals = null, customSymbol, customSeparator) {
  if (val === null || val === undefined) return "";
  if (typeof val === "number") {
    return formatMoney(val, decimals !== null ? decimals : (Math.abs(val % 1) > 0 ? 2 : 0), customSymbol, customSeparator);
  }
  const str = String(val).trim();
  if (!str || str === "—") return str;
  if (/^-?[£$€¥]/.test(str) || /^[£$€¥]/.test(str) || /^\(?[£$€¥]/.test(str)) {
    const parsed = parseMoney(str, customSeparator);
    const hasDecimals = decimals !== null ? decimals > 0 : Math.abs(parsed % 1) > 0;
    return formatMoney(parsed, hasDecimals ? 2 : 0, customSymbol, customSeparator);
  }
  return str;
}

export function parseLikelihood(likelihoodVal, fallback = 0.5) {
  if (typeof likelihoodVal === "number" && !isNaN(likelihoodVal)) {
    return likelihoodVal > 1 ? likelihoodVal / 100 : likelihoodVal;
  }
  const rawStr = String(likelihoodVal || "").trim();
  if (!rawStr) return fallback;
  const parsed = parseFloat(rawStr.replace("%", ""));
  if (isNaN(parsed)) return fallback;
  if (rawStr.includes("%") || parsed >= 1) {
    return parsed / 100;
  }
  return parsed;
}

export const PulseMath = {
  calcMonthly(job, targetDate, valueType = "revenue", isIncomeMode = false) {
    if (!job || !targetDate) return 0;
    const eqStart = job.eqStartDate ? new Date(job.eqStartDate) : (job.startDate ? new Date(job.startDate) : null);
    const eqEnd = job.erEndDate ? new Date(job.erEndDate) : (job.endDate ? new Date(job.endDate) : null);
    if (!eqStart || !eqEnd || isNaN(eqStart.getTime()) || isNaN(eqEnd.getTime())) return 0;

    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();
    const tStart = new Date(targetYear, targetMonth, 1);
    const tEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);

    const isRetainer =
      String(job.projectRetainer || "").toLowerCase().includes("retainer") ||
      String(job.type || "").toLowerCase().includes("retainer");
    const isPipeline = String(job.type || "").toLowerCase() === "pipeline";
    const hasSplit = String(job.hasSplit || "").toLowerCase() === "true";

    const hasChildRetainers = isRetainer && Array.isArray(job.childRetainers) && job.childRetainers.length > 0;
    const withinParentDates = (eqEnd >= tStart && eqStart <= tEnd);

    // Strict boundary enforcement: must be within parent dates OR covered by child retainers
    if (!withinParentDates && !hasChildRetainers) return 0;

    // --- RESTORED SPLIT LOGIC ---
    if (hasSplit && !isRetainer && job.splitStr) {
      const splitStr = String(job.splitStr || "").trim();
      const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const mStr = `${monthNames[targetMonth]}-${String(targetYear).slice(-2)}`;
      const regex = new RegExp(`${mStr}\\s*:\\s*([^,]+)`, "i");
      const match = splitStr.match(regex);
      let splitRevVal = match ? parseMoney(match[1]) : 0;

      let unadjustedRawRev = parseMoney(job.totalAmount || job.totalRev || job.revenue);
      let rawDC = parseMoney(job.totalDC || job.directCosts);
      let prop = unadjustedRawRev !== 0 ? rawDC / unadjustedRawRev : 0;

      let valToReturn = 0;
      if (valueType === "directCosts") {
        valToReturn = splitRevVal * prop;
      } else {
        valToReturn = isIncomeMode ? splitRevVal - splitRevVal * prop : splitRevVal;
      }

      if (isPipeline) {
        let prob = parseLikelihood(job.likelihoodNum !== undefined ? job.likelihoodNum : job.likelihood, 1);
        if (prob < 0 || prob > 1) prob = 1;
        valToReturn = valToReturn * prob;
      }

      return valToReturn;
    }

    // --- RETAINER LOGIC (Matches Calcs!K2 & Calcs!L2 ret_sum) ---
    if (isRetainer) {
      let prob = 1;
      if (isPipeline) {
        prob = parseLikelihood(job.likelihoodNum !== undefined ? job.likelihoodNum : job.likelihood, 0.5);
      }

      // Check if any child invoice covers targetDate (New formula recognition)
      let activeChildSum = 0;
      let hasActiveChild = false;

      if (hasChildRetainers) {
        const tY = targetDate.getFullYear();
        const tM = targetDate.getMonth();
        const targetMonthIdx = tY * 12 + tM;

        for (const cr of job.childRetainers) {
          const cStart = cr.startMonth ? new Date(cr.startMonth) : null;
          const cEnd = cr.endMonth ? new Date(cr.endMonth) : null;
          if (cStart && cEnd && !isNaN(cStart.getTime()) && !isNaN(cEnd.getTime())) {
            const cStartIdx = cStart.getFullYear() * 12 + cStart.getMonth();
            const cEndIdx = cEnd.getFullYear() * 12 + cEnd.getMonth();
            if (targetMonthIdx >= cStartIdx && targetMonthIdx <= cEndIdx) {
              hasActiveChild = true;
              if (valueType === "directCosts") {
                activeChildSum += (cr.dcPm || 0) * prob;
              } else if (valueType === "revenue") {
                const val = isIncomeMode ? (cr.incPm || (cr.revPm - (cr.dcPm || 0))) : cr.revPm;
                activeChildSum += val * prob;
              }
            }
          }
        }
      }

      if (hasActiveChild) {
        return activeChildSum;
      }

      // Fallback: If no active child invoice for this month, use parent planned retainer fee if within parent contract dates
      if (!withinParentDates) return 0;

      const rev = parseMoney(job.revenue || job.revNum);
      const dc = parseMoney(job.directCosts || job.dcNum);
      const retRev = rev * prob;
      const retDC = dc * prob;
      const retIncome = retRev - retDC;

      if (valueType === "directCosts") return retDC;
      if (valueType === "revenue") {
        return isIncomeMode ? retIncome : retRev;
      }
      return 0;
    }

    // --- STANDARD PROJECT LOGIC (Matches Calcs!K2 std_sum) ---
    let origBaseRev = parseMoney(job.origBaseRev);
    let origBaseIncome = parseMoney(job.origBaseIncome);
    let origBaseDC = origBaseRev - origBaseIncome;

    if (origBaseRev === 0 && origBaseIncome === 0) {
      // Fallback if spreadsheet helper columns are missing for this row
      const rev = parseMoney(job.revenue || job.revNum);
      const dc = parseMoney(job.directCosts || job.dcNum);
      let prob = 1;
      if (isPipeline) {
        prob = parseLikelihood(job.likelihoodNum !== undefined ? job.likelihoodNum : job.likelihood, 0.5);
      }
      const totalMonths = Math.max(1, (eqEnd.getFullYear() - eqStart.getFullYear()) * 12 + (eqEnd.getMonth() - eqStart.getMonth()) + 1);
      origBaseRev = (rev / totalMonths) * prob;
      origBaseIncome = ((rev - dc) / totalMonths) * prob;
      origBaseDC = (dc / totalMonths) * prob;
    }

    if (valueType === "directCosts") return origBaseDC;
    if (valueType === "revenue") {
      return isIncomeMode ? origBaseIncome : origBaseRev;
    }
    return 0;
  },
};

export const DeepDiveEngine = {
  parseHeaderDate(str) {
    if (!str) return null;
    if (str instanceof Date && !isNaN(str.getTime())) return str;
    const match = String(str).match(/([a-zA-Z]{3,})\s*[\-\s]?\s*(\d{2,4})/);
    if (match) {
      const monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const m = monthMap[match[1].toLowerCase().substring(0, 3)];
      let y = parseInt(match[2], 10);
      if (y < 100) y += 2000;
      if (m !== undefined && !isNaN(y)) return new Date(y, m, 1);
    }
    const ukMatch = String(str).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (ukMatch) {
      return new Date(parseInt(ukMatch[3], 10), parseInt(ukMatch[2], 10) - 1, parseInt(ukMatch[1], 10));
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  },

  formatShortDate(dateVal) {
    if (!dateVal) return "—";
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
  },

  aggregatePeriods(targetDate, numPeriods, fetchCallback) {
    const aggregatedMap = new Map();
    const startYear = targetDate.getFullYear();
    const startMonth = targetDate.getMonth();

    for (let i = 0; i < numPeriods; i++) {
      const currentMonthDate = new Date(startYear, startMonth + i, 1);
      const monthlyData = fetchCallback(currentMonthDate);

      monthlyData.forEach((item) => {
        const key = `${item.client || ""}|${item.name || item.role || "Unknown"}|${item.status || item.type || ""}`;
        if (!aggregatedMap.has(key)) {
          aggregatedMap.set(key, JSON.parse(JSON.stringify(item)));
        } else {
          const existing = aggregatedMap.get(key);
          existing.amount += item.amount;
        }
      });
    }

    return Array.from(aggregatedMap.values()).sort((a, b) => {
      const cmp = String(a.client || "").localeCompare(String(b.client || ""));
      if (cmp !== 0) return cmp;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  },

  getJobsForMonth(allJobs, targetDate, type, isIncomeMode = false, isScenarioView = false, scenariosConfig = null) {
    let results = [];
    if (!allJobs || allJobs.length === 0) return results;

    const confirmedJobs = (isScenarioView && scenariosConfig?.confirmedJobs) || new Set();
    const disabledJobs = (isScenarioView && scenariosConfig?.disabledJobs) || new Set();

    allJobs.forEach((job) => {
      let effectiveType = String(job.type || "").toLowerCase();
      let isAssumedConfirmed = false;

      if (isScenarioView && scenariosConfig) {
        const pId = Number(job.parentId !== undefined ? job.parentId : (job.rowNumber ? job.rowNumber - 2 : job.id));
        if (disabledJobs.has(job.id) || disabledJobs.has(pId)) {
          return;
        }
        if (confirmedJobs.has(job.id) || confirmedJobs.has(pId)) {
          effectiveType = "confirmed";
          if (String(job.type || "").toLowerCase() === "pipeline") {
            isAssumedConfirmed = true;
          }
        }
      }

      if (type === "confRev" && effectiveType === "pipeline") return;
      if (type === "pipeRev" && effectiveType !== "pipeline") return;

      const valueType = type === "dirCosts" ? "directCosts" : "revenue";
      let monthlyAmount = PulseMath.calcMonthly(job, targetDate, valueType, isIncomeMode);

      if (isAssumedConfirmed) {
        let prob = 1;
        if (job.likelihoodNum !== undefined && !isNaN(job.likelihoodNum)) {
          prob = job.likelihoodNum;
        } else if (job.likelihood) {
          prob = parseLikelihood(job.likelihood, 1);
        }
        if (prob <= 0 || prob > 1) prob = 1;
        monthlyAmount = prob > 0 ? (monthlyAmount / prob) : 0;
      }

      if (Math.abs(monthlyAmount) >= 0.01) {
        let rawAmount = 0;
        if (type === "dirCosts") {
          rawAmount = parseMoney(job.directCosts);
        } else {
          rawAmount = isIncomeMode
            ? parseMoney(job.revenue) - parseMoney(job.directCosts)
            : parseMoney(job.revenue);
        }

        const isRetainer = String(job.projectRetainer || "").toLowerCase().includes("retainer");
        const startStr = DeepDiveEngine.formatShortDate(job.startDate);
        const endStr = DeepDiveEngine.formatShortDate(job.endDate);
        const datesStr = startStr && endStr ? ` | ${startStr} to ${endStr}` : "";

        let detail = "";
        const formattedJobAmount = Math.abs(rawAmount % 1) > 0.001 ? formatMoney(rawAmount, 2) : formatMoney(rawAmount, 0);
        if (isRetainer) {
          detail = `Retainer | ${formattedJobAmount} per month${datesStr}`;
        } else {
          detail = `Project | ${formattedJobAmount}${datesStr}`;
        }

        results.push({
          client: job.client || "General",
          name: job.jobName || "",
          amount: monthlyAmount,
          totalAmount: rawAmount,
          type: job.projectRetainer || "Project",
          detail,
          startStr: job.startDate,
          endStr: job.endDate,
          status: effectiveType,
          likelihood: effectiveType === "confirmed" ? "100%" : (job.likelihood || "50%"),
        });
      }
    });

    results.sort((a, b) => {
      const cmp = String(a.client || "").localeCompare(String(b.client || ""));
      if (cmp !== 0) return cmp;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

    return results;
  },

  getSalariesForMonth(salariesData, targetDate, isDelivery) {
    let list = [];
    if (!salariesData) return list;

    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();

    if (salariesData.deepDive && salariesData.monthHeaders) {
      let colIdx = -1;
      for (let i = 11; i < salariesData.monthHeaders.length; i += 7) {
        let hd = DeepDiveEngine.parseHeaderDate(salariesData.monthHeaders[i]);
        if (hd && hd.getFullYear() === targetYear && hd.getMonth() === targetMonth) {
          colIdx = i;
          break;
        }
      }

      if (colIdx !== -1) {
        const staffByRow = {};
        (salariesData.staff || []).forEach((s) => {
          if (s.rowNumber) staffByRow[s.rowNumber - 4] = s;
        });

        for (let i = 0; i < salariesData.deepDive.length; i++) {
          const row = salariesData.deepDive[i];
          if (!row) continue;

          // Cross-reference row index i with staffByRow to guarantee name, role and delPct
          // even if client sheet formula scrambled row 304+ column A
          const staffObj = staffByRow[i];
          const name = (row[0] && String(row[0]).trim()) || (staffObj ? staffObj.name : "");
          if (!name || !name.trim()) continue;

          const role = (row[1] && String(row[1]).trim()) || (staffObj ? staffObj.role : "");

          const salary = parseMoney(row[colIdx]);
          const erNic = parseMoney(row[colIdx + 2]);
          const erPen = parseMoney(row[colIdx + 5]);
          const totalCost = salary + erNic + erPen;

          if (Math.abs(totalCost) < 0.01) continue;

          let delPctRaw = row[6] !== undefined && String(row[6]).trim() !== "" ? row[6] : (staffObj ? staffObj.deliveryPct : "0%");
          let delPct = parseMoney(delPctRaw);
          if (String(delPctRaw).includes("%")) delPct = delPct / 100;
          else if (delPct > 1) delPct = delPct / 100;

          let applicablePct = isDelivery ? delPct : (1 - delPct);
          if (Math.abs(applicablePct) < 0.001) continue;

          list.push({
            name: String(name).trim(),
            role: String(role || "").trim(),
            amount: Math.round(totalCost * applicablePct),
            totalCost: totalCost,
            pct: applicablePct,
          });
        }
      }
    }

    // Fallback if deepDive not available
    if (list.length === 0 && salariesData.staff && salariesData.staff.length > 0) {
      salariesData.staff.forEach((s) => {
        let delPct = 0;
        if (s.deliveryPct !== undefined && String(s.deliveryPct).trim() !== "") {
          delPct = parseMoney(s.deliveryPct);
          if (String(s.deliveryPct).includes("%")) delPct = delPct / 100;
          else if (delPct > 1) delPct = delPct / 100;
        } else if (s.isDelivery) {
          delPct = 1;
        }
        const applicablePct = isDelivery ? delPct : (1 - delPct);
        if (applicablePct <= 0.001) return;
        const monthlyCost = s.actualAnnualCost / 12;
        const amt = Math.round(monthlyCost * applicablePct);
        if (amt > 0) {
          list.push({
            name: s.name,
            role: s.role || "",
            amount: amt,
            totalCost: monthlyCost,
            pct: applicablePct,
          });
        }
      });
    }

    list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    return list;
  },

  getDividendsForMonth(dividendsData, targetDate, isDelivery, headersObj = null) {
    let list = [];
    if (!dividendsData || !targetDate) return list;

    // A. If dividendsData has years cache (original WebApp structure)
    if (dividendsData.years) {
      const targetYear = targetDate.getFullYear();
      const targetMonth = targetDate.getMonth();
      let targetYIdx = -1;
      let targetCIdx = -1;

      for (let y = 0; y < dividendsData.years.length; y++) {
        const headerRow = dividendsData.years[y].cells?.[0] || [];
        for (let c = 1; c < headerRow.length; c++) {
          let hd = DeepDiveEngine.parseHeaderDate(headerRow[c]?.v || headerRow[c]);
          if (hd && hd.getFullYear() === targetYear && hd.getMonth() === targetMonth) {
            targetYIdx = y;
            targetCIdx = c;
            break;
          }
        }
        if (targetYIdx !== -1) break;
      }
      if (targetYIdx === -1) return list;

      const cells = dividendsData.years[targetYIdx].cells || [];
      for (let i = 1; i < cells.length; i++) {
        const row = cells[i];
        const name = row[0]?.v || row[0];
        if (!name) continue;

        const nameLower = String(name).toLowerCase();
        const isDelRow = nameLower.includes("total") && nameLower.includes("delivery") && !nameLower.includes("non-delivery");
        const isNonDelRow = nameLower.includes("total") && nameLower.includes("non-delivery");

        if (!nameLower.includes("div in lieu")) continue;
        if (isDelivery && !isDelRow) continue;
        if (!isDelivery && !isNonDelRow) continue;

        const valRaw = row[targetCIdx] ? (row[targetCIdx].v !== undefined ? row[targetCIdx].v : row[targetCIdx]) : 0;
        const totalCost = parseMoney(valRaw);
        if (Math.abs(totalCost) < 0.01) continue;

        list.push({
          name: "Dividends as salary",
          amount: totalCost,
          totalCost: totalCost,
          pct: 1,
        });
      }
      return list;
    }

    // B. If dividendsData is an array of dividend objects (from keyData.outgoings.dividends)
    if (Array.isArray(dividendsData)) {
      const targetYear = targetDate.getFullYear();
      const targetMonth = targetDate.getMonth();
      let foundY = -1;
      let foundC = -1;

      if (headersObj) {
        for (const y of [1, 2, 3]) {
          const hList = headersObj[y] || [];
          for (let c = 0; c < hList.length; c++) {
            const hd = DeepDiveEngine.parseHeaderDate(hList[c]);
            if (hd && hd.getFullYear() === targetYear && hd.getMonth() === targetMonth) {
              foundY = y;
              foundC = c;
              break;
            }
          }
          if (foundY !== -1) break;
        }
      }

      if (foundY === -1) {
        foundY = 1;
        foundC = targetMonth;
      }

      dividendsData.forEach((d) => {
        let delPct = 0.5; // default 50%
        if (d.deliveryPct !== undefined && String(d.deliveryPct).trim() !== "") {
          delPct = parseMoney(d.deliveryPct);
          if (String(d.deliveryPct).includes("%")) delPct = delPct / 100;
          else if (delPct > 1) delPct = delPct / 100;
        }
        const applicablePct = isDelivery ? delPct : 1 - delPct;
        if (applicablePct <= 0.001) return;

        const allocs = d.allocations?.[foundY] || d.monthlyAllocations || [];
        const rawAmt = parseMoney(allocs[foundC] || 0);
        const amt = Math.round(rawAmt * applicablePct);
        if (Math.abs(amt) > 0.01) {
          list.push({
            name: d.name || "Dividends as salary",
            amount: amt,
            totalCost: rawAmt,
            pct: applicablePct,
          });
        }
      });
    }

    return list;
  },
};

export const CashDeepDiveEngine = {
  parseSafeDate(dateStr) {
    if (!dateStr) return null;
    if (typeof dateStr === "string") {
      if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
        const parts = dateStr.split("-");
        return { y: parseInt(parts[0], 10), m: parseInt(parts[1], 10) - 1, d: parseInt(parts[2], 10) };
      }
      const ukMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if (ukMatch) {
        return { y: parseInt(ukMatch[3], 10), m: parseInt(ukMatch[2], 10) - 1, d: parseInt(ukMatch[1], 10) };
      }
    }
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
  },

  parsePayDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    const monMatch = s.match(/^(\d{1,2})[\s\-\/]([a-zA-Z]{3})[\s\-\/](\d{2,4})$/);
    if (monMatch) {
      const day = parseInt(monMatch[1], 10);
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = months[monMatch[2].toLowerCase()];
      let year = parseInt(monMatch[3], 10);
      if (year < 100) year += 2000;
      if (month !== undefined && !isNaN(year) && !isNaN(day)) {
        return new Date(year, month, day);
      }
    }
    const isoMatch = s.match(/^(\d{4})[\s\-\/](\d{1,2})[\s\-\/](\d{1,2})$/);
    if (isoMatch) {
      return new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
    }
    const ukMatch = s.match(/^(\d{1,2})[\/](\d{1,2})[\/](\d{2,4})$/);
    if (ukMatch) {
      let year = parseInt(ukMatch[3], 10);
      if (year < 100) year += 2000;
      return new Date(year, parseInt(ukMatch[2], 10) - 1, parseInt(ukMatch[1], 10));
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  },

  parseSafeDays(daysVal) {
    if (!daysVal && daysVal !== 0) return 0;
    if (typeof daysVal === "number") return daysVal;
    const str = String(daysVal);
    const n = parseInt(str, 10);
    return isNaN(n) ? 0 : n;
  },

  getInvoicesSentCash(allJobs, targetDate, vatRate = 0.2) {
    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();
    const results = { confirmed: [], pipeline: [] };
    if (!allJobs) return results;

    const cleanInvoiceRef = (rawRef, isRet) => {
      if (!rawRef) return "";
      const s = String(rawRef).trim();
      const lower = s.toLowerCase();
      if (
        lower.startsWith("place") ||
        lower.startsWith("placeholder") ||
        lower.startsWith("tbd") ||
        lower === "—" ||
        lower === "-"
      ) {
        return "";
      }
      if (isRet && /^invoice\s*\d+$/i.test(lower)) {
        return "";
      }
      if (/^retainer\s*month\s*\d+$/i.test(lower)) {
        return "";
      }
      return s;
    };

    allJobs.forEach((job) => {
      const isRetainer = String(job.projectRetainer || "").toLowerCase().includes("retainer");
      const hasMultipleInvoices = !!job.inv2Amount || !!job.inv3Amount || !!job.inv2SendDate || !!job.inv3SendDate;
      const currentVatRate = job.vat === "Yes" ? vatRate : 0;

      let likelihood = 1;
      if (String(job.type || "").toLowerCase() === "pipeline") {
        if (typeof job.likelihoodNum === "number" && !isNaN(job.likelihoodNum)) {
          likelihood = job.likelihoodNum;
        } else {
          likelihood = parseLikelihood(job.likelihood, 0.5);
        }
      }

      // A retainer recurs monthly IF AND ONLY IF it is on the parent row and does NOT have child-row / milestone invoices
      const hasChildRows = !!(
        job.hasChildRows ||
        (job.childRowNumbers && job.childRowNumbers.length > 0) ||
        (job.invoices && job.invoices.some((inv) => inv.isChild || inv.childRowNum))
      );
      const hasChildInvoice = !!(
        job.inv1IsChild ||
        job.inv2IsChild ||
        job.inv3IsChild ||
        (job.invoices && job.invoices.some((inv) => inv.isChild || inv.childRowNum))
      );
      const parentHasNoInvoice = job.parentHasInvoice === false;
      const isRecurringRetainer = isRetainer && !hasMultipleInvoices && !hasChildInvoice && !hasChildRows && !parentHasNoInvoice;

      if (isRecurringRetainer) {
        const amountRaw = job.inv1Amount || job.revenue;
        const parsedSend = this.parseSafeDate(job.inv1SendDate || job.inv1RecDate || job.startDate);
        const parsedStart = this.parseSafeDate(job.adjStartDate || job.startDate);
        const parsedEnd = this.parseSafeDate(job.adjEndDate || job.endDate);

        if (amountRaw && parsedSend && parsedStart && parsedEnd) {
          const amountExVat = parseMoney(amountRaw) * likelihood;
          if (Math.abs(amountExVat) < 0.01) return;

          const startDate = new Date(parsedStart.y, parsedStart.m, 1);
          const endDate = new Date(parsedEnd.y, parsedEnd.m, 1);
          const status = job.inv1Status || "";
          const ref = cleanInvoiceRef(job.inv1Ref, true);

          let currDate = new Date(startDate.getTime());
          let monthCount = 1;

          while (currDate <= endDate) {
            const simulatedSendDate = new Date(currDate.getFullYear(), currDate.getMonth(), parsedSend.d || 1);

            if (simulatedSendDate.getFullYear() === targetYear && simulatedSendDate.getMonth() === targetMonth) {
              const vatAmount = amountExVat * currentVatRate;
              const totalAmount = amountExVat + vatAmount;

              const invData = {
                client: job.client,
                jobName: job.jobName,
                type: job.projectRetainer || "Retainer",
                ref: ref || "",
                amountExVat,
                vatAmount,
                totalAmount,
                sendDate: simulatedSendDate,
                status: String(job.type || "").toLowerCase() === "pipeline" ? "" : status,
              };

              if (String(job.type || "").toLowerCase() === "pipeline") results.pipeline.push(invData);
              else results.confirmed.push(invData);
            }
            currDate.setMonth(currDate.getMonth() + 1);
            monthCount++;
          }
        }
      } else {
        for (let i = 1; i <= 50; i++) {
          const amountRaw = job[`inv${i}Amount`];
          if (!amountRaw) continue;

          const amountExVat = parseMoney(amountRaw) * likelihood;
          if (Math.abs(amountExVat) < 0.01) continue;

          const parsedSend = this.parseSafeDate(job[`inv${i}SendDate`]);
          if (!parsedSend) continue;

          const sendDate = new Date(parsedSend.y, parsedSend.m, parsedSend.d);

          if (sendDate.getFullYear() === targetYear && sendDate.getMonth() === targetMonth) {
            const vatAmount = amountExVat * currentVatRate;
            const totalAmount = amountExVat + vatAmount;
            const ref = cleanInvoiceRef(job[`inv${i}Ref`], isRetainer);

            const invData = {
              client: job.client,
              jobName: job.jobName,
              type: job.projectRetainer || "Project",
              ref: ref || "",
              amountExVat,
              vatAmount,
              totalAmount,
              sendDate,
              status: String(job.type || "").toLowerCase() === "pipeline" ? "" : (job[`inv${i}Status`] || ""),
            };

            if (String(job.type || "").toLowerCase() === "pipeline") results.pipeline.push(invData);
            else results.confirmed.push(invData);
          }
        }
      }
    });

    results.confirmed.sort((a, b) => a.sendDate - b.sendDate);
    results.pipeline.sort((a, b) => a.sendDate - b.sendDate);
    return results;
  },

  getJobCash(allJobs, targetDate, type, vatRate = 0.2) {
    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();
    const results = [];
    if (!allJobs) return results;

    const isPipelineType = type === "cashPipeInc" || type === "pipeCash";
    const isDirCash = type === "cashDirCosts" || type.includes("dirCash");

    allJobs.forEach((job) => {
      const isJobPipeline = String(job.type || "").toLowerCase() === "pipeline";
      if (!isPipelineType && isJobPipeline) return;
      if (isPipelineType && !isJobPipeline) return;
      if (isDirCash && isJobPipeline) return;

      const isRetainer = String(job.projectRetainer || "").toLowerCase().includes("retainer");
      const hasMultipleInvoices = !!job.inv2Amount || !!job.inv3Amount || !!job.inv2SendDate || !!job.inv3SendDate;
      const vatMultiplier = job.vat === "Yes" ? (1 + vatRate) : 1;
      const prefix = isDirCash ? "dirInv" : "inv";

      let likelihood = 1;
      if (isJobPipeline) {
        if (typeof job.likelihoodNum === "number" && !isNaN(job.likelihoodNum)) {
          likelihood = job.likelihoodNum;
        } else {
          likelihood = parseLikelihood(job.likelihood, 0.5);
        }
      }

      // A retainer recurs monthly IF AND ONLY IF it is on the parent row and does NOT have child-row / milestone invoices
      const hasChildRows = !!(
        job.hasChildRows ||
        (job.childRowNumbers && job.childRowNumbers.length > 0) ||
        (job.invoices && job.invoices.some((inv) => inv.isChild || inv.childRowNum)) ||
        (job.directExpenses && job.directExpenses.some((exp) => exp.isChild || exp.childRowNum))
      );
      const hasChildInvoice = !!(
        job[`${prefix}1IsChild`] ||
        job[`${prefix}2IsChild`] ||
        job[`${prefix}3IsChild`] ||
        (job.invoices && job.invoices.some((inv) => inv.isChild || inv.childRowNum)) ||
        (job.directExpenses && job.directExpenses.some((exp) => exp.isChild || exp.childRowNum))
      );
      const parentHasNoInvoice = job.parentHasInvoice === false;
      const isRecurringRetainer = isRetainer && !hasMultipleInvoices && !isDirCash && !hasChildInvoice && !hasChildRows && !parentHasNoInvoice;

      if (isRecurringRetainer) {
        const amountRaw = job[`${prefix}1Amount`] || job.revenue;
        const parsedSend = this.parseSafeDate(job[`${prefix}1SendDate`] || job[`${prefix}1RecDate`] || job.startDate);
        const parsedStart = this.parseSafeDate(job.adjStartDate || job.startDate);
        const parsedEnd = this.parseSafeDate(job.adjEndDate || job.endDate);

        if (amountRaw && parsedStart && parsedEnd) {
          const multiplier = isDirCash ? (job[`dirInv1Vat`] === "Yes" ? (1 + vatRate) : 1) : vatMultiplier;
          let amount = parseMoney(amountRaw) * multiplier * likelihood;
          if (isDirCash) amount = -Math.abs(amount);

          if (Math.abs(amount) < 0.01) return;

          const daysToPay = this.parseSafeDays(job[`${prefix}1Days`] !== undefined && String(job[`${prefix}1Days`]).trim() !== "" ? job[`${prefix}1Days`] : "30");
          const status = job[`${prefix}1Status`] || "";
          const ref = job[`${prefix}1Ref`] || "";

          // First payment date in Google Sheets PipeCalcs / ConfCalcs:
          // FS = SendDate + DaysToPay
          // Retainer recurs once per calendar month from month(FS) until month(endDate)
          const sendD = parsedSend?.d || 1;
          const sendM = parsedStart.m !== undefined ? parsedStart.m : parsedStart.getMonth();
          const sendY = parsedStart.y !== undefined ? parsedStart.y : parsedStart.getFullYear();

          const firstPay = new Date(sendY, sendM, sendD + daysToPay);
          const startPayY = firstPay.getFullYear();
          const startPayM = firstPay.getMonth();

          const endY = parsedEnd.y !== undefined ? parsedEnd.y : parsedEnd.getFullYear();
          const endM = parsedEnd.m !== undefined ? parsedEnd.m : parsedEnd.getMonth();
          const totalMonths = (endY - sendY) * 12 + (endM - sendM) + 1;

          for (let m = 0; m < totalMonths; m++) {
            const currentPayMonth = startPayM + m;
            const payYear = startPayY + Math.floor(currentPayMonth / 12);
            const payMonth = currentPayMonth % 12;

            if (payYear === targetYear && payMonth === targetMonth) {
              const monthCount = m + 1;
              const desc = isDirCash
                ? `Direct cost (Month ${monthCount})`
                : (ref ? `${ref} (Month ${monthCount})` : `Retainer Month ${monthCount}`);
              results.push({
                client: job.client,
                name: job.jobName,
                desc: isPipelineType ? "" : desc,
                amount: Math.round(amount),
                payDate: new Date(payYear, payMonth, Math.min(sendD, 28)),
                status: isPipelineType ? "" : status,
                isPipeline: isPipelineType,
                type: job.projectRetainer || "Retainer",
              });
            }
          }
        }
      } else {
        for (let i = 1; i <= 50; i++) {
          const amountRaw = job[`${prefix}${i}Amount`];
          if (!amountRaw) continue;

          const multiplier = isDirCash ? (job[`dirInv${i}Vat`] === "Yes" ? (1 + vatRate) : 1) : vatMultiplier;
          let amount = parseMoney(amountRaw) * multiplier * likelihood;
          if (isDirCash) amount = -Math.abs(amount);

          if (Math.abs(amount) < 0.01) continue;

          const parsedSend = this.parseSafeDate(job[`${prefix}${i}SendDate`] || job[`${prefix}${i}RecDate`]);
          if (!parsedSend) continue;

          const daysToPay = this.parseSafeDays(job[`${prefix}${i}Days`]);
          const payDate = new Date(parsedSend.y, parsedSend.m, parsedSend.d + daysToPay);

          if (payDate.getFullYear() === targetYear && payDate.getMonth() === targetMonth) {
            const defaultDesc = isDirCash ? `Direct cost ${i}` : `Invoice ${i}`;
            const actualDesc = job[`${prefix}${i}Desc`] || job[`${prefix}${i}Ref`] || defaultDesc;
            results.push({
              client: job.client,
              name: job.jobName,
              desc: isPipelineType ? "" : actualDesc,
              amount: Math.round(amount),
              payDate,
              status: isPipelineType ? "" : (job[`${prefix}${i}Status`] || ""),
              isPipeline: isPipelineType,
              type: job.projectRetainer || "Project",
            });
          }
        }
      }
    });

    results.sort((a, b) => a.payDate - b.payDate);
    return results;
  },

  getSalariesCash(targetDate, salariesData) {
    const results = [];
    if (!salariesData || !salariesData.deepDive || !salariesData.monthHeaders) return results;

    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();

    let colIdx = -1;
    for (let i = 11; i < salariesData.monthHeaders.length; i += 7) {
      let hd = DeepDiveEngine.parseHeaderDate(salariesData.monthHeaders[i]);
      if (hd && hd.getFullYear() === targetYear && hd.getMonth() === targetMonth) {
        colIdx = i;
        break;
      }
    }
    if (colIdx === -1) return results;

    const targetCol = colIdx;
    if (!salariesData.deepDive[56]) return results;

    const rawNet = salariesData.deepDive[56][targetCol];
    const rawHmrc = salariesData.deepDive[57][targetCol];
    const rawPension = salariesData.deepDive[58][targetCol];

    const netPayroll = -Math.abs(parseMoney(rawNet));
    const hmrc = -Math.abs(parseMoney(rawHmrc));
    const pension = -Math.abs(parseMoney(rawPension));

    if (Math.abs(netPayroll) > 0.01) results.push({ name: "Net Payroll", amount: netPayroll });
    if (Math.abs(hmrc) > 0.01) results.push({ name: "HMRC (PAYE & NICs)", amount: hmrc });
    if (Math.abs(pension) > 0.01) results.push({ name: "Pension", amount: pension });

    return results;
  },

  getOutgoingsCash(targetDate, type, keyData) {
    const results = [];
    if (!keyData || !keyData.outgoings) return results;

    const isContractor = type.includes("conCash") || type === "cashContractors";
    const contractorSource = String(
      keyData?.outgoingsMeta?.contractorSource || keyData?.outgoings?.contractorSource || ""
    ).toLowerCase();
    const isNotesMode = contractorSource.includes("notes");

    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();

    // In Notes metadata mode, contractor payments are driven by transaction {Pay date} across the OutgNotes grid
    if (isContractor && isNotesMode) {
      const allTx = keyData?.outgoings?.contractorTransactions || keyData?.outgoingsMeta?.contractorTransactions || [];

      allTx.forEach((tx) => {
        const pd = CashDeepDiveEngine.parsePayDate(tx.payDate);
        if (pd && pd.getFullYear() === targetYear && pd.getMonth() === targetMonth) {
          const rawAmt = -Math.abs(tx.grossAmount || tx.amount || 0);
          const netAmt = -Math.abs(tx.netAmount || tx.amountNet || 0);
          const vatAmt = tx.vatAmount > 0 || tx.vatSetting === "Yes" ? -Math.abs(tx.vatAmount || 0) : 0;

          results.push({
            appId: tx.appId || "",
            vendor: tx.vendor || tx.contractorName || "",
            client: tx.vendor || tx.contractorName || "",
            name: tx.vendor || tx.contractorName || "",
            desc: tx.itemDesc || tx.rawDesc || "",
            itemDesc: tx.itemDesc || tx.rawDesc || "",
            rawDesc: tx.rawDesc || "",
            amountNet: netAmt,
            vatAmount: vatAmt,
            grossAmount: rawAmt,
            amount: rawAmt,
            vatSetting: tx.vatSetting || "No",
            status: tx.status || "",
            recDate: tx.recDate || "",
            payDate: tx.payDate || "",
            payDateStr: DeepDiveEngine.formatShortDate(tx.payDate),
            rowNumber: tx.rowNumber || null,
          });
        }
      });

      // Sort by payDate ascending, then vendor name
      results.sort((a, b) => {
        const da = CashDeepDiveEngine.parsePayDate(a.payDate);
        const db = CashDeepDiveEngine.parsePayDate(b.payDate);
        const ta = da ? da.getTime() : 0;
        const tb = db ? db.getTime() : 0;
        if (ta !== tb) return ta - tb;
        return String(a.vendor || "").localeCompare(String(b.vendor || ""));
      });

      return results;
    }

    const cacheItems = isContractor
      ? (keyData.outgoings.contractors || [])
      : (keyData.outgoings.expenses || []).filter(
          (e) => !e.name || !e.name.toLowerCase().includes("depreciation")
        );

    let foundY = -1;
    let foundC = -1;
    const headersObj = keyData.outgoings.headers || {};

    for (const y of [1, 2, 3]) {
      const hList = headersObj[y] || [];
      for (let c = 0; c < hList.length; c++) {
        const hd = DeepDiveEngine.parseHeaderDate(hList[c]);
        if (hd && hd.getFullYear() === targetYear && hd.getMonth() === targetMonth) {
          foundY = y;
          foundC = c;
          break;
        }
      }
      if (foundY !== -1) break;
    }

    if (foundY === -1) {
      const curY = keyData.outgoings.currentYear || 2;
      const todayYear = new Date().getFullYear();
      foundY = Math.min(3, Math.max(1, curY + (targetYear - todayYear)));
      foundC = targetMonth;
    }

    cacheItems.forEach((row) => {
      if (!row.name || row.name.toLowerCase() === "hide") return;

      const payTiming = String(row.paymentTiming || "Curr").toLowerCase();
      let colToRead = foundC;
      let yearToRead = foundY;

      if (payTiming === "next") {
        if (foundC === 0) {
          yearToRead = foundY - 1;
          colToRead = 11;
        } else {
          colToRead = foundC - 1;
        }
      }

      if (yearToRead >= 1 && yearToRead <= 3) {
        const allocs = row.allocations?.[yearToRead] || [];
        const rawVal = allocs[colToRead] || 0;
        let amount = parseMoney(rawVal);

        if (Math.abs(amount) > 0.01) {
          if (row.vat === "Yes") {
            amount *= 1.2;
          }
          amount = -Math.abs(Math.round(amount));
          results.push({
            name: row.name,
            amount,
          });
        }
      }
    });

    if (isContractor && keyData.outgoingsMeta) {
      const payTiming = String(keyData.outgoingsMeta.makingUpCosTiming || "Curr").toLowerCase();
      const vatStatus = keyData.outgoingsMeta.makingUpCosVat || "";

      let colToRead = foundC;
      let yearToRead = foundY;

      if (payTiming === "next") {
        if (foundC === 0) {
          yearToRead = foundY - 1;
          colToRead = 11;
        } else {
          colToRead = foundC - 1;
        }
      }

      const mIdx = colToRead;
      const yArrIdx = yearToRead - 1;
      const targetArray =
        type === "conCash_excl"
          ? keyData.outgoingsMeta.makingUpCosBaseConf
          : keyData.outgoingsMeta.makingUpCosBase;

      if (targetArray && yArrIdx >= 0 && yArrIdx < targetArray.length) {
        const cosRow = targetArray[yArrIdx];
        if (cosRow && mIdx >= 0 && mIdx < cosRow.length) {
          let cosAmount = parseMoney(cosRow[mIdx]);
          if (Math.abs(cosAmount) > 0.01) {
            if (vatStatus === "Yes") {
              cosAmount *= 1.2;
            }
            cosAmount = -Math.abs(Math.round(cosAmount));
            results.push({ name: "Making up CoS amount", amount: cosAmount });
          }
        }
      }
    }

    return results;
  },
};

export function getDeepDiveType(rowLabel = "") {
  const l = String(rowLabel).toLowerCase().trim();

  // Explicit exclusions - NEVER open popover for totals or margins
  if (
    l === "total overheads" ||
    l.includes("total overheads") ||
    l.includes("overheads as %") ||
    l.includes("overheads %") ||
    l.includes("gross profit") ||
    l.includes("operating profit") ||
    l.includes("total revenue") ||
    l.includes("total income") ||
    l.includes("total cost") ||
    l.includes("staff costs to")
  ) {
    return null;
  }

  // Performance items
  if (l.includes("confirmed revenue") || l.includes("confirmed income") || l.includes("confirmed project") || l.includes("confirmed retainer")) return "confRev";
  if (l.includes("pipeline revenue") || l.includes("pipeline income") || l.includes("pipeline opportunity")) return "pipeRev";
  if (l.includes("staff costs - delivery") || l.includes("delivery staff")) return "staffDel";
  if (l.includes("staff costs - non-delivery") || l.includes("non-delivery staff")) return "staffNonDel";
  if (l.includes("direct cost payments") || l.includes("direct costs") || l === "direct cost") return "dirCosts";
  if (l.includes("other expenses - delivery") || l.includes("delivery expenses")) return "expDel";
  if (l.includes("other expenses - non-delivery") || l.includes("non-delivery expenses")) return "expNonDel";
  if (l.includes("dividends as salary") || l === "dividends") return "dividends";

  // Cash flow items
  if (l.includes("confirmed cash incoming") || l.includes("confirmed receipts")) return "cashConfInflow";
  if (l.includes("pipeline cash incoming") || l.includes("pipeline receipts")) return "cashPipeInflow";
  if (l.includes("salaries") || l.includes("net wages") || l.includes("wages")) return "cashSalaries";
  if (l.includes("contractors")) return "cashContractors";
  if (l.includes("other expenses")) return "cashOutgoings";
  if (l.includes("corporation tax") || l === "taxcash") return "taxCash";
  if (l === "vat" || l === "vatcash") return "vatCash";
  if (l.includes("non-operating income") || l === "nonopinccash") return "nonOpIncCash";
  if (l.includes("non-operating expenses") || l === "nonopexpcash") return "nonOpExpCash";
  if (l.includes("other cash movements") || l === "othermovecash") return "otherMoveCash";

  return null;
}

export function buildDeepDiveData({
  ddType,
  periodLabel,
  monthIndex, // 0 to 11, or -1 for FY total
  cellValue,
  yearIndex = 1, // 1, 2, or 3
  targetDate = null,
  aggregateCount = 1,
  keyData,
  isIncomeMode = false,
  isRestricted = false,
  isScenarioView = false,
  scenariosConfig = null,
}) {
  if (!keyData) {
    return {
      title: "Breakdown",
      period: periodLabel,
      total: cellValue,
      items: [],
      sections: null,
    };
  }

  const isFYTotal = monthIndex === -1;
  const count = aggregateCount > 1 ? aggregateCount : (isFYTotal ? 12 : 1);
  const effectiveDate = targetDate || new Date(2025 + (yearIndex - 1), Math.max(0, monthIndex), 1);
  const mIdx = monthIndex >= 0 ? monthIndex : 0;
  const yIdx = Math.max(0, yearIndex - 1);
  const effectiveIncomeMode =
    Boolean(isIncomeMode) ||
    String(keyData?.outgoingsMeta?.mode || "").toLowerCase() === "income" ||
    String(periodLabel || "").toLowerCase().includes("income") ||
    String(ddType || "").toLowerCase().includes("inc");

  // 1. Confirmed Revenue / Income
  if (ddType === "confRev") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    let items = [];

    if (count > 1) {
      items = DeepDiveEngine.aggregatePeriods(effectiveDate, count, (d) =>
        DeepDiveEngine.getJobsForMonth(allJobs, d, "confRev", effectiveIncomeMode, isScenarioView, scenariosConfig)
      );
    } else {
      items = DeepDiveEngine.getJobsForMonth(allJobs, effectiveDate, "confRev", effectiveIncomeMode, isScenarioView, scenariosConfig);
    }

    const totalJobs = items.reduce((s, i) => s + i.amount, 0);
    let drift = Math.round(parseMoney(cellValue) - totalJobs);
    if (Math.abs(drift) > 0 && Math.abs(drift) <= 2 && items.length > 0) {
      let maxIdx = 0;
      for (let k = 1; k < items.length; k++) {
        if (items[k].amount > items[maxIdx].amount) maxIdx = k;
      }
      items[maxIdx].amount += drift;
      drift = 0;
    }
    if (isScenarioView && Math.abs(drift) > 2) {
      items.push({ name: "Manual scenario adjustment", amount: drift });
    } else if (!isScenarioView && Math.abs(drift) > 2) {
      items.push({ name: "Rounding adjustment", amount: drift });
    }

    return {
      title: effectiveIncomeMode ? "Confirmed income" : "Confirmed revenue",
      period: periodLabel,
      total: cellValue,
      items: items.map((i) => ({
        name: i.name,
        client: i.client,
        detail: i.detail,
        amount: i.amount,
      })),
      sections: null,
    };
  }

  // 2. Pipeline Revenue / Income
  if (ddType === "pipeRev") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    let items = [];

    if (count > 1) {
      items = DeepDiveEngine.aggregatePeriods(effectiveDate, count, (d) =>
        DeepDiveEngine.getJobsForMonth(allJobs, d, "pipeRev", effectiveIncomeMode, isScenarioView, scenariosConfig)
      );
    } else {
      items = DeepDiveEngine.getJobsForMonth(allJobs, effectiveDate, "pipeRev", effectiveIncomeMode, isScenarioView, scenariosConfig);
    }

    const totalJobs = items.reduce((s, i) => s + i.amount, 0);
    const drift = Math.round(parseMoney(cellValue) - totalJobs);
    if (isScenarioView && Math.abs(drift) > 1) {
      items.push({ name: "Scenario adjustment", amount: drift });
    } else if (!isScenarioView && Math.abs(drift) > 1) {
      items.push({ name: "Rounding adjustment", amount: drift });
    }

    return {
      title: effectiveIncomeMode ? "Pipeline income" : "Pipeline revenue",
      period: periodLabel,
      total: cellValue,
      items: items.map((i) => ({
        name: i.name,
        client: i.client,
        detail: `${i.likelihood} likelihood • ${i.detail}`,
        amount: i.amount,
      })),
      sections: null,
    };
  }

  // 3 & 4. Staff Costs - Delivery & Non-Delivery (Matching Original WebApp lines 16413-16527)
  if (ddType === "staffDel" || ddType === "staffNonDel") {
    const isDel = ddType === "staffDel";
    const targetYear = effectiveDate.getFullYear();
    const targetMonth = effectiveDate.getMonth();
    const monthCount = count > 1 ? count : 1;

    // A. Salaries
    let salaries = [];
    if (count > 1) {
      salaries = DeepDiveEngine.aggregatePeriods(effectiveDate, count, (d) =>
        DeepDiveEngine.getSalariesForMonth(keyData.salaries, d, isDel)
      );
    } else {
      salaries = DeepDiveEngine.getSalariesForMonth(keyData.salaries, effectiveDate, isDel);
    }

    let calcSalTotal = salaries.reduce((s, item) => s + item.amount, 0);

    // Calculate actualSalaries from Outgoings to compute employment allowance
    // Matching WebApp.html lines 16437-16468
    let actualSalaries = 0;
    for (let i = 0; i < monthCount; i++) {
      const currDate = new Date(targetYear, targetMonth + i, 1);
      const cy = currDate.getFullYear();
      const cm = currDate.getMonth();
      let foundYIdx = -1;
      let foundMIdx = -1;

      if (keyData.outgoings?.headers && keyData.outgoingsMeta) {
        for (const y of [1, 2, 3]) {
          const hdrs = keyData.outgoings.headers[y] || [];
          for (let c = 0; c < hdrs.length; c++) {
            const hd = DeepDiveEngine.parseHeaderDate(hdrs[c]);
            if (hd && hd.getFullYear() === cy && hd.getMonth() === cm) {
              foundYIdx = y - 1; // 0-indexed for outgoingsMeta arrays
              foundMIdx = c;
              break;
            }
          }
          if (foundYIdx !== -1) break;
        }
      }

      if (foundYIdx !== -1 && foundMIdx !== -1) {
        if (isDel && keyData.outgoingsMeta.salariesDel?.[foundYIdx]) {
          actualSalaries += parseMoney(keyData.outgoingsMeta.salariesDel[foundYIdx][foundMIdx]);
        } else if (!isDel && keyData.outgoingsMeta.salariesNonDel?.[foundYIdx]) {
          actualSalaries += parseMoney(keyData.outgoingsMeta.salariesNonDel[foundYIdx][foundMIdx]);
        }
      } else {
        // Fallback to yearIndex - 1 and (mIdx + i)
        const fallbackY = Math.max(0, yearIndex - 1);
        const fallbackM = (mIdx + i) % 12;
        if (isDel && keyData.outgoingsMeta?.salariesDel?.[fallbackY]) {
          actualSalaries += parseMoney(keyData.outgoingsMeta.salariesDel[fallbackY][fallbackM]);
        } else if (!isDel && keyData.outgoingsMeta?.salariesNonDel?.[fallbackY]) {
          actualSalaries += parseMoney(keyData.outgoingsMeta.salariesNonDel[fallbackY][fallbackM]);
        }
      }
    }

    const allowanceDiff = Math.round(actualSalaries - calcSalTotal);
    if (Math.abs(allowanceDiff) > 2) {
      salaries.push({
        name: "Employment allowance",
        role: "",
        amount: allowanceDiff,
        totalCost: allowanceDiff,
        pct: 1,
      });
      calcSalTotal += allowanceDiff;
    } else if (allowanceDiff !== 0) {
      // Absorb small £1-£2 penny rounding difference into salaries so calcSalTotal matches actualSalaries exactly
      if (salaries.length > 0) {
        let maxIdx = 0;
        for (let sIdx = 1; sIdx < salaries.length; sIdx++) {
          if (salaries[sIdx].amount > salaries[maxIdx].amount) maxIdx = sIdx;
        }
        salaries[maxIdx].amount += allowanceDiff;
        salaries[maxIdx].totalCost += allowanceDiff;
      }
      calcSalTotal += allowanceDiff;
    }
    const salTotal = calcSalTotal;

    // B. Dividends as salary
    const dividends = [];
    (keyData.outgoings?.dividends || []).forEach((d) => {
      let delPct = 0.5; // default 50%
      if (d.deliveryPct !== undefined && String(d.deliveryPct).trim() !== "") {
        delPct = parseMoney(d.deliveryPct);
        if (String(d.deliveryPct).includes("%")) delPct = delPct / 100;
        else if (delPct > 1) delPct = delPct / 100;
      }
      const applicablePct = isDel ? delPct : (1 - delPct);
      if (applicablePct <= 0.001) return;

      let rawAmt = 0;
      for (let i = 0; i < monthCount; i++) {
        const currDate = new Date(targetYear, targetMonth + i, 1);
        let foundY = yearIndex;
        let foundC = (mIdx + i) % 12;
        if (keyData.outgoings?.headers) {
          for (const y of [1, 2, 3]) {
            const hdrs = keyData.outgoings.headers[y] || [];
            for (let c = 0; c < hdrs.length; c++) {
              const hd = DeepDiveEngine.parseHeaderDate(hdrs[c]);
              if (hd && hd.getFullYear() === currDate.getFullYear() && hd.getMonth() === currDate.getMonth()) {
                foundY = y;
                foundC = c;
                break;
              }
            }
          }
        }
        const allocs = d.allocations?.[foundY] || d.monthlyAllocations || [];
        rawAmt += parseMoney(allocs[foundC] || 0);
      }

      const amt = Math.round(rawAmt * applicablePct);
      if (amt > 0) {
        dividends.push({
          name: d.name || "Dividends as salary",
          role: "",
          amount: amt,
          totalCost: rawAmt,
          pct: applicablePct,
        });
      }
    });
    const divTotal = dividends.reduce((s, d) => s + d.amount, 0);

    // C. Contractors
    const contractors = [];
    (keyData.outgoings?.contractors || []).forEach((c) => {
      let delPct = 1.0; // default 100%
      if (c.deliveryPct !== undefined && String(c.deliveryPct).trim() !== "") {
        delPct = parseMoney(c.deliveryPct);
        if (String(c.deliveryPct).includes("%")) delPct = delPct / 100;
        else if (delPct > 1) delPct = delPct / 100;
      }
      const applicablePct = isDel ? delPct : (1 - delPct);
      if (applicablePct <= 0.001) return;

      let rawAmt = 0;
      for (let i = 0; i < monthCount; i++) {
        const currDate = new Date(targetYear, targetMonth + i, 1);
        let foundY = yearIndex;
        let foundC = (mIdx + i) % 12;
        if (keyData.outgoings?.headers) {
          for (const y of [1, 2, 3]) {
            const hdrs = keyData.outgoings.headers[y] || [];
            for (let c = 0; c < hdrs.length; c++) {
              const hd = DeepDiveEngine.parseHeaderDate(hdrs[c]);
              if (hd && hd.getFullYear() === currDate.getFullYear() && hd.getMonth() === currDate.getMonth()) {
                foundY = y;
                foundC = c;
                break;
              }
            }
          }
        }
        const allocs = c.allocations?.[foundY] || c.monthlyAllocations || [];
        rawAmt += parseMoney(allocs[foundC] || 0);
      }

      const amt = Math.round(rawAmt * applicablePct);
      if (amt > 0) {
        contractors.push({
          name: c.name,
          role: "",
          amount: amt,
          totalCost: rawAmt,
          pct: applicablePct,
        });
      }
    });
    const conTotal = contractors.reduce((s, c) => s + c.amount, 0);

    // D. Additional staff costs: Making up CoS & Profit share
    let cosTotal = 0;
    let psTotal = 0;
    let manualStaffAdjTotal = 0;

    for (let i = 0; i < monthCount; i++) {
      const currDate = new Date(targetYear, targetMonth + i, 1);
      let foundYIdx = -1;
      let foundMIdx = -1;

      if (keyData.outgoings?.headers) {
        for (const y of [1, 2, 3]) {
          const hdrs = keyData.outgoings.headers[y] || [];
          for (let c = 0; c < hdrs.length; c++) {
            const hd = DeepDiveEngine.parseHeaderDate(hdrs[c]);
            if (hd && hd.getFullYear() === currDate.getFullYear() && hd.getMonth() === currDate.getMonth()) {
              foundYIdx = y - 1;
              foundMIdx = c;
              break;
            }
          }
          if (foundYIdx !== -1) break;
        }
      }

      if (foundYIdx === -1) {
        foundYIdx = Math.max(0, yearIndex - 1);
        foundMIdx = (mIdx + i) % 12;
      }

      if (isScenarioView && scenariosConfig?.scenarioMeta) {
        const sm = scenariosConfig.scenarioMeta;
        if (isDel) {
          cosTotal += (sm.mCos?.[foundMIdx] !== undefined)
            ? sm.mCos[foundMIdx]
            : parseMoney(keyData.outgoingsMeta?.makingUpCosBase?.[foundYIdx]?.[foundMIdx] || 0);
          psTotal += (sm.psDel?.[foundMIdx] !== undefined)
            ? sm.psDel[foundMIdx]
            : parseMoney(keyData.outgoingsMeta?.profitShareBaseDel?.[foundYIdx]?.[foundMIdx] || 0);
          manualStaffAdjTotal += sm.adjDelStaff?.[foundMIdx] || 0;
        } else {
          psTotal += (sm.psNonDel?.[foundMIdx] !== undefined)
            ? sm.psNonDel[foundMIdx]
            : parseMoney(keyData.outgoingsMeta?.profitShareBaseNonDel?.[foundYIdx]?.[foundMIdx] || 0);
          manualStaffAdjTotal += sm.adjNonDelStaff?.[foundMIdx] || 0;
        }
      } else {
        if (isDel && keyData.outgoingsMeta?.makingUpCosBase?.[foundYIdx]) {
          cosTotal += parseMoney(keyData.outgoingsMeta.makingUpCosBase[foundYIdx][foundMIdx] || 0);
        }

        if (keyData.outgoingsMeta) {
          const psArr = isDel
            ? keyData.outgoingsMeta.profitShareBaseDel?.[foundYIdx]
            : keyData.outgoingsMeta.profitShareBaseNonDel?.[foundYIdx];
          if (psArr) {
            psTotal += parseMoney(psArr[foundMIdx] || 0);
          }
        }
      }
    }
    cosTotal = Math.round(cosTotal);
    psTotal = Math.round(psTotal);
    manualStaffAdjTotal = Math.round(manualStaffAdjTotal);

    // Build expandable and flat sections matching original WebApp (WebApp.html lines 16428-16520)
    const sections = [];
    const targetCellVal = parseMoney(cellValue);

    if (isRestricted) {
      // In the original app (WebApp.html line 16431):
      // restrictedTotal = cellTotal - conTotal - addTotal;
      // This includes salaries and dividends combined in the cell, without exposing dividend details.
      const restrictedTotal = Math.round(targetCellVal - conTotal - cosTotal - psTotal - manualStaffAdjTotal);
      if (Math.abs(restrictedTotal) >= 0.01) {
        sections.push({
          key: "salaries",
          title: "Salaries",
          amount: restrictedTotal,
          isAccordion: false,
          items: [],
        });
      }
    } else {
      if (Math.abs(salTotal) >= 0.01) {
        sections.push({
          key: "salaries",
          title: "Salaries",
          amount: salTotal,
          isAccordion: true,
          items: salaries,
        });
      }

      if (Math.abs(divTotal) >= 0.01) {
        sections.push({
          key: "dividends",
          title: "Dividends as salary",
          amount: divTotal,
          isAccordion: false,
          items: dividends,
        });
      }
    }

    if (Math.abs(conTotal) >= 0.01) {
      sections.push({
        key: "contractors",
        title: "Contractors",
        amount: conTotal,
        isAccordion: true,
        items: contractors,
      });
    }

    if (Math.abs(cosTotal) >= 0.01) {
      sections.push({
        key: "cos",
        title: "Making up CoS",
        amount: cosTotal,
        isAccordion: false,
        items: [],
      });
    }

    if (Math.abs(psTotal) >= 0.01) {
      sections.push({
        key: "profitShare",
        title: "Profit share",
        amount: psTotal,
        isAccordion: false,
        items: [],
      });
    }

    if (Math.abs(manualStaffAdjTotal) >= 0.01) {
      sections.push({
        key: "manualStaffAdj",
        title: "Manual scenario adjustment",
        amount: manualStaffAdjTotal,
        isAdjustment: true,
        items: [],
      });
    }

    // Drift / Rounding adjustment is strictly restricted to full users (WebApp.html line 16513)
    if (!isRestricted) {
      let calculatedTotal = salTotal + divTotal + conTotal + cosTotal + psTotal + manualStaffAdjTotal;
      let drift = Math.round(targetCellVal - calculatedTotal);

      // If minor rounding drift (<= £2), absorb into the largest section so no rounding error exists
      if (Math.abs(drift) > 0 && Math.abs(drift) <= 2 && sections.length > 0) {
        let maxSec = sections[0];
        for (let s = 1; s < sections.length; s++) {
          if (!sections[s].isAdjustment && sections[s].amount > maxSec.amount) {
            maxSec = sections[s];
          }
        }
        maxSec.amount += drift;
        calculatedTotal += drift;
        drift = 0;
      }

      if (isScenarioView && Math.abs(drift) > 2) {
        sections.push({
          key: "scenarioAdj",
          title: "Scenario adjustment",
          amount: drift,
          isAdjustment: true,
        });
      } else if (!isScenarioView && Math.abs(drift) > 2) {
        sections.push({
          key: "roundingAdj",
          title: "Rounding adjustment",
          amount: drift,
          isAdjustment: true,
        });
      }
    }

    return {
      title: isDel ? "Delivery staff costs" : "Non-delivery staff costs",
      period: periodLabel,
      total: cellValue,
      sections,
      items: [],
    };
  }

  // 5. Direct Costs / Contractors
  if (ddType === "dirCosts") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    let items = [];

    if (count > 1) {
      items = DeepDiveEngine.aggregatePeriods(effectiveDate, count, (d) =>
        DeepDiveEngine.getJobsForMonth(allJobs, d, "dirCosts", effectiveIncomeMode, isScenarioView, scenariosConfig)
      );
    } else {
      items = DeepDiveEngine.getJobsForMonth(allJobs, effectiveDate, "dirCosts", effectiveIncomeMode, isScenarioView, scenariosConfig);
    }

    const totalJobs = items.reduce((s, i) => s + i.amount, 0);
    let drift = Math.round(parseMoney(cellValue) - totalJobs);
    if (Math.abs(drift) > 0 && Math.abs(drift) <= 2 && items.length > 0) {
      let maxIdx = 0;
      for (let k = 1; k < items.length; k++) {
        if (items[k].amount > items[maxIdx].amount) maxIdx = k;
      }
      items[maxIdx].amount += drift;
      drift = 0;
    }
    if (isScenarioView && Math.abs(drift) > 2) {
      items.push({ name: "Manual scenario adjustment", amount: drift });
    } else if (!isScenarioView && Math.abs(drift) > 2) {
      items.push({ name: "Rounding adjustment", amount: drift });
    }

    return {
      title: "Direct costs",
      period: periodLabel,
      total: cellValue,
      items,
      sections: null,
    };
  }

  // 6. Overhead & Delivery Expenses (NO VAT or Timing per user instructions)
  if (ddType === "expNonDel" || ddType === "expDel") {
    const isDel = ddType === "expDel";
    const expenses = (keyData.outgoings?.expenses || []).filter((e) =>
      isDel ? e.isDelivery : !e.isDelivery
    );
    const targetYear = effectiveDate.getFullYear();
    const targetMonth = effectiveDate.getMonth();
    const monthCount = count > 1 ? count : 1;

    const items = expenses.map((e) => {
      let amt = 0;
      for (let i = 0; i < monthCount; i++) {
        const currDate = new Date(targetYear, targetMonth + i, 1);
        let foundY = yearIndex;
        let foundC = (mIdx + i) % 12;
        if (keyData.outgoings?.headers) {
          for (const y of [1, 2, 3]) {
            const hdrs = keyData.outgoings.headers[y] || [];
            for (let c = 0; c < hdrs.length; c++) {
              const hd = DeepDiveEngine.parseHeaderDate(hdrs[c]);
              if (hd && hd.getFullYear() === currDate.getFullYear() && hd.getMonth() === currDate.getMonth()) {
                foundY = y;
                foundC = c;
                break;
              }
            }
          }
        }
        const allocs = e.allocations?.[foundY] || e.monthlyAllocations || [];
        amt += parseMoney(allocs[foundC] || 0);
      }

      return {
        name: e.name,
        detail: "", // No VAT or timing info per instruction
        amount: Math.round(amt),
      };
    }).filter((item) => item.amount > 0);

    const totalExp = items.reduce((s, i) => s + i.amount, 0);
    let drift = Math.round(parseMoney(cellValue) - totalExp);
    if (Math.abs(drift) > 0 && Math.abs(drift) <= 2 && items.length > 0) {
      let maxIdx = 0;
      for (let k = 1; k < items.length; k++) {
        if (items[k].amount > items[maxIdx].amount) maxIdx = k;
      }
      items[maxIdx].amount += drift;
      drift = 0;
    }
    if (isScenarioView && Math.abs(drift) > 2) {
      items.push({ name: "Manual scenario adjustment", amount: drift });
    } else if (!isScenarioView && Math.abs(drift) > 2) {
      items.push({ name: "Rounding adjustment", amount: drift });
    }

    return {
      title: isDel ? "Delivery expenses" : "Non-delivery expenses",
      period: periodLabel,
      total: cellValue,
      items,
      sections: null,
    };
  }

  // 7. Dividends (Performance)
  if (ddType === "dividends") {
    const dividends = keyData.outgoings?.dividends || [];
    const items = dividends
      .map((d) => {
        const allocs = d.allocations?.[yearIndex] || d.monthlyAllocations || [];
        const amt = isFYTotal
          ? d.totals?.[yearIndex] || 0
          : parseMoney(allocs[monthIndex] || "0");
        return {
          name: d.name,
          amount: Math.round(amt),
        };
      })
      .filter((item) => item.amount > 0);

    return {
      title: "Dividends as salary",
      period: periodLabel,
      total: cellValue,
      items,
      sections: null,
    };
  }

  // 8. Confirmed Cash Incoming (Matching WebApp.html lines 17118-17131)
  if (ddType === "cashConfInflow" || ddType === "cashConfInc" || ddType === "confCash") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    const jobCash = CashDeepDiveEngine.getJobCash(allJobs, effectiveDate, "confCash");
    const targetCellVal = parseMoney(cellValue);
    const sumItems = jobCash.reduce((s, i) => s + i.amount, 0);
    const drift = Math.round(targetCellVal - sumItems);

    const items = jobCash.map((j) => ({
      name: j.name,
      client: j.client,
      desc: j.desc || "",
      payDate: j.payDate,
      payDateStr: DeepDiveEngine.formatShortDate(j.payDate),
      status: j.status || "",
      amount: j.amount,
      isPipeline: false,
    }));

    if (Math.abs(drift) > 2) {
      items.push({
        name: "Manual adjustment",
        amount: drift,
      });
    }

    return {
      title: "Confirmed cash incoming",
      period: periodLabel,
      total: cellValue,
      items,
      sections: null,
    };
  }

  // 9. Pipeline Cash Incoming (Matching WebApp.html lines 17118-17131)
  if (ddType === "cashPipeInflow" || ddType === "cashPipeInc" || ddType === "pipeCash") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    const jobCash = CashDeepDiveEngine.getJobCash(allJobs, effectiveDate, "pipeCash");
    const targetCellVal = parseMoney(cellValue);
    const sumItems = jobCash.reduce((s, i) => s + i.amount, 0);
    const drift = Math.round(targetCellVal - sumItems);

    const items = jobCash.map((j) => ({
      name: j.name,
      client: j.client,
      desc: j.desc || "",
      payDate: j.payDate,
      payDateStr: DeepDiveEngine.formatShortDate(j.payDate),
      status: j.status || "",
      amount: j.amount,
      isPipeline: true,
    }));

    if (Math.abs(drift) > 2) {
      items.push({
        name: "Manual adjustment",
        amount: drift,
      });
    }

    return {
      title: "Pipeline cash incoming",
      period: periodLabel,
      total: cellValue,
      items,
      sections: null,
    };
  }

  // 10. Cash Salaries Outflows (Matching WebApp.html lines 17150-17185)
  if (ddType === "cashSalaries" || ddType === "salCash") {
    if (isRestricted) {
      return {
        title: "Salary payments",
        period: periodLabel,
        total: cellValue,
        items: [],
        sections: [
          {
            title: "Salary payments",
            amount: parseMoney(cellValue),
            isAccordion: false,
          },
        ],
      };
    }

    const items = CashDeepDiveEngine.getSalariesCash(effectiveDate, keyData.salaries);
    let total = items.reduce((sum, item) => sum + item.amount, 0);

    const targetCellVal = parseMoney(cellValue);
    const drift = Math.round(targetCellVal - total);
    if (Math.abs(drift) > 2) {
      items.push({
        name: "Manual adjustment",
        amount: drift,
      });
    }

    return {
      title: "Salaries outgoing",
      period: periodLabel,
      total: cellValue,
      items,
      sections: null,
    };
  }

  // 11. Cash Contractors (Matching WebApp.html lines 17132-17149)
  if (ddType === "cashContractors" || ddType === "conCash" || ddType === "conCash_incl") {
    const list = CashDeepDiveEngine.getOutgoingsCash(effectiveDate, "conCash_incl", keyData);
    const targetCellVal = parseMoney(cellValue);
    const total = list.reduce((sum, item) => sum + item.amount, 0);
    const drift = Math.round(targetCellVal - total);

    if (Math.abs(drift) > 2) {
      list.push({
        name: "Manual adjustment",
        amount: drift,
      });
    }

    return {
      title: "Contractors outgoing",
      period: periodLabel,
      total: cellValue,
      items: list,
      sections: null,
    };
  }

  // 12. Cash Direct Costs (Matching WebApp.html lines 17118-17131)
  if (ddType === "cashDirCosts" || ddType === "dirCash" || ddType === "dirCash_incl") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    const jobCash = CashDeepDiveEngine.getJobCash(allJobs, effectiveDate, "cashDirCosts");
    const targetCellVal = parseMoney(cellValue);
    const sumItems = jobCash.reduce((s, i) => s + i.amount, 0);
    const drift = Math.round(targetCellVal - sumItems);

    const items = jobCash.map((j) => ({
      name: j.name,
      client: j.client,
      desc: j.desc || "",
      payDate: j.payDate,
      payDateStr: DeepDiveEngine.formatShortDate(j.payDate),
      status: j.status || "",
      amount: j.amount,
      isPipeline: false,
    }));

    if (Math.abs(drift) > 2) {
      items.push({
        name: "Manual adjustment",
        amount: drift,
      });
    }

    return {
      title: "Direct cost payments",
      period: periodLabel,
      total: cellValue,
      items,
      sections: null,
    };
  }

  // 13. Cash Outgoings / Other Expenses (Matching WebApp.html lines 17132-17149)
  if (ddType === "cashOutgoings" || ddType === "expCash") {
    const list = CashDeepDiveEngine.getOutgoingsCash(effectiveDate, "expCash", keyData);
    const targetCellVal = parseMoney(cellValue);
    const total = list.reduce((sum, item) => sum + item.amount, 0);
    const drift = Math.round(targetCellVal - total);

    if (Math.abs(drift) > 2) {
      list.push({
        name: "Manual adjustment",
        amount: drift,
      });
    }

    return {
      title: "Other expenses",
      period: periodLabel,
      total: cellValue,
      items: list,
      sections: null,
    };
  }

  // 14. Cash Dividends (Matching WebApp.html line 17273)
  if (ddType === "cashDividends" || ddType === "divCash") {
    return {
      title: "Dividends as salary",
      period: periodLabel,
      total: cellValue,
      items: [],
      sections: [
        {
          title: "Dividends as salary",
          amount: parseMoney(cellValue),
          isAccordion: false,
        },
      ],
    };
  }

  // 15. Flat Cash Flow Detail Rows (Matching WebApp.html lines 17272-17283)
  const cashFlatTitles = {
    taxCash: "Corporation tax",
    vatCash: "VAT",
    nonOpIncCash: "Non-operating income",
    nonOpExpCash: "Non-operating expenses",
    otherMoveCash: "Other cash movements",
    cashTaxes: "Tax payments",
    cashOther: "Other cash movements",
  };

  if (cashFlatTitles[ddType]) {
    const displayTitle = cashFlatTitles[ddType];
    return {
      title: displayTitle,
      period: periodLabel,
      total: cellValue,
      items: [],
      sections: [
        {
          title: displayTitle,
          amount: parseMoney(cellValue),
          isAccordion: false,
        },
      ],
    };
  }

  return {
    title: "Breakdown",
    period: periodLabel,
    total: cellValue,
    items: [],
    sections: null,
  };
}

/**
 * mutateFYDataForScenarios
 * Direct algebraic resolution engine ported from client-GAS-scripts/WebApp.html (lines 14512-14910)
 */
export function mutateFYDataForScenarios(activeYear, scenariosConfig = {}) {
  if (!activeYear || !activeYear.rows) return null;
  const yearData = JSON.parse(JSON.stringify(activeYear));
  const rows = yearData.rows;
  const headerMonths = yearData.headerMonths || [];

  const formatCurrency = (num) => (num === 0 ? `${getCurrencySymbol()}0` : formatMoney(num));
  const formatPercent = (num) => Math.round(num * 100) + "%";

  const monthDates = [];
  for (let m = 0; m < 12; m++) {
    const str = headerMonths[m] || "";
    const ukDate = String(str).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (ukDate) {
      monthDates[m] = new Date(parseInt(ukDate[3], 10), parseInt(ukDate[2], 10) - 1, parseInt(ukDate[1], 10));
    } else {
      const shortDate = String(str).match(/^([a-zA-Z]{3})[\s\-](\d{2,4})$/);
      if (shortDate) {
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const mi = months[shortDate[1].toLowerCase()];
        let yr = parseInt(shortDate[2], 10);
        if (yr < 100) yr += 2000;
        monthDates[m] = new Date(yr, mi, 1);
      } else {
        const d = new Date(str);
        monthDates[m] = isNaN(d.getTime()) ? null : d;
      }
    }
  }

  const confirmedJobs = scenariosConfig.confirmedJobs || new Set();
  const disabledJobs = scenariosConfig.disabledJobs || new Set();
  const adjs = scenariosConfig.adjs || {
    rev: Array(12).fill(0),
    delStaff: Array(12).fill(0),
    delExp: Array(12).fill(0),
    nonDelStaff: Array(12).fill(0),
    nonDelExp: Array(12).fill(0),
    nbChecked: Array(12).fill(true),
  };
  const jobsList = scenariosConfig.jobs || [];
  const outgoingsMeta = scenariosConfig.outgoingsMeta || {};
  const yearIdx = scenariosConfig.yearIndex !== undefined ? scenariosConfig.yearIndex : 2;
  const outIdx = Math.max(0, yearIdx - 1);

  // Determine mode directly from row 12
  const row12Label = String(rows[12]?.label || "").toLowerCase();
  const isRevMode = row12Label.includes("direct");

  let sumDeltaConfRev = 0, sumDeltaPipeRev = 0, sumDeltaNB = 0;
  let sumDeltaDC = 0, sumDeltaDelStaff = 0, sumDeltaDelExp = 0;
  let sumDeltaNonDelStaff = 0, sumDeltaNonDelExp = 0;

  const scenarioMeta = {
    mCos: new Array(12).fill(0),
    psDel: new Array(12).fill(0),
    psNonDel: new Array(12).fill(0),
    adjDelStaff: new Array(12).fill(0),
    adjNonDelStaff: new Array(12).fill(0),
    adjDelExp: new Array(12).fill(0),
    adjNonDelExp: new Array(12).fill(0),
    adjRev: new Array(12).fill(0),
  };

  for (let m = 0; m <= 12; m++) {
    const isTotalCol = m === 12;

    const getExactVal = (rIdx) => {
      const row = activeYear.rows[rIdx];
      if (!row) return 0;
      if (isTotalCol) {
        return typeof row.totalMath === "number" ? row.totalMath : parseMoney(row.totalVal);
      }
      const rawNum = row.monthlyMath?.[m];
      return typeof rawNum === "number" ? rawNum : parseMoney(row.monthlyValues?.[m]);
    };

    const getVisualVal = (rIdx) => {
      const row = activeYear.rows[rIdx];
      if (!row) return 0;
      if (isTotalCol) return parseMoney(row.totalVal);
      return parseMoney(row.monthlyValues?.[m]);
    };

    const getOldVal = getExactVal;

    let deltaConfRev = 0, deltaPipeRev = 0, deltaNB = 0, deltaDC = 0;
    let adjDelStaff = 0, adjDelExp = 0, adjNonDelStaff = 0, adjNonDelExp = 0;

    if (!isTotalCol) {
      let exactPipeRevDeduction = 0, exactAssumedConfRev = 0, exactDCDeduction = 0, exactAssumedConfDCAdd = 0;

      jobsList.forEach((job) => {
        const pId = Number(job.parentId !== undefined ? job.parentId : (job.rowNumber - 2));
        const isConfirmed = confirmedJobs.has(pId) || confirmedJobs.has(job.id);
        const isUnchecked = disabledJobs.has(pId) || disabledJobs.has(job.id);

        let prob = 1;
        if (job.likelihood) {
          let parsed = parseFloat(String(job.likelihood).replace("%", ""));
          if (!isNaN(parsed)) prob = String(job.likelihood).includes("%") ? parsed / 100 : (parsed > 1 ? parsed / 100 : parsed);
        }
        if (prob <= 0 || prob > 1) prob = 1;

        if (!monthDates[m]) return;

        let jobRevMonthWeighted = PulseMath.calcMonthly(job, monthDates[m], "revenue", !isRevMode);
        let jobDcMonthWeighted = PulseMath.calcMonthly(job, monthDates[m], "directCosts", !isRevMode);

        if (isConfirmed || isUnchecked) {
          exactPipeRevDeduction += jobRevMonthWeighted;
        }

        if (isConfirmed) {
          let grossRevMonth = prob > 0 ? jobRevMonthWeighted / prob : 0;
          let grossDcMonth = prob > 0 ? jobDcMonthWeighted / prob : 0;
          exactAssumedConfRev += grossRevMonth;
          if (isRevMode) {
            exactAssumedConfDCAdd += grossDcMonth - jobDcMonthWeighted;
          }
        } else if (isUnchecked) {
          if (isRevMode) exactDCDeduction += jobDcMonthWeighted;
        }
      });

      const exactOldConfRev = getOldVal(3);
      const exactNewConfRev = exactOldConfRev + exactAssumedConfRev + (adjs.rev[m] || 0);

      const exactOldPipeRev = getOldVal(4);
      const exactNewPipeRev = exactOldPipeRev - exactPipeRevDeduction;

      const exactOldNB = getOldVal(5);
      const exactNewNB = adjs.nbChecked[m] ? exactOldNB : 0;

      deltaConfRev = Math.round(exactNewConfRev) - Math.round(exactOldConfRev);
      deltaPipeRev = Math.round(exactNewPipeRev) - Math.round(exactOldPipeRev);
      deltaNB = Math.round(exactNewNB) - Math.round(exactOldNB);

      let newTotalRev = getOldVal(8) + (exactNewConfRev - exactOldConfRev) + (exactNewPipeRev - exactOldPipeRev) + (exactNewNB - exactOldNB);

      let exactNewDC = 0;
      if (isRevMode) {
        const exactOldDC = getOldVal(12);
        exactNewDC = Math.max(0, exactOldDC - exactDCDeduction + exactAssumedConfDCAdd);
        deltaDC = Math.round(exactNewDC) - Math.round(exactOldDC);
      } else {
        deltaDC = 0;
      }

      let adjDelStaffRaw = adjs.delStaff[m] || 0;
      let adjNonDelStaffRaw = adjs.nonDelStaff[m] || 0;
      let exactAdjDelExp = adjs.delExp[m] || 0;
      let exactAdjNonDelExp = adjs.nonDelExp[m] || 0;
      adjDelExp = Math.round(exactAdjDelExp);
      adjNonDelExp = Math.round(exactAdjNonDelExp);

      let salaryDel = 0, salaryNonDel = 0;
      if (outgoingsMeta.salariesDel && outgoingsMeta.salariesDel[outIdx]) {
        salaryDel = parseMoney(outgoingsMeta.salariesDel[outIdx][m]);
      }
      if (outgoingsMeta.salariesNonDel && outgoingsMeta.salariesNonDel[outIdx]) {
        salaryNonDel = parseMoney(outgoingsMeta.salariesNonDel[outIdx][m]);
      }

      let baseM = 0, basePS_del = 0, basePS_nonDel = 0, forceZeroM = false;
      let M_tgt = outgoingsMeta.makingUpCosPct || 0;

      if (outgoingsMeta.makingUpCosBase && outgoingsMeta.makingUpCosBase[outIdx]) {
        baseM = parseMoney(outgoingsMeta.makingUpCosBase[outIdx][m]);
      }
      if (outgoingsMeta.profitShareBaseDel && outgoingsMeta.profitShareBaseDel[outIdx]) {
        basePS_del = parseMoney(outgoingsMeta.profitShareBaseDel[outIdx][m]);
      }
      if (outgoingsMeta.profitShareBaseNonDel && outgoingsMeta.profitShareBaseNonDel[outIdx]) {
        basePS_nonDel = parseMoney(outgoingsMeta.profitShareBaseNonDel[outIdx][m]);
      }
      if (outgoingsMeta.makingUpCosHardZero && outgoingsMeta.makingUpCosHardZero[outIdx]) {
        if (outgoingsMeta.makingUpCosHardZero[outIdx][m] === true) forceZeroM = true;
      }

      let newDirectCosts = isRevMode ? exactNewDC : 0;
      let newOtherExpDel = isRevMode ? (getOldVal(13) + exactAdjDelExp) : (getOldVal(12) + exactAdjDelExp);
      let newOtherExpNonDel = getOldVal(23) + exactAdjNonDelExp;

      let trueStaffDel = (getOldVal(11) - baseM - basePS_del) + adjDelStaffRaw;
      let trueStaffNonDel = (getOldVal(22) - basePS_nonDel) + adjNonDelStaffRaw;

      let pBase = newTotalRev - newDirectCosts - newOtherExpDel - newOtherExpNonDel - trueStaffDel - trueStaffNonDel;

      let p = 0;
      const psSwitch = String(scenariosConfig.profitShareSwitch || outgoingsMeta.profitShareSwitch || "").trim().toLowerCase();
      if (psSwitch === "monthly") {
        p = scenariosConfig.profitSharePct !== undefined ? scenariosConfig.profitSharePct : (outgoingsMeta.profitSharePct || 0);
      }

      let M = 0, B = 0, B_del = 0, B_nonDel = 0;
      let targetCoS = newTotalRev * M_tgt;
      let trueBaseCoS = newDirectCosts + newOtherExpDel + trueStaffDel;

      let totalSalaries = salaryDel + salaryNonDel;
      let d = totalSalaries > 0 ? (salaryDel / totalSalaries) : 0.5;

      let hasFinancialDeltas = (deltaConfRev !== 0 || deltaPipeRev !== 0 || deltaNB !== 0 || deltaDC !== 0 || adjDelStaffRaw !== 0 || adjNonDelStaffRaw !== 0 || adjDelExp !== 0 || adjNonDelExp !== 0);

      if (!hasFinancialDeltas) {
        M = baseM;
        B_del = basePS_del;
        B_nonDel = basePS_nonDel;
        B = B_del + B_nonDel;
      } else {
        if (M_tgt > 0 && !forceZeroM) {
          let denom = 1 - (p * d);
          if (denom === 0) denom = 1;
          let B_temp = (p * (pBase - targetCoS + trueBaseCoS)) / denom;
          let M_temp = targetCoS - trueBaseCoS - (B_temp * d);

          if (M_temp < 0) {
            M = 0;
            B = p * Math.max(0, pBase);
          } else {
            if (B_temp < 0) {
              B = 0;
              M = Math.max(0, targetCoS - trueBaseCoS);
            } else {
              M = M_temp;
              B = B_temp;
            }
          }
        } else {
          M = 0;
          B = p * Math.max(0, pBase);
        }

        if (M < 0) M = 0;
        if (B < 0) B = 0;

        B_del = B * d;
        B_nonDel = B * (1 - d);
      }

      scenarioMeta.mCos[m] = Math.round(M);
      scenarioMeta.psDel[m] = Math.round(B_del);
      scenarioMeta.psNonDel[m] = Math.round(B_nonDel);
      scenarioMeta.adjDelStaff[m] = adjDelStaffRaw;
      scenarioMeta.adjNonDelStaff[m] = adjNonDelStaffRaw;
      scenarioMeta.adjDelExp[m] = adjDelExp;
      scenarioMeta.adjNonDelExp[m] = adjNonDelExp;
      scenarioMeta.adjRev[m] = adjs.rev[m] || 0;

      adjDelStaff = Math.round((M - baseM) + (B_del - basePS_del) + adjDelStaffRaw);
      adjNonDelStaff = Math.round((B_nonDel - basePS_nonDel) + adjNonDelStaffRaw);

      sumDeltaConfRev += deltaConfRev;
      sumDeltaPipeRev += deltaPipeRev;
      sumDeltaNB += deltaNB;
      sumDeltaDC += deltaDC;
      sumDeltaDelStaff += adjDelStaff;
      sumDeltaDelExp += adjDelExp;
      sumDeltaNonDelStaff += adjNonDelStaff;
      sumDeltaNonDelExp += adjNonDelExp;
    } else {
      // Total column uses horizontal delta sums
      deltaConfRev = sumDeltaConfRev;
      deltaPipeRev = sumDeltaPipeRev;
      deltaNB = sumDeltaNB;
      deltaDC = sumDeltaDC;
      adjDelStaff = sumDeltaDelStaff;
      adjDelExp = sumDeltaDelExp;
      adjNonDelStaff = sumDeltaNonDelStaff;
      adjNonDelExp = sumDeltaNonDelExp;
    }

    const applyDelta = (rIdx, delta) => {
      if (rows[rIdx] && rows[rIdx].label !== "Hide") {
        const visualBaseline = getVisualVal(rIdx);
        const newVal = formatCurrency(visualBaseline + delta);
        if (isTotalCol) {
          rows[rIdx].totalVal = newVal;
        } else {
          rows[rIdx].monthlyValues[m] = newVal;
        }
      }
    };

    applyDelta(3, deltaConfRev); // Confirmed Revenue
    applyDelta(4, deltaPipeRev); // Pipeline Revenue
    applyDelta(5, deltaNB); // NB to Find

    const totalDeltaRev = deltaConfRev + deltaPipeRev + deltaNB;
    applyDelta(8, totalDeltaRev); // Total Rev

    applyDelta(11, adjDelStaff); // Staff costs delivery

    let deltaCOS = 0;
    if (isRevMode) {
      applyDelta(12, deltaDC); // Direct costs
      applyDelta(13, adjDelExp); // Other expenses - delivery
      deltaCOS = deltaDC + adjDelStaff + adjDelExp;
    } else {
      applyDelta(12, adjDelExp);
      deltaCOS = adjDelStaff + adjDelExp;
    }
    applyDelta(15, deltaCOS); // Total Costs of Sale

    const deltaGP = totalDeltaRev - deltaCOS;
    applyDelta(17, deltaGP); // Gross Profit

    applyDelta(22, adjNonDelStaff); // Staff costs non-delivery
    applyDelta(23, adjNonDelExp); // Other expenses non-delivery

    const deltaOverheads = adjNonDelStaff + adjNonDelExp;
    applyDelta(25, deltaOverheads); // Total Overheads

    applyDelta(29, deltaGP - deltaOverheads); // Operating Profit

    // Recalculate Margins
    const getNewVal = (rIdx) => {
      if (!rows[rIdx] || rows[rIdx].label === "Hide") return 0;
      return parseMoney(isTotalCol ? rows[rIdx].totalVal : rows[rIdx].monthlyValues[m]);
    };
    const newTotalRev = getNewVal(8);

    if (rows[19] && rows[19].label !== "Hide") {
      const pct = formatPercent(newTotalRev ? getNewVal(17) / newTotalRev : 0);
      if (isTotalCol) rows[19].totalVal = pct;
      else rows[19].monthlyValues[m] = pct;
    }
    if (rows[27] && rows[27].label !== "Hide") {
      const pct = formatPercent(newTotalRev ? getNewVal(25) / newTotalRev : 0);
      if (isTotalCol) rows[27].totalVal = pct;
      else rows[27].monthlyValues[m] = pct;
    }
    if (rows[31] && rows[31].label !== "Hide") {
      const pct = formatPercent(newTotalRev ? getNewVal(29) / newTotalRev : 0);
      if (isTotalCol) rows[31].totalVal = pct;
      else rows[31].monthlyValues[m] = pct;
    }
  }

  yearData.scenarioMeta = scenarioMeta;
  return yearData;
}

export function getKPIColor(valStr, t1, t2, higherBetter = true) {
  if (!valStr || !String(valStr).includes("%")) return null;
  const num = parseFloat(String(valStr).replace(/%/g, "")) / 100;
  if (isNaN(num)) return null;

  let bg = "#d9ead3"; // sage green
  if (higherBetter) {
    if (num < t2) bg = "#f4cccc"; // rose pink
    else if (num <= t1) bg = "#fce5cd"; // peach
    else bg = "#d9ead3";
  } else {
    if (num > t1) bg = "#f4cccc";
    else if (num >= t2) bg = "#d9ead3";
    else bg = "#fce5cd";
  }
  return bg;
}
