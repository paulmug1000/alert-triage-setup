import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import { fetchVatData, saveCorpTaxRate } from "../../../services/vatService.js";
import { getClients } from "../../../services/workspaces.js";
import { assertSetupClientSheetBinding, canAccessPma, isReadOnlySession } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { assertTrustedOrigin, sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

function maskTaxErrorDisplay_(raw) {
  return /^#(?:REF!|NAME\?|VALUE!|DIV\/0!|NUM!|N\/A|ERROR!)\b/i.test(String(raw || "").trim())
    ? "Error"
    : raw;
}

function redactFyDataMap_(fyData = {}) {
  const out = {};
  for (const [fyId, fyVal] of Object.entries(fyData || {})) {
    if (!fyVal) continue;
    const { rawDisplay: totalRaw, ...fyRest } = fyVal;
    out[fyId] = {
      ...fyRest,
      ...(totalRaw !== undefined ? { rawDisplay: maskTaxErrorDisplay_(totalRaw) } : {}),
      months: (fyVal.months || []).map(({ colLetter, colIdx, rawDisplay, ...mRest }) => ({
        ...mRest,
        ...(rawDisplay !== undefined ? { rawDisplay: maskTaxErrorDisplay_(rawDisplay) } : {}),
      })),
    };
  }
  return out;
}

function redactVatSectionList_(sections = []) {
  return (sections || []).map((sec) => ({
    ...sec,
    rows: (sec.rows || []).map(({ sheetRow, ...rRest }) => ({
      ...rRest,
      fyData: redactFyDataMap_(rRest.fyData),
    })),
  }));
}

export function redactTaxesPayloadForNonAdmin(data) {
  if (!data || typeof data !== "object") return data;
  return {
    ...data,
    fyConfigs: (data.fyConfigs || []).map(({ totalColLetter, totalCol, ...fyRest }) => ({
      ...fyRest,
      monthCols: (fyRest.monthCols || []).map(({ colLetter, colIdx, ...mRest }) => mRest),
    })),
    sections: redactVatSectionList_(data.sections),
    otherSections: redactVatSectionList_(data.otherSections),
    ...(data.corpTax
      ? {
          corpTax: {
            ...data.corpTax,
            sections: (data.corpTax.sections || []).map(({ rateRow, ...cSec }) => ({
              ...cSec,
              ratesByFy: Object.fromEntries(
                Object.entries(cSec.ratesByFy || {}).map(([fyId, rateObj]) => {
                  if (!rateObj) return [fyId, rateObj];
                  const { colLetter, rawDisplay, ...rateRest } = rateObj;
                  return [
                    fyId,
                    {
                      ...rateRest,
                      ...(rawDisplay !== undefined ? { rawDisplay: maskTaxErrorDisplay_(rawDisplay) } : {}),
                    },
                  ];
                })
              ),
              rows: (cSec.rows || []).map(({ sheetRow, ...rRest }) => ({
                ...rRest,
                fyData: redactFyDataMap_(rRest.fyData),
              })),
            })),
          },
        }
      : {}),
  };
}

export default async function handler(req, res) {
  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Forbidden: Access restricted to Pulse Portal" });
  }

  installSheetIdBoundary(req, res, sessionUser);

  if (req.method === "GET") {
    const rl = await checkRateLimit("pma-view", sessionUser.email || getTrustedClientIp(req), 120, 60);
    if (!rl.allowed) {
      return res.status(429).json({ success: false, error: "Too many requests. Please retry shortly." });
    }

    let { clientName, clientSheetId, bypassCache } = req.query;

    if (!clientSheetId && clientName) {
      try {
        const all = await getClients();
        const match = all.find((c) => c.clientName?.toLowerCase() === clientName.toLowerCase().trim());
        if (match) clientSheetId = match.clientSheetId;
      } catch (e) {
        console.warn("Failed to resolve client sheet in GET /api/pma/vat:", e);
      }
    }

    if (!clientSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientSheetId parameter.",
      });
    }

    const sheets = await getSheetsClient();
    const bindAuth = await assertSetupClientSheetBinding(sessionUser, {
      clientName,
      clientSheetId,
      sheets,
    });
    if (!bindAuth.authorized) {
      return res.status(bindAuth.status || 403).json({ success: false, error: bindAuth.error || "Access denied to this client." });
    }
    clientName = bindAuth.clientName || clientName;

    try {
      const data = await fetchVatData(
        clientName || "Client",
        clientSheetId,
        bypassCache === "true" || bypassCache === true,
        { minBypassAgeMs: sessionUser.isAdmin ? 0 : 15000 }
      );

      if (!sessionUser.isAdmin && data) {
        return res.status(200).json(redactTaxesPayloadForNonAdmin(data));
      }

      return res.status(200).json(data);
    } catch (err) {
      console.error("Error in GET /api/pma/vat:", err);
      return res.status(500).json({
        success: false,
        error: sessionUser.isAdmin
          ? (err.message || "Failed to load taxes data")
          : sanitizeSpreadsheetTerms(err.message || "Failed to load taxes data"),
      });
    }
  }

  if (req.method === "POST") {
    if (!assertTrustedOrigin(req, res)) return;

    if (isReadOnlySession(sessionUser)) {
      return res.status(403).json({ success: false, error: "Read-only session cannot modify tax settings." });
    }

    const canEditCorpTax = Boolean(
      !isReadOnlySession(sessionUser) &&
      (sessionUser.isAdmin || sessionUser.role === "Admin" || sessionUser.role === "ClientManager")
    );
    if (!canEditCorpTax) {
      return res.status(403).json({
        success: false,
        error: "Only administrators and client managers can update corporation tax rates.",
      });
    }

    const rl = await checkRateLimit("pma-edit", sessionUser.email || getTrustedClientIp(req), 60, 60);
    if (!rl.allowed) {
      return res.status(429).json({ success: false, error: "Too many requests. Please retry shortly." });
    }

    let { action, clientName, clientSheetId, section, fyId, fyLabel, ratePct } = req.body || {};

    if (!clientSheetId && clientName) {
      try {
        const all = await getClients();
        const match = all.find((c) => c.clientName?.toLowerCase() === clientName.toLowerCase().trim());
        if (match) clientSheetId = match.clientSheetId;
      } catch (e) {
        console.warn("Failed to resolve client sheet in POST /api/pma/vat:", e);
      }
    }

    if (!clientSheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing required clientSheetId parameter.",
      });
    }

    const sheets = await getSheetsClient();
    const bindAuth = await assertSetupClientSheetBinding(sessionUser, {
      clientName: clientName || "",
      clientSheetId,
      sheets,
    });
    if (!bindAuth.authorized) {
      return res.status(bindAuth.status || 403).json({
        success: false,
        error: bindAuth.error || "Access denied to this client.",
      });
    }
    clientName = bindAuth.clientName || clientName;

    if (action !== "update_corp_tax_rate") {
      return res.status(400).json({ success: false, error: "Unsupported action." });
    }

    const cleanSection = String(section || "").trim();
    const cleanFyId = String(fyId || "").trim();
    const parsedRate = typeof ratePct === "number" ? ratePct : parseFloat(String(ratePct ?? "").trim());
    if (cleanSection !== "cashflow" && cleanSection !== "actual") {
      return res.status(400).json({ success: false, error: "Invalid corporation tax section." });
    }
    if (cleanFyId !== "fy1" && cleanFyId !== "fy2" && cleanFyId !== "fy3") {
      return res.status(400).json({ success: false, error: "Invalid financial year identifier." });
    }
    if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100) {
      return res.status(400).json({
        success: false,
        error: "Corporation tax rate must be a percentage between 0 and 100.",
      });
    }

    try {
      const result = await saveCorpTaxRate({
        clientName: clientName || "Client",
        clientSheetId,
        section: cleanSection,
        fyId: cleanFyId,
        fyLabel: String(fyLabel || "").trim(),
        ratePct: parsedRate,
        userEmail: sessionUser.email || "",
      });

      return res.status(200).json({
        success: true,
        updated: result.updated,
        data: !sessionUser.isAdmin && result.data ? redactTaxesPayloadForNonAdmin(result.data) : result.data,
      });
    } catch (err) {
      console.error("Error in POST /api/pma/vat:", err);
      return res.status(500).json({
        success: false,
        error: sessionUser.isAdmin
          ? (err.message || "Failed to update corporation tax rate")
          : sanitizeSpreadsheetTerms(err.message || "Failed to update corporation tax rate"),
      });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
