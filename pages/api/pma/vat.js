import { resolveLiveSessionUser } from "../../../services/authService.js";
import { fetchVatData } from "../../../services/vatService.js";
import { getClients } from "../../../services/workspaces.js";
import { verifyUserAuthorizedForSheet, canAccessPma } from "../../../services/userPermissions.js";
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

  if (!sessionUser.isAdmin) {
    const sheets = await getSheetsClient();
    const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error || "Access denied to this client." });
    }
  }

  try {
    const data = await fetchVatData(
      clientName || "Client",
      clientSheetId,
      bypassCache === "true" || bypassCache === true
    );

    if (!sessionUser.isAdmin && data) {
      return res.status(200).json({
        ...data,
        fyConfigs: (data.fyConfigs || []).map(({ totalColLetter, ...fyRest }) => ({
          ...fyRest,
          monthCols: (fyRest.monthCols || []).map(({ colLetter, ...mRest }) => mRest),
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
                  months: (fyVal.months || []).map(({ colLetter, ...mRest }) => mRest),
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
