# Phase 2 Triage System - Setup Guide

## Overview

Phase 2 adds an alert triage system to your existing app. It reads discrepancies flagged by your automation, analyzes them with Claude, and learns from your decisions.

## Step 1: Create Required Sheets in Automation Commander

You need to add three new sheets to your Automation Commander master sheet:

### 1. AIKnowledgeBase Sheet
```
Columns: A, B, C, D, E
- A: Category
- B: Subcategory
- C: Concept
- D: Description
- E: Notes (optional)

Row 1: Headers
Row 2+: Knowledge entries (populated from interview or manually)

Examples:
- Category: INVOICE_MATCHING
  Subcategory: Client
  Concept: Exact Match
  Description: Client names must match exactly (case-insensitive, trimmed)

- Category: EDGE_CASE
  Subcategory: Retainer
  Concept: Mode Transition
  Description: When 2nd invoice added to retainer with 1 invoice, move parent invoice to child row 1
```

### 2. TriageLog Sheet
```
Columns: A, B, C, D, E, F, G, H
- A: Timestamp
- B: Alert Type
- C: Alert ID
- D: Client
- E: Amount
- F: Claude's Recommendation (JSON)
- G: User Action (approve|reject|investigate|refine)
- H: User Correction/Notes

Row 1: Headers
Row 2+: Decision log entries (auto-populated by Phase 2)
```

### 3. LearningQueue Sheet (for future learning feature)
```
Columns: A, B, C, D, E, F, G
- A: Timestamp
- B: Pattern Type
- C: Pattern Description
- D: Evidence Count
- E: System Suggestion
- F: User Decision (approved|rejected|modified)
- G: Approved Rule (if accepted)

Row 1: Headers
Row 2+: Filled by Researcher Claude on Fridays
```

## Step 2: Populate AIKnowledgeBase Sheet

You can either:

**Option A: Manual Entry (Fastest)**
1. Copy the knowledge base from Part 1-12 of ALERT_TRIAGE_KNOWLEDGE_BASE.md
2. Manually enter key concepts into AIKnowledgeBase sheet
3. Start with 5-10 most important rules

**Option B: Automated Entry (Requires Apps Script)**
Write an Apps Script function to parse the markdown and populate the sheet:
```javascript
function populateKnowledgeBase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("AIKnowledgeBase");
  
  // Add headers
  sheet.getRange("A1:E1").setValues([
    ["Category", "Subcategory", "Concept", "Description", "Notes"]
  ]);
  
  // Add key rules from knowledge base
  const data = [
    ["INVOICE_MATCHING", "Client", "Exact Match", "Client names must match exactly (case-insensitive, trimmed)", ""],
    ["INVOICE_MATCHING", "Client", "Substring Match", "If both > 3 chars, check if either is substring", ""],
    ["INVOICE_MATCHING", "Amount", "Tolerance - Same Currency", "Match within 5 pennies", ""],
    ["INVOICE_MATCHING", "Amount", "Tolerance - Foreign Currency", "Match within 10%", ""],
    // ... add more rows
  ];
  
  sheet.getRange(2, 1, data.length, 5).setValues(data);
}
```

## Step 3: Update Discrepancy Flag Locations (CRITICAL)

In your Automation Commander **AutoUpdates tab**, find where the discrepancy flags are stored:

The Phase 2 system expects them in columns BN, BO, BP (row 2):
- BN2: invoice discrepancies FLAG
- BO2: expense discrepancies FLAG  
- BP2: crm discrepancies FLAG

**If your flags are in different locations**, you'll need to update the `getDiscrepancyFlags()` function in `/pages/api/triage.js`:

```javascript
// CURRENT (assumes BN, BO, BP):
const response = await sheets.spreadsheets.values.get({
  spreadsheetId: automationCommanderSheetId,
  range: "AutoUpdates!BN2:BP2",
});

// CHANGE TO YOUR ACTUAL LOCATIONS:
const response = await sheets.spreadsheets.values.get({
  spreadsheetId: automationCommanderSheetId,
  range: "AutoUpdates!XX2:ZZ2", // Update XX:ZZ to your actual columns
});
```

## Step 4: Update Service Account Permissions

Make sure your service account has edit access to:
- Automation Commander sheet (to read flags and knowledge base)
- Each client's master sheet (to read InvComp, DirComp, CRMComp and write TriageLog)

If you see permission errors when running Phase 2, share these sheets with:
```
alert-triage-backend@automation-commander.iam.gserviceaccount.com
```

As **Editor** role.

## Step 5: Configure Environment Variables

In your Vercel project, ensure these environment variables are set (they should be from Phase 1):

```
REDIS_URL=redis://...
ANTHROPIC_API_KEY=sk-ant-...
SERVICE_ACCOUNT_PROJECT_ID=automation-commander
SERVICE_ACCOUNT_PRIVATE_KEY_ID=...
SERVICE_ACCOUNT_PRIVATE_KEY=...
SERVICE_ACCOUNT_EMAIL=alert-triage-backend@automation-commander.iam.gserviceaccount.com
SERVICE_ACCOUNT_CLIENT_ID=...
```

## Step 6: Deploy Phase 2

1. Download the updated app code from `/mnt/user-data/outputs/alert-triage-setup/`
2. Replace your local copy
3. Commit: `git add -A && git commit -m "Add Phase 2: Alert Triage System"`
4. Push: `git push`
5. Vercel will auto-deploy

## Step 7: First Run

1. Open your app at https://project-shj9n.vercel.app
2. Click "Alert Triage"
3. Enter your **Automation Commander Sheet ID**
4. Click "Start Triage"
5. System will:
   - Check discrepancy flags in Automation Commander
   - Read InvComp, DirComp, CRMComp from each client's master sheet
   - Apply double flush to ensure fresh data
   - Present alerts one-by-one for review

## Troubleshooting

### "No alerts found"
- Check that discrepancy FLAGS in Automation Commander are TRUE
- Check that comparison sheets (InvComp, DirComp, CRMComp) have master switches (E2) set to allow activation
- Verify that alert rows exist in these sheets

### "Permission denied" errors
- Share sheets with service account email (alert-triage-backend@automation-commander.iam.gserviceaccount.com)
- Make sure service account has **Editor** access

### "Failed to read AIKnowledgeBase"
- Check that AIKnowledgeBase sheet exists in Automation Commander
- Verify column headers are correct (A=Category, B=Subcategory, C=Concept, D=Description)

### "Claude analysis failed"
- Check ANTHROPIC_API_KEY is valid and has available credits
- Check that the API key hasn't expired

## Next Steps

After Phase 2 is working:

1. **Build Phase 2B (Weekly Learning):**
   - Researcher Claude analyzes TriageLog
   - Generates pattern suggestions
   - You approve/reject/refine interactively

2. **Build Phase 2C (Auto-Implementation):**
   - Approved rules auto-update AIKnowledgeBase
   - Next run's Claude benefits from new rules

3. **Monitor & Refine:**
   - Weekly: Review TriageLog for patterns
   - Monthly: Update AIKnowledgeBase with new rules
   - Track: How often Claude's recommendations are correct

## Architecture Summary

```
User opens app
    ↓
Clicks "Alert Triage"
    ↓
App reads Automation Commander (discrepancy FLAGS)
    ↓
For each client's master sheet:
  1. Activate master switch (E2)
  2. Double flush (wait + dummy read + flush)
  3. Read InvComp, DirComp, CRMComp discrepancy columns
    ↓
Collect all flagged alert rows
    ↓
For each alert:
  1. Pass to Claude with AIKnowledgeBase context
  2. Claude analyzes and recommends action
  3. Show user (Approve/Reject/Investigate/Refine)
    ↓
Log decision to TriageLog
    ↓
Friday: Researcher Claude analyzes week's decisions
    ↓
Suggest new rules → You approve → AIKnowledgeBase updated
    ↓
Next week: Live Claude benefits from new rules
```

## Files Added/Modified

### New Files
- `/pages/api/triage.js` - Backend API for triage
- `/pages/triage.jsx` - Triage UI
- `/pages/menu.jsx` - Main menu
- `/pages/interview.jsx` - Interview UI (copied from index.js)

### Modified Files
- `/pages/index.js` - Now points to menu

### No Changes Needed
- `/pages/api/setup.js` - Interview API stays same
- Existing interview functionality unchanged
- Interview and Triage share the same app

---

**Need help?** Check the ALERT_TRIAGE_KNOWLEDGE_BASE.md for detailed technical information.
