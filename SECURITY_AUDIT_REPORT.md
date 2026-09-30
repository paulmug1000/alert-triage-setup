# Pulse Management System - Security Audit & Remediation Report

**Date:** September 30, 2026  
**Target:** `pulse-management-system/` (Next.js Orchestration & Management Layer)  
**Status:** ✅ **Phase 1 & Phase 2 Remediations Fully Implemented & Verified**

---

## Executive Summary

A comprehensive penetration testing and security architecture audit was performed across the Pulse Management System. Ten critical and high-severity vulnerability classes were identified that exposed tenant data, allowed privilege escalation, permitted unauthorized endpoint execution, or posed formula injection risks.

All vulnerabilities across **Phase 1 (Immediate Critical Fixes)** and **Phase 2 (Architectural Hardening)** have been implemented, tested, and verified with a clean Next.js production build (`next build` exit code 0).

---

## Remediated Vulnerabilities & Architecture Matrix

| Ref | Vulnerability Category | Severity | File(s) Affected | Remediated Status |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | Missing Authentication on Central API Gateway | **Critical** (CVSS 9.8) | [pages/api/triage.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/triage.js) | ✅ Closed |
| **SEC-02** | Inverted Multi-Tenant Isolation Logic | **Critical** (CVSS 9.4) | [services/workspaces.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/workspaces.js), [services/activityService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/activityService.js), [services/alertState.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/alertState.js) | ✅ Closed |
| **SEC-03** | Broken Object-Level Authorization (BOLA/IDOR) | **High** (CVSS 8.5) | [services/tasksController.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/tasksController.js), [services/viewsService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/viewsService.js), [services/importTools.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/importTools.js), [services/cashflowReconService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/cashflowReconService.js) | ✅ Closed |
| **SEC-04** | SSO Popup Token Confusion & Privilege Escalation | **High** (CVSS 8.8) | [services/authService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/authService.js), [pages/api/auth/oauth/google/callback.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/auth/oauth/google/callback.js), [pages/api/auth/oauth/microsoft/callback.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/auth/oauth/microsoft/callback.js), [pages/api/auth/sso-verify.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/auth/sso-verify.js) | ✅ Closed |
| **SEC-05** | OAuth CSRF / State Fixation & Host Header Poisoning | **High** (CVSS 8.1) | [pages/api/auth/oauth/google.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/auth/oauth/google.js), [pages/api/auth/oauth/microsoft.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/auth/oauth/microsoft.js), OAuth Callbacks | ✅ Closed |
| **SEC-06** | Administrative Action Bypass & DoS Vectors | **High** (CVSS 7.7) | [pages/api/triage.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/triage.js) | ✅ Closed |
| **SEC-07** | Spreadsheet Formula Injection (CWE-1236) | **Medium** (CVSS 6.8) | [services/workspaces.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/workspaces.js), [services/viewsService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/viewsService.js), [services/cashflowReconService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/cashflowReconService.js), [services/pmaLogger.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/pmaLogger.js) | ✅ Closed |
| **SEC-08** | Stored HTML Injection in Daily Alerts Digest | **Medium** (CVSS 6.1) | [services/dailyAlertsNotifier.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/dailyAlertsNotifier.js) | ✅ Closed |
| **SEC-09** | Overly Permissive CORS & Insecure Transport Defaults | **Medium** (CVSS 5.9) | [pages/api/triage.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/triage.js), [pages/api/auth/sso-verify.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/auth/sso-verify.js), [services/redisClient.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/redisClient.js), [next.config.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/next.config.js) | ✅ Closed |
| **SEC-10** | Outdated Dependency Vulnerabilities | **Medium** (CVSS 5.3) | [package.json](file:///c:/Code/pulse-ecosystem/pulse-management-system/package.json), [package-lock.json](file:///c:/Code/pulse-ecosystem/pulse-management-system/package-lock.json) | ✅ Closed |

---

## Detailed Remediation Breakdown

### Phase 1: Immediate Critical Fixes

#### 1. Central API Authentication Gateway (`/api/triage`)
- **Problem**: `/api/triage` routes ~80 distinct actions (cashflow, views, job modifications, contractor additions, memory flushes). It previously checked authorization only inside individual sub-actions, leaving dozens of core business endpoints completely open without session verification.
- **Remediation**:
  - Implemented top-level gateway enforcement via `getSessionUser(req)`.
  - Strictly whitelisted public authentication routes (`send_otp`, `verify_otp`, `get_session`, `logout`).
  - Added secret verification (`CRON_SECRET`, `AGENT_TRIGGER_SECRET`) for external orchestrator triggers.
  - All other actions reject unauthenticated calls with HTTP 401.

#### 2. Inverted Multi-Tenant Isolation Logic
- **Problem**: `get_all_workspaces`, `get_activity_log`, and alert state queries checked `if (sessionUser && !sessionUser.isAdmin)` to filter clients, but if `sessionUser` was missing/unauthenticated, the filter was completely bypassed, returning data across **all clients** to anyone.
- **Remediation**:
  - Unauthenticated requests are rejected immediately at the service level with 401.
  - Filter logic strictly grants all clients only if `sessionUser.isAdmin === true` or `sessionUser.assignedClients === "*"`.
  - Non-admin sessions are strictly constrained to `sessionUser.assignedClients`.

#### 3. SSO Popup Token Confusion & Privilege Escalation
- **Problem**: 
  - OAuth popups generated full-privilege session JWTs and transmitted them via `postMessage(..., "*")` with wildcard origin.
  - Non-admin accounts whose `assignedClients` were missing defaulted to `assignedClients = "*"` (all clients / admin access).
  - Session tokens were valid for 90 days.
- **Remediation**:
  - Updated OAuth callbacks to issue tokens tagged `{ tokenType: "sso_token" }` with an expiry of 10 minutes for popup flows.
  - Hardened `getSessionUser()` to strictly reject tokens without `{ tokenType: "session" }` and reduced session lifetime to 7 days.
  - Restricted `postMessage` target origin to verified domains (`https://pma.pulsedashboard.co.uk`, Google script domains, or current host) - never `'*'`.
  - Missing `assignedClients` now defaults strictly to `[]` (zero access), preventing default-admin elevation.

#### 4. OAuth CSRF & Host Header Poisoning
- **Problem**: OAuth initialization did not set or verify cryptographic state nonces, enabling OAuth CSRF/login fixation. Redirect URIs trusted the untrusted `req.headers.host` header.
- **Remediation**:
  - Generated cryptographically random `state` nonces stored in `HttpOnly`, `SameSite=Lax`, `Secure` cookies (`oauth_state_google`, `oauth_state_ms`).
  - Validated state in callback handlers; mismatched states return HTTP 403.
  - Base URLs prioritize `NEXT_PUBLIC_APP_URL` and `VERCEL_PROJECT_PRODUCTION_URL` over untrusted `Host` headers.

---

### Phase 2: Architectural Hardening

#### 5. Broken Object-Level Authorization (BOLA/IDOR)
- **Problem**: Endpoints modifying or reading specific client workspaces (such as tasks controller, update view data, import tools, cash adjustment notes) accepted `clientSheetId` or `clientName` directly from the request body without checking if the authenticated user had permission for that client.
- **Remediation**:
  - Integrated `isUserAuthorizedForClient(sessionUser, clientName)` across:
    - [services/tasksController.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/tasksController.js) (tasks list, toggle, delete, add, sync)
    - [services/viewsService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/viewsService.js) (`get_client_view_data`, `update_cell_data`)
    - [services/importTools.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/importTools.js) (`import_pipeline_jobs`, `import_confirmed_jobs`)
    - [services/cashflowReconService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/cashflowReconService.js) (`get_cashflow_recon_data`, `updateCashAdjustmentNote`)
  - Any attempt to access an unauthorized client returns HTTP 403 Forbidden.

#### 6. Administrative Action Access Control
- **Problem**: Administrative endpoints (`emergency_flush_redis`, `save_claude_settings`, `trigger_proactive_checks`, `save_sweep_frequency`, `trigger_agent_run`, memory maintenance) could be triggered by any authenticated user, regardless of role.
- **Remediation**:
  - Enforced `if (!sessionUser?.isAdmin) return res.status(403).json(...)` across all system maintenance, configuration, and agent trigger endpoints in [pages/api/triage.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/pages/api/triage.js).

#### 7. Spreadsheet Formula Injection (CWE-1236)
- **Problem**: User-supplied values written to Google Sheets with `valueInputOption: "USER_ENTERED"` were not sanitized, allowing formula injection (e.g. `=HYPERLINK()`, `=IMPORTXML()`, `@SUM()`).
- **Remediation**:
  - Created centralized `sanitizeFormulaInput(val)` in [utils/helpers.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/utils/helpers.js) and [services/userPermissions.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/userPermissions.js).
  - Strings starting with formula control characters (`=`, `+`, `-`, `@`) that are not valid finite numbers are prepended with a single quote `'`, preventing Google Sheets from executing them as expressions.
  - Applied sanitization to [services/viewsService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/viewsService.js), [services/workspaces.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/workspaces.js), and [services/cashflowReconService.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/cashflowReconService.js).
  - Switched [services/pmaLogger.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/pmaLogger.js) audit logging to `valueInputOption: "RAW"`.

#### 8. Stored HTML Injection in Daily Alerts Digest
- **Problem**: `dailyAlertsNotifier.js` interpolated alert titles, client names, and user remarks directly into HTML emails without HTML escaping.
- **Remediation**:
  - Implemented `escapeHtml()` utility in [services/dailyAlertsNotifier.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/services/dailyAlertsNotifier.js).
  - All dynamic fields (`userName`, `userEmail`, `clientName`, `alertSummary`, `formattedValue`) are escaped before email assembly.

#### 9. CORS, TLS & Security Headers
- **Problem**:
  - CORS header in `triage.js` and `sso-verify.js` allowed any `.vercel.app` domain (permitting arbitrary Vercel tenants to make cross-origin requests).
  - Redis connection in `redisClient.js` had `tls: { rejectUnauthorized: false }`.
  - Missing standard HTTP security headers (HSTS, X-Frame-Options, Content-Type-Options).
- **Remediation**:
  - Removed wildcard regex from CORS handlers; allowed origins are strictly pinned.
  - Enabled Redis TLS verification by default: `rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false"`.
  - Added enterprise security headers in [next.config.js](file:///c:/Code/pulse-ecosystem/pulse-management-system/next.config.js):
    - `X-Frame-Options: SAMEORIGIN`
    - `X-Content-Type-Options: nosniff`
    - `Referrer-Policy: strict-origin-when-cross-origin`
    - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
    - `Permissions-Policy: camera=(), microphone=(), geolocation=()`

#### 10. Dependency Upgrade & Build Verification
- **Problem**: Next.js 14.1.0 contained known security advisories.
- **Remediation**:
  - Upgraded Next.js to 14.2.35.
  - Replaced deprecated `experimental.isrMemoryCacheSize` with `cacheMaxMemorySize`.
  - Ran clean production build (`next build`) - verified 0 compile errors across all static and dynamic API routes.

---

## Verification & Compatibility Checklist

- [x] **Next.js Production Build**: `npm run build` executed and passed with exit code 0.
- [x] **Client GAS Script Compatibility**: Verified that `/api/auth/sso-verify` continues to validate popup SSO logins as expected by [client-GAS-scripts/Emailauthsystem.gs](file:///c:/Code/pulse-ecosystem/client-GAS-scripts/Emailauthsystem.gs#L563) while preventing SSO tokens from accessing the PMA management backend.
- [x] **Automation & Cron Compatibility**: Verified that `/api/cron` and automation commander webhooks function seamlessly with valid `CRON_SECRET` and `AGENT_TRIGGER_SECRET`.
- [x] **Tenant Scoping**: Verified that unauthenticated requests can no longer leak all tenant workspaces.
