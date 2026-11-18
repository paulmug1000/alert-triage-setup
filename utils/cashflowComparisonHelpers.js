const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDateDMmmYy(val) {
  if (val == null || val === "") return "";
  const s = String(val).trim();
  const num = Number(s);
  if (!isNaN(num) && num >= 35000 && num <= 60000) {
    const utcDays = num - 25569;
    const date = new Date(utcDays * 86400 * 1000);
    const d = date.getUTCDate();
    const m = MONTH_NAMES_SHORT[date.getUTCMonth()];
    const yy = String(date.getUTCFullYear()).slice(-2);
    return `${d}-${m}-${yy}`;
  }
  const mIso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (mIso) {
    const d = parseInt(mIso[3], 10);
    const m = MONTH_NAMES_SHORT[parseInt(mIso[2], 10) - 1] || "";
    const yy = mIso[1].slice(-2);
    return `${d}-${m}-${yy}`;
  }
  const mUk = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (mUk) {
    const d = parseInt(mUk[1], 10);
    const m = MONTH_NAMES_SHORT[parseInt(mUk[2], 10) - 1] || "";
    let yy = mUk[3];
    if (yy.length === 4) yy = yy.slice(-2);
    return `${d}-${m}-${yy}`;
  }
  const mText = s.match(/^(\d{1,2})[\s\-/.]([a-zA-Z]{3,})[\s\-/.](?:'?)(\d{2,4})$/);
  if (mText) {
    const d = parseInt(mText[1], 10);
    const rawMon = mText[2].toLowerCase();
    const mIdx = MONTH_NAMES_SHORT.findIndex((mn) => rawMon.startsWith(mn.toLowerCase()));
    const m = mIdx !== -1 ? MONTH_NAMES_SHORT[mIdx] : mText[2].slice(0, 3);
    let yy = mText[3];
    if (yy.length === 4) yy = yy.slice(-2);
    return `${d}-${m}-${yy}`;
  }
  return s;
}

/**
 * Pairs bank transactions with Pulse items based on spreadsheet row cross-references
 * or heuristic amount matches, separating cleanly into matched pairs and unmatched lists.
 */
export function buildAlignedComparison(bankItems = [], pulseItems = [], options = {}) {
  const type = options.type || "revenue";
  const isCredit = type === "revenue";
  const maxVariancePct = options.maxVariancePct ?? 0.15;

  const isErr = (val) => {
    if (val == null) return false;
    const s = String(val).trim();
    return s.startsWith("#") || s === "—";
  };

  const parseAmt = (v) => parseFloat(String(v || "0").replace(/[£,\s]/g, "")) || 0;

  const getExpectedDirAmt = (b) => {
    const inV = parseAmt(b?.inAmt);
    const outV = parseAmt(b?.outAmt);
    if (isCredit) {
      if (outV > 0 && inV === 0) return -outV;
      return inV > 0 ? inV : parseAmt(b?.amount);
    }
    if (inV > 0 && outV === 0) return -inV;
    return outV > 0 ? outV : parseAmt(b?.amount);
  };

  const isSettledPulseItem = (p) => {
    const st = String(p?.status || "").trim().toLowerCase();
    return st === "paid" || st === "reconciled" || st === "complete" || st === "completed";
  };

  const cleanBank = (bankItems || []).filter((b) => {
    if (!b) return false;
    if (isErr(b.date) || isErr(b.payee) || isErr(b.inAmt) || isErr(b.outAmt) || isErr(b.amount)) return false;
    const inVal = Math.abs(parseAmt(b.inAmt));
    const outVal = Math.abs(parseAmt(b.outAmt));
    const amtVal = Math.abs(parseAmt(b.amount));
    return inVal > 0 || outVal > 0 || amtVal > 0;
  });

  const cleanPulse = (pulseItems || []).filter((p) => {
    if (!p) return false;
    return !isErr(p.client) && !isErr(p.amount) && !isErr(p.job);
  });

  const matchedPairs = [];
  const usedBankIndices = new Set();
  const usedPulseIndices = new Set();

  const extractCandidateRefs = (str) => {
    if (!str) return [];
    const refs = new Set();
    const s = String(str);
    const explicit = s.match(/(?:INV|INVOICE|RV|REF|BILL)?[-:\s#]*([A-Z]{0,4}[-:\s#]*\d{2,7})/gi);
    if (explicit) {
      explicit.forEach((ex) => {
        const digits = ex.replace(/\D/g, "");
        if (digits.length >= 2) refs.add(digits);
      });
    }
    const numMatches = s.match(/\b\d{2,6}\b/g);
    if (numMatches) {
      numMatches.forEach((num) => refs.add(num));
    }
    return Array.from(refs);
  };

  const getBankRefs = (b) => {
    const list = [
      ...extractCandidateRefs(b.particulars),
      ...extractCandidateRefs(b.ref),
      ...extractCandidateRefs(b.payee),
    ];
    return Array.from(new Set(list));
  };

  const getPulseRef = (p) => {
    if (!p.ref) return null;
    const refs = extractCandidateRefs(p.ref);
    return refs.length > 0 ? refs[0] : String(p.ref).trim().replace(/\D/g, "") || String(p.ref).trim();
  };

  const hasExplicitRefToken = (b, refStr) => {
    if (!b || !refStr) return false;
    const cleanRef = String(refStr).replace(/\D/g, "");
    if (!cleanRef) return false;
    if (String(b.ref || "").replace(/\D/g, "") === cleanRef) return true;
    const combined = `${b.particulars || ""} ${b.ref || ""} ${b.payee || ""}`;
    const escaped = cleanRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const explicitPattern = new RegExp(`(?:inv|invoice|rv|bill|ref)[-:\\s#]*[a-z]{0,4}[-:\\s#]*0*${escaped}\\b`, "i");
    if (explicitPattern.test(combined)) return true;
    if (cleanRef.length >= 4) {
      const partAndRef = `${b.particulars || ""} ${b.ref || ""}`;
      if (new RegExp(`\\b0*${escaped}\\b`, "i").test(partAndRef)) return true;
    }
    return false;
  };

  const namesMatch = (nameA, nameB) => {
    if (!nameA || !nameB) return false;
    const a = String(nameA).toLowerCase().replace(/[^a-z0-9]/g, "");
    const b = String(nameB).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!a || !b) return false;
    return a.includes(b) || b.includes(a);
  };

  const findCombo = (items, k, target, tolerance) => {
    const backtrack = (start, combo, currentSum) => {
      if (combo.length === k) {
        if (Math.abs(currentSum - target) < tolerance) return [...combo];
        return null;
      }
      for (let i = start; i < items.length; i++) {
        if (currentSum + items[i].amount > target + tolerance && items[i].amount > 0) continue;
        combo.push(items[i]);
        const res = backtrack(i + 1, combo, currentSum + items[i].amount);
        if (res) return res;
        combo.pop();
      }
      return null;
    };
    return backtrack(0, [], 0);
  };

  const findSubsetSum = (items, targetAmt, tolerance = 0.05) => {
    const totalSum = items.reduce((acc, it) => acc + it.amount, 0);
    if (Math.abs(totalSum - targetAmt) < tolerance) {
      return items;
    }
    if (items.length <= 12) {
      for (let size = 2; size < items.length; size++) {
        const combo = findCombo(items, size, targetAmt, tolerance);
        if (combo) return combo;
      }
    }
    return null;
  };

  // 1A. Exact 1-to-1 ref + amount match
  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    const bAmt = parseAmt(b.inAmt || b.outAmt || b.amount);
    if (bAmt <= 0) return;
    const bRefs = getBankRefs(b);
    if (bRefs.length === 0) return;

    const pIdx = cleanPulse.findIndex((p, idx) => {
      if (usedPulseIndices.has(idx)) return false;
      const pRef = getPulseRef(p);
      if (!pRef || !bRefs.includes(pRef)) return false;
      const pAmt = parseAmt(p.amount);
      return Math.abs(bAmt - pAmt) < 0.05;
    });

    if (pIdx !== -1) {
      matchedPairs.push({ bank: b, pulse: cleanPulse[pIdx], matchType: "ref_exact" });
      usedBankIndices.add(bIdx);
      usedPulseIndices.add(pIdx);
    }
  });

  // 1B. 1 Bank item matches MULTIPLE Pulse items sharing an invoice reference
  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    const bAmt = parseAmt(b.inAmt || b.outAmt || b.amount);
    if (bAmt <= 0) return;
    const bRefs = getBankRefs(b);
    if (bRefs.length === 0) return;

    for (const ref of bRefs) {
      const candidatePulseIndices = [];
      let sumPulse = 0;
      cleanPulse.forEach((p, pIdx) => {
        if (usedPulseIndices.has(pIdx)) return;
        const pRef = getPulseRef(p);
        if (pRef === ref) {
          candidatePulseIndices.push(pIdx);
          sumPulse += parseAmt(p.amount);
        }
      });

      if (candidatePulseIndices.length > 1) {
        if (Math.abs(sumPulse - bAmt) < 0.05) {
          const matchedPulseItems = candidatePulseIndices.map((i) => cleanPulse[i]);
          matchedPairs.push({
            bank: b,
            pulse: matchedPulseItems,
            isMultiPulse: true,
            matchType: "ref_multi_pulse",
          });
          usedBankIndices.add(bIdx);
          candidatePulseIndices.forEach((i) => usedPulseIndices.add(i));
          break;
        } else {
          const candidateItems = candidatePulseIndices.map((i) => ({ idx: i, amount: parseAmt(cleanPulse[i].amount) }));
          const subset = findSubsetSum(candidateItems, bAmt);
          if (subset && subset.length > 1) {
            const matchedPulseItems = subset.map((s) => cleanPulse[s.idx]);
            matchedPairs.push({
              bank: b,
              pulse: matchedPulseItems,
              isMultiPulse: true,
              matchType: "ref_multi_pulse",
            });
            usedBankIndices.add(bIdx);
            subset.forEach((s) => usedPulseIndices.add(s.idx));
            break;
          }
        }
      }
    }
  });

  // 1C. Multiple Bank partial payments matching 1 Pulse item by reference
  cleanPulse.forEach((p, pIdx) => {
    if (usedPulseIndices.has(pIdx) || !p.ref) return;
    const pAmt = parseAmt(p.amount);
    if (pAmt <= 0) return;
    const pRef = getPulseRef(p);
    if (!pRef) return;

    const candidateBankIndices = [];
    let sumBank = 0;
    cleanBank.forEach((b, bIdx) => {
      if (usedBankIndices.has(bIdx)) return;
      const bRefs = getBankRefs(b);
      if (bRefs.includes(pRef)) {
        candidateBankIndices.push(bIdx);
        sumBank += parseAmt(b.inAmt || b.outAmt || b.amount);
      }
    });

    if (candidateBankIndices.length > 1 && Math.abs(sumBank - pAmt) < 0.05) {
      const matchedBankItems = candidateBankIndices.map((i) => cleanBank[i]);
      matchedPairs.push({
        bank: matchedBankItems,
        pulse: p,
        isMultiBank: true,
        matchType: "ref_partial_sum",
      });
      candidateBankIndices.forEach((i) => usedBankIndices.add(i));
      usedPulseIndices.add(pIdx);
    }
  });

  // 2. Match by sheet matched ID
  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    if (!b.matched || b.matched === "No Match" || b.matched === "Matched") return;

    const ids = String(b.matched).replace(/\*/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    ids.forEach((id) => {
      const pIdx = cleanPulse.findIndex((p, idx) => !usedPulseIndices.has(idx) && (p.pulseId === id || p.matchedRow === id));
      if (pIdx !== -1) {
        matchedPairs.push({ bank: b, pulse: cleanPulse[pIdx], matchType: "sheet_id" });
        usedBankIndices.add(bIdx);
        usedPulseIndices.add(pIdx);
      }
    });
  });

  // 3A. Exact 1-to-1 amount + payee/client similarity + same date
  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    const bAmt = parseAmt(b.inAmt || b.outAmt || b.amount);
    if (bAmt <= 0) return;

    const bPayee = b.payee || b.particulars || "";
    const bDateStr = formatDateDMmmYy(b.date);
    if (!bDateStr) return;

    const pIdx = cleanPulse.findIndex((p, idx) => {
      if (usedPulseIndices.has(idx)) return false;
      const pAmt = parseAmt(p.amount);
      if (Math.abs(bAmt - pAmt) > 0.01) return false;
      if (!namesMatch(bPayee, p.client)) return false;
      const pDateStr = formatDateDMmmYy(p.expDate || p.payDate || p.date);
      return Boolean(pDateStr && pDateStr === bDateStr);
    });

    if (pIdx !== -1) {
      matchedPairs.push({ bank: b, pulse: cleanPulse[pIdx], matchType: "amt_name_date" });
      usedBankIndices.add(bIdx);
      usedPulseIndices.add(pIdx);
    }
  });

  // 3B. Exact 1-to-1 amount + payee/client similarity
  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    const bAmt = parseAmt(b.inAmt || b.outAmt || b.amount);
    if (bAmt <= 0) return;

    const bPayee = b.payee || b.particulars || "";
    const pIdx = cleanPulse.findIndex((p, idx) => {
      if (usedPulseIndices.has(idx)) return false;
      const pAmt = parseAmt(p.amount);
      if (Math.abs(bAmt - pAmt) > 0.01) return false;
      return namesMatch(bPayee, p.client);
    });

    if (pIdx !== -1) {
      matchedPairs.push({ bank: b, pulse: cleanPulse[pIdx], matchType: "amt_name" });
      usedBankIndices.add(bIdx);
      usedPulseIndices.add(pIdx);
    }
  });

  // 4A. 1 Bank item matches MULTIPLE Pulse items for the same client
  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    const bAmt = parseAmt(b.inAmt || b.outAmt || b.amount);
    if (bAmt <= 0) return;
    const bPayee = b.payee || b.particulars || "";
    if (!bPayee) return;

    const candidatePulseIndices = [];
    let sumPulse = 0;
    cleanPulse.forEach((p, pIdx) => {
      if (usedPulseIndices.has(pIdx)) return;
      if (namesMatch(bPayee, p.client)) {
        candidatePulseIndices.push(pIdx);
        sumPulse += parseAmt(p.amount);
      }
    });

    if (candidatePulseIndices.length > 1) {
      if (Math.abs(sumPulse - bAmt) < 0.05) {
        const matchedPulseItems = candidatePulseIndices.map((i) => cleanPulse[i]);
        matchedPairs.push({
          bank: b,
          pulse: matchedPulseItems,
          isMultiPulse: true,
          matchType: "payee_multi_pulse",
        });
        usedBankIndices.add(bIdx);
        candidatePulseIndices.forEach((i) => usedPulseIndices.add(i));
      } else {
        const candidateItems = candidatePulseIndices.map((i) => ({ idx: i, amount: parseAmt(cleanPulse[i].amount) }));
        const subset = findSubsetSum(candidateItems, bAmt);
        if (subset && subset.length > 1) {
          const matchedPulseItems = subset.map((s) => cleanPulse[s.idx]);
          matchedPairs.push({
            bank: b,
            pulse: matchedPulseItems,
            isMultiPulse: true,
            matchType: "payee_multi_pulse",
          });
          usedBankIndices.add(bIdx);
          subset.forEach((s) => usedPulseIndices.add(s.idx));
        }
      }
    }
  });

  // 4B. Multiple Bank items matching 1 Pulse item by payee/client
  cleanPulse.forEach((p, pIdx) => {
    if (usedPulseIndices.has(pIdx)) return;
    const pAmt = parseAmt(p.amount);
    const pClient = String(p.client || "").trim();
    if (!pClient || pAmt <= 0) return;

    const candidateBankIndices = [];
    let sumBank = 0;
    cleanBank.forEach((b, bIdx) => {
      if (usedBankIndices.has(bIdx)) return;
      const bAmt = parseAmt(b.inAmt || b.outAmt || b.amount);
      if (bAmt <= 0) return;
      const bPayee = b.payee || b.particulars || "";
      if (bPayee && namesMatch(bPayee, pClient)) {
        candidateBankIndices.push(bIdx);
        sumBank += bAmt;
      }
    });

    if (candidateBankIndices.length > 1) {
      if (Math.abs(sumBank - pAmt) < 0.05) {
        const matchedBankItems = candidateBankIndices.map((i) => cleanBank[i]);
        matchedPairs.push({
          bank: matchedBankItems,
          pulse: p,
          isMultiBank: true,
          matchType: "payee_partial_sum",
        });
        candidateBankIndices.forEach((i) => usedBankIndices.add(i));
        usedPulseIndices.add(pIdx);
      } else {
        const candidateItems = candidateBankIndices.map((i) => ({
          idx: i,
          amount: parseAmt(cleanBank[i].inAmt || cleanBank[i].outAmt || cleanBank[i].amount),
        }));
        const subset = findSubsetSum(candidateItems, pAmt);
        if (subset && subset.length > 1) {
          const matchedBankItems = subset.map((s) => cleanBank[s.idx]);
          matchedPairs.push({
            bank: matchedBankItems,
            pulse: p,
            isMultiBank: true,
            matchType: "payee_partial_sum",
          });
          subset.forEach((s) => usedBankIndices.add(s.idx));
          usedPulseIndices.add(pIdx);
        }
      }
    }
  });

  // 4C. Settled FX / settlement variance matches
  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    const bAmt = getExpectedDirAmt(b);
    if (bAmt <= 0) return;
    const bRefs = getBankRefs(b);
    if (bRefs.length === 0) return;
    const bPayee = b.payee || b.particulars || "";

    for (const ref of bRefs) {
      const candidatePulseIndices = [];
      let sumPulse = 0;
      let allSettledAndPositive = true;
      let hasPayeeOrExplicitRef = false;

      cleanPulse.forEach((p, pIdx) => {
        if (usedPulseIndices.has(pIdx)) return;
        const pRef = getPulseRef(p);
        if (pRef === ref) {
          const pAmt = parseAmt(p.amount);
          if (!isSettledPulseItem(p) || pAmt <= 0) {
            allSettledAndPositive = false;
          }
          if (namesMatch(bPayee, p.client) || hasExplicitRefToken(b, ref)) {
            hasPayeeOrExplicitRef = true;
          }
          candidatePulseIndices.push(pIdx);
          sumPulse += pAmt;
        }
      });

      if (candidatePulseIndices.length > 1 && allSettledAndPositive && hasPayeeOrExplicitRef && sumPulse > 0) {
        const diff = Math.abs(bAmt - sumPulse);
        if (diff >= 0.05 && diff / sumPulse <= maxVariancePct) {
          matchedPairs.push({
            bank: b,
            pulse: candidatePulseIndices.map((i) => cleanPulse[i]),
            isMultiPulse: true,
            matchType: "ref_fx_multi_pulse",
          });
          usedBankIndices.add(bIdx);
          candidatePulseIndices.forEach((i) => usedPulseIndices.add(i));
          break;
        }
      }
    }
  });

  cleanPulse.forEach((p, pIdx) => {
    if (usedPulseIndices.has(pIdx) || !p.ref || !isSettledPulseItem(p)) return;
    const pAmt = parseAmt(p.amount);
    if (pAmt <= 0) return;
    const pRef = getPulseRef(p);
    if (!pRef) return;

    const otherSameRef = cleanPulse.some((op, oIdx) => oIdx !== pIdx && !usedPulseIndices.has(oIdx) && getPulseRef(op) === pRef);
    if (otherSameRef) return;

    const candidateBankIndices = [];
    let sumBank = 0;
    cleanBank.forEach((b, bIdx) => {
      if (usedBankIndices.has(bIdx)) return;
      const bAmt = getExpectedDirAmt(b);
      if (bAmt <= 0) return;
      const bRefs = getBankRefs(b);
      if (!bRefs.includes(pRef)) return;
      const bPayee = b.payee || b.particulars || "";
      if (namesMatch(bPayee, p.client) || hasExplicitRefToken(b, pRef)) {
        candidateBankIndices.push(bIdx);
        sumBank += bAmt;
      }
    });

    if (candidateBankIndices.length > 1 && sumBank > 0) {
      const diff = Math.abs(sumBank - pAmt);
      if (diff >= 0.05 && diff / pAmt <= maxVariancePct) {
        matchedPairs.push({
          bank: candidateBankIndices.map((i) => cleanBank[i]),
          pulse: p,
          isMultiBank: true,
          matchType: "ref_fx_partial_sum",
        });
        candidateBankIndices.forEach((i) => usedBankIndices.add(i));
        usedPulseIndices.add(pIdx);
      }
    }
  });

  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    const bAmt = getExpectedDirAmt(b);
    if (bAmt <= 0) return;
    const bRefs = getBankRefs(b);
    if (bRefs.length === 0) return;
    const bPayee = b.payee || b.particulars || "";

    let bestPulseIdx = -1;
    let bestDiff = Infinity;

    cleanPulse.forEach((p, idx) => {
      if (usedPulseIndices.has(idx) || !isSettledPulseItem(p)) return;
      const pAmt = parseAmt(p.amount);
      if (pAmt <= 0) return;
      const pRef = getPulseRef(p);
      if (!pRef || !bRefs.includes(pRef)) return;
      if (!namesMatch(bPayee, p.client) && !hasExplicitRefToken(b, pRef)) return;

      const diff = Math.abs(bAmt - pAmt);
      if (diff >= 0.05 && diff / pAmt <= maxVariancePct && diff < bestDiff) {
        bestDiff = diff;
        bestPulseIdx = idx;
      }
    });

    if (bestPulseIdx !== -1) {
      matchedPairs.push({ bank: b, pulse: cleanPulse[bestPulseIdx], matchType: "ref_fx_variance" });
      usedBankIndices.add(bIdx);
      usedPulseIndices.add(bestPulseIdx);
    }
  });

  // 5. Match by exact amount fallback
  cleanBank.forEach((b, bIdx) => {
    if (usedBankIndices.has(bIdx)) return;
    const bAmt = parseAmt(b.inAmt || b.outAmt || b.amount);
    if (bAmt <= 0) return;

    const pIdx = cleanPulse.findIndex((p, idx) => {
      if (usedPulseIndices.has(idx)) return false;
      const pAmt = parseAmt(p.amount);
      return Math.abs(bAmt - pAmt) < 0.01;
    });

    if (pIdx !== -1) {
      matchedPairs.push({ bank: b, pulse: cleanPulse[pIdx], matchType: "amt_only" });
      usedBankIndices.add(bIdx);
      usedPulseIndices.add(pIdx);
    }
  });

  const enrichedPairs = matchedPairs.map((pair) => {
    const bankList = Array.isArray(pair.bank) ? pair.bank : [pair.bank];
    const pulseList = Array.isArray(pair.pulse) ? pair.pulse : [pair.pulse];
    const bankTotal = Math.round(bankList.reduce((acc, item) => acc + getExpectedDirAmt(item), 0) * 100) / 100;
    const pulseTotal = Math.round(pulseList.reduce((acc, item) => acc + parseAmt(item?.amount), 0) * 100) / 100;
    const amountDiff = Math.round((bankTotal - pulseTotal) * 100) / 100;
    const cashImpact = isCredit ? amountDiff : Math.round((pulseTotal - bankTotal) * 100) / 100;
    const hasVariance = Math.abs(amountDiff) >= 0.05;
    const variancePct = pulseTotal > 0 ? Math.round((amountDiff / pulseTotal) * 10000) / 100 : 0;
    return {
      ...pair,
      bankTotal,
      pulseTotal,
      amountDiff,
      cashImpact,
      hasVariance,
      variancePct,
    };
  });

  const variancePairs = enrichedPairs.filter((mp) => mp.hasVariance);
  const totalCashVariance = Math.round(variancePairs.reduce((s, mp) => s + mp.cashImpact, 0) * 100) / 100;

  const unmatchedBank = cleanBank.filter((_, idx) => !usedBankIndices.has(idx));
  const unmatchedPulse = cleanPulse.filter((_, idx) => !usedPulseIndices.has(idx));

  return { matchedPairs: enrichedPairs, unmatchedBank, unmatchedPulse, variancePairs, totalCashVariance };
}

/**
 * Summarizes settled FX / settlement variances from a comparison result for finalisation cards & note generation.
 */
export function summarizeSettlementVariances(comparison, type = "revenue") {
  const variancePairs = comparison?.variancePairs || [];
  const items = variancePairs.map((pair) => {
    const bankArr = Array.isArray(pair.bank) ? pair.bank : [pair.bank];
    const pulseArr = Array.isArray(pair.pulse) ? pair.pulse : [pair.pulse];
    const clientOrPayee = String(
      pulseArr[0]?.client || bankArr[0]?.payee || bankArr[0]?.particulars || (type === "revenue" ? "Customer" : "Supplier")
    ).trim();
    const ref = String(pulseArr[0]?.ref || bankArr[0]?.ref || "").trim();
    return {
      clientOrPayee,
      ref,
      bankAmt: pair.bankTotal,
      pulseAmt: pair.pulseTotal,
      amountDiff: pair.amountDiff,
      cashImpact: pair.cashImpact,
      variancePct: pair.variancePct,
    };
  });
  return {
    items,
    totalCashImpact: comparison?.totalCashVariance || 0,
  };
}
