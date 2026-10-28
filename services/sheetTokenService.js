import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const TOKEN_PREFIX = "ws_";
const DEFAULT_AC_ID = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M";

const SHEET_ID_KEYS = new Set([
  "clientSheetId",
  "masterSheetId",
  "reconSheetId",
  "cashTabSheetId",
  "automationCommanderSheetId",
  "acSheetId",
  "spreadsheetId",
  "payrollClientSheetId",
  "timeMasterSheetId",
  "targetSheetId",
  "sourceSheetId",
  "templateSheetId",
  "masterId",
  "reconId",
  "sheetIdToCheck",
  "expectedSheetId",
]);

const CONDITIONAL_SHEET_ID_KEYS = new Set([
  "sheetId",
  "clientId",
]);

const STRIP_NON_ADMIN_KEYS = new Set([
  "clientUrl",
  "masterUrl",
  "clientSheetUrl",
  "masterSheetUrl",
  "reconUrl",
  "reconSheetUrl",
  "masterScriptId",
  "clientScriptId",
  "gasUrl",
  "deploymentUrl",
  "parentTemplateUrl",
  "driveFolderUrl",
  "folderUrl",
  "masterDeploymentUrl",
  "backupUrl",
  "reportUrl",
  "masterSheetScriptId",
  "clientSheetScriptId",
  "templateMasterUrl",
  "templateClientUrl",
  "spreadsheetUrl",
  "webAppUrl",
]);

function getTokenEncryptionKey() {
  const secret =
    process.env.PMA_JWT_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    process.env.INTEGRATION_ENCRYPTION_KEY?.trim() ||
    process.env.PULSE_INTERNAL_SECRET?.trim() ||
    (process.env.NODE_ENV === "production" ? "" : "pulse_workspace_token_dev_key_2026");
  if (!secret) {
    throw new Error("CRITICAL: Missing secret environment variable for sheetTokenService");
  }
  return crypto.createHash("sha256").update(`ws_token_key:${secret}`).digest();
}

/**
 * Deterministically encrypts a Google Spreadsheet ID into an opaque workspace token (`ws_...`).
 * Identical input sheet IDs always produce the exact same token so frontend state/cache keys remain stable.
 */
export function wrapSheetId(rawSheetId) {
  if (!rawSheetId || typeof rawSheetId !== "string") return rawSheetId || "";
  const trimmed = rawSheetId.trim();
  if (!trimmed || trimmed.startsWith(TOKEN_PREFIX) || trimmed === "default") {
    return trimmed;
  }

  try {
    const key = getTokenEncryptionKey();
    const iv = crypto
      .createHmac("sha256", key)
      .update(`ws_iv:${trimmed}`)
      .digest()
      .subarray(0, IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(trimmed, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${TOKEN_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
  } catch {
    return "";
  }
}

/**
 * Synchronously decrypts an opaque workspace token (`ws_...` or `"default"`) back to the canonical Google Spreadsheet ID.
 * If the input is already a raw spreadsheet ID, returns it unchanged.
 * If a `ws_...` token is malformed or tampered with, returns `""` (fail-closed).
 */
export function unwrapSheetId(idOrToken) {
  if (!idOrToken || typeof idOrToken !== "string") return idOrToken;
  const trimmed = idOrToken.trim();
  if (!trimmed) return idOrToken;

  if (trimmed === "default") {
    return process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_ID;
  }

  if (!trimmed.startsWith(TOKEN_PREFIX)) {
    return idOrToken;
  }

  try {
    const rawBuf = Buffer.from(trimmed.slice(TOKEN_PREFIX.length), "base64url");
    if (rawBuf.length < IV_LENGTH + TAG_LENGTH + 1) {
      return "__INVALID_WS_TOKEN__";
    }
    const iv = rawBuf.subarray(0, IV_LENGTH);
    const tag = rawBuf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = rawBuf.subarray(IV_LENGTH + TAG_LENGTH);

    const key = getTokenEncryptionKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return "__INVALID_WS_TOKEN__";
  }
}

/**
 * Recursively unwraps any `ws_...` opaque workspace tokens (and `"default"` AC sheet aliases)
 * in-place across incoming request bodies or query objects.
 */
export function unwrapRequestSheetIds(obj, seen = new WeakSet(), rawSheetRefs = null) {
  if (!obj || typeof obj !== "object") {
    if (typeof obj === "string") {
      const t = obj.trim();
      if (t.startsWith(TOKEN_PREFIX)) return unwrapSheetId(t);
    }
    return obj;
  }
  if (seen.has(obj)) return obj;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const val = obj[i];
      if (typeof val === "string") {
        const t = val.trim();
        if (t.startsWith(TOKEN_PREFIX)) {
          obj[i] = unwrapSheetId(t);
        }
      } else if (val && typeof val === "object") {
        unwrapRequestSheetIds(val, seen, rawSheetRefs);
      }
    }
    return obj;
  }

  const canonicalAcId = process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_ID;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string") {
      const t = val.trim();
      if (t.startsWith(TOKEN_PREFIX)) {
        obj[key] = unwrapSheetId(t);
      } else if (
        (key === "automationCommanderSheetId" || key === "acSheetId") &&
        (t === "default" || t === canonicalAcId)
      ) {
        obj[key] = canonicalAcId;
      } else if (rawSheetRefs && SHEET_ID_KEYS.has(key) && t.length > 0 && t !== "default") {
        rawSheetRefs.push({ target: obj, key });
      } else if (
        rawSheetRefs &&
        CONDITIONAL_SHEET_ID_KEYS.has(key) &&
        /^[a-zA-Z0-9-_]{22,}$/.test(t)
      ) {
        rawSheetRefs.push({ target: obj, key });
      }
    } else if (val && typeof val === "object") {
      unwrapRequestSheetIds(val, seen, rawSheetRefs);
    }
  }
  return obj;
}

export function isSysAdminUser(sessionUser) {
  return Boolean(
    sessionUser &&
      (sessionUser.isAdmin || sessionUser.role === "Admin") &&
      !sessionUser.isReadOnly &&
      sessionUser.authProvider !== "EmailOTP"
  );
}

/**
 * Recursively masks spreadsheet IDs (`clientSheetId`, `masterSheetId`, etc.) into opaque `ws_...` tokens
 * and strips direct spreadsheet/GAS URLs for non-admin sessions (`MED-05` & Rule 13).
 * System administrators (`isAdmin && !isReadOnly`) receive the unmodified payload.
 */
export function maskResponseSheetIdsForUser(data, sessionUser, seen = new WeakMap()) {
  if (isSysAdminUser(sessionUser)) {
    return data;
  }
  if (!data || typeof data !== "object") {
    return data;
  }
  if (data instanceof Date || Buffer.isBuffer(data)) {
    return data;
  }
  if (seen.has(data)) {
    return seen.get(data);
  }

  if (Array.isArray(data)) {
    const outArr = new Array(data.length);
    seen.set(data, outArr);
    for (let i = 0; i < data.length; i++) {
      outArr[i] = maskResponseSheetIdsForUser(data[i], sessionUser, seen);
    }
    return outArr;
  }

  const outObj = {};
  seen.set(data, outObj);

  for (const [key, val] of Object.entries(data)) {
    if (STRIP_NON_ADMIN_KEYS.has(key)) {
      outObj[key] = "";
      continue;
    }

    if (key === "formula") {
      outObj[key] = null;
      continue;
    }

    if (key === "rawVal" && typeof val === "string" && val.trim().startsWith("=")) {
      outObj[key] = data.numVal ?? data.v ?? "";
      continue;
    }

    if (SHEET_ID_KEYS.has(key)) {
      if (typeof val === "string" && val.trim().length > 0) {
        outObj[key] = wrapSheetId(val);
      } else {
        outObj[key] = val;
      }
      continue;
    }

    if (CONDITIONAL_SHEET_ID_KEYS.has(key)) {
      if (typeof val === "string" && /^[a-zA-Z0-9-_]{22,}$/.test(val.trim())) {
        outObj[key] = wrapSheetId(val);
      } else {
        outObj[key] = val;
      }
      continue;
    }

    if (val && typeof val === "object") {
      outObj[key] = maskResponseSheetIdsForUser(val, sessionUser, seen);
    } else {
      outObj[key] = val;
    }
  }

  return outObj;
}

const _resBoundaryState = new WeakMap();
const _reqBoundaryState = new WeakMap();

/**
 * Installs request-entry unwrapping and response-exit masking on Next.js `(req, res)`.
 * Safe to call multiple times on the same request.
 */
export function installSheetIdBoundary(req, res, sessionUser = null) {
  if (req) {
    let reqState = _reqBoundaryState.get(req);
    if (!reqState) {
      const rawSheetRefs = [];
      if (req.body && typeof req.body === "object") {
        unwrapRequestSheetIds(req.body, new WeakSet(), rawSheetRefs);
      }
      if (req.query && typeof req.query === "object") {
        unwrapRequestSheetIds(req.query, new WeakSet(), rawSheetRefs);
      }
      reqState = { unwrapped: true, rawSheetRefs };
      _reqBoundaryState.set(req, reqState);
    }
    if (sessionUser && !isSysAdminUser(sessionUser) && !req.isSystemAuthorized && reqState.rawSheetRefs.length > 0) {
      for (const ref of reqState.rawSheetRefs) {
        if (ref.key === "automationCommanderSheetId" || ref.key === "acSheetId") {
          ref.target[ref.key] = unwrapSheetId("default");
        } else {
          ref.target[ref.key] = "__RAW_SHEET_ID_FORBIDDEN__";
        }
      }
    }
  }

  if (!res || typeof res.json !== "function") return;

  const existing = _resBoundaryState.get(res);
  if (!existing) {
    const origJson = res.json.bind(res);
    const state = { sessionUser };
    _resBoundaryState.set(res, state);
    res.json = function maskedJson(payload) {
      if (req?.isSystemAuthorized) {
        return origJson(payload);
      }
      const effectiveUser = state.sessionUser !== undefined ? state.sessionUser : sessionUser;
      const safePayload = maskResponseSheetIdsForUser(payload, effectiveUser);
      return origJson(safePayload);
    };
  } else if (sessionUser !== undefined) {
    existing.sessionUser = sessionUser;
  }
}
