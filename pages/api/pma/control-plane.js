import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import { setControlPlaneSource } from "../../../services/supabaseClient.js";
import { getControlPlaneStatus, syncControlPlaneToSupabase } from "../../../services/controlPlaneMigrationService.js";
import { logPmaActivity } from "../../../services/pmaLogger.js";

export const config = {
  maxDuration: 120,
};

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser || !sessionUser.isAdmin || sessionUser.isReadOnly) {
    return res.status(403).json({
      success: false,
      error: "Forbidden: System administrator access is required.",
    });
  }

  try {
    if (req.method === "GET") {
      const status = await getControlPlaneStatus();
      return res.status(200).json({ success: true, ...status });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "Method not allowed." });
    }

    const { action, mode, automationCommanderSheetId } = req.body || {};

    if (!action || action === "status") {
      const status = await getControlPlaneStatus();
      return res.status(200).json({ success: true, ...status });
    }

    if (action === "sync_to_supabase") {
      const sheets = await getSheetsClient();
      const result = await syncControlPlaneToSupabase({
        sheets,
        automationCommanderSheetId,
        userEmail: sessionUser.email || "Admin",
      });
      const status = await getControlPlaneStatus();
      return res.status(200).json({
        ...result,
        status,
      });
    }

    if (action === "set_source") {
      if (mode !== "sheets" && mode !== "supabase") {
        return res.status(400).json({ success: false, error: "Invalid source mode. Expected 'sheets' or 'supabase'." });
      }
      const newMode = await setControlPlaneSource(mode, sessionUser.email || "Admin");
      await logPmaActivity({
        automationCommanderSheetId,
        category: "SYSTEM",
        action: "CONTROL_PLANE_SOURCE_CHANGED",
        summary: `Switched active Control Plane source to "${newMode}"`,
        details: { mode: newMode },
        userEmail: sessionUser.email || "Admin",
      });
      const status = await getControlPlaneStatus();
      return res.status(200).json({
        success: true,
        activeSource: newMode,
        status,
      });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("❌ /api/pma/control-plane error:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
    });
  }
}
