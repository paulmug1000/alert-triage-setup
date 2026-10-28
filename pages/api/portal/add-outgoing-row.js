import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, sanitizeFormulaInput, isReadOnlySession } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache } from "../../../services/cacheService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({
      success: false,
      error: "Pulse is read-only when logged in with a one-time password.",
    });
  }

  const {
    clientSheetId,
    clientName,
    section = "contractor", // 'contractor' | 'expense'
    name,
    vat = "Yes",
    invoiceTiming = "Curr",
    paymentTiming = "Curr",
    deliveryPct = "100%",
    isDelivery = true,
  } = req.body || {};

  if (!clientSheetId || !name || !String(name).trim()) {
    return res.status(400).json({
      success: false,
      error: "clientSheetId and name are required",
    });
  }

  try {
    const sheets = await getSheetsClient();

    // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
    const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }
    const verifiedClientName = auth.clientName;

    const isSenior = sessionUser.isSenior ||
      sessionUser.role === "Senior (Restricted)" ||
      String(sessionUser.role || "").toLowerCase().includes("senior");

    const secLower = String(section || "").toLowerCase();
    if (isSenior && (secLower.includes("divid") || secLower.includes("salar"))) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Senior users cannot modify salaries or dividends",
      });
    }

    // Determine row range in Outgoings tab
    const isContractor = secLower.includes("contractor");
    const startRow = isContractor ? 13 : 126;
    const endRow = isContractor ? 110 : 225;
    const range = `Outgoings!A${startRow}:A${endRow}`;

    const checkResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range,
      })
    );

    const rows = checkResp.data.values || [];
    let targetRow = null;
    const maxRows = endRow - startRow + 1;

    for (let i = 0; i < maxRows; i++) {
      const cellVal = rows[i]?.[0];
      if (!cellVal || String(cellVal).trim() === "") {
        targetRow = startRow + i;
        break;
      }
    }

    if (!targetRow || targetRow > endRow) {
      return res.status(400).json({
        success: false,
        error: `${isContractor ? "Contractors" : "Expenses"} section is full (max row ${endRow})`,
      });
    }

    const nameClean = sanitizeFormulaInput(String(name).trim());
    const vatClean = String(vat || "").toLowerCase() === "no" ? "No" : "Yes";
    const invClean = String(invoiceTiming || "").toLowerCase().startsWith("next") ? "Next" : "Curr";
    const payClean = String(paymentTiming || "").toLowerCase().startsWith("next") ? "Next" : "Curr";

    let pctClean = deliveryPct;
    if (pctClean === undefined || pctClean === null || pctClean === "") {
      pctClean = isDelivery ? "100%" : "0%";
    } else {
      const pctNum = parseFloat(String(pctClean).replace(/%/g, "").trim());
      pctClean = Number.isFinite(pctNum) ? `${Math.max(0, Math.min(100, pctNum))}%` : (isDelivery ? "100%" : "0%");
    }

    // Write columns A to E in Outgoings tab
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: clientSheetId,
        range: `Outgoings!A${targetRow}:E${targetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[nameClean, vatClean, invClean, payClean, pctClean]],
        },
      })
    );

    // Invalidate caches for this client
    try {
      memoryCache.del(`pulse:portal:*:${clientSheetId}*`);
      const keys = await redisClient.keys(`pulse:portal:*:${clientSheetId}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (cacheErr) {
      console.warn("⚠️ Cache invalidation warning:", cacheErr.message);
    }

    // Log Activity
    try {
      await logPulseActivity(sheets, {
        clientName: verifiedClientName || clientName || "Client",
        category: isContractor ? "CONTRACTORS" : "EXPENSES",
        action: isContractor ? "CONTRACTOR_CREATED" : "EXPENSE_CREATED",
        summary: `Added new ${isContractor ? "contractor" : "expense category"} '${nameClean}' (Row ${targetRow})`,
        details: {
          name: nameClean,
          vat: vatClean,
          invoiceTiming: invClean,
          paymentTiming: payClean,
          deliveryPct: pctClean,
          row: targetRow,
          clientName: verifiedClientName || clientName,
        },
        user: sessionUser.name || sessionUser.email,
      });
    } catch (logErr) {
      console.warn("⚠️ Failed to log outgoing row creation:", logErr.message);
    }

    const isDeliveryBool = pctClean === "100%" || (parseFloat(pctClean) || 0) > 0;

    return res.status(200).json({
      success: true,
      rowNumber: targetRow,
      item: {
        rowNumber: targetRow,
        name: nameClean,
        vat: vatClean,
        invoiceTiming: invClean,
        paymentTiming: payClean,
        deliveryPct: pctClean,
        isDelivery: isDeliveryBool,
        allocations: {
          1: new Array(12).fill("£0"),
          2: new Array(12).fill("£0"),
          3: new Array(12).fill("£0"),
        },
        totals: { 1: 0, 2: 0, 3: 0 },
        monthlyAllocations: new Array(12).fill("£0"),
        totalAnnual: 0,
      },
    });
  } catch (err) {
    console.error("❌ /api/portal/add-outgoing-row error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
