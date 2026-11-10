import { withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";
import { getSupabaseAdmin, isSupabaseConfigured, isSupabaseControlPlaneActive } from "./supabaseClient.js";
import {
  wrapSheetId,
  unwrapSheetId,
  unwrapRequestSheetIds,
  maskResponseSheetIdsForUser,
  installSheetIdBoundary,
  isSysAdminUser,
} from "./sheetTokenService.js";

export {
  wrapSheetId,
  unwrapSheetId,
  unwrapRequestSheetIds,
  maskResponseSheetIdsForUser,
  installSheetIdBoundary,
  isSysAdminUser,
};

export const USERS_TAB = "Users";
export const DEFAULT_AC_SHEET_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";
const REDIS_USERS_KEY = "pma:users:list";
const REDIS_USERS_TTL_SECS = 300; // 5 minutes cache

export function getCanonicalAcSheetId() {
  return process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_SHEET_ID;
}

let usersTabVerified = false;

/**
 * Ensure the "Users" tab exists on Automation Commander spreadsheet.
 * If not present, creates it with proper schema and seeds an initial Admin user.
 */
export async function ensureUsersTab(sheets) {
  const acId = getCanonicalAcSheetId();
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
        range: `${USERS_TAB}!A1:H2`,
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

let _usersMemoryCache = null;
let _usersCachedAt = 0;

/**
 * Get all users from the Users sheet (cached in Redis for 5 minutes and in-memory for 60 seconds)
 */
export async function getAllUsers(sheets, _ignoredAcId = DEFAULT_AC_SHEET_ID, bypassCache = false) {
  const acId = getCanonicalAcSheetId();
  const now = Date.now();

  if (!bypassCache && _usersMemoryCache && (now - _usersCachedAt < 60000)) {
    return _usersMemoryCache;
  }

  // Try Redis cache
  if (!bypassCache) {
    try {
      const cached = await redisClient.get(REDIS_USERS_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        _usersMemoryCache = parsed;
        _usersCachedAt = now;
        return parsed;
      }
    } catch (e) {
      console.warn("⚠️ Redis get users cache error:", e.message);
    }
  }

  // Try Supabase users table when active
  if (await isSupabaseControlPlaneActive()) {
    try {
      const sb = getSupabaseAdmin();
      const { data: rows, error } = await sb
        .from("users")
        .select("*")
        .order("sheet_row_index", { ascending: true });
      if (!error && Array.isArray(rows) && rows.length > 0) {
        const users = rows.map((r, idx) => {
          const email = String(r.email || "").toLowerCase().trim();
          const role = r.role || "ClientUser";
          const assignedArr = Array.isArray(r.assigned_clients) ? r.assigned_clients : [];
          const assignedClients = (role === "Admin" && assignedArr.includes("*"))
            ? "*"
            : assignedArr.filter(c => c && c !== "*");
          return {
            rowIndex: r.sheet_row_index || idx + 2,
            email,
            name: r.full_name || email.split("@")[0],
            role,
            isAdmin: role === "Admin",
            isSenior: role === "Senior (Restricted)",
            isClientUser: role === "ClientUser",
            assignedClients,
            status: r.status === "Suspended" ? "Suspended" : "Active",
            createdAt: r.created_at || "",
            lastLoginAt: r.last_login_at || "",
            dailyAlertsEmail: r.daily_alerts_email === "No" ? "No" : "Yes",
          };
        });
        _usersMemoryCache = users;
        _usersCachedAt = now;
        try {
          await redisClient.set(REDIS_USERS_KEY, JSON.stringify(users), { EX: REDIS_USERS_TTL_SECS });
        } catch (_) {}
        return users;
      }
    } catch (sbErr) {
      console.warn("⚠️ Supabase getAllUsers fallback to sheet:", sbErr.message);
    }
  }

  await ensureUsersTab(sheets);

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
        const assignedClients = (role === "Admin" && assignedRaw === "*") ? "*" : assignedRaw.split(",").map(c => c.trim()).filter(Boolean && (c => c !== "*"));
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
    console.error("❌ Error fetching users from database:", err.message);
    return [];
  }
}

/**
 * Find user by email
 */
export async function getUserByEmail(email, sheets, _ignoredAcId = DEFAULT_AC_SHEET_ID, bypassCache = false) {
  if (!email) return null;
  const normalizedEmail = String(email).toLowerCase().trim();
  const users = await getAllUsers(sheets, getCanonicalAcSheetId(), bypassCache);
  return users.find(u => u.email === normalizedEmail) || null;
}

/**
 * Update Last Login At timestamp for a user in the spreadsheet and bust Redis cache
 */
export async function updateUserLastLogin(email, sheets, _ignoredAcId = DEFAULT_AC_SHEET_ID) {
  try {
    const normalizedEmail = String(email || "").toLowerCase().trim();
    if (!normalizedEmail) return;
    const nowIso = new Date().toISOString();

    if (isSupabaseConfigured()) {
      try {
        const sb = getSupabaseAdmin();
        if (sb) {
          await sb
            .from("users")
            .update({ last_login_at: nowIso })
            .eq("email", normalizedEmail);
        }
      } catch (sbErr) {
        console.warn("⚠️ Supabase updateUserLastLogin warning:", sbErr.message);
      }
    }

    const acId = getCanonicalAcSheetId();
    const user = await getUserByEmail(email, sheets, acId, true);
    if (user && user.rowIndex) {
      const updateSheet = () =>
        withRetry(() => sheets.spreadsheets.values.update({
          spreadsheetId: acId,
          range: `${USERS_TAB}!G${user.rowIndex}`,
          valueInputOption: "RAW",
          requestBody: {
            values: [[nowIso]]
          }
        }));
      if (await isSupabaseControlPlaneActive()) {
        updateSheet().catch(() => {});
      } else {
        await updateSheet();
      }
    }

    // Invalidate caches
    _usersMemoryCache = null;
    try {
      await redisClient.del(REDIS_USERS_KEY);
    } catch (e) { }
  } catch (e) {
    console.warn("⚠️ Failed to update user last login:", e.message);
  }
}

/**
 * Update Daily Alerts Email preference ("Yes" | "No") for a user in the spreadsheet and bust Redis cache
 */
export async function updateUserDailyAlertsEmail(email, dailyAlertsEmail, sheets, _ignoredAcId = DEFAULT_AC_SHEET_ID) {
  try {
    const acId = getCanonicalAcSheetId();
    const user = await getUserByEmail(email, sheets, acId, true);
    if (!user || !user.rowIndex) {
      throw new Error(`User not found: ${email}`);
    }

    const val = String(dailyAlertsEmail).trim().toLowerCase() === "no" ? "No" : "Yes";
    if (isSupabaseConfigured()) {
      try {
        const sb = getSupabaseAdmin();
        if (sb) {
          await sb
            .from("users")
            .update({ daily_alerts_email: val })
            .eq("email", String(email || "").toLowerCase().trim());
        }
      } catch (sbErr) {
        console.warn("⚠️ Supabase updateUserDailyAlertsEmail warning:", sbErr.message);
      }
    }
    if (user.rowIndex) {
      const updateSheet = () =>
        withRetry(() => sheets.spreadsheets.values.update({
          spreadsheetId: acId,
          range: `${USERS_TAB}!H${user.rowIndex}`,
          valueInputOption: "RAW",
          requestBody: {
            values: [[val]]
          }
        }));
      if (await isSupabaseControlPlaneActive()) {
        updateSheet().catch(() => {});
      } else {
        await updateSheet();
      }
    }

    _usersMemoryCache = null;

    // Invalidate Redis cache so subsequent reads see the updated preference
    try {
      await redisClient.del(REDIS_USERS_KEY);
    } catch (e) { }

    return { success: true, dailyAlertsEmail: val };
  } catch (e) {
    console.error("❌ Failed to update user daily alerts email:", e.message);
    throw e;
  }
}

/**
 * Match assigned client identifier against an actual client name.
 * Strictly requires an exact match (case-insensitive and trimmed of whitespace).
 * Wildcard "*" grants access to all clients.
 */
export function matchesClientName(assignedIdentifier, actualClientName) {
  if (!assignedIdentifier || !actualClientName) return false;
  const sa = String(assignedIdentifier).trim().toLowerCase();
  const sb = String(actualClientName).trim().toLowerCase();
  if (sa === "*") return true;
  if (sa === sb) return true;
  const advisorAliases = ["advisor", "advisor account", "advisor_account", "central advisor", "central advisor account"];
  if (advisorAliases.includes(sa) && advisorAliases.includes(sb)) return true;
  const na = normalizeClientKeyForLookup(sa);
  const nb = normalizeClientKeyForLookup(sb);
  return Boolean(na && nb && na === nb);
}

const clientSheetIdToNameCache = new Map();
const clientNameToMasterIdCache = new Map();
const clientNameToClientIdCache = new Map();

function normalizeClientKeyForLookup(str) {
  return String(str || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

async function refreshAutoUpdatesSheetMappings(sheets) {
  if (await isSupabaseControlPlaneActive()) {
    try {
      const sb = getSupabaseAdmin();
      const { data: clients, error } = await sb
        .from("clients")
        .select("client_name, client_sheet_id, master_sheet_id, recon_sheet_id");
      if (!error && Array.isArray(clients) && clients.length > 0) {
        for (const c of clients) {
          const cName = String(c.client_name || "").trim();
          const rId = String(c.recon_sheet_id || "").trim();
          const cId = String(c.client_sheet_id || "").trim();
          const mId = String(c.master_sheet_id || "").trim();
          if (rId && cName) clientSheetIdToNameCache.set(rId, cName);
          if (cId && cName) {
            clientSheetIdToNameCache.set(cId, cName);
            clientNameToClientIdCache.set(cName.toLowerCase(), cId);
            clientNameToClientIdCache.set(normalizeClientKeyForLookup(cName), cId);
          }
          if (mId && cName) {
            clientSheetIdToNameCache.set(mId, cName);
            clientNameToMasterIdCache.set(cName.toLowerCase(), mId);
            clientNameToMasterIdCache.set(normalizeClientKeyForLookup(cName), mId);
          }
        }
        return;
      }
    } catch (_) {}
  }

  const acId = getCanonicalAcSheetId();
  const resp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: acId,
      range: "AutoUpdates!A2:N500"
    })
  );
  const rows = resp.data.values || [];
  for (const r of rows) {
    const cName = String(r[0] || "").trim();
    const reconUrl = String(r[9] || "").trim();
    const clientUrl = String(r[11] || "").trim();
    const masterUrl = String(r[12] || "").trim();
    const rId = extractSheetIdFromUrl(reconUrl) || reconUrl;
    const cId = extractSheetIdFromUrl(clientUrl) || clientUrl;
    const mId = extractSheetIdFromUrl(masterUrl) || masterUrl;
    if (rId && cName) {
      clientSheetIdToNameCache.set(rId, cName);
    }
    if (cId && cName) {
      clientSheetIdToNameCache.set(cId, cName);
      clientNameToClientIdCache.set(cName.toLowerCase(), cId);
      clientNameToClientIdCache.set(normalizeClientKeyForLookup(cName), cId);
    }
    if (mId && cName) {
      clientSheetIdToNameCache.set(mId, cName);
      clientNameToMasterIdCache.set(cName.toLowerCase(), mId);
      clientNameToMasterIdCache.set(normalizeClientKeyForLookup(cName), mId);
    }
  }
}

/**
 * Resolves a clientName from a clientSheetId or masterSheetId using AutoUpdates mapping
 */
export async function resolveClientNameBySheetId(sheets, sheetId, _ignoredAcId = DEFAULT_AC_SHEET_ID) {
  if (!sheetId) return "";
  const unwrapped = unwrapSheetId(sheetId);
  if (!unwrapped) return "";
  const cleanId = extractSheetIdFromUrl(unwrapped) || unwrapped;
  if (clientSheetIdToNameCache.has(cleanId)) {
    return clientSheetIdToNameCache.get(cleanId);
  }
  try {
    await refreshAutoUpdatesSheetMappings(sheets);
    if (clientSheetIdToNameCache.has(cleanId)) {
      return clientSheetIdToNameCache.get(cleanId);
    }
  } catch (err) {
    console.warn("⚠️ Error resolving clientName by sheetId:", err.message);
  }
  return "";
}

/**
 * Resolves the canonical clientSheetId for a clientName or normalized clientKey from AutoUpdates
 */
export async function resolveClientSheetIdByClientName(sheets, clientNameOrKey) {
  if (!clientNameOrKey) return "";
  const rawLower = String(clientNameOrKey).trim().toLowerCase();
  const normKey = normalizeClientKeyForLookup(clientNameOrKey);
  if (clientNameToClientIdCache.has(rawLower)) return clientNameToClientIdCache.get(rawLower);
  if (clientNameToClientIdCache.has(normKey)) return clientNameToClientIdCache.get(normKey);
  try {
    await refreshAutoUpdatesSheetMappings(sheets);
    if (clientNameToClientIdCache.has(rawLower)) return clientNameToClientIdCache.get(rawLower);
    if (clientNameToClientIdCache.has(normKey)) return clientNameToClientIdCache.get(normKey);
  } catch (err) {
    console.warn("⚠️ Error resolving clientSheetId by clientName:", err.message);
  }
  return "";
}

/**
 * Resolves the canonical masterSheetId for a clientName or normalized clientKey from AutoUpdates
 */
export async function resolveMasterSheetIdByClientName(sheets, clientNameOrKey) {
  if (!clientNameOrKey) return "";
  const rawLower = String(clientNameOrKey).trim().toLowerCase();
  const normKey = normalizeClientKeyForLookup(clientNameOrKey);
  if (clientNameToMasterIdCache.has(rawLower)) return clientNameToMasterIdCache.get(rawLower);
  if (clientNameToMasterIdCache.has(normKey)) return clientNameToMasterIdCache.get(normKey);
  try {
    await refreshAutoUpdatesSheetMappings(sheets);
    if (clientNameToMasterIdCache.has(rawLower)) return clientNameToMasterIdCache.get(rawLower);
    if (clientNameToMasterIdCache.has(normKey)) return clientNameToMasterIdCache.get(normKey);
  } catch (err) {
    console.warn("⚠️ Error resolving masterSheetId by clientName:", err.message);
  }
  return "";
}

/**
 * Universal Fail-Closed Authorization Guard for spreadsheet operations.
 * Binds sheetId to verified tenant identity and enforces role/client permissions.
 */
export async function verifyUserAuthorizedForSheet(arg1, arg2, arg3, arg4, _ignoredAcId = DEFAULT_AC_SHEET_ID) {
  let sessionUser = arg1;
  let sheetId = arg2;
  let clientNameClaim = arg3;
  let sheets = arg4;

  // Support both (sessionUser, sheetId, clientNameClaim, sheets) and (sheets, sessionUser, sheetId, clientNameClaim)
  if (arg1 && typeof arg1 === "object" && arg1.spreadsheets) {
    sheets = arg1;
    sessionUser = arg2;
    sheetId = arg3;
    clientNameClaim = typeof arg4 === "string" ? arg4 : "";
  }

  if (!sessionUser) {
    return { authorized: false, status: 401, error: "Unauthorized: Active session required" };
  }
  if (sessionUser.isAdmin && !sessionUser.isReadOnly && sessionUser.authProvider !== "EmailOTP") {
    return { authorized: true, clientName: clientNameClaim || "Admin" };
  }
  sheetId = unwrapSheetId(sheetId);
  if (!sheetId && clientNameClaim && sheets) {
    sheetId =
      (await resolveClientSheetIdByClientName(sheets, clientNameClaim)) ||
      (await resolveMasterSheetIdByClientName(sheets, clientNameClaim));
  }
  if (!sheetId) {
    return { authorized: false, status: 400, error: "Missing sheet ID" };
  }

  // 1. Resolve registered tenant name strictly from canonical AutoUpdates registry
  const resolvedClient = await resolveClientNameBySheetId(sheets, sheetId);

  if (!resolvedClient) {
    return { authorized: false, status: 403, error: "Forbidden: Unrecognized or unmapped client spreadsheet" };
  }

  // 2. Ensure clientName claim (if supplied) matches the actual sheet
  if (clientNameClaim && !matchesClientName(clientNameClaim, resolvedClient)) {
    return { authorized: false, status: 403, error: "Forbidden: Client identifier mismatch for requested spreadsheet" };
  }

  // 3. Verify user assignment for this client
  const isAuthorized = isUserAuthorizedForClient(sessionUser, resolvedClient);
  if (!isAuthorized) {
    return { authorized: false, status: 403, error: "Forbidden: Not authorized for this client" };
  }

  return { authorized: true, clientName: resolvedClient };
}

/**
 * Check if a session is read-only (e.g. EmailOTP session)
 */
export function isReadOnlySession(user) {
  if (!user) return true;
  return Boolean(user.isReadOnly || user.authProvider === "EmailOTP");
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
 * Check if a user is strictly restricted to the Pulse Portal (ClientUser, Senior (Restricted), or EmailOTP read-only)
 */
export function isPulseOnlyUser(user) {
  if (!user) return false;
  if (isReadOnlySession(user)) return true;
  if (user.isAdmin || user.role === "Admin") return false;
  if (user.role === "ClientManager") return false;
  return isPulseOnlyRole(user.role) || Boolean(user.isSenior) || Boolean(user.isClientUser);
}

/**
 * Check if a user has permission to access the Pulse Management Area (PMA)
 */
export function canAccessPma(user) {
  if (!user) return false;
  if (isReadOnlySession(user)) return false;
  if (user.isAdmin || user.role === "Admin") return true;
  if (user.role === "ClientManager") return true;
  return false;
}

/**
 * Check if a user is permitted to view sensitive salaries and dividends data
 */
export function canViewSalariesAndDividends(user) {
  if (!user) return false;
  if (user.isAdmin || user.role === "Admin") return true;
  if (user.role === "ClientManager") return true;
  if (user.isSenior || String(user.role || "").toLowerCase().includes("senior")) return false;
  return true;
}

/**
 * Check if a user is authorized to view or edit data for a given client
 */
export function isUserAuthorizedForClient(user, clientName) {
  if (!user) return false;
  // Only non-read-only Admin is an internal staff role able to see all clients
  if ((user.role === "Admin" || user.isAdmin) && !isReadOnlySession(user)) return true;
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
  // Only non-read-only Admin is an internal staff role able to see all clients
  if ((user.role === "Admin" || user.isAdmin) && !isReadOnlySession(user)) return allClients;

  const assignedList = Array.isArray(user.assignedClients) ? user.assignedClients : [];
  return allClients.filter(c => {
    const name = String(c.name || c.clientName || "").trim();
    return assignedList.some(assigned => matchesClientName(assigned, name));
  });
}

/**
 * Sanitize user inputs to prevent CSV / Spreadsheet formula injection (CWE-1236).
 * Neutralizes strings starting with =, +, -, @, ', \t, \r by prefixing with a single quote ',
 * unless the string is a valid finite numeric value.
 */
export function sanitizeFormulaInput(val) {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if (!trimmed) return val;
  // If it's a valid finite number, it is safe (e.g. "-500", "+25.5")
  if (!isNaN(Number(trimmed))) return val;
  // If it starts with formula trigger characters or a leading single quote that Google Sheets strips on USER_ENTERED, neutralize it
  if (/^[\s'’]*[=+\-@]/.test(val)) {
    return `'${val.replace(/^[\s'’]+/, "")}`;
  }
  return val;
}

/**
 * Formats an invoice reference / code for spreadsheet entry.
 * Prevents Google Sheets from stripping leading zeroes or parsing refs as numbers/dates
 * when written with valueInputOption: "USER_ENTERED".
 */
export function formatInvoiceRefForSheet(ref) {
  if (ref === null || ref === undefined) return "";
  const s = String(ref).trim();
  if (!s) return "";
  if (s.startsWith("'")) return s;
  const sanitized = sanitizeFormulaInput(s);
  if (typeof sanitized === "string" && sanitized.startsWith("'")) return sanitized;
  if (/^\d+$/.test(String(sanitized))) {
    return `'${sanitized}`;
  }
  return sanitized;
}

/**
 * Return an object that can check whether a client has at least one active ClientManager assigned.
 */
export async function getClientManagerClientMap(sheets, _ignoredAcId = DEFAULT_AC_SHEET_ID) {
  try {
    const users = await getAllUsers(sheets, getCanonicalAcSheetId());
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

export async function invalidateUsersCache() {
  _usersMemoryCache = null;
  _usersCachedAt = 0;
  try {
    await redisClient.del(REDIS_USERS_KEY);
  } catch (_) {}
}

/**
 * Create a new user or update an existing user in Supabase public.users
 * and mirror to Automation Commander!Users.
 */
export async function createOrUpdateUser(sheets, {
  email,
  name,
  role = "ClientUser",
  assignedClients = [],
  status = "Active",
  dailyAlertsEmail = "Yes",
}) {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw new Error("A valid email address is required.");
  }

  const validRoles = ["Admin", "Senior (Restricted)", "ClientManager", "ClientUser"];
  const normalizedRole = validRoles.includes(role) ? role : "ClientUser";
  const normalizedStatus = String(status || "Active").trim() === "Suspended" ? "Suspended" : "Active";
  const normalizedDailyEmail = String(dailyAlertsEmail || "Yes").trim().toLowerCase() === "no" ? "No" : "Yes";
  const cleanName = sanitizeFormulaInput(String(name || normalizedEmail.split("@")[0]).trim());

  let clientList = [];
  if (normalizedRole === "Admin") {
    clientList = ["*"];
  } else if (Array.isArray(assignedClients)) {
    clientList = assignedClients.map(c => String(c || "").trim()).filter(c => c && c !== "*");
  } else if (typeof assignedClients === "string") {
    clientList = assignedClients.split(",").map(c => c.trim()).filter(c => c && c !== "*");
  }

  const sheetAssignedStr = normalizedRole === "Admin" ? "*" : clientList.join(", ");
  const acId = getCanonicalAcSheetId();
  const existingUsers = await getAllUsers(sheets, acId, true);
  const existingUser = existingUsers.find(u => u.email === normalizedEmail);
  const nowIso = new Date().toISOString();
  const createdAt = existingUser?.createdAt || nowIso;
  const lastLoginAt = existingUser?.lastLoginAt || null;
  const targetRowIndex = existingUser?.rowIndex || (existingUsers.reduce((m, u) => Math.max(m, u.rowIndex || 2), 1) + 1);

  if (isSupabaseConfigured()) {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { error: sbErr } = await sb
        .from("users")
        .upsert({
          email: normalizedEmail,
          full_name: cleanName,
          role: normalizedRole,
          assigned_clients: clientList,
          status: normalizedStatus,
          created_at: createdAt,
          last_login_at: lastLoginAt || null,
          daily_alerts_email: normalizedDailyEmail,
          sheet_row_index: targetRowIndex,
        }, { onConflict: "email" });
      if (sbErr) {
        throw new Error(`Supabase user save failed: ${sbErr.message}`);
      }
    }
  }

  const mirrorToSheet = async () => {
    try {
      await ensureUsersTab(sheets);
      const resp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: acId,
          range: `${USERS_TAB}!A2:H500`,
        })
      );
      const rows = resp.data.values || [];
      const rowIdx = rows.findIndex(r => String(r[0] || "").toLowerCase().trim() === normalizedEmail);
      const rowValues = [
        normalizedEmail,
        cleanName,
        normalizedRole,
        sanitizeFormulaInput(sheetAssignedStr),
        normalizedStatus,
        createdAt,
        lastLoginAt || "",
        normalizedDailyEmail,
      ];
      if (rowIdx !== -1) {
        const sheetRow = rowIdx + 2;
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: acId,
            range: `${USERS_TAB}!A${sheetRow}:H${sheetRow}`,
            valueInputOption: "RAW",
            requestBody: { values: [rowValues] },
          })
        );
      } else {
        await withRetry(() =>
          sheets.spreadsheets.values.append({
            spreadsheetId: acId,
            range: `${USERS_TAB}!A:H`,
            valueInputOption: "RAW",
            requestBody: { values: [rowValues] },
          })
        );
      }
    } catch (sheetErr) {
      console.warn("⚠️ Users tab background mirror warning:", sheetErr.message);
    }
  };

  if (await isSupabaseControlPlaneActive()) {
    mirrorToSheet().catch(() => {});
  } else {
    await mirrorToSheet();
  }

  await invalidateUsersCache();
  const updatedList = await getAllUsers(sheets, acId, true);
  return {
    success: true,
    isNew: !existingUser,
    user: updatedList.find(u => u.email === normalizedEmail) || null,
    users: updatedList,
  };
}

/**
 * Delete a user from Supabase public.users and clear their row in Automation Commander!Users.
 */
export async function deleteUserByEmail(sheets, { email, actorEmail }) {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  const normalizedActor = String(actorEmail || "").toLowerCase().trim();
  if (!normalizedEmail) throw new Error("Email is required");
  if (normalizedEmail === normalizedActor) {
    throw new Error("You cannot delete your own active admin account.");
  }

  const acId = getCanonicalAcSheetId();
  const existingUsers = await getAllUsers(sheets, acId, true);
  const target = existingUsers.find(u => u.email === normalizedEmail);
  if (!target) throw new Error(`User not found: ${normalizedEmail}`);

  if (target.role === "Admin") {
    const activeAdmins = existingUsers.filter(u => u.role === "Admin" && u.status === "Active");
    if (activeAdmins.length <= 1) {
      throw new Error("Cannot delete the last active Admin user.");
    }
  }

  if (isSupabaseConfigured()) {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { error: sbErr } = await sb
        .from("users")
        .delete()
        .eq("email", normalizedEmail);
      if (sbErr) throw new Error(`Supabase user delete failed: ${sbErr.message}`);
    }
  }

  const mirrorDeleteToSheet = async () => {
    try {
      const resp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: acId,
          range: `${USERS_TAB}!A2:H500`,
        })
      );
      const rows = resp.data.values || [];
      const rowIdx = rows.findIndex(r => String(r[0] || "").toLowerCase().trim() === normalizedEmail);
      if (rowIdx !== -1) {
        const sheetRow = rowIdx + 2;
        await withRetry(() =>
          sheets.spreadsheets.values.clear({
            spreadsheetId: acId,
            range: `${USERS_TAB}!A${sheetRow}:H${sheetRow}`,
          })
        );
      }
    } catch (sheetErr) {
      console.warn("⚠️ Users tab background delete warning:", sheetErr.message);
    }
  };

  if (await isSupabaseControlPlaneActive()) {
    mirrorDeleteToSheet().catch(() => {});
  } else {
    await mirrorDeleteToSheet();
  }

  await invalidateUsersCache();
  const updatedList = await getAllUsers(sheets, acId, true);
  return { success: true, users: updatedList };
}


