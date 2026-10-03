import { withRetry } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";

export const USERS_TAB = "Users";
export const DEFAULT_AC_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
const REDIS_USERS_KEY = "pma:users:list";
const REDIS_USERS_TTL_SECS = 300; // 5 minutes cache

let usersTabVerified = false;

/**
 * Ensure the "Users" tab exists on Automation Commander spreadsheet.
 * If not present, creates it with proper schema and seeds an initial Admin user.
 */
export async function ensureUsersTab(sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID) {
  const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
  if (usersTabVerified) return;

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: acId,
      fields: "sheets.properties.title"
    });
    const exists = meta.data.sheets?.some(s => s.properties?.title === USERS_TAB);

    if (!exists) {
      console.log(`📋 Creating "${USERS_TAB}" tab on Automation Commander...`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: acId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: USERS_TAB,
                  gridProperties: { rowCount: 500, columnCount: 10, frozenRowCount: 1 }
                }
              }
            }
          ]
        }
      });

      // Write headers and initial Admin row
      await sheets.spreadsheets.values.update({
        spreadsheetId: acId,
        range: `${USERS_TAB}!A1:G2`,
        valueInputOption: "RAW",
        requestBody: {
          values: [
            ["Email", "Full Name", "Role", "Assigned Clients", "Status", "Created At", "Last Login At", "Daily Alerts Email"],
            ["paul@gothrive.uk", "Paul", "Admin", "*", "Active", new Date().toISOString(), "", "Yes"]
          ]
        }
      });
      console.log(`✅ "${USERS_TAB}" tab created and seeded with initial Admin user.`);
    }
    usersTabVerified = true;
  } catch (err) {
    console.warn(`⚠️ ensureUsersTab error:`, err.message);
  }
}

/**
 * Get all users from the Users sheet (cached in Redis for 5 minutes)
 */
export async function getAllUsers(sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID, bypassCache = false) {
  const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;

  // Try Redis cache
  if (!bypassCache) {
    try {
      const cached = await redisClient.get(REDIS_USERS_KEY);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      console.warn("⚠️ Redis get users cache error:", e.message);
    }
  }

  await ensureUsersTab(sheets, acId);

  try {
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: acId,
      range: `${USERS_TAB}!A2:H500`
    }));

    const rows = resp.data.values || [];
    const users = rows
      .map((row, idx) => {
        if (!row || !row[0] || String(row[0]).trim().length === 0) return null;
        const email = String(row[0] || "").toLowerCase().trim();
        const name = String(row[1] || "").trim();
        const roleRaw = String(row[2] || "").trim();
        const roleLower = roleRaw.toLowerCase();
        let role = "ClientUser";
        if (roleLower === "admin") {
          role = "Admin";
        } else if (roleLower.includes("senior")) {
          role = "Senior (Restricted)";
        } else if (roleLower === "clientmanager" || roleLower === "client manager" || roleLower === "manager") {
          role = "ClientManager";
        } else if (roleLower === "clientuser" || roleLower === "client user" || roleLower === "client") {
          role = "ClientUser";
        }

        const assignedRaw = String(row[3] || "").trim();
        const assignedClients = assignedRaw === "*" ? "*" : assignedRaw.split(",").map(c => c.trim()).filter(Boolean);
        const status = String(row[4] || "").trim().toLowerCase() === "suspended" ? "Suspended" : "Active";
        const createdAt = row[5] || "";
        const lastLoginAt = row[6] || "";
        const dailyAlertsEmail = String(row[7] || "").trim().toLowerCase() === "no" ? "No" : "Yes";

        return {
          rowIndex: idx + 2, // 1-indexed spreadsheet row matching A2:H500 offset
          email,
          name: name || email.split("@")[0],
          role,
          isAdmin: role === "Admin",
          isSenior: role === "Senior (Restricted)",
          isClientUser: role === "ClientUser",
          assignedClients,
          status,
          createdAt,
          lastLoginAt,
          dailyAlertsEmail
        };
      })
      .filter(Boolean);

    // Save to Redis
    try {
      await redisClient.set(REDIS_USERS_KEY, JSON.stringify(users), { EX: REDIS_USERS_TTL_SECS });
    } catch (e) {
      console.warn("⚠️ Redis set users cache error:", e.message);
    }

    return users;
  } catch (err) {
    console.error("❌ Error fetching users from sheet:", err.message);
    return [];
  }
}

/**
 * Find user by email
 */
export async function getUserByEmail(email, sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID, bypassCache = false) {
  if (!email) return null;
  const normalizedEmail = String(email).toLowerCase().trim();
  const users = await getAllUsers(sheets, automationCommanderSheetId, bypassCache);
  return users.find(u => u.email === normalizedEmail) || null;
}

/**
 * Update Last Login At timestamp for a user in the spreadsheet and bust Redis cache
 */
export async function updateUserLastLogin(email, sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID) {
  try {
    const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
    const user = await getUserByEmail(email, sheets, acId, true);
    if (!user || !user.rowIndex) return;

    const nowIso = new Date().toISOString();
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: acId,
      range: `${USERS_TAB}!G${user.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[nowIso]]
      }
    }));

    // Invalidate Redis cache
    try {
      await redisClient.del(REDIS_USERS_KEY);
    } catch (e) {}
  } catch (e) {
    console.warn("⚠️ Failed to update user last login:", e.message);
  }
}

/**
 * Update Daily Alerts Email preference ("Yes" | "No") for a user in the spreadsheet and bust Redis cache
 */
export async function updateUserDailyAlertsEmail(email, dailyAlertsEmail, sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID) {
  try {
    const acId = automationCommanderSheetId || DEFAULT_AC_SHEET_ID;
    const user = await getUserByEmail(email, sheets, acId, true);
    if (!user || !user.rowIndex) {
      throw new Error(`User not found: ${email}`);
    }

    const val = String(dailyAlertsEmail).trim().toLowerCase() === "no" ? "No" : "Yes";
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: acId,
      range: `${USERS_TAB}!H${user.rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[val]]
      }
    }));

    // Invalidate Redis cache so subsequent reads see the updated preference
    try {
      await redisClient.del(REDIS_USERS_KEY);
    } catch (e) {}

    return { success: true, dailyAlertsEmail: val };
  } catch (e) {
    console.error("❌ Failed to update user daily alerts email:", e.message);
    throw e;
  }
}

/**
 * Match assigned client identifier against an actual client name.
 * Handles:
 * - Exact equality ("Eleven" === "Eleven")
 * - Case and whitespace tolerance (" eleven " === "eleven")
 * - Alphanumeric stripped tolerance ("ayefourdesign" === "ayefour design")
 * - Prefix / Substring tolerance ("Orinoco" matches "Orinoco Communications", "Ayefour" matches "Ayefour Design")
 */
export function matchesClientName(assignedIdentifier, actualClientName) {
  if (!assignedIdentifier || !actualClientName) return false;
  const sa = String(assignedIdentifier).trim().toLowerCase();
  const sb = String(actualClientName).trim().toLowerCase();
  if (sa === sb) return true;

  const clean = n => String(n || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const ca = clean(sa);
  const cb = clean(sb);
  if (ca && cb && ca === cb) return true;

  if (sa.length >= 3 && (sb.includes(sa) || sa.includes(sb))) return true;
  if (ca.length >= 3 && (cb.includes(ca) || ca.includes(cb))) return true;

  return false;
}

/**
 * Check if a role is strictly restricted to the client-facing Pulse Portal (never allowed in PMA)
 */
export function isPulseOnlyRole(role) {
  if (!role) return true;
  const r = String(role).trim().toLowerCase();
  return r === "clientuser" || r === "client user" || r === "client" || r.includes("senior");
}

/**
 * Check if a user is strictly restricted to the Pulse Portal (ClientUser or Senior (Restricted))
 */
export function isPulseOnlyUser(user) {
  if (!user) return false;
  if (user.isAdmin || user.role === "Admin") return false;
  if (user.role === "ClientManager") return false;
  return isPulseOnlyRole(user.role) || Boolean(user.isSenior) || Boolean(user.isClientUser);
}

/**
 * Check if a user has permission to access the Pulse Management Area (PMA)
 */
export function canAccessPma(user) {
  if (!user) return false;
  if (user.isAdmin || user.role === "Admin") return true;
  if (user.role === "ClientManager") return true;
  return false;
}

/**
 * Check if a user is authorized to view or edit data for a given client
 */
export function isUserAuthorizedForClient(user, clientName) {
  if (!user) return false;
  // Only Admin is an internal staff role able to see all clients
  if (user.role === "Admin" || user.isAdmin) return true;
  if (!clientName) return false;

  const assignedList = Array.isArray(user.assignedClients) ? user.assignedClients : [];
  return assignedList.some(assigned => matchesClientName(assigned, clientName));
}

/**
 * Filter an array of client objects so non-admins only see assigned clients.
 * Expects client objects to have a `name` or `clientName` property.
 */
export function filterClientsForUser(allClients, user) {
  if (!allClients || !Array.isArray(allClients)) return [];
  if (!user) return [];
  // Only Admin is an internal staff role able to see all clients
  if (user.role === "Admin" || user.isAdmin) return allClients;

  const assignedList = Array.isArray(user.assignedClients) ? user.assignedClients : [];
  return allClients.filter(c => {
    const name = String(c.name || c.clientName || "").trim();
    return assignedList.some(assigned => matchesClientName(assigned, name));
  });
}

/**
 * Sanitize user inputs to prevent CSV / Spreadsheet formula injection (CWE-1236).
 * Neutralizes strings starting with =, +, -, @ by prefixing with a single quote ',
 * unless the string is a valid finite numeric value.
 */
export function sanitizeFormulaInput(val) {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if (!trimmed) return val;
  // If it's a valid finite number, it is safe (e.g. "-500", "+25.5")
  if (!isNaN(Number(trimmed))) return val;
  // If it starts with formula trigger characters, neutralize it
  if (/^[=+\-@]/.test(trimmed)) {
    return `'${val}`;
  }
  return val;
}

/**
 * Return an object that can check whether a client has at least one active ClientManager assigned.
 */
export async function getClientManagerClientMap(sheets, automationCommanderSheetId = DEFAULT_AC_SHEET_ID) {
  try {
    const users = await getAllUsers(sheets, automationCommanderSheetId);
    const clientManagers = (users || []).filter(u => u.role === "ClientManager" && u.status === "Active");
    const assignedList = [];
    clientManagers.forEach(u => {
      if (Array.isArray(u.assignedClients)) {
        u.assignedClients.forEach(c => assignedList.push(c));
      }
    });
    return {
      clientManagers,
      hasManager: (clientName) => {
        if (!clientName) return false;
        return assignedList.some(assigned => matchesClientName(assigned, clientName));
      }
    };
  } catch (err) {
    console.warn("⚠️ getClientManagerClientMap error:", err.message);
    return {
      clientManagers: [],
      hasManager: () => false
    };
  }
}

