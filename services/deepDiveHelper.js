/**
 * deepDiveHelper.js
 * Universal Math Engine & Deep Dive Aggregation matching client-GAS-scripts/WebApp.html
 */

export function parseMoney(val) {
  if (typeof val === "number") return val;
  if (!val) return 0;
  const clean = String(val).replace(/[£,]/g, "").trim();
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

export function formatMoney(val) {
  const rounded = Math.round(val || 0);
  const sign = rounded < 0 ? "-" : "";
  return `${sign}£${Math.abs(rounded).toLocaleString()}`;
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

    // Strict boundary enforcement exactly matching Google Sheets ER >= B2 and EQ <= C2
    if (eqEnd < tStart || eqStart > tEnd) return 0;

    const isRetainer =
      String(job.projectRetainer || "").toLowerCase().includes("retainer") ||
      String(job.type || "").toLowerCase().includes("retainer");
    const isPipeline = String(job.type || "").toLowerCase() === "pipeline";
    const hasSplit = String(job.hasSplit || "").toLowerCase() === "true";

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
        let prob = 1;
        if (job.likelihood !== undefined && job.likelihood !== "") {
          let parsed = parseFloat(String(job.likelihood).replace("%", ""));
          if (!isNaN(parsed)) prob = parsed > 1 ? parsed / 100 : parsed;
        }
        if (prob < 0 || prob > 1) prob = 1;
        valToReturn = valToReturn * prob;
      }

      return valToReturn;
    }

    // --- STANDARD/RETAINER LOGIC ---
    // Return precise pre-calculated values from Google Sheets Helper Columns
    let origBaseRev = parseMoney(job.origBaseRev);
    let origBaseIncome = parseMoney(job.origBaseIncome);
    let origBaseDC = origBaseRev - origBaseIncome;

    if (origBaseRev === 0 && origBaseIncome === 0) {
      // Fallback if spreadsheet helper columns are missing for this row
      const rev = parseMoney(job.revenue || job.revNum);
      const dc = parseMoney(job.directCosts || job.dcNum);
      let prob = 1;
      if (isPipeline) {
        const parsed = parseFloat(String(job.likelihood || "50").replace("%", ""));
        if (!isNaN(parsed)) prob = parsed > 1 ? parsed / 100 : parsed;
      }
      if (isRetainer) {
        origBaseRev = rev * prob;
        origBaseIncome = (rev - dc) * prob;
        origBaseDC = dc * prob;
      } else {
        const totalMonths = Math.max(1, (eqEnd.getFullYear() - eqStart.getFullYear()) * 12 + (eqEnd.getMonth() - eqStart.getMonth()) + 1);
        origBaseRev = (rev / totalMonths) * prob;
        origBaseIncome = ((rev - dc) / totalMonths) * prob;
        origBaseDC = (dc / totalMonths) * prob;
      }
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

  getJobsForMonth(allJobs, targetDate, type, isIncomeMode = false) {
    let results = [];
    if (!allJobs || allJobs.length === 0) return results;

    allJobs.forEach((job) => {
      let effectiveType = String(job.type || "").toLowerCase();

      if (type === "confRev" && effectiveType === "pipeline") return;
      if (type === "pipeRev" && effectiveType !== "pipeline") return;

      const valueType = type === "dirCosts" ? "directCosts" : "revenue";
      const monthlyAmount = PulseMath.calcMonthly(job, targetDate, valueType, isIncomeMode);

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
        if (isRetainer) {
          detail = `Retainer | £${Math.round(monthlyAmount).toLocaleString()} per month${datesStr}`;
        } else {
          detail = `Project | £${Math.round(rawAmount).toLocaleString()}${datesStr}`;
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
          status: job.type,
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

    allJobs.forEach((job) => {
      const isRetainer = String(job.projectRetainer || "").toLowerCase().includes("retainer");
      const hasMultipleInvoices = !!job.inv2Amount || !!job.inv3Amount || !!job.inv2SendDate || !!job.inv3SendDate;
      const currentVatRate = job.vat === "Yes" ? vatRate : 0;

      let likelihood = 1;
      if (String(job.type || "").toLowerCase() === "pipeline") {
        const parsedLikel = parseFloat(String(job.likelihood).replace("%", ""));
        if (!isNaN(parsedLikel)) {
          likelihood = parsedLikel > 1 ? parsedLikel / 100 : parsedLikel;
        }
      }

      if (isRetainer && !hasMultipleInvoices) {
        const amountRaw = job.inv1Amount || job.revenue;
        const parsedSend = this.parseSafeDate(job.inv1SendDate || job.inv1RecDate || job.startDate);
        const parsedStart = this.parseSafeDate(job.adjStartDate || job.startDate);
        const parsedEnd = this.parseSafeDate(job.adjEndDate || job.endDate);

        if (amountRaw && parsedSend && parsedStart && parsedEnd) {
          const amountExVat = parseMoney(amountRaw) * likelihood;
          if (Math.abs(amountExVat) < 0.01) return;

          const startDate = new Date(parsedStart.y, parsedStart.m, 1);
          const endDate = new Date(parsedEnd.y, parsedEnd.m, 1);
          const status = job.inv1Status || "Pending";
          const ref = job.inv1Ref || "";

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
                ref: ref ? `${ref} (Month ${monthCount})` : `Retainer Month ${monthCount}`,
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

            const invData = {
              client: job.client,
              jobName: job.jobName,
              type: job.projectRetainer || "Project",
              ref: job[`inv${i}Ref`] || `Invoice ${i}`,
              amountExVat,
              vatAmount,
              totalAmount,
              sendDate,
              status: String(job.type || "").toLowerCase() === "pipeline" ? "" : (job[`inv${i}Status`] || "Pending"),
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
        const parsedLikel = parseFloat(String(job.likelihood).replace("%", ""));
        if (!isNaN(parsedLikel)) {
          likelihood = parsedLikel > 1 ? parsedLikel / 100 : parsedLikel;
        }
      }

      if (isRetainer && !hasMultipleInvoices && !isDirCash) {
        const amountRaw = job[`${prefix}1Amount`] || job.revenue;
        const parsedSend = this.parseSafeDate(job[`${prefix}1SendDate`] || job[`${prefix}1RecDate`] || job.startDate);
        const parsedStart = this.parseSafeDate(job.adjStartDate || job.startDate);
        const parsedEnd = this.parseSafeDate(job.adjEndDate || job.endDate);

        if (amountRaw && parsedSend && parsedStart && parsedEnd) {
          const multiplier = isDirCash ? (job[`dirInv1Vat`] === "Yes" ? (1 + vatRate) : 1) : vatMultiplier;
          let amount = parseMoney(amountRaw) * multiplier * likelihood;
          if (isDirCash) amount = -Math.abs(amount);

          if (Math.abs(amount) < 0.01) return;

          const startDate = new Date(parsedStart.y, parsedStart.m, 1);
          const endDate = new Date(parsedEnd.y, parsedEnd.m, 1);
          const daysToPay = this.parseSafeDays(job[`${prefix}1Days`]);
          const status = job[`${prefix}1Status`] || "Pending";
          const ref = job[`${prefix}1Ref`] || "";

          let currDate = new Date(startDate.getTime());
          let monthCount = 1;

          while (currDate <= endDate) {
            const simulatedSendDate = new Date(currDate.getFullYear(), currDate.getMonth(), parsedSend.d || 1);
            const payDate = new Date(simulatedSendDate.getFullYear(), simulatedSendDate.getMonth(), simulatedSendDate.getDate() + daysToPay);

            if (payDate.getFullYear() === targetYear && payDate.getMonth() === targetMonth) {
              const desc = isDirCash ? `Direct cost (Month ${monthCount})` : (ref ? `${ref} (Month ${monthCount})` : `Retainer Month ${monthCount}`);
              results.push({
                client: job.client,
                name: job.jobName,
                desc: isPipelineType ? "" : desc,
                amount: Math.round(amount),
                payDate,
                status: isPipelineType ? "" : status,
                isPipeline: isPipelineType,
                type: job.projectRetainer || "Retainer",
              });
            }
            currDate.setMonth(currDate.getMonth() + 1);
            monthCount++;
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
              status: isPipelineType ? "" : (job[`${prefix}${i}Status`] || "Pending"),
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
};

export function getDeepDiveType(rowLabel = "") {
  const l = String(rowLabel).toLowerCase().trim();
  if (l.includes("confirmed revenue") || l.includes("confirmed income") || l.includes("confirmed project") || l.includes("confirmed retainer")) return "confRev";
  if (l.includes("pipeline revenue") || l.includes("pipeline income") || l.includes("pipeline opportunity")) return "pipeRev";
  if (l.includes("staff costs - delivery") || l.includes("delivery staff")) return "staffDel";
  if (l.includes("staff costs - non-delivery") || l.includes("overhead staff") || l.includes("management staff")) return "staffNonDel";
  if (l.includes("direct cost payments") || l.includes("direct cost")) return "dirCosts";
  if (l.includes("other expenses - delivery") || l.includes("delivery expense")) return "expDel";
  if (l.includes("other expenses - non-delivery") || l.includes("overhead expense") || l.includes("overheads") || l.includes("general overhead")) return "expNonDel";
  if (l.includes("dividends as salary") || l.includes("dividend")) return "dividends";
  if (l.includes("confirmed cash incoming") || l.includes("confirmed receipts")) return "cashConfInflow";
  if (l.includes("pipeline cash incoming") || l.includes("pipeline receipts")) return "cashPipeInflow";
  if (l.includes("salaries") || l.includes("net wages") || l.includes("wages")) return "cashSalaries";
  if (l.includes("contractors")) return "cashContractors";
  if (l.includes("other expenses")) return "cashOutgoings";
  return null;
}

export function buildDeepDiveData({
  ddType,
  periodLabel,
  monthIndex, // 0 to 11, or -1 for FY total
  cellValue,
  yearIndex = 1, // 1, 2, or 3
  targetDate = null,
  keyData,
  isIncomeMode = false,
}) {
  if (!keyData) {
    return {
      title: "Breakdown",
      period: periodLabel,
      total: cellValue,
      items: [],
    };
  }

  const isFYTotal = monthIndex === -1;
  const effectiveDate = targetDate || new Date(2025 + (yearIndex - 1), Math.max(0, monthIndex), 1);

  // 1. Confirmed Revenue
  if (ddType === "confRev") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    let items = [];

    if (isFYTotal) {
      items = DeepDiveEngine.aggregatePeriods(new Date(effectiveDate.getFullYear(), 0, 1), 12, (d) =>
        DeepDiveEngine.getJobsForMonth(allJobs, d, "confRev", isIncomeMode)
      );
    } else {
      items = DeepDiveEngine.getJobsForMonth(allJobs, effectiveDate, "confRev", isIncomeMode);
    }

    return {
      title: isIncomeMode ? "Confirmed Income Contributors" : "Confirmed Revenue Contributors",
      period: periodLabel,
      total: cellValue,
      items: items.map((i) => ({
        name: i.name,
        client: i.client,
        detail: i.detail,
        badge: "Confirmed",
        amount: i.amount,
      })),
    };
  }

  // 2. Pipeline Revenue
  if (ddType === "pipeRev") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    let items = [];

    if (isFYTotal) {
      items = DeepDiveEngine.aggregatePeriods(new Date(effectiveDate.getFullYear(), 0, 1), 12, (d) =>
        DeepDiveEngine.getJobsForMonth(allJobs, d, "pipeRev", isIncomeMode)
      );
    } else {
      items = DeepDiveEngine.getJobsForMonth(allJobs, effectiveDate, "pipeRev", isIncomeMode);
    }

    return {
      title: isIncomeMode ? "Pipeline Income Opportunities" : "Pipeline Revenue Opportunities",
      period: periodLabel,
      total: cellValue,
      items: items.map((i) => ({
        name: i.name,
        client: i.client,
        detail: `${i.likelihood} likelihood • ${i.detail}`,
        badge: "Pipeline",
        amount: i.amount,
      })),
    };
  }

  // 3 & 4. Staff Costs - Delivery & Non-Delivery (Ported from WebApp.html lines 16413-16527)
  if (ddType === "staffDel" || ddType === "staffNonDel") {
    const isDel = ddType === "staffDel";
    const items = [];
    const yIdx = Math.max(0, yearIndex - 1);
    const mIdx = monthIndex >= 0 ? monthIndex : 0;

    // A. Salaries
    const staffList = keyData.salaries?.staff || [];
    let calcSalTotal = 0;
    const salaryItems = [];
    staffList.forEach((s) => {
      let delPct = 0;
      if (s.deliveryPct !== undefined && String(s.deliveryPct).trim() !== "") {
        delPct = parseMoney(s.deliveryPct);
        if (String(s.deliveryPct).includes("%")) delPct = delPct / 100;
        else if (delPct > 1) delPct = delPct / 100;
      } else if (s.isDelivery) {
        delPct = 1;
      }
      const applicablePct = isDel ? delPct : (1 - delPct);
      if (applicablePct <= 0.001) return;

      const monthlyCost = isFYTotal ? s.actualAnnualCost : (s.actualAnnualCost / 12);
      const amt = Math.round(monthlyCost * applicablePct);
      if (amt > 0) {
        calcSalTotal += amt;
        const mathText = Math.abs(applicablePct - 1) > 0.01 ? `${Math.round(applicablePct * 100)}% of ${formatMoney(monthlyCost)}` : "";
        salaryItems.push({
          name: s.name,
          client: "",
          detail: s.role ? (mathText ? `${s.role} • ${mathText}` : s.role) : mathText,
          badge: isDel ? "Delivery" : "Overhead",
          amount: amt,
        });
      }
    });

    // Employment allowance difference
    let actualSalaries = 0;
    if (keyData.outgoingsMeta) {
      if (isDel && keyData.outgoingsMeta.salariesDel?.[yIdx]) {
        actualSalaries = isFYTotal
          ? keyData.outgoingsMeta.salariesDel[yIdx].reduce((a, b) => a + b, 0)
          : (keyData.outgoingsMeta.salariesDel[yIdx][mIdx] || 0);
      } else if (!isDel && keyData.outgoingsMeta.salariesNonDel?.[yIdx]) {
        actualSalaries = isFYTotal
          ? keyData.outgoingsMeta.salariesNonDel[yIdx].reduce((a, b) => a + b, 0)
          : (keyData.outgoingsMeta.salariesNonDel[yIdx][mIdx] || 0);
      }
    }
    const allowanceDiff = actualSalaries - calcSalTotal;
    if (Math.abs(allowanceDiff) > 2) {
      salaryItems.push({
        name: "Employment allowance",
        client: "",
        detail: "HMRC allowance adjustment",
        badge: "Allowance",
        amount: Math.round(allowanceDiff),
      });
      calcSalTotal += allowanceDiff;
    }
    items.push(...salaryItems);

    // B. Dividends as salary
    const dividendsList = keyData.outgoings?.dividends || [];
    dividendsList.forEach((d) => {
      let delPct = 0.5; // default 50%
      if (d.deliveryPct !== undefined && String(d.deliveryPct).trim() !== "") {
        delPct = parseMoney(d.deliveryPct);
        if (String(d.deliveryPct).includes("%")) delPct = delPct / 100;
        else if (delPct > 1) delPct = delPct / 100;
      }
      const applicablePct = isDel ? delPct : (1 - delPct);
      if (applicablePct <= 0.001) return;

      const allocs = d.allocations?.[yearIndex] || d.monthlyAllocations || [];
      const rawAmt = isFYTotal
        ? d.totals?.[yearIndex] || 0
        : parseMoney(allocs[mIdx] || "0");
      const amt = Math.round(rawAmt * applicablePct);
      if (amt > 0) {
        items.push({
          name: d.name || "Dividends as salary",
          client: "",
          detail: `Dividend in lieu • ${Math.round(applicablePct * 100)}%`,
          badge: "Dividend",
          amount: amt,
        });
      }
    });

    // C. Contractors
    const contractorsList = keyData.outgoings?.contractors || [];
    contractorsList.forEach((c) => {
      let delPct = 1.0; // default 100%
      if (c.deliveryPct !== undefined && String(c.deliveryPct).trim() !== "") {
        delPct = parseMoney(c.deliveryPct);
        if (String(c.deliveryPct).includes("%")) delPct = delPct / 100;
        else if (delPct > 1) delPct = delPct / 100;
      }
      const applicablePct = isDel ? delPct : (1 - delPct);
      if (applicablePct <= 0.001) return;

      const allocs = c.allocations?.[yearIndex] || c.monthlyAllocations || [];
      const rawAmt = isFYTotal
        ? c.totals?.[yearIndex] || 0
        : parseMoney(allocs[mIdx] || "0");
      const amt = Math.round(rawAmt * applicablePct);
      if (amt > 0) {
        items.push({
          name: c.name,
          client: "",
          detail: `Contractor • ${Math.round(applicablePct * 100)}% delivery`,
          badge: "Contractor",
          amount: amt,
        });
      }
    });

    // D. Additional staff costs: Making up CoS & Profit share
    if (isDel && keyData.outgoingsMeta?.makingUpCosBase?.[yIdx]) {
      const cosVal = isFYTotal
        ? keyData.outgoingsMeta.makingUpCosBase[yIdx].reduce((a, b) => a + b, 0)
        : (keyData.outgoingsMeta.makingUpCosBase[yIdx][mIdx] || 0);
      if (cosVal > 0) {
        items.push({
          name: "Making up CoS",
          client: "",
          detail: "Cost of sale adjustment",
          badge: "CoS",
          amount: Math.round(cosVal),
        });
      }
    }

    if (keyData.outgoingsMeta) {
      const psArr = isDel ? keyData.outgoingsMeta.profitShareBaseDel?.[yIdx] : keyData.outgoingsMeta.profitShareBaseNonDel?.[yIdx];
      const psVal = psArr ? (isFYTotal ? psArr.reduce((a, b) => a + b, 0) : (psArr[mIdx] || 0)) : 0;
      if (psVal > 0) {
        items.push({
          name: "Profit share",
          client: "",
          detail: "Profit share allocation",
          badge: "Profit Share",
          amount: Math.round(psVal),
        });
      }
    }

    // E. Rounding / Drift adjustment to match cellValue exactly
    const targetCellVal = parseMoney(cellValue);
    const sumItems = items.reduce((s, i) => s + i.amount, 0);
    const drift = Math.round(targetCellVal - sumItems);
    if (Math.abs(drift) >= 1) {
      items.push({
        name: "Rounding adjustment",
        client: "",
        detail: "Alignment with ledger",
        badge: "Adjustment",
        amount: drift,
      });
    }

    return {
      title: isDel ? "Delivery staff costs" : "Non-delivery staff costs",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 5. Direct Costs / Contractors
  if (ddType === "dirCosts") {
    const contractors = keyData.outgoings?.contractors || [];
    const items = contractors.map((c) => {
      const allocs = c.allocations?.[yearIndex] || c.monthlyAllocations || [];
      const amt = isFYTotal
        ? c.totals?.[yearIndex] || 0
        : parseFloat(String(allocs[monthIndex] || "0").replace(/[£,]/g, "")) || 0;
      return {
        name: c.name,
        detail: `Timing: ${c.paymentTiming || "Curr"} • Delivery: ${c.deliveryPct}`,
        badge: "Contractor",
        amount: amt,
      };
    }).filter((item) => item.amount > 0);

    return {
      title: "Direct Costs / Contractors Breakdown",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 6. Overhead Expenses
  if (ddType === "expNonDel" || ddType === "expDel") {
    const isDel = ddType === "expDel";
    const expenses = (keyData.outgoings?.expenses || []).filter((e) =>
      isDel ? e.isDelivery : !e.isDelivery
    );
    const items = expenses.map((e) => {
      const allocs = e.allocations?.[yearIndex] || e.monthlyAllocations || [];
      const amt = isFYTotal
        ? e.totals?.[yearIndex] || 0
        : parseFloat(String(allocs[monthIndex] || "0").replace(/[£,]/g, "")) || 0;
      return {
        name: e.name,
        detail: `VAT: ${e.vat || "Yes"} • Timing: ${e.paymentTiming || "Curr"}`,
        badge: isDel ? "Delivery" : "Overhead",
        amount: amt,
      };
    }).filter((item) => item.amount > 0);

    return {
      title: isDel ? "Delivery Expenses Breakdown" : "Overhead Expenses Breakdown",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 7. Dividends
  if (ddType === "dividends") {
    const dividends = keyData.outgoings?.dividends || [];
    const items = dividends.map((d) => {
      const allocs = d.allocations?.[yearIndex] || d.monthlyAllocations || [];
      const amt = isFYTotal
        ? d.totals?.[yearIndex] || 0
        : parseFloat(String(allocs[monthIndex] || "0").replace(/[£,]/g, "")) || 0;
      return {
        name: d.name,
        detail: `Timing: ${d.paymentTiming || "Curr"}`,
        badge: "Distribution",
        amount: amt,
      };
    }).filter((item) => item.amount > 0);

    return {
      title: "Dividend Projections Breakdown",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 8. Confirmed Cash Incoming (Screenshot 2 Match)
  if (ddType === "cashConfInflow" || ddType === "cashConfInc") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    const jobCash = CashDeepDiveEngine.getJobCash(allJobs, effectiveDate, "cashConfInc");
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
        client: "",
        desc: "",
        payDate: null,
        payDateStr: "",
        status: "",
        amount: drift,
      });
    }

    return {
      title: "Confirmed cash incoming",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 9. Pipeline Cash Incoming
  if (ddType === "cashPipeInflow" || ddType === "cashPipeInc") {
    const allJobs = keyData.jobs?.all || [...(keyData.jobs?.confirmed || []), ...(keyData.jobs?.pipeline || [])];
    const jobCash = CashDeepDiveEngine.getJobCash(allJobs, effectiveDate, "cashPipeInc");
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
        client: "",
        desc: "",
        payDate: null,
        payDateStr: "",
        status: "",
        amount: drift,
      });
    }

    return {
      title: "Pipeline cash incoming",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 10. Cash Salaries Outflows
  if (ddType === "cashSalaries") {
    const staff = keyData.salaries?.staff || [];
    const items = staff.map((s) => {
      const amt = isFYTotal ? s.actualAnnualCost : Math.round(s.actualAnnualCost / 12);
      return {
        name: s.name,
        client: "",
        desc: `${s.role || "Staff"} • ${s.isDelivery ? "Delivery" : "Overhead"} Payroll`,
        payDate: effectiveDate,
        payDateStr: DeepDiveEngine.formatShortDate(effectiveDate),
        status: "Salary",
        amount: amt > 0 ? -amt : amt,
      };
    }).filter((i) => i.amount !== 0);

    return {
      title: "Salary payments",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 11. Cash Contractors
  if (ddType === "cashContractors") {
    const contractors = keyData.outgoings?.contractors || [];
    const items = contractors.map((c) => {
      const allocs = c.allocations?.[yearIndex] || c.monthlyAllocations || [];
      const rawAmt = isFYTotal ? c.totals?.[yearIndex] || 0 : parseMoney(allocs[monthIndex] || "0");
      const gross = rawAmt * (c.vat === "Yes" ? 1.2 : 1.0);
      const amt = -Math.abs(Math.round(gross));
      return {
        name: c.name,
        client: "",
        desc: `Timing: ${c.paymentTiming || "Curr"} • Delivery: ${c.deliveryPct}`,
        payDate: effectiveDate,
        payDateStr: DeepDiveEngine.formatShortDate(effectiveDate),
        status: "Contractor",
        amount: amt,
      };
    }).filter((i) => Math.abs(i.amount) > 0);

    return {
      title: "Contractor payments",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 12. Cash Direct Costs
  if (ddType === "cashDirCosts") {
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
        client: "",
        desc: "",
        payDate: null,
        payDateStr: "",
        status: "",
        amount: drift,
      });
    }

    return {
      title: "Direct cost payments",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 13. Cash Outgoings
  if (ddType === "cashOutgoings") {
    const expenses = keyData.outgoings?.expenses || [];
    const items = expenses.map((e) => {
      const allocs = e.allocations?.[yearIndex] || e.monthlyAllocations || [];
      const rawAmt = isFYTotal ? e.totals?.[yearIndex] || 0 : parseMoney(allocs[monthIndex] || "0");
      const gross = rawAmt * (e.vat === "Yes" ? 1.2 : 1.0);
      const amt = -Math.abs(Math.round(gross));
      return {
        name: e.name,
        client: "",
        desc: `Timing: ${e.paymentTiming || "Curr"} • VAT: ${e.vat || "Yes"}`,
        payDate: effectiveDate,
        payDateStr: DeepDiveEngine.formatShortDate(effectiveDate),
        status: "Expense",
        amount: amt,
      };
    }).filter((i) => Math.abs(i.amount) > 0);

    return {
      title: "Outgoings payments",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  // 14. Cash Dividends
  if (ddType === "cashDividends") {
    const dividends = keyData.outgoings?.dividends || [];
    const items = dividends.map((d) => {
      const allocs = d.allocations?.[yearIndex] || d.monthlyAllocations || [];
      const rawAmt = isFYTotal ? d.totals?.[yearIndex] || 0 : parseMoney(allocs[monthIndex] || "0");
      const amt = -Math.abs(Math.round(rawAmt));
      return {
        name: d.name,
        client: "",
        desc: `Timing: ${d.paymentTiming || "Curr"}`,
        payDate: effectiveDate,
        payDateStr: DeepDiveEngine.formatShortDate(effectiveDate),
        status: "Dividend",
        amount: amt,
      };
    }).filter((i) => Math.abs(i.amount) > 0);

    return {
      title: "Dividends as salary",
      period: periodLabel,
      total: cellValue,
      items,
    };
  }

  return {
    title: "Breakdown",
    period: periodLabel,
    total: cellValue,
    items: [],
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

  const formatCurrency = (num) => (num === 0 ? "£0" : formatMoney(num));
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
      if (String(outgoingsMeta.profitShareSwitch || "").trim().toLowerCase() === "monthly") {
        p = outgoingsMeta.profitSharePct || 0;
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
