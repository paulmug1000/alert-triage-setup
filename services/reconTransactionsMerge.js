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
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m1) {
    const day = m1[1].padStart(2, "0");
    const month = m1[2].padStart(2, "0");
    let year = m1[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }
  const m2 = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m2) {
    const year = m2[1];
    const month = m2[2].padStart(2, "0");
    const day = m2[3].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return s.slice(0, 10);
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

    if (txDate && unDate) {
      if (txDate === unDate) {
        score += 35;
      } else {
        const diffMs = Math.abs(new Date(txDate).getTime() - new Date(unDate).getTime());
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (diffDays <= 3) {
          score += 25;
        } else if (txDate.slice(0, 7) === unDate.slice(0, 7)) {
          score += 10;
        }
      }
    }

    const unTxt = cleanStr(`${un.payee || ""} ${un.particulars || ""} ${un.reference || ""}`);
    if (txTxt && unTxt && (txTxt.includes(unTxt) || unTxt.includes(txTxt))) {
      score += 30;
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
      if (apiDate && exDate && apiDate === exDate) score += 20;

      const apiTxt = cleanStr(`${apiTx.payee || ""} ${apiTx.particulars || ""} ${apiTx.reference || ""}`);
      const exTxt = cleanStr(`${ex.payee || ""} ${ex.particulars || ""} ${ex.reference || ""}`);
      if (apiTxt && exTxt && (apiTxt.includes(exTxt) || exTxt.includes(apiTxt))) score += 30;

      if (score > bestScore && score >= 20) {
        bestScore = score;
        bestIdx = exIdx;
      }
    });

    if (bestIdx !== -1) {
      matchedIncomingIndices.add(apiIdx);
      matchedExistingIndices.add(bestIdx);
    }
  });

  // Step 1: Process matched pairs (Update fields, STRICTLY keep existing Column Q category)
  matchedIncomingIndices.forEach(apiIdx => {
    const apiTx = incomingApiTxns[apiIdx];
    let matchedExIdx = currentBankTxns.findIndex((ex, idx) => matchedExistingIndices.has(idx) && ex.sourceId === apiTx.sourceId);
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

  // Step 2: Unmatched incoming (Safety Fallback with high bar)
  // An incoming API transaction not in bank transactions list is ONLY added to nextBankTxns
  // if it matches an unreconciled item in unreconPool with a high bar (minScore: 40).
  incomingApiTxns.forEach((apiTx, apiIdx) => {
    if (matchedIncomingIndices.has(apiIdx)) return;

    // High bar check: MUST match an item in unreconPool (requires exact amount + direction AND either date within 3 days or matching payee text)
    const matchedUn = matchAndRemoveFromUnreconPool(apiTx, unreconPool, { minScore: 40 });
    if (!matchedUn) {
      // High bar prevents extraneous/unmatched transactions from polluting the bank transactions list!
      return;
    }

    newAddedCount++;
    matchedFromUnreconCount++;

    const isCredit = parseAmount(apiTx.inAmount || apiTx.inAmt) > 0;
    const assignedCategory = isCredit ? "Revenue" : "Outgoings";

    const newTx = {
      ...apiTx,
      category: assignedCategory,
      suggestedCategory: assignedCategory,
      accountName: apiTx.accountName || defaultAccount,
      isReconciled: true,
      isNew: true, // Shaded green because it was recovered from unreconciled list
      source: apiTx.source || "quickbooks"
    };

    nextBankTxns.push(newTx);
    fallbackAddedTxns.push({
      ...newTx,
      unreconPayee: matchedUn.payee,
      unreconDate: matchedUn.date,
      unreconAmount: matchedUn.amount,
      unreconCategory: matchedUn.category
    });
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
      return Math.abs(exAmt - unAmt) < 0.01 && normalizeDateStr(ex.date) === normalizeDateStr(un.date);
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
