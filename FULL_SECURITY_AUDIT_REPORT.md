# Pulse Multi-Tenant Ecosystem — Full Security & Penetration Testing Audit Report

**Date:** October 26, 2026  
**Auditor:** Antigravity AI Security Suite (Defensive Security Audit & Penetration Review)  
**Target Systems:**  
1. **Layer 1: Pulse Application & Orchestration (PMA & Portal)** — [pulse-management-system/](file:///c:/Code/pulse-ecosystem/pulse-management-system)  
2. **Layer 2: Master Sheet Data Engine** — [master-GAS-scripts/](file:///c:/Code/pulse-ecosystem/master-GAS-scripts)  
3. **Layer 3: Client Sheet Utility** — [client-GAS-scripts/Code.gs](file:///c:/Code/pulse-ecosystem/client-GAS-scripts/Code.gs)  
4. **Auxiliary Control Plane** — [agent-automater/](file:///c:/Code/pulse-ecosystem/agent-automater), [bulk-updater/](file:///c:/Code/pulse-ecosystem/bulk-updater), [deployment-manager/](file:///c:/Code/pulse-ecosystem/deployment-manager), [reporting-control/](file:///c:/Code/pulse-ecosystem/reporting-control)  

---

## 1. Executive Summary

A comprehensive, full-spectrum source code security audit and penetration testing sweep was conducted across the entire Pulse ecosystem. 

Since the previous audit in early October 2026, substantial security hardening was successfully completed:
- Core Portal endpoints (`key-data.js`, `save-job.js`, `save-table-data.js`, `performance.js`, `budget.js`, `cash.js`) now implement `verifyUserAuthorizedForSheet` with fail-closed checks.
- Formula sanitization (`sanitizeFormulaInput`) and HTML escaping (`escapeHtml` in `MonthView.jsx`) have been integrated into primary data views.
- Strict Content-Security-Policy (CSP) headers and HSTS configurations are active in [next.config.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/next.config.js).
- OTP authentication now enforces IP rate-limiting, CSPRNG code generation, and blocks administrative roles from one-time passcode login.

However, the audit revealed **11 security vulnerabilities** across multi-tenant isolation, token brokering, API access control, open redirects, and control plane scripts that require remediation.

---

## 2. Vulnerability Matrix

| Ref | Vulnerability Description | Severity | CVSS v3.1 | CWE | Target Component |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-26-01** | Cross-Tenant OAuth Token Exfiltration via Shared `INTERNAL_SECRET` | **Critical** | **9.8** | CWE-798 / CWE-287 | [pages/api/integrations/token.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/integrations/token.js), [master-GAS-scripts/XeroConnector.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/XeroConnector.gs) |
| **SEC-26-02** | Broken Object-Level Authorization (BOLA/IDOR) in PMA Workspace Endpoints | **Critical** | **9.1** | CWE-639 / CWE-285 | [pages/api/pma/cash.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/pma/cash.js), [salaries.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/pma/salaries.js), [expenses.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/pma/expenses.js), [nbtofind.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/pma/nbtofind.js), [services/workspaces.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/workspaces.js) |
| **SEC-26-03** | Authorization Bypass via Parameter Omission & Decoupling in Gateway & Setup | **Critical** | **8.8** | CWE-639 / CWE-703 | [pages/api/triage.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/triage.js) (L501, L519), [pages/api/setup/keyinfo.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/setup/keyinfo.js) (L33, L52) |
| **SEC-26-04** | Unauthenticated Cross-Sheet Overwrite in `agent-automater` `doPost` Web App | **High** | **8.6** | CWE-306 / CWE-862 | [agent-automater/TriagePrecompute.gs](file:///c:/Code/pulse-ecosystem/agent-automater/TriagePrecompute.gs#L20-L67) |
| **SEC-26-05** | Static Shared Fallback Secrets Committed in Script Source Code | **High** | **8.2** | CWE-798 / CWE-259 | [master-GAS-scripts/5_Agent_Receiver.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/5_Agent_Receiver.gs#L2736), [agent-automater/TriagePrecompute.gs](file:///c:/Code/pulse-ecosystem/agent-automater/TriagePrecompute.gs#L13-L14), [pages/api/triage.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/triage.js#L291-L300) |
| **SEC-26-06** | Open Redirect via Unvalidated `redirectBack` across All OAuth Connectors | **High** | **7.4** | CWE-601 | [pages/api/integrations/*/callback.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/integrations/xero/callback.js#L278) |
| **SEC-26-07** | Missing Authorization & Information Leak in Integrations Status API | **Medium** | **6.5** | CWE-284 / CWE-200 | [pages/api/integrations/status.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/integrations/status.js#L299-L337) |
| **SEC-26-08** | Missing Tenant Authorization in Bulk Task Creation | **Medium** | **6.3** | CWE-285 | [services/tasksController.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/tasksController.js#L66-L117) |
| **SEC-26-09** | Spreadsheet Formula Injection in Confirmed Job Promotion & Setup Deployment URL | **Medium** | **6.1** | CWE-1236 | [pages/api/portal/confirm-job.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/portal/confirm-job.js#L270), [services/setupService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/setupService.js#L1358) |
| **SEC-26-10** | Fail-Open Secret Comparison in `handleStorePrecomputed` | **Medium** | **5.3** | CWE-703 / CWE-287 | [services/triageEngine.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/triageEngine.js#L1378) |
| **SEC-26-11** | Known Vulnerabilities in Direct and Transitive Node.js Packages | **Medium** | **5.5** | CWE-1035 | [package.json](file:///c:/Code/pulse-ecosystem/pulse-management-system/package.json), [package-lock.json](file:///c:/Code/pulse-ecosystem/pulse-management-system/package-lock.json) |

---

## 3. Deep Dive Vulnerability Findings

### SEC-26-01: Cross-Tenant OAuth Token Exfiltration via Shared `INTERNAL_SECRET`
- **Severity:** Critical (CVSS: 9.8 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:N`)
- **Affected Files:**
  - [pages/api/integrations/token.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/integrations/token.js#L93-L135)
  - [master-GAS-scripts/XeroConnector.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/XeroConnector.gs#L12-L17)
  - [master-GAS-scripts/QuickBooksConnector.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/QuickBooksConnector.gs#L60-L65)
  - [master-GAS-scripts/PipedriveConnector.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/PipedriveConnector.gs#L352-L357)
  - [master-GAS-scripts/MondayConnector.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/MondayConnector.gs#L327-L332)
  - [master-GAS-scripts/HubSpotConnector.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/HubSpotConnector.gs#L360-L365)
  - [master-GAS-scripts/CloseConnector.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/CloseConnector.gs#L319-L324)
  - [master-GAS-scripts/ClickUpConnector.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/ClickUpConnector.gs#L366-L371)
  - [master-GAS-scripts/CapsuleConnector.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/CapsuleConnector.gs#L334-L339)

#### Technical Analysis:
Every client Master Google Sheet contains bound Google Apps Script files with a shared hardcoded static secret:
```javascript
const PULSE_BROKER_CONFIG = {
  DEFAULT_BROKER_URL: "https://app.pulsedashboard.co.uk",
  INTERNAL_SECRET: "pulse-sec-35588181c0c3ed96c191aae2caa23354d3e668173e5e558d"
};
```
In Next.js, `/api/integrations/token` checks:
```javascript
const expectedSecret = process.env.PULSE_INTERNAL_SECRET;
const isSecretValid = Boolean(expectedSecret && providedSecret && providedSecret === expectedSecret);
if (!isSecretValid && !isAdmin) return res.status(401).json(...);

// Accepts any target spreadsheetId or clientKey:
const record = await getIntegrationTokens({ clientKey, masterSheetId: spreadsheetId, tool });
return res.status(200).json({ success: true, accessToken: record.tokens.accessToken, ... });
```
Because the same static secret is embedded into every client's spreadsheet script, **any user with Viewer or Editor access to ANY client Master Sheet has the token broker master key**. An attacker can query `/api/integrations/token?tool=xero&spreadsheetId=<VICTIM_SHEET_ID>` and the server returns the decrypted live OAuth access token and tenant ID for that other tenant.

#### Recommended Remediation:
1. Deprecate static shared bearer secret authentication on `/api/integrations/token`.
2. Implement **mutual per-tenant authentication**:
   - Issue each client master sheet a distinct, high-entropy client secret stored in its private `ScriptProperties` during onboarding (never in source code).
   - Alternatively, sign token requests with a per-tenant HMAC key bound to that specific `spreadsheetId`.
3. Require the Token Broker to verify that the credentials supplied in the request are strictly authorized for the requested `spreadsheetId`.

---

### SEC-26-02: Broken Object-Level Authorization (BOLA/IDOR) in PMA Workspace Endpoints
- **Severity:** Critical (CVSS: 9.1 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N`)
- **Affected Files:**
  - [pages/api/pma/salaries.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/pma/salaries.js#L17-L55)
  - [pages/api/pma/cash.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/pma/cash.js#L17-L55)
  - [pages/api/pma/expenses.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/pma/expenses.js#L18-L55)
  - [pages/api/pma/nbtofind.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/pma/nbtofind.js#L16-L55)
  - [services/workspaces.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/workspaces.js#L345-L450) (`handleGetOutgoingsInbox`, `handleGetInvoicesInbox`, `handleGetAssignedExpenses`)

#### Technical Analysis:
In `pages/api/pma/salaries.js`, `cash.js`, `expenses.js`, and `nbtofind.js`:
```javascript
const isPulseOnly = sessionUser.role === "ClientUser" || ... || (!sessionUser.isAdmin && sessionUser.role !== "ClientManager");
if (isPulseOnly) return res.status(403).json(...);

// Proceeds to fetch data without checking user's assignedClients:
const data = await getSalariesData({ clientName, masterSheetId, clientSheetId });
return res.status(200).json(data);
```
`ClientManager` users are permitted into PMA, but each `ClientManager` is only assigned to a subset of clients (`sessionUser.assignedClients`). None of these routes check `isUserAuthorizedForClient(sessionUser, clientName)` or `verifyUserAuthorizedForSheet()`.
Any `ClientManager` can fetch or mutate payroll, salaries, dividends, outgoings, and bank feeds for any client in the database simply by changing `clientSheetId` or `masterSheetId` in the query or body.

#### Recommended Remediation:
Add universal tenant verification at the top of every PMA endpoint:
```javascript
const resolvedName = await resolveClientNameBySheetId(sheets, clientSheetId || masterSheetId);
const targetClient = clientName || resolvedName;
if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, targetClient)) {
  return res.status(403).json({ success: false, error: "Access denied to this client." });
}
```

---

### SEC-26-03: Authorization Bypass via Parameter Omission & Decoupling in Gateway & Setup
- **Severity:** Critical (CVSS: 8.8 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N`)
- **Affected Files:**
  - [pages/api/triage.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/triage.js#L501-L503) (`get_client_view_data`)
  - [pages/api/triage.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/triage.js#L519-L521) (`get_cashflow_recon_data`)
  - [pages/api/setup/keyinfo.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/setup/keyinfo.js#L33-L35) (GET)
  - [pages/api/setup/keyinfo.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/setup/keyinfo.js#L52-L54) (POST)

#### Technical Analysis:
In `triage.js`:
```javascript
const { clientSheetId, masterSheetId, tab, clientName, bypassCache } = req.body;
if (!sessionUser.isAdmin && clientName && !isUserAuthorizedForClient(sessionUser, clientName)) {
  return res.status(403).json({ success: false, error: "Access denied to this client" });
}
```
And in `setup/keyinfo.js`:
```javascript
if (clientName && !sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, clientName)) {
  return res.status(403).json({ success: false, error: "Access denied to this client." });
}
```
If an attacker sends a request **omitting `clientName`** (e.g. `{ "clientSheetId": "<Victim_Sheet_ID>" }`), `clientName` is `undefined`. The expression `(!sessionUser.isAdmin && clientName && ...)` evaluates to `false`, completely bypassing the permission check (fail-open).
Furthermore, if an attacker supplies `clientName: "MyAllowedClient"` with `clientSheetId: "<Victim_Sheet_ID>"`, the check evaluates to authorized while the operation executes against the victim's spreadsheet.

#### Recommended Remediation:
Never treat `clientName` as optional if access depends on it, and always resolve the sheet ID to verify tenant identity:
```javascript
const verifiedName = await resolveClientNameBySheetId(sheets, clientSheetId || masterSheetId);
if (!verifiedName || (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, verifiedName))) {
  return res.status(403).json({ success: false, error: "Access denied to this spreadsheet." });
}
```

---

### SEC-26-04: Unauthenticated Cross-Sheet Overwrite in `agent-automater` `doPost` Web App
- **Severity:** High (CVSS: 8.6 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:H/A:N`)
- **Affected File:**
  - [agent-automater/TriagePrecompute.gs](file:///c:/Code/pulse-ecosystem/agent-automater/TriagePrecompute.gs#L20-L67)

#### Technical Analysis:
The `doPost` handler in `agent-automater` accepts incoming HTTP requests:
```javascript
function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var action = body.action || "";
  if (action === "refreshOutgoings") {
    var clientSS = SpreadsheetApp.openById(body.clientSheetId);
    var masterSS = SpreadsheetApp.openById(body.masterSheetId);
    ...
    masterOutgoings.getRange(rangeAddress).setNotes(sourceNotes);
  }
}
```
There is **no authentication header check, no secret verification, and no caller identity validation**. Any user who discovers the published Apps Script Web App URL can trigger cross-sheet note cloning and overwrite arbitrary Google Sheets accessible to the service account or publishing account.

#### Recommended Remediation:
Add a mandatory shared secret check to `doPost` in `TriagePrecompute.gs`:
```javascript
var props = PropertiesService.getScriptProperties();
var expectedSecret = props.getProperty("AUTOMATER_WEBHOOK_SECRET");
if (!expectedSecret || body.secret !== expectedSecret) {
  return ContentService.createTextOutput(JSON.stringify({ success: false, error: "Unauthorized" }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

---

### SEC-26-05: Static Shared Fallback Secrets Committed in Script Source Code
- **Severity:** High (CVSS: 8.2 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N`)
- **Affected Files:**
  - [master-GAS-scripts/5_Agent_Receiver.gs](file:///c:/Code/pulse-ecosystem/master-GAS-scripts/5_Agent_Receiver.gs#L2736)
  - [agent-automater/TriagePrecompute.gs](file:///c:/Code/pulse-ecosystem/agent-automater/TriagePrecompute.gs#L13-L14)
  - [pages/api/triage.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/triage.js#L291-L300)

#### Technical Analysis:
Static fallback secrets remain hardcoded in plaintext:
1. `5_Agent_Receiver.gs`:
   ```javascript
   const cronSecret = "triage-cron-2026-AY4K2LDMXBV8DS7";
   const isAuthed = (expectedSecret && payload.secret === expectedSecret) || (payload.secret === cronSecret);
   ```
2. `TriagePrecompute.gs`:
   ```javascript
   cronSecret: "triage-cron-2026-AY4K2LDMXBV8DS7",
   bypassToken: "VvcLAd5uuERBU8HyGJH9PGsMQscNCqqN"
   ```
3. `triage.js`:
   ```javascript
   const validAgentSecrets = [
     process.env.AGENT_TRIGGER_SECRET,
     process.env.CRON_SECRET,
     "triage-cron-2026-AY4K2LDMXBV8DS7",
     "^V0#8pSKx)y9xq}|"
   ];
   const internalSecret = process.env.PULSE_INTERNAL_SECRET || "pulse-sec-35588181c0c3ed96c191aae2caa23354d3e668173e5e558d";
   ```
Anyone with access to the codebase can send `secret: "pulse-sec-35588181c0c3ed96c191aae2caa23354d3e668173e5e558d"` or `"triage-cron-2026-AY4K2LDMXBV8DS7"` to execute agent runs, bypass Vercel protection, or invoke internal API endpoints.

#### Recommended Remediation:
- Remove all fallback secret strings from source code.
- If environment variables (`PULSE_INTERNAL_SECRET`, `CRON_SECRET`, `AGENT_TRIGGER_SECRET`) are missing, fail closed and reject requests.
- Store secrets solely in Vercel Environment Variables and Google Apps Script `ScriptProperties`.

---

### SEC-26-06: Open Redirect via Unvalidated `redirectBack` across All OAuth Connectors
- **Severity:** High (CVSS: 7.4 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N`)
- **Affected Files:**
  - `pages/api/integrations/xero/connect.js` & `callback.js` (L278, L295)
  - `pages/api/integrations/quickbooks/connect.js` & `callback.js` (L182, L188)
  - `pages/api/integrations/pipedrive/connect.js` & `callback.js` (L100, L106)
  - `pages/api/integrations/monday/connect.js` & `callback.js` (L100, L106)
  - `pages/api/integrations/hubspot/connect.js` & `callback.js` (L101, L107)
  - `pages/api/integrations/close/connect.js` & `callback.js` (L100, L106)
  - `pages/api/integrations/clickup/connect.js` & `callback.js` (L100, L106)
  - `pages/api/integrations/capsule/connect.js` & `callback.js` (L100, L106)

#### Technical Analysis:
All OAuth connectors accept a `redirectBack` query/body parameter during connection initiation, pack it into the OAuth `statePayload`, and execute `res.redirect(returnUrl + ...)` in the callback handler.
No verification is performed on `redirectBack`:
```javascript
const returnUrl = statePayload.redirectBack || "/portal";
return res.redirect(`${returnUrl}${separator}${redirectParams.toString()}`);
```
An attacker can distribute a link:
`https://app.pulsedashboard.co.uk/api/integrations/xero/connect?clientKey=advisor&redirectBack=https://evil.com/phish`
Upon OAuth authorization, the user is redirected to `https://evil.com/phish?integration=xero&status=success&tenant=...`, exposing connected organization names and facilitating credential harvesting.

#### Recommended Remediation:
Validate `redirectBack` to strictly enforce local paths or trusted domains:
```javascript
function sanitizeRedirectUrl(url) {
  if (!url || typeof url !== "string") return "/pma";
  const trimmed = url.trim();
  // Must start with single slash and not double slash (protocol-relative)
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/\\")) {
    return trimmed;
  }
  return "/pma";
}
```

---

### SEC-26-07: Missing Authorization & Information Leak in Integrations Status API
- **Severity:** Medium (CVSS: 6.5 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N`)
- **Affected File:**
  - [pages/api/integrations/status.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/integrations/status.js#L299-L337)

#### Technical Analysis:
In `pages/api/integrations/status.js`, the check `const sessionUser = getSessionUser(req)` is only invoked inside `if (all === "true" || all === "1")`.
When called in single-client mode (`GET /api/integrations/status?clientKey=AlphaClient`):
- There is **no session check**.
- There is **no role check**.
The endpoint responds with full third-party connection health, integration tool names, and the entire `sharedXero` structure (including all connected organization names, tenant IDs, and token expiry timestamps).

#### Recommended Remediation:
Move session authentication to the top of `handler()` so all modes require an authenticated user:
```javascript
const sessionUser = getSessionUser(req);
if (!sessionUser) {
  return res.status(401).json({ error: "Active session required." });
}
if (!sessionUser.isAdmin && clientKey && !isUserAuthorizedForClient(sessionUser, clientKey)) {
  return res.status(403).json({ error: "Access denied to this client." });
}
```

---

### SEC-26-08: Missing Tenant Authorization in Bulk Task Creation
- **Severity:** Medium (CVSS: 6.3 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N`)
- **Affected File:**
  - [services/tasksController.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/tasksController.js#L66-L117)

#### Technical Analysis:
In `handleCreateTask`, authorization is strictly checked:
```javascript
if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, alert.clientName)) {
  return res.status(403).json({ success: false, error: "Access denied to this client" });
}
```
However, in `handleBulkCreateTasks`:
```javascript
export async function handleBulkCreateTasks(req, res, sheets) {
  const { alerts: alertsToTask, taskNote, ... } = req.body;
  for (const alert of alertsToTask) {
    // Zero check on alert.clientName!
    createdTaskRows.push(taskRow);
  }
}
```
A non-admin `ClientManager` can bulk create tasks or snooze alerts for clients to which they are not assigned.

#### Recommended Remediation:
Add tenant verification in `handleBulkCreateTasks`:
```javascript
for (const alert of alertsToTask) {
  if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, alert.clientName)) {
    continue; // or reject entire batch
  }
  ...
}
```

---

### SEC-26-09: Spreadsheet Formula Injection in Confirmed Job Promotion & Setup Deployment URL
- **Severity:** Medium (CVSS: 6.1 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:N/A:N`)
- **Affected Files:**
  - [pages/api/portal/confirm-job.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/portal/confirm-job.js#L138, #L270)
  - [pages/api/portal/unconfirm-job.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/portal/unconfirm-job.js#L339)
  - [services/setupService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/setupService.js#L1358)

#### Technical Analysis:
1. In `confirm-job.js`, rows are read from the Pipeline tab using `valueRenderOption: "FORMULA"` (line 138), and then written to the Confirmed tab with `valueInputOption: "USER_ENTERED"` (line 270) without sanitization. If an unprivileged user inputs a formula into Pipeline job notes, promoting the job triggers formula execution in Confirmed.
2. In `services/setupService.js` (`saveDeploymentUrl`), `deploymentUrl` is written to `KeyInfo!X29` and `Clients!W...` using `USER_ENTERED` without verifying URL syntax or neutralizing formula prefixes (`=`, `+`, `-`, `@`).

#### Recommended Remediation:
- Pass all cell values through `sanitizeFormulaInput()` before writing with `USER_ENTERED`.
- In `saveDeploymentUrl`, validate that `deploymentUrl` strictly matches `^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$`.

---

### SEC-26-10: Fail-Open Secret Comparison in `handleStorePrecomputed`
- **Severity:** Medium (CVSS: 5.3 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N`)
- **Affected File:**
  - [services/triageEngine.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/triageEngine.js#L1378)

#### Technical Analysis:
In `triageEngine.js`:
```javascript
export async function handleStorePrecomputed(req, res, sheets) {
  const { secret, ... } = req.body;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorised" });
  }
```
If `process.env.CRON_SECRET` is unset, `secret` (when absent) is `undefined`, and `undefined !== undefined` evaluates to `false`. The endpoint fails open and overwrites precomputed alert memory without authentication.

#### Recommended Remediation:
Enforce existence check before comparison:
```javascript
const expectedCron = process.env.CRON_SECRET?.trim();
if (!expectedCron || secret !== expectedCron) {
  return res.status(401).json({ success: false, error: "Unauthorized" });
}
```

---

### SEC-26-11: Known Vulnerabilities in Direct and Transitive Node.js Packages
- **Severity:** Medium (CVSS: 5.5 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L`)
- **Affected Packages:**
  - `next`: `14.2.35` (Advisories: Request smuggling in rewrites, DoS in image optimization, Windows server path flaws)
  - `xlsx`: `0.18.5` (Prototype pollution and ReDoS)
  - `nodemailer`: `<10.1.4` (Address parser header injection)

#### Recommended Remediation:
- Run `npm audit fix` in [pulse-management-system/](file:///c:/Code/pulse-ecosystem/pulse-management-system) to update non-breaking dependencies (`nodemailer`, `undici`, `source-map-js`).
- Plan migration of `xlsx` to a secure modern parser (e.g. `exceljs` or native Google Sheets API parsing).
- Evaluate upgrading Next.js within the 14.x LTS branch to `14.2.x` latest patched release.

---

## 4. Prioritized Remediation Plan

### Phase 1: Immediate High-Risk Remediations (Day 1 - 2)
1. **Fix BOLA / IDOR in PMA Endpoints (SEC-26-02 & SEC-26-03)**:
   - In `triage.js`, `pages/api/pma/*` (`salaries.js`, `cash.js`, `expenses.js`, `nbtofind.js`), and `setup/keyinfo.js`:
   - Replace loose `if (clientName && ...)` checks with server-side resolution via `resolveClientNameBySheetId(sheets, sheetId)`.
   - Strictly reject any request where `!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, resolvedClientName)`.
2. **Close Open Redirects in OAuth Connectors (SEC-26-06)**:
   - In `pages/api/integrations/*/connect.js` and `callback.js`:
   - Enforce `sanitizeRedirectUrl()` restricting `redirectBack` to local `/pma` or `/pulse` paths.
3. **Secure Integrations Status Route (SEC-26-07)**:
   - Enforce active session and client authorization on `GET /api/integrations/status` across both single-client and all-client modes.
4. **Harden `agent-automater` `doPost` (SEC-26-04)**:
   - Enforce shared secret validation in `TriagePrecompute.gs` before processing any sheet operations.

### Phase 2: Secrets & Cryptographic Hygiene (Day 3 - 5)
5. **Token Broker Mutual Authentication (SEC-26-01)**:
   - Migrate token requests from static shared bearer secret to per-client secrets stored in `ScriptProperties` or HMAC-signed requests.
6. **Eliminate Hardcoded Fallback Secrets (SEC-26-05 & SEC-26-10)**:
   - Remove `"triage-cron-2026-AY4K2LDMXBV8DS7"`, `"^V0#8pSKx)y9xq}|"`, and hardcoded `pulse-sec-...` fallbacks from source code.
   - Enforce fail-closed comparison on `CRON_SECRET` in `triageEngine.js`.
7. **Disarm Formula Injection in Promotion & Setup (SEC-26-09)**:
   - Apply `sanitizeFormulaInput()` in `confirm-job.js`, `unconfirm-job.js`, and `saveDeploymentUrl`.

### Phase 3: Defense-in-Depth & Maintenance (Sprint 2)
8. **Add Tenant Check to `handleBulkCreateTasks` (SEC-26-08)**.
9. **Harden Dev Login (SEC-26-10)**: Ensure `dev-login.js` requires an explicit environment flag `ENABLE_DEV_LOGIN === "true"` and sets `Secure` cookies.
10. **Address Package Vulnerabilities (SEC-26-11)** via `npm audit fix`.

---
*Report generated by Antigravity AI Security Suite.*
