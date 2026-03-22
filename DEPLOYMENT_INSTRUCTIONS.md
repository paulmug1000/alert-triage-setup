# Phase 2 Deployment - Quick Start

## ✅ What's Ready

All code for Phase 2 has been built and tested. Everything is in:
```
/mnt/user-data/outputs/alert-triage-setup/
```

## 📋 Pre-Deployment Checklist (5 minutes)

### 1. Verify Sheet IDs
- [ ] Find your Automation Commander Sheet ID
  - Open your Automation Commander in Google Sheets
  - Copy the ID from the URL: `https://docs.google.com/spreadsheets/d/SHEET_ID/edit`
  - You'll need this when you first run triage

### 2. Create Required Sheets in Automation Commander

Open Automation Commander → Add 3 new sheets:

**Sheet 1: AIKnowledgeBase**
```
Headers (Row 1): Category | Subcategory | Concept | Description | Notes

Add at least these key rules (copy from knowledge base doc):
- INVOICE_MATCHING rules
- EDGE_CASE rules  
- Key patterns from your system

(You can add more later, start with 5-10 important ones)
```

**Sheet 2: TriageLog**
```
Headers (Row 1): Timestamp | Alert Type | Alert ID | Client | Amount | Claude Recommendation | User Action | User Notes

(This will be auto-populated by Phase 2)
```

**Sheet 3: LearningQueue** (for future use)
```
Headers (Row 1): Timestamp | Pattern Type | Pattern Description | Evidence Count | System Suggestion | User Decision | Approved Rule

(For Phase 2B - learning system. Can leave empty for now)
```

### 3. Verify Permissions
- [ ] Service account email has Editor access to Automation Commander
  - Share with: `alert-triage-backend@automation-commander.iam.gserviceaccount.com`
- [ ] Same service account has Editor access to all client master sheets
  - (If not already shared from Phase 1)

### 4. Environment Variables
- [ ] Verify in Vercel that these are set:
  - `REDIS_URL` ✓ (from Phase 1)
  - `ANTHROPIC_API_KEY` ✓ (from Phase 1)
  - `SERVICE_ACCOUNT_*` variables ✓ (from Phase 1)
  
  (All should already be configured from Phase 1 setup)

## 🚀 Deployment (10 minutes)

### Step 1: Update Local Code
```bash
# Copy the updated app to your local machine
# The full app is in: /mnt/user-data/outputs/alert-triage-setup/

# Navigate to your project directory
cd /path/to/your/alert-triage-setup

# Make sure you have the latest files
# (All new files are ready to go)
```

### Step 2: Commit & Push
```bash
# Stage all changes
git add -A

# Commit with descriptive message
git commit -m "Deploy Phase 2: Alert Triage System with Claude integration"

# Push to GitHub (triggers Vercel auto-deploy)
git push origin main
```

### Step 3: Wait for Deployment
- Go to Vercel dashboard
- Watch the deployment progress
- Should take 2-3 minutes
- Check that build succeeds (no errors)

### Step 4: Test the App
- [ ] Open https://project-shj9n.vercel.app
- [ ] Should see menu with 2 options: Interview & Triage
- [ ] Click "Alert Triage"
- [ ] Enter your Automation Commander Sheet ID
- [ ] Click "Start Triage"

## 🔍 First Run Testing (5 minutes)

### What to Expect:
1. **Loading:** System checks discrepancy FLAGS in Automation Commander
2. **Fetching:** Reads all client master sheets and comparison sheets
3. **Analysis:** For each alert found, Claude analyzes it
4. **Presentation:** Shows one alert at a time with Claude's recommendation
5. **Logging:** Every decision gets logged to TriageLog sheet

### If Everything Works:
- [ ] You see "X alerts found" message
- [ ] First alert appears with Claude's analysis
- [ ] Analysis is thoughtful and makes sense
- [ ] Can click Approve/Reject/Investigate/Refine
- [ ] Can see progress bar advancing
- [ ] After all alerts reviewed, completion screen appears
- [ ] TriageLog sheet has new entries

### If Something Breaks:
See "PHASE2_SETUP_GUIDE.md" → "Troubleshooting" section

---

## 📊 What Each Screen Does

### Menu Screen
- Two buttons: Interview Mode & Triage Mode
- Explains what each does
- Shows the workflow

### Triage Screen
Shows one alert at a time with:
- **Alert Details:** What discrepancies were found
- **Key Data:** Client, amount, date
- **Claude's Analysis:**
  - Confidence score (0-100%)
  - Recommendation (AUTO_MATCH, REQUEST_CLARIFICATION, NEW_WORK, DATA_ERROR, INVESTIGATE)
  - Reasoning
  - Suggested action
  - Questions for you
  - Why automation missed this
- **Your Actions:**
  - ✓ Approve (accept Claude's recommendation)
  - ✗ Reject (Claude was wrong)
  - ? Investigate (not sure, mark for review)
  - ✎ Refine (modify and approve)

### Completion Screen
- Shows total alerts reviewed
- Summary of decisions
- Button to return to menu

---

## 📝 Expected Data Flow

```
Your Automation Commander (master sheet)
  ↓
  Contains flags in AutoUpdates:
    - invoice discrepancies: TRUE/FALSE
    - expense discrepancies: TRUE/FALSE
    - crm discrepancies: TRUE/FALSE
  ↓
For each client's master sheet:
  - If flags are TRUE, Phase 2 reads:
    - InvComp (columns S-Y discrepancy flags)
    - DirComp (columns AO-AV discrepancy flags)
    - CRMComp (columns AY-BF & FE-FL discrepancy flags)
  ↓
Collects all alert rows where ANY flag = TRUE
  ↓
Passes each alert to Claude with AIKnowledgeBase
  ↓
Claude analyzes with understanding of your system
  ↓
Shows recommendation to user
  ↓
User approves/rejects/investigates
  ↓
Decision logged to TriageLog sheet
  ↓
Next alert loads
  ↓
Repeat until all done
```

---

## 🎯 Success Looks Like This:

1. App opens to menu ✓
2. Click Triage → Ask for Automation Commander Sheet ID ✓
3. Enter ID → System finds alerts ✓
4. First alert appears with Claude's smart analysis ✓
5. Analysis references your knowledge base ✓
6. Confidence score is reasonable (not always 99% or 40%) ✓
7. Can approve/reject/investigate each alert ✓
8. Progress bar advances ✓
9. All alerts reviewed → Completion screen ✓
10. TriageLog sheet has decision log ✓

---

## ⚠️ Common Issues & Quick Fixes

| Issue | Fix |
|-------|-----|
| "Automation Commander Sheet ID required" | Make sure you paste the full ID (long string of chars) |
| "No alerts found" | Check discrepancy FLAGS in AutoUpdates are TRUE |
| "Permission denied" | Share sheets with service account email |
| "Failed to read AIKnowledgeBase" | Check AIKnowledgeBase sheet exists in Automation Commander |
| "Claude analysis failed" | Check ANTHROPIC_API_KEY in Vercel env vars |
| "Triage keeps loading" | Check Vercel logs for errors |

See PHASE2_SETUP_GUIDE.md for detailed troubleshooting.

---

## 📚 Documentation

Three documents to reference:

1. **PHASE2_BUILD_SUMMARY.md** - What was built (architecture, features, data flow)
2. **PHASE2_SETUP_GUIDE.md** - How to set up & troubleshoot
3. **ALERT_TRIAGE_KNOWLEDGE_BASE.md** - Technical reference (matching rules, edge cases, Claude's role)

---

## Next Steps After Deployment

### Immediate (This week)
- [ ] Deploy Phase 2
- [ ] Test with one client's alerts
- [ ] Review TriageLog sheet
- [ ] Verify Claude's analysis quality
- [ ] Adjust AIKnowledgeBase if needed

### Short-term (Next week)
- [ ] Run triage on all weekly alerts
- [ ] Collect feedback on Claude's recommendations
- [ ] Add any missing rules to AIKnowledgeBase
- [ ] Plan Phase 2B (Learning system)

### Phase 2B (2-3 weeks out)
- Build Researcher Claude
- Friday evening: Analyze week's decisions
- Suggest new rules
- Interactive approval UI
- Auto-update AIKnowledgeBase

### Phase 2C (4+ weeks out)
- Auto-implement approved rules
- Track confidence improvements
- Build learning dashboard
- Full closed-loop learning

---

## Questions Before Deployment?

Check:
1. PHASE2_BUILD_SUMMARY.md - Comprehensive overview
2. PHASE2_SETUP_GUIDE.md - Detailed setup & troubleshooting
3. ALERT_TRIAGE_KNOWLEDGE_BASE.md - Technical details

---

## Ready?

When you're ready to deploy:

```bash
cd /path/to/your/alert-triage-setup
git add -A
git commit -m "Deploy Phase 2: Alert Triage System"
git push origin main
```

Then check Vercel for deployment status.

**Good luck! 🚀**
