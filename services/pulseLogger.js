import { withRetry } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";
import { parseLogDate, formatRelativeTime, isWithin30Days, appendLiveActivityToCache } from "./activityService.js";

export const DEFAULT_AC_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
export const PULSE_ACTIVITY_LOG_TAB = "PulseActivityLog";
const REDIS_ACTIVITY_PREFIX = "pulse:activity:";
const MAX_ROWS = 5000;
let tabVerified = false;

/**
 * Ensure PulseActivityLog tab exists on Automation Commander with correct headers
 */
export async function ensurePulseActivityLogTab(sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID) {
  if (tabVerified) return;
  const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: acId,
      fields: "sheets.properties.title"
    });
    const exists = meta.data.sheets?.some(s => s.properties?.title === PULSE_ACTIVITY_LOG_TAB);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: acId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: PULSE_ACTIVITY_LOG_TAB,
                  gridProperties: { rowCount: 1000, columnCount: 10 }
                }
              }
            }
          ]
        }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: acId,
        range: `${PULSE_ACTIVITY_LOG_TAB}!A1:G1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [["Timestamp", "Client", "Category", "Action", "Summary", "Details", "User"]]
        }
      });
      console.log(`📋 Created ${PULSE_ACTIVITY_LOG_TAB} tab on Automation Commander.`);
    }
    tabVerified = true;
  } catch (err) {
    console.warn(`⚠️ Could not ensure ${PULSE_ACTIVITY_LOG_TAB} tab:`, err.message);
  }
}

/**
 * Log an activity event performed inside Pulse Portal or Authentication
 * Appends row to PulseActivityLog on Automation Commander and busts Redis activity cache.
 * Safe & Non-blocking: will never throw to the caller.
 */
export async function logPulseActivity(sheets, {
  automationCommanderSheetId = DEFAULT_AC_SHEET_ID,
  clientName = "System",
  category = "PULSE",
  action = "",
  summary = "",
  details = {},
  user = "System"
}) {
  try {
    const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
    await ensurePulseActivityLogTab(sheets, acId);

    const nowISO = new Date().toISOString();
    const cleanClient = String(clientName || "System").trim();
    const cleanCategory = String(category || "PULSE").trim().toUpperCase();
    const cleanAction = String(action || "").trim();
    const cleanSummary = String(summary || "").trim();
    const cleanUser = String(user || "System").trim();
    const detailsStr = typeof details === "string" ? details : JSON.stringify(details || {});

    // 1. Append row to Automation Commander
    await withRetry(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: acId,
        range: `${PULSE_ACTIVITY_LOG_TAB}!A:G`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[nowISO, cleanClient, cleanCategory, cleanAction, cleanSummary, detailsStr, cleanUser]]
        }
      })
    );

    console.log(`📝 [Pulse Log] ${cleanCategory} (${cleanClient}): ${cleanAction} - ${cleanSummary}`);

    // 2. Non-destructively prepend new event to Redis cache so fresh event is visible immediately
    // without wiping out the 30-second Google Sheets AutoLog scrape!
    try {
      const date = new Date(nowISO);
      const liveEvent = {
        id: `pulse_${date.getTime()}_${cleanClient.replace(/\s+/g, "_") || "System"}_${Date.now()}`,
        timestamp: nowISO,
        timestampMs: date.getTime(),
        relativeTime: formatRelativeTime(date),
        clientName: cleanClient,
        category: cleanCategory,
        source: "user",
        action: cleanAction,
        summary: cleanSummary,
        structuredDetails: typeof details === "object" ? details : { raw: detailsStr },
        userEmail: cleanUser,
        author: cleanUser,
        isRoutine: false,
        rawDetails: detailsStr ? `${cleanSummary}\n\nDetails: ${detailsStr}` : cleanSummary
      };
      await appendLiveActivityToCache(liveEvent, cleanClient);
      console.log(`⚡ [Pulse Log] Prepended live event to Redis activity cache for ${cleanClient || "System"}`);
    } catch (cacheErr) {
      console.warn("⚠️ Could not update live Redis cache in logPulseActivity:", cacheErr.message);
    }

    // 3. Optional periodic pruning: check row count and trim oldest if > MAX_ROWS
    // Run asynchronously without awaiting to keep caller fast
    prunePulseActivityLogIfNeeded(sheets, acId).catch(() => {});
  } catch (err) {
    console.error("❌ logPulseActivity error:", err.message);
  }
}

/**
 * Truncates oldest log rows if row count exceeds MAX_ROWS
 */
async function prunePulseActivityLogIfNeeded(sheets, acId) {
  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: `${PULSE_ACTIVITY_LOG_TAB}!A:A`
      })
    );
    const rowCount = (resp.data.values || []).length;
    if (rowCount > MAX_ROWS + 50) {
      const deleteCount = rowCount - MAX_ROWS;
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: acId,
        fields: "sheets.properties"
      });
      const sheetMeta = meta.data.sheets?.find(s => s.properties?.title === PULSE_ACTIVITY_LOG_TAB);
      if (sheetMeta) {
        await withRetry(() =>
          sheets.spreadsheets.batchUpdate({
            spreadsheetId: acId,
            requestBody: {
              requests: [
                {
                  deleteDimension: {
                    range: {
                      sheetId: sheetMeta.properties.sheetId,
                      dimension: "ROWS",
                      startIndex: 1, // preserve row 0 (headers)
                      endIndex: 1 + deleteCount
                    }
                  }
                }
              ]
            }
          })
        );
        console.log(`🧹 Pruned ${deleteCount} old rows from ${PULSE_ACTIVITY_LOG_TAB}`);
      }
    }
  } catch (err) {
    console.warn(`⚠️ Error pruning ${PULSE_ACTIVITY_LOG_TAB}:`, err.message);
  }
}

/**
 * Fetch and parse Pulse Activity logs from Automation Commander
 */
export async function fetchPulseActivity(sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID, targetClientName = null) {
  const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
  await ensurePulseActivityLogTab(sheets, acId);

  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: `${PULSE_ACTIVITY_LOG_TAB}!A2:G5000`,
        valueRenderOption: "FORMATTED_VALUE"
      })
    );

    const rows = resp.data.values || [];
    const events = [];

    rows.forEach((row, idx) => {
      const rawTimestamp = row[0];
      const client = String(row[1] || "").trim();
      const category = String(row[2] || "PULSE").trim().toUpperCase();
      const action = String(row[3] || "").trim();
      const summary = String(row[4] || "").trim();
      const rawDetails = String(row[5] || "").trim();
      const user = String(row[6] || "").trim();

      if (!rawTimestamp || !summary) return;

      // Filter by targetClient if specified
      if (targetClientName && targetClientName !== "ALL") {
        if (targetClientName === "SYSTEM") {
          // System/Security filter: matches System, Multi-Client, Unregistered, or category AUTH
          const isSystem = client === "System" || client === "Multi-Client" || client === "Unregistered" || category === "AUTH";
          if (!isSystem) return;
        } else {
          // Specific client filter
          let matches = client && client.toLowerCase() === targetClientName.toLowerCase();
          if (!matches) {
            // Check if user's assigned clients in details contains targetClient
            try {
              if (rawDetails.includes(targetClientName)) {
                const parsed = JSON.parse(rawDetails);
                if (Array.isArray(parsed.assignedClients)) {
                  matches = parsed.assignedClients.some(ac => ac.toLowerCase() === targetClientName.toLowerCase());
                }
              }
            } catch {}
          }
          if (!matches) return;
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

      structuredDetails.pulseAction = action;
      structuredDetails.pulseUser = user;
      structuredDetails.pulseTimestamp = rawTimestamp;

      events.push({
        id: `pulse_${date.getTime()}_${client.replace(/\s+/g, "_")}_${idx}`,
        timestamp: rawTimestamp,
        timestampMs: date.getTime(),
        relativeTime: formatRelativeTime(date),
        clientName: client,
        category,
        source: "user",
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
    console.warn(`⚠️ Could not fetch ${PULSE_ACTIVITY_LOG_TAB}:`, err.message);
    return [];
  }
}

/**
 * Fetch dedicated Security and Auth audit log entries for Admin Settings table
 */
export async function fetchSecurityAuditLogs(sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID, limit = 100) {
  const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
  await ensurePulseActivityLogTab(sheets, acId);

  try {
    const resp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: acId,
        range: `${PULSE_ACTIVITY_LOG_TAB}!A2:G5000`,
        valueRenderOption: "FORMATTED_VALUE"
      })
    );

    const rows = resp.data.values || [];
    const authLogs = [];

    // Filter to Category AUTH or Action containing LOGIN / AUTH / PORTAL
    for (let idx = rows.length - 1; idx >= 0; idx--) {
      const row = rows[idx];
      const rawTimestamp = row[0];
      const client = String(row[1] || "").trim();
      const category = String(row[2] || "").trim().toUpperCase();
      const action = String(row[3] || "").trim();
      const summary = String(row[4] || "").trim();
      const rawDetails = String(row[5] || "").trim();
      const user = String(row[6] || "").trim();

      if (!rawTimestamp || !action) continue;

      const isAuthEvent = category === "AUTH" || action.includes("LOGIN") || action.includes("AUTH") || action.includes("PORTAL");
      if (!isAuthEvent) continue;

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

      authLogs.push({
        id: `sec_${idx}_${rawTimestamp}`,
        timestamp: rawTimestamp,
        client,
        category,
        action,
        summary,
        user,
        ip: structuredDetails.ip || "-",
        provider: structuredDetails.provider || "-",
        details: structuredDetails
      });

      if (authLogs.length >= limit) break;
    }

    return authLogs;
  } catch (err) {
    console.error(`❌ fetchSecurityAuditLogs error:`, err.message);
    return [];
  }
}
