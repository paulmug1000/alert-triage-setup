import { resolveLiveSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, unwrapSheetId } from "../../../services/userPermissions.js";
import { resolvePortalCache } from "../../../services/cacheService.js";
import { formatMoney as formatPortalMoney } from "../../../services/deepDiveHelper.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

const CASH_CACHE_TTL_SECS = 60; // 60s L1 fresh window
const CASH_REDIS_TTL_SECS = 86400; // 24h Redis SWR retention

// Fast month string parser (e.g. "Oct 26" -> Date)
function parseMonthYear(str) {
  if (!str) return null;
  const match = String(str).trim().match(/^([a-zA-Z]{3})[\s\-](\d{2,4})$/);
  if (match) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const m = months[match[1].toLowerCase()];
    let yr = parseInt(match[2], 10);
    if (yr < 100) yr += 2000;
    if (m !== undefined && !isNaN(yr)) {
      return new Date(yr, m, 1);
    }
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Redacts restricted salary and dividend details for Senior (Restricted) users while
 * merging their combined total onto the Salaries outgoing row.
 */
export function sanitizeCashForUser(payload, isSeniorUser) {
  if (!isSeniorUser || !payload) return payload;
  const isRestrictedLabel = (lbl) =>
    /salar|divid|payroll|wages|director|remuneration|net\s*pay|pension|paye|\bnic\b/i.test(String(lbl || ""));

  let detectedCurrency = "£";
  const sampleRows = [...(payload.excludingPipeline || []), ...(payload.includingPipeline || [])];
  for (const r of sampleRows) {
    if (isRestrictedLabel(r?.label)) continue;
    const sampleVal = (r?.rollingValues || []).find((v) => /[£$€¥]/.test(String(v || "")));
    if (sampleVal) {
      const m = String(sampleVal).match(/([£$€¥])/);
      if (m) {
        detectedCurrency = m[1];
        break;
      }
    }
  }

  const mergeAndRedactSection = (rows, primaryRowIndex, mergeRowIndices) => {
    if (!Array.isArray(rows)) return rows;
    const mergeSet = new Set(mergeRowIndices);
    const indexedMergeRows = rows.filter((r) => mergeSet.has(r?.rowIndex));
    const rowsToMerge = indexedMergeRows.length > 0
      ? indexedMergeRows
      : rows.filter((r) => /salar|divid/i.test(String(r?.label || "")));

    const targetRowIndex = rowsToMerge.some((r) => r?.rowIndex === primaryRowIndex)
      ? primaryRowIndex
      : rowsToMerge[0]?.rowIndex;

    const sumNumericArrays = (fieldName) => {
      const maxLen = rowsToMerge.reduce((mx, r) => Math.max(mx, Array.isArray(r?.[fieldName]) ? r[fieldName].length : 0), 0);
      return Array.from({ length: maxLen }, (_, idx) => {
        let total = 0;
        for (const r of rowsToMerge) {
          const v = r?.[fieldName]?.[idx];
          total += typeof v === "number" && Number.isFinite(v) ? v : 0;
        }
        return Math.round(total * 100) / 100;
      });
    };

    const combinedRollingRaw = rowsToMerge.length > 0 ? sumNumericArrays("rollingRawValues") : null;
    const combinedAllRaw = rowsToMerge.length > 0 ? sumNumericArrays("allRawValues") : null;
    const combinedRollingVals = combinedRollingRaw ? combinedRollingRaw.map((n) => formatPortalMoney(n, 0, detectedCurrency, ",")) : null;
    const combinedAllVals = combinedAllRaw ? combinedAllRaw.map((n) => formatPortalMoney(n, 0, detectedCurrency, ",")) : null;

    return rows.map((r) => {
      if (targetRowIndex !== undefined && r?.rowIndex === targetRowIndex && combinedRollingRaw && combinedAllRaw) {
        return {
          ...r,
          label: "Salaries outgoing",
          rollingValues: combinedRollingVals,
          rollingRawValues: combinedRollingRaw,
          rollingNotes: Array.isArray(r.rollingNotes) ? r.rollingNotes.map(() => "") : r.rollingNotes,
          allValues: combinedAllVals,
          allRawValues: combinedAllRaw,
          allNotes: Array.isArray(r.allNotes) ? r.allNotes.map(() => "") : r.allNotes,
        };
      }
      if (mergeSet.has(r?.rowIndex) || isRestrictedLabel(r?.label)) {
        return {
          ...r,
          rollingValues: Array.isArray(r.rollingValues) ? r.rollingValues.map(() => "—") : r.rollingValues,
          rollingRawValues: Array.isArray(r.rollingRawValues) ? r.rollingRawValues.map(() => 0) : r.rollingRawValues,
          rollingNotes: Array.isArray(r.rollingNotes) ? r.rollingNotes.map(() => "") : r.rollingNotes,
          allValues: Array.isArray(r.allValues) ? r.allValues.map(() => "—") : r.allValues,
          allRawValues: Array.isArray(r.allRawValues) ? r.allRawValues.map(() => 0) : r.allRawValues,
          allNotes: Array.isArray(r.allNotes) ? r.allNotes.map(() => "") : r.allNotes,
        };
      }
      return r;
    });
  };

  return {
    ...payload,
    excludingPipeline: mergeAndRedactSection(payload.excludingPipeline, 8, [8, 9, 10, 11]),
    includingPipeline: mergeAndRedactSection(payload.includingPipeline, 50, [50, 51, 52, 53]),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (req.method === "POST" && !assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const rawClientSheetId = String(req.query.clientSheetId || req.body?.clientSheetId || "").trim();
  const clientName = String(req.query.clientName || req.body?.clientName || "").trim();
  const bypassCache = req.query.bypassCache === "true" || req.body?.bypassCache === true;
  const isAutoRefresh = req.query.autoRefresh === "true" || req.body?.autoRefresh === true;

  if (!rawClientSheetId) {
    return res.status(400).json({ success: false, error: "clientSheetId is required" });
  }

  const clientSheetId = unwrapSheetId(extractSheetIdFromUrl(rawClientSheetId) || rawClientSheetId);
  if (!clientSheetId || clientSheetId === "__INVALID_WS_TOKEN__") {
    return res.status(400).json({ success: false, error: "Invalid clientSheetId" });
  }

  const sheets = await getSheetsClient();

  // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
  const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
  if (!auth.authorized) {
    return res.status(auth.status || 403).json({ success: false, error: auth.error });
  }

  const isSeniorUser = Boolean(
    sessionUser.isSenior ||
    sessionUser.role === "Senior (Restricted)" ||
    String(sessionUser.role || "").toLowerCase().includes("senior")
  );

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  const cacheKey = `pulse:portal:cash:${clientSheetId}`;

  try {
    const result = await resolvePortalCache({
      cacheKey,
      bypassCache,
      isAutoRefresh,
      isReadOnly: Boolean(sessionUser.isReadOnly),
      l1TtlSecs: CASH_CACHE_TTL_SECS,
      redisTtlSecs: CASH_REDIS_TTL_SECS,
      fetchFreshFn: async () => {
        const resp = await withRetry(() =>
          sheets.spreadsheets.get({
            spreadsheetId: clientSheetId,
            ranges: ["Cash!A1:AZ80", "AppData!G59", "KeyInfo!B10"],
            fields: "sheets(properties.title,data.rowData.values(formattedValue,effectiveValue,note))",
          })
        );

        const cashSheet = resp.data?.sheets?.find((s) => s.properties?.title === "Cash");
        const appDataSheet = resp.data?.sheets?.find((s) => s.properties?.title === "AppData");
        const keyInfoSheet = resp.data?.sheets?.find((s) => s.properties?.title === "KeyInfo");
        const rawRows = cashSheet?.data?.[0]?.rowData || [];
        const g59Val = String(appDataSheet?.data?.[0]?.rowData?.[0]?.values?.[0]?.formattedValue || "").trim().toLowerCase();
        const b10Val = String(keyInfoSheet?.data?.[0]?.rowData?.[0]?.values?.[0]?.formattedValue || "").trim().toLowerCase();
        const showChart = g59Val === "yes";
        const isTransfersMode = b10Val.includes("transfer");

        if (!rawRows.length) {
          return { _skipCache: true, _notFound: true };
        }

        const headerRow = rawRows[0]?.values || [];
        const monthCols = [];

        // Parse month columns from row 1
        for (let c = 1; c < headerRow.length; c++) {
          const h = String(headerRow[c]?.formattedValue || "").trim();
          if (!h) continue;
          const parsedDate = parseMonthYear(h);
          monthCols.push({
            colIndex: c,
            monthStr: h,
            date: parsedDate ? parsedDate.toISOString() : null,
          });
        }

        // Determine current month index
        const today = new Date();
        let currentMonthIdx = 0;
        for (let i = 0; i < monthCols.length; i++) {
          const d = monthCols[i].date ? new Date(monthCols[i].date) : null;
          if (d) {
            const mStart = new Date(d.getFullYear(), d.getMonth(), 1);
            const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
            if (today >= mStart && today <= mEnd) {
              currentMonthIdx = i;
              break;
            }
          }
        }

        // Rolling 7-month window: M-1 to M+5
        const windowStartIdx = Math.max(0, currentMonthIdx - 1);
        const windowEndIdx = Math.min(monthCols.length, windowStartIdx + 7);
        const rollingMonthCols = monthCols.slice(windowStartIdx, windowEndIdx);

        // Build line items for Table 1 (Excluding pipeline: rows 3 to 38 -> indices 2 to 37)
        // and Table 2 (Including pipeline: rows 44 to 78 -> indices 43 to 77)
        const extractRawVal = (cell) => {
          const eff = cell?.effectiveValue?.numberValue;
          if (typeof eff === "number" && Number.isFinite(eff)) return Math.round(eff * 100) / 100;
          const fmt = cell?.formattedValue;
          if (fmt === undefined || fmt === null || fmt === "") return 0;
          const cleaned = String(fmt).replace(/[£$€,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
          const n = Number(cleaned);
          return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
        };

        const parseTableSection = (startRowIdx, endRowIdx) => {
          const sectionRows = [];
          for (let r = startRowIdx; r <= endRowIdx; r++) {
            const rowCells = rawRows[r]?.values || [];
            const label = String(rowCells[0]?.formattedValue || "").trim();
            if (!label) continue;

            // Extract values and notes for rolling 7 months
            const rollingValues = rollingMonthCols.map((m) => {
              const cell = rowCells[m.colIndex];
              const val = cell?.formattedValue;
              return val !== undefined && val !== null ? String(val).trim() : "£0";
            });

            const rollingRawValues = rollingMonthCols.map((m) => extractRawVal(rowCells[m.colIndex]));

            const rollingNotes = rollingMonthCols.map((m) => {
              const cell = rowCells[m.colIndex];
              const note = cell?.note;
              return note !== undefined && note !== null ? String(note).trim() : "";
            });

            // Also extract all months for full-year/historical viewing
            const allValues = monthCols.map((m) => {
              const cell = rowCells[m.colIndex];
              const val = cell?.formattedValue;
              return val !== undefined && val !== null ? String(val).trim() : "£0";
            });

            const allRawValues = monthCols.map((m) => extractRawVal(rowCells[m.colIndex]));

            const allNotes = monthCols.map((m) => {
              const cell = rowCells[m.colIndex];
              const note = cell?.note;
              return note !== undefined && note !== null ? String(note).trim() : "";
            });

            sectionRows.push({
              rowIndex: r + 1,
              label,
              rollingValues,
              rollingRawValues,
              rollingNotes,
              allValues,
              allRawValues,
              allNotes,
            });
          }
          return sectionRows;
        };

        const excludingPipelineRows = parseTableSection(2, 37);
        const includingPipelineRows = parseTableSection(43, 77);

        const cashPayload = {
          _cachedAt: new Date().toISOString(),
          currentMonth: monthCols[currentMonthIdx]?.monthStr || "Current Month",
          currentMonthIdx,
          rollingMonths: rollingMonthCols.map((m) => m.monthStr),
          allMonths: monthCols.map((m) => m.monthStr),
          excludingPipeline: excludingPipelineRows,
          includingPipeline: includingPipelineRows,
          showChart,
          isTransfersMode,
        };

        return cashPayload;
      },
    });

    if (result.data?._notFound) {
      return res.status(404).json({ success: false, error: "Cash sheet is empty or not found" });
    }

    return res.status(200).json({
      success: true,
      fromCache: result.fromCache,
      fromMemory: result.fromMemory,
      fromRedis: result.fromRedis,
      staleRevalidating: result.staleRevalidating,
      data: sanitizeCashForUser(result.data, isSeniorUser),
      cachedAt: result.cachedAt,
    });
  } catch (err) {
    console.error("❌ /api/portal/cash error:", err);
    return res.status(500).json({ success: false, error: sessionUser?.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.") });
  }
}
