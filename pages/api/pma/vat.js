import { resolveLiveSessionUser, getTrustedClientIp, checkRateLimit } from "../../../services/authService.js";
import { fetchVatData } from "../../../services/vatService.js";
import { getClients } from "../../../services/workspaces.js";
import { assertSetupClientSheetBinding, canAccessPma } from "../../../services/userPermissions.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { installSheetIdBoundary } from "../../../services/sheetTokenService.js";
import { sanitizeSpreadsheetTerms } from "../../../utils/helpers.js";

export default async function handler(req, res) {
  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (!canAccessPma(sessionUser)) {
    return res.status(403).json({ success: false, error: "Forbidden: Access restricted to Pulse Portal" });
  }

  installSheetIdBoundary(req, res, sessionUser);

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

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
      const maskVatErrDisplay = (raw) =>
        /^#(?:REF!|NAME\?|VALUE!|N\/A|ERROR!)$/i.test(String(raw || "").trim()) ? "Error" : raw;
      return res.status(200).json({
        ...data,
        fyConfigs: (data.fyConfigs || []).map(({ totalColLetter, totalCol, ...fyRest }) => ({
          ...fyRest,
          monthCols: (fyRest.monthCols || []).map(({ colLetter, colIdx, ...mRest }) => mRest),
        })),
        sections: (data.sections || []).map((sec) => ({
          ...sec,
          rows: (sec.rows || []).map(({ sheetRow, ...rRest }) => ({
            ...rRest,
            fyData: Object.fromEntries(
              Object.entries(rRest.fyData || {}).map(([fyId, fyVal]) => [
                fyId,
                {
                  ...fyVal,
                  ...(fyVal?.rawDisplay !== undefined ? { rawDisplay: maskVatErrDisplay(fyVal.rawDisplay) } : {}),
                  months: (fyVal.months || []).map(({ colLetter, colIdx, rawDisplay, ...mRest }) => ({
                    ...mRest,
                    ...(rawDisplay !== undefined ? { rawDisplay: maskVatErrDisplay(rawDisplay) } : {}),
                  })),
                },
              ])
            ),
          })),
        })),
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("Error in GET /api/pma/vat:", err);
    return res.status(500).json({
      success: false,
      error: sessionUser.isAdmin
        ? (err.message || "Failed to load VAT data")
        : sanitizeSpreadsheetTerms(err.message || "Failed to load VAT data"),
    });
  }
}
