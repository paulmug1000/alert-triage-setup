/**
 * ============================================================================
 * RECON TRANSACTIONS MERGE UTILITY (services/reconTransactionsMerge.js)
 * ============================================================================
 * 
 * Clean, lightweight delta merge for bank transactions:
 * - When an unreconciled item gets reconciled in QuickBooks/Xero:
 *     1. Updates the item in the bank transactions list with any incoming API info
 *     2. Strictly keeps the EXISTING Column Q category from the bank transactions list
 *     3. Shades the reconciled item green (isNew: true)
 *     4. Removes the item from the unreconciled transactions list (CD4:CN)
 * - Keeps unreconciled items in the bank transactions list until they clear.
 */

const MONTH_NAMES_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const MONTH_MAP = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12"
};

export function parseAmount(val) {
  if (val == null || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const clean = String(val).replace(/[£$€,\s()]/g, "");
  const isParen = /^\(.*\)$/.test(String(val).trim());
  const num = parseFloat(clean);
  if (isNaN(num)) return 0;
  return isParen ? -num : num;
}

export function normalizeDateStr(d) {
  if (!d) return "";
  if (d instanceof Date && !isNaN(d.getTime())) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const s = String(d).trim();
  if (!s) return "";

  // 0. Excel serial number: e.g. 46316
  const num = Number(s);
  if (!isNaN(num) && num >= 35000 && num <= 60000) {
    const utcDays = num - 25569;
    const date = new Date(utcDays * 86400 * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // 1. ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss
  const mIso = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (mIso) {
    const year = mIso[1];
    const month = mIso[2].padStart(2, "0");
    const day = mIso[3].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // 2. Textual DD-MMM-YY(YY) or DD MMM YY(YY): e.g. "1-Oct-26", "01 Oct 2026", "1st Oct 2026"
  const mAlpha = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]([a-zA-Z]{3,9})[\s\-/.](?:'?)(\d{2,4})$/);
  if (mAlpha) {
    const day = mAlpha[1].padStart(2, "0");
    const monKey = mAlpha[2].toLowerCase();
    const month = MONTH_MAP[monKey] || (MONTH_NAMES_SHORT.findIndex(mn => monKey.startsWith(mn.toLowerCase())) !== -1
      ? String(MONTH_NAMES_SHORT.findIndex(mn => monKey.startsWith(mn.toLowerCase())) + 1).padStart(2, "0")
      : null);
    let year = mAlpha[3];
    if (year.length === 2) year = `20${year}`;
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  // 3. Textual MMM DD, YYYY or MMM DD YYYY
  const mAlphaFirst = s.match(/^([a-zA-Z]{3,9})[\s\-/.](?:'?)(\d{1,2})(?:st|nd|rd|th)?,?[\s\-/.](?:'?)(\d{2,4})$/);
  if (mAlphaFirst) {
    const monKey = mAlphaFirst[1].toLowerCase();
    const month = MONTH_MAP[monKey];
    const day = mAlphaFirst[2].padStart(2, "0");
    let year = mAlphaFirst[3];
    if (year.length === 2) year = `20${year}`;
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  // 4. Numeric UK format: DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const mDigits = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (mDigits) {
    const day = mDigits[1].padStart(2, "0");
    const month = mDigits[2].padStart(2, "0");
    let year = mDigits[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }

  // 5. Native Date parse fallback
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    if (year >= 2000 && year <= 2099) {
      const month = String(parsed.getMonth() + 1).padStart(2, "0");
      const day = String(parsed.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
  }

  return s.slice(0, 10);
}

export const PAYMENT_PROCESSOR_KEYWORDS = [
  "gocardless",
  "stripe",
  "paypal",
  "sumup",
  "worldpay",
  "izettle",
  "zettle",
  "amex",
  "american express",
  "bacs",
  "direct debit",
  "dd",
  "standing order",
  "so",
  "transferwise",
  "wise"
];

export function isPaymentProcessorText(str) {
  if (!str) return false;
  const s = String(str).toLowerCase().replace(/[^a-z0-9]/g, "");
  return PAYMENT_PROCESSOR_KEYWORDS.some(kw => {
    const cleanKw = kw.replace(/[^a-z0-9]/g, "");
    return s.includes(cleanKw);
  });
}

export function matchAndRemoveFromUnreconPool(tx, unreconPool, options = {}) {
  const minScoreThreshold = options.minScore || 25;
  const o = parseAmount(tx.outAmount || tx.outAmt);
  const i = parseAmount(tx.inAmount || tx.inAmt);
  const txTotal = o > 0 ? o : i;
  const isCredit = i > 0;
  const txDate = normalizeDateStr(tx.date);
  const cleanStr = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const txTxt = cleanStr(`${tx.payee || ""} ${tx.particulars || ""} ${tx.reference || ""}`);
  const txIsProcessor = isPaymentProcessorText(txTxt);

  let bestIdx = -1;
  let bestScore = 0;

  unreconPool.forEach((un, unIdx) => {
    const unO = parseAmount(un.outAmount || un.outAmt || un.amount);
    const unI = parseAmount(un.inAmount || un.inAmt);
    const unTotal = unO > 0 ? unO : unI;
    const unCredit = unI > 0;

    if (isCredit !== unCredit) return;
    if (Math.abs(txTotal - unTotal) > 0.01) return;

    let score = 15;
    const unDate = normalizeDateStr(un.date);
    let dateMatched = false;

    if (txDate && unDate) {
      if (txDate === unDate) {
        score += 35;
        dateMatched = true;
      } else {
        const diffMs = Math.abs(new Date(txDate).getTime() - new Date(unDate).getTime());
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (diffDays <= 3) {
          score += 25;
          dateMatched = true;
        } else if (diffDays <= 5) {
          score += 15;
          dateMatched = true;
        } else if (txDate.slice(0, 7) === unDate.slice(0, 7)) {
          score += 10;
        }
      }
    }

    const unTxt = cleanStr(`${un.payee || ""} ${un.particulars || ""} ${un.reference || ""}`);
    const unIsProcessor = isPaymentProcessorText(unTxt);
    const isProcessorPair = txIsProcessor || unIsProcessor;

    if (txTxt && unTxt && (txTxt.includes(unTxt) || unTxt.includes(txTxt))) {
      score += 30;
    } else if (isProcessorPair && dateMatched) {
      // Payment processor alias bonus: When one side is a payment processor (GoCardless/Stripe/etc)
      // and the other is the merchant/vendor name, an amount + date match represents a high-confidence match
      score += 25;
    }

    if (score > bestScore && score >= minScoreThreshold) {
      bestScore = score;
      bestIdx = unIdx;
    }
  });

  if (bestIdx !== -1) {
    const matched = unreconPool[bestIdx];
    unreconPool.splice(bestIdx, 1);
    return matched;
  }

  // Pass 2: Multi-item split match: check if txTotal matches the sum of 2 items in unreconPool
  if (unreconPool.length >= 2 && txTotal > 0) {
    for (let a = 0; a < unreconPool.length; a++) {
      const unA = unreconPool[a];
      const unOA = parseAmount(unA.outAmount || unA.outAmt || unA.amount);
      const unIA = parseAmount(unA.inAmount || unA.inAmt);
      const totalA = unOA > 0 ? unOA : unIA;
      const creditA = unIA > 0;
      if (creditA !== isCredit) continue;

      for (let b = a + 1; b < unreconPool.length; b++) {
        const unB = unreconPool[b];
        const unOB = parseAmount(unB.outAmount || unB.outAmt || unB.amount);
        const unIB = parseAmount(unB.inAmount || unB.inAmt);
        const totalB = unOB > 0 ? unOB : unIB;
        const creditB = unIB > 0;
        if (creditB !== isCredit) continue;

        if (Math.abs(txTotal - (totalA + totalB)) <= 0.02) {
          const dateA = normalizeDateStr(unA.date);
          const dateB = normalizeDateStr(unB.date);
          const isDateClose = (d) => {
            if (!txDate || !d) return true;
            const diffDays = Math.abs(new Date(txDate).getTime() - new Date(d).getTime()) / (1000 * 60 * 60 * 24);
            return diffDays <= 7;
          };
          if (isDateClose(dateA) || isDateClose(dateB)) {
            // Matched 2-to-1 split! Remove both (higher index first)
            const matchedItems = [unreconPool[b], unreconPool[a]];
            unreconPool.splice(b, 1);
            unreconPool.splice(a, 1);
            return matchedItems[0];
          }
        }
      }
    }
  }

  return null;
}

export function performTransactionsUpdate({
  currentBankTxns = [],
  currentUnreconItems = [],
  incomingApiTxns = [],
  incomingNonCashTxns = [],
  defaultAccount = ""
}) {
  let updatedCount = 0;
  let deletedCount = 0;
  let newAddedCount = 0;
  let matchedFromUnreconCount = 0;
  let matchedNonCashCount = 0;

  let unreconPool = [...currentUnreconItems];
  const matchedIncomingIndices = new Set();
  const matchedExistingIndices = new Set();
  const apiToExistingMap = new Map();
  const nextBankTxns = [];
  const fallbackAddedTxns = [];

  const getAmt = (t) => {
    const o = parseAmount(t.outAmount || t.outAmt);
    const i = parseAmount(t.inAmount || t.inAmt);
    return { outVal: o, inVal: i, total: o > 0 ? o : i, isCredit: i > 0 };
  };

  const cleanStr = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // Pass 1: Match by sourceId
  incomingApiTxns.forEach((apiTx, apiIdx) => {
    if (!apiTx.sourceId) return;
    const existIdx = currentBankTxns.findIndex((ex, idx) => !matchedExistingIndices.has(idx) && ex.sourceId === apiTx.sourceId);
    if (existIdx !== -1) {
      matchedIncomingIndices.add(apiIdx);
      matchedExistingIndices.add(existIdx);
      apiToExistingMap.set(apiIdx, existIdx);
    }
  });

  // Pass 2: Match by signature (exact amount + direction + date + payee/ref)
  incomingApiTxns.forEach((apiTx, apiIdx) => {
    if (matchedIncomingIndices.has(apiIdx)) return;
    const apiA = getAmt(apiTx);

    let bestIdx = -1;
    let bestScore = 0;

    currentBankTxns.forEach((ex, exIdx) => {
      if (matchedExistingIndices.has(exIdx)) return;
      const exA = getAmt(ex);

      if (apiA.isCredit !== exA.isCredit) return;
      if (Math.abs(apiA.total - exA.total) > 0.01) return;

      let score = 10;
      const apiDate = normalizeDateStr(apiTx.date);
      const exDate = normalizeDateStr(ex.date);
      let dateMatched = false;

      if (apiDate && exDate) {
        if (apiDate === exDate) {
          score += 20;
          dateMatched = true;
        } else {
          const diffMs = Math.abs(new Date(apiDate).getTime() - new Date(exDate).getTime());
          const diffDays = diffMs / (1000 * 60 * 60 * 24);
          if (diffDays <= 3) {
            score += 15;
            dateMatched = true;
          } else if (diffDays <= 5) {
            score += 10;
            dateMatched = true;
          }
        }
      }

      const apiTxt = cleanStr(`${apiTx.payee || ""} ${apiTx.particulars || ""} ${apiTx.reference || ""}`);
      const exTxt = cleanStr(`${ex.payee || ""} ${ex.particulars || ""} ${ex.reference || ""}`);
      const isProcessor = isPaymentProcessorText(apiTxt) || isPaymentProcessorText(exTxt);

      if (apiTxt && exTxt && (apiTxt.includes(exTxt) || exTxt.includes(apiTxt))) {
        score += 30;
      } else if (isProcessor && dateMatched) {
        // Payment processor alias bonus: When one side is a payment processor (GoCardless/Stripe/etc)
        // and the other is the merchant/vendor name, an amount + date match represents a high-confidence match
        score += 20;
      }

      if (score > bestScore && score >= 20) {
        bestScore = score;
        bestIdx = exIdx;
      }
    });

    if (bestIdx !== -1) {
      matchedIncomingIndices.add(apiIdx);
      matchedExistingIndices.add(bestIdx);
      apiToExistingMap.set(apiIdx, bestIdx);
    }
  });

  // Pass 2b: Match by reference / particulars / payee when amount has changed (e.g. multi-currency conversion update)
  incomingApiTxns.forEach((apiTx, apiIdx) => {
    if (matchedIncomingIndices.has(apiIdx)) return;
    const apiA = getAmt(apiTx);
    const apiRef = cleanStr(apiTx.reference || apiTx.invoiceNumber || "");
    const apiParticulars = cleanStr(apiTx.particulars || "");
    const apiPayee = cleanStr(apiTx.payee || "");
    const apiDate = normalizeDateStr(apiTx.date);

    let bestIdx = -1;
    let bestScore = 0;

    currentBankTxns.forEach((ex, exIdx) => {
      if (matchedExistingIndices.has(exIdx)) return;
      const exA = getAmt(ex);

      // Must be same direction (both inflow or both outflow)
      if (apiA.isCredit !== exA.isCredit) return;

      const exRef = cleanStr(ex.reference || "");
      const exParticulars = cleanStr(ex.particulars || "");
      const exPayee = cleanStr(ex.payee || "");
      const exDate = normalizeDateStr(ex.date);

      let score = 0;

      // 1. Reference match (e.g. invoice RV-1206)
      if (apiRef && exRef && (apiRef === exRef || apiRef.includes(exRef) || exRef.includes(apiRef))) {
        score += 40;
      }

      // 2. Particulars match (e.g. "Invoice RV-1206 payment")
      if (apiParticulars && exParticulars && (apiParticulars === exParticulars || apiParticulars.includes(exParticulars) || exParticulars.includes(apiParticulars))) {
        score += 35;
      }

      // 3. Payee match
      if (apiPayee && exPayee && (apiPayee === exPayee || apiPayee.includes(exPayee) || exPayee.includes(apiPayee))) {
        score += 25;
      }

      // 4. Date match
      if (apiDate && exDate) {
        if (apiDate === exDate) {
          score += 25;
        } else {
          const diffMs = Math.abs(new Date(apiDate).getTime() - new Date(exDate).getTime());
          const diffDays = diffMs / (1000 * 60 * 60 * 24);
          if (diffDays <= 3) {
            score += 15;
          } else if (diffDays <= 7) {
            score += 10;
          }
        }
      }

      // High confidence threshold for amount-mismatched updates (must have matching ref or particulars + close date/payee)
      if (score > bestScore && score >= 55) {
        bestScore = score;
        bestIdx = exIdx;
      }
    });

    if (bestIdx !== -1) {
      matchedIncomingIndices.add(apiIdx);
      matchedExistingIndices.add(bestIdx);
      apiToExistingMap.set(apiIdx, bestIdx);
    }
  });

  // Step 1: Process matched pairs (Update fields, STRICTLY keep existing Column Q category)
  matchedIncomingIndices.forEach(apiIdx => {
    const apiTx = incomingApiTxns[apiIdx];
    let matchedExIdx = apiToExistingMap.has(apiIdx) ? apiToExistingMap.get(apiIdx) : -1;
    if (matchedExIdx === -1) {
      matchedExIdx = currentBankTxns.findIndex((ex, idx) => matchedExistingIndices.has(idx) && ex.sourceId === apiTx.sourceId);
    }
    if (matchedExIdx === -1) {
      matchedExIdx = currentBankTxns.findIndex((ex, idx) => {
        if (!matchedExistingIndices.has(idx)) return false;
        const apiA = getAmt(apiTx);
        const exA = getAmt(ex);
        return apiA.isCredit === exA.isCredit && Math.abs(apiA.total - exA.total) < 0.01;
      });
    }

    const exTx = matchedExIdx !== -1 ? currentBankTxns[matchedExIdx] : null;

    // Check if this matched transaction was an unreconciled item
    const matchedUn = matchAndRemoveFromUnreconPool(apiTx, unreconPool);
    const wasUnreconciled = Boolean(matchedUn || (exTx && exTx.isReconciled === false));

    if (wasUnreconciled) {
      matchedFromUnreconCount++;
    }

    // Keep existing Column Q category already sitting against the transaction in Column Q
    // Must strictly be an approved U3:U16 category (e.g. Contractors, Salaries, Outgoings, Revenue)
    // NEVER a specific P&L overhead category like Advertising!
    const isCredit = parseAmount(apiTx.inAmount || apiTx.inAmt) > 0;
    const defaultCat = isCredit ? "Revenue" : "Outgoings";
    const assignedCategory = exTx?.category || exTx?.suggestedCategory || defaultCat;

    if (exTx) {
      if (parseAmount(exTx.outAmount) !== parseAmount(apiTx.outAmount) ||
        parseAmount(exTx.inAmount) !== parseAmount(apiTx.inAmount) ||
        (exTx.payee || "") !== (apiTx.payee || "") ||
        (exTx.date || "") !== (apiTx.date || "")) {
        updatedCount++;
      }
    }

    nextBankTxns.push({
      ...(exTx || {}),
      ...apiTx,
      id: exTx?.id || apiTx.id,
      rowNum: exTx?.rowNum || apiTx.rowNum,
      category: assignedCategory,
      suggestedCategory: assignedCategory,
      accountName: apiTx.accountName || exTx?.accountName || defaultAccount,
      isReconciled: true,
      isNew: wasUnreconciled, // Shaded green ONLY if it was previously unreconciled
      source: apiTx.source || "quickbooks"
    });
  });

  // Step 2: Unmatched incoming API transactions
  // Reconciled transactions from the accounting platform (Xero / QuickBooks) are valid bank transactions
  incomingApiTxns.forEach((apiTx, apiIdx) => {
    if (matchedIncomingIndices.has(apiIdx)) return;

    // Check if this incoming transaction matches an unreconciled statement item (minScore: 40)
    const matchedUn = matchAndRemoveFromUnreconPool(apiTx, unreconPool, { minScore: 40 });
    if (matchedUn) {
      matchedFromUnreconCount++;
    }

    newAddedCount++;

    const isCredit = parseAmount(apiTx.inAmount || apiTx.inAmt) > 0;
    const defaultCat = isCredit ? "Revenue" : "Outgoings";
    // If it matched an unreconciled item that had a cashflow category, inherit it
    const assignedCategory = (matchedUn && matchedUn.category && matchedUn.category !== "Outgoings")
      ? matchedUn.category
      : (apiTx.category || apiTx.suggestedCategory || defaultCat);

    const newTx = {
      ...apiTx,
      category: assignedCategory,
      suggestedCategory: assignedCategory,
      accountName: apiTx.accountName || defaultAccount,
      isReconciled: true,
      isNew: Boolean(matchedUn), // Shaded green if it was recovered from unreconciled list
      source: apiTx.source || "quickbooks"
    };

    nextBankTxns.push(newTx);
    if (matchedUn) {
      fallbackAddedTxns.push({
        ...newTx,
        unreconPayee: matchedUn.payee,
        unreconDate: matchedUn.date,
        unreconAmount: matchedUn.amount,
        unreconCategory: matchedUn.category
      });
    }
  });

  // Step 2b: Non-Cash API Transactions matched against unreconciled items
  incomingNonCashTxns.forEach(ncTx => {
    const matchedUn = matchAndRemoveFromUnreconPool(ncTx, unreconPool);
    if (matchedUn) {
      matchedNonCashCount++;
    }
  });

  // Step 3: Existing bank transactions not matched by API feed
  // Unreconciled transactions remain in the list until they are reconciled!
  currentBankTxns.forEach((ex, exIdx) => {
    if (matchedExistingIndices.has(exIdx)) return;

    // Check if this existing transaction is in the unreconciled list
    const isInUnreconList = unreconPool.some(un => {
      const unO = parseAmount(un.outAmount || un.amount);
      const unI = parseAmount(un.inAmount);
      const isCredit = unI > 0;
      const unAmt = isCredit ? unI : unO;
      const exO = parseAmount(ex.outAmount || ex.outAmt);
      const exI = parseAmount(ex.inAmount || ex.inAmt);
      const exAmt = isCredit ? exI : exO;
      const amtMatch = Math.abs(exAmt - unAmt) < 0.01;
      const exNorm = normalizeDateStr(ex.date);
      const unNorm = normalizeDateStr(un.date);
      let dateMatch = true;
      if (exNorm && unNorm) {
        if (exNorm === unNorm) {
          dateMatch = true;
        } else {
          const diffDays = Math.abs(new Date(exNorm).getTime() - new Date(unNorm).getTime()) / (1000 * 60 * 60 * 24);
          dateMatch = diffDays <= 4;
        }
      }
      return amtMatch && dateMatch;
    });

    const isPendingUnrecon = ex.isReconciled === false || ex.source === "unreconciled_pasted" || isInUnreconList;

    if (isPendingUnrecon) {
      const wasReplaced = nextBankTxns.some(t => t.id === ex.id);
      if (!wasReplaced) {
        nextBankTxns.push({
          ...ex,
          isReconciled: false,
          isNew: false
        });
      }
    } else {
      // Reconciled API transaction was deleted / reversed in accounting platform
      deletedCount++;
    }
  });

  nextBankTxns.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return {
    nextBankTxns,
    nextUnreconItems: unreconPool,
    newAddedCount,
    matchedFromUnreconCount,
    matchedNonCashCount,
    updatedCount,
    deletedCount,
    fallbackAddedTxns
  };
}
