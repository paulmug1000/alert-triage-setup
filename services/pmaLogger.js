import { withRetry } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";
import { parseLogDate, formatRelativeTime, isWithin30Days } from "./activityService.js";

export const DEFAULT_AC_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
export const PMA_ACTIVITY_LOG_TAB = "PmaActivityLog";
const REDIS_ACTIVITY_PREFIX = "pulse:activity:";

/**
 * Ensure PmaActivityLog tab exists on Automation Commander with correct headers
 */
export async function ensurePmaActivityLogTab(sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID) {
  const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: acId,
      fields: "sheets.properties.title"
    });
    const exists = meta.data.sheets?.some(s => s.properties?.title === PMA_ACTIVITY_LOG_TAB);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: acId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: PMA_ACTIVITY_LOG_TAB,
                  gridProperties: { rowCount: 1000, columnCount: 10 }
                }
              }
            }
          ]
        }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: acId,
        range: `${PMA_ACTIVITY_LOG_TAB}!A1:G1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [["Timestamp", "Client", "Category", "Action", "Summary", "Details", "User"]]
        }
      });
    }
  } catch (err) {
    console.warn(`⚠️ Could not ensure ${PMA_ACTIVITY_LOG_TAB} tab:`, err.message);
  }
}

/**
 * Log an activity event performed inside Pulse Management App (PMA)
 * Appends row to PmaActivityLog on Automation Commander and busts Redis activity cache.
 * Safe & Non-blocking: will never throw to the caller.
 */
export async function logPmaActivity(sheets, {
  automationCommanderSheetId = DEFAULT_AC_SHEET_ID,
  clientName = "",
  category = "PMA",
  action = "",
  summary = "",
  details = {},
  user = "PMA Admin"
}) {
  try {
    const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
    const nowISO = new Date().toISOString();
    const cleanClient = String(clientName || "").trim();
    const cleanCategory = String(category || "PMA").trim().toUpperCase();
    const cleanAction = String(action || "").trim();
    const cleanSummary = String(summary || "").trim();
    const cleanUser = String(user || "PMA Admin").trim();
    const detailsStr = typeof details === "string" ? details : JSON.stringify(details || {});

    // 1. Append row to Automation Commander
    await withRetry(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: acId,
        range: `${PMA_ACTIVITY_LOG_TAB}!A:G`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[nowISO, cleanClient, cleanCategory, cleanAction, cleanSummary, detailsStr, cleanUser]]
        }
      })
    );

    console.log(`📝 [PMA Log] ${cleanCategory} (${cleanClient || "All"}): ${cleanAction} — ${cleanSummary}`);

    // 2. Invalidate Redis activity cache so fresh event is visible immediately
    try {
      const keysToDelete = [
        `${REDIS_ACTIVITY_PREFIX}all:normal`,
        `${REDIS_ACTIVITY_PREFIX}all:with_routine`
      ];
      if (cleanClient) {
        keysToDelete.push(
          `${REDIS_ACTIVITY_PREFIX}client:${cleanClient}:normal`,
          `${REDIS_ACTIVITY_PREFIX}client:${cleanClient}:with_routine`
        );
      }
      await Promise.all(keysToDelete.map(k => redisClient.del(k)));
      console.log(`⚡ [PMA Log] Invalidated Redis activity cache for ${cleanClient || "ALL"}`);
    } catch (cacheErr) {
      console.warn("⚠️ Could not bust Redis cache in logPmaActivity:", cacheErr.message);
    }
  } catch (err) {
    console.error("❌ logPmaActivity error:", err.message);
  }
}

/**
 * Fetch and parse PMA Activity logs from Automation Commander
 */
export async function fetchPmaActivity(sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID, targetClientName = null) {
  const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: `${PMA_ACTIVITY_LOG_TAB}!A2:G2000`,
        valueRenderOption: "FORMATTED_VALUE"
      })
    );

    const rows = resp.data.values || [];
    const events = [];

    rows.forEach((row, idx) => {
      const rawTimestamp = row[0];
      const client = String(row[1] || "").trim();
      const category = String(row[2] || "PMA").trim().toUpperCase();
      const action = String(row[3] || "").trim();
      const summary = String(row[4] || "").trim();
      const rawDetails = String(row[5] || "").trim();
      const user = String(row[6] || "PMA Admin").trim();

      if (!rawTimestamp || !summary) return;

      // Filter by targetClient if specified
      if (targetClientName && targetClientName !== "ALL") {
        if (!client || client.toLowerCase() !== targetClientName.toLowerCase()) {
          return;
        }
      }

      const date = parseLogDate(rawTimestamp);
      if (!date || !isWithin30Days(date)) return;

      let structuredDetails = {};
      try {
        if (rawDetails.startsWith("{") || rawDetails.startsWith("[")) {
          structuredDetails = JSON.parse(rawDetails);
        } else {
          structuredDetails = { raw: rawDetails };
        }
      } catch {
        structuredDetails = { raw: rawDetails };
      }

      // Add common metadata to structuredDetails
      structuredDetails.pmaAction = action;
      structuredDetails.pmaUser = user;
      structuredDetails.pmaTimestamp = rawTimestamp;

      events.push({
        id: `pma_${date.getTime()}_${client.replace(/\s+/g, "_")}_${idx}`,
        timestamp: rawTimestamp,
        timestampMs: date.getTime(),
        relativeTime: formatRelativeTime(date),
        clientName: client,
        category,
        source: "PMA",
        action,
        summary,
        structuredDetails,
        userEmail: user,
        author: user,
        isRoutine: false,
        rawDetails: rawDetails ? `${summary}\n\nDetails: ${rawDetails}` : summary
      });
    });

    return events;
  } catch (err) {
    console.warn(`⚠️ Could not fetch ${PMA_ACTIVITY_LOG_TAB}:`, err.message);
    return [];
  }
}
