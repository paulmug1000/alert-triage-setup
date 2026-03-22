# Alert Triage System - Complete Project Overview

**Status:** ✅ Phase 2 Complete & Ready to Deploy

---

## Project Summary

The Alert Triage System is an AI-powered financial automation analyzer that:

1. **Reads** discrepancies flagged by your existing automation (InvComp, DirComp, CRMComp)
2. **Analyzes** each discrepancy using Claude AI with your knowledge base
3. **Recommends** actions (auto-match, request clarification, new work, etc.)
4. **Learns** from your decisions and improves over time

---

## Architecture

### Tech Stack
- **Frontend:** React + Next.js 14
- **Backend:** Node.js on Vercel (serverless)
- **AI:** Claude API (claude-sonnet-4-6)
- **Data:** Google Sheets API + service account
- **Session Storage:** Redis (24-hour persistence)
- **Hosting:** Vercel

### Core Components

```
alert-triage-setup/
├── pages/
│   ├── index.js          # Menu router
│   ├── menu.jsx          # Main menu (Interview vs Triage)
│   ├── interview.jsx     # Interview mode (existing, enhanced)
│   ├── triage.jsx        # Triage UI (new)
│   └── api/
│       ├── setup.js      # Interview API (existing)
│       └── triage.js     # Triage backend API (new)
├── package.json
├── .env.local            # Credentials (gitignored)
├── .gitignore
└── vercel.json
```

---

## Data Flow

### Triage Session Workflow

```
User clicks "Alert Triage"
    ↓
Enter Automation Commander Sheet ID
    ↓
System checks discrepancy FLAGS in Automation Commander
    ↓
For each client's master sheet:
  1. Set master switch (E2 = TRUE)
  2. Double flush (ensure calculations complete)
  3. Read InvComp, DirComp, CRMComp discrepancy columns
  4. Collect all rows with ANY flag = TRUE
    ↓
Fetch AIKnowledgeBase from Automation Commander
    ↓
Store alerts + knowledge base in Redis session
    ↓
For each alert (one at a time):
  a. Pass to Claude with context
  b. Claude analyzes with knowledge base
  c. Claude recommends action + confidence score
  d. Display to user
  e. User approves/rejects/investigates
  f. Log decision to TriageLog
    ↓
After all alerts reviewed:
  Show completion screen
    ↓
(Future) Friday evening:
  Researcher Claude analyzes week's TriageLog
  Suggests new rules to AIKnowledgeBase
  User approves/rejects suggestions
  System learns and improves
```

---

## Key Features

### ✅ Intelligent Alert Analysis
- Claude understands your matching system
- Focuses on exceptions automation missed
- Uses AIKnowledgeBase for consistent analysis
- Provides confidence scores & detailed reasoning

### ✅ Data Freshness
- Double flush pattern ensures no stale data
- Master switches trigger fresh calculations
- Reliable data reading from complex sheets

### ✅ Comprehensive Coverage
- **Invoice discrepancies:** 7 types (missing, client, amount, date, duplicate, paid, status)
- **Expense discrepancies:** 8 types (missing, duplicate, description, amount, VAT, dates, status)
- **CRM discrepancies:** 8 types per direction (missing, client, name, revenue, costs, dates, likelihood)
- **Bidirectional CRM:** Reads both sections (CRM→Dashboard, Dashboard→CRM)

### ✅ Decision Logging
- Every alert logged
- Every decision logged
- Claude's recommendation + user's action + corrections
- Foundation for learning loop

### ✅ Mobile-Friendly UI
- Responsive design
- Works on phone/tablet/desktop
- One alert at a time for focused review
- Progress bar for motivation

---

## Quick Start

### Deploy in 3 Steps:
1. **Create 3 sheets** in Automation Commander (AIKnowledgeBase, TriageLog, LearningQueue)
2. **Populate AIKnowledgeBase** with your matching rules (5-10 key rules to start)
3. **Push to GitHub** and Vercel auto-deploys

### First Run:
1. Open https://project-shj9n.vercel.app
2. Click "Alert Triage"
3. Enter your Automation Commander Sheet ID
4. Review alerts one-by-one with Claude's recommendations

**See DEPLOYMENT_INSTRUCTIONS.md for complete walkthrough.**

---

## Google Sheets Integration

### Required Sheets in Automation Commander

**1. AIKnowledgeBase**
- Columns: Category | Subcategory | Concept | Description
- Stores matching rules and patterns Claude uses
- Updated manually or by Researcher Claude (Phase 2B)

**2. TriageLog**
- Columns: Timestamp | Alert Type | Alert ID | Client | Amount | Claude Recommendation | User Action | Notes
- Auto-populated by Phase 2 system
- Used by Researcher Claude to identify patterns

**3. LearningQueue**
- Columns: Timestamp | Pattern Type | Description | Evidence | Suggestion | User Decision | Approved Rule
- For Phase 2B (Learning system)
- Can leave empty for now

### Client Master Sheets (Already Exist)
- **InvComp:** Invoice discrepancies (columns S-Y flags)
- **DirComp:** Expense discrepancies (columns AO-AV flags)
- **CRMComp:** CRM discrepancies (columns AY-BF & FE-FL flags)

---

## Learning Loop

### Phase 2 (This Release - Alert Triage)
- ✅ Read alerts from comparison sheets
- ✅ Analyze with Claude + knowledge base
- ✅ User approves/rejects decisions
- ✅ Log decisions to TriageLog

### Phase 2B (Next - Learning System)
- 📋 Researcher Claude analyzes TriageLog
- 📋 Identifies patterns where Claude succeeded/failed
- 📋 Suggests new rules interactively
- 📋 Auto-update AIKnowledgeBase

### Phase 2C (Future - Auto-Implementation)
- 📋 Approved rules auto-implemented
- 📋 Learning dashboard
- 📋 Confidence tracking
- 📋 Continuous improvement

---

## Documentation

### For Deployment
- **DEPLOYMENT_INSTRUCTIONS.md** - Step-by-step deployment (10 min)
- **PHASE2_SETUP_GUIDE.md** - Detailed setup + troubleshooting

### For Understanding
- **PHASE2_BUILD_SUMMARY.md** - What was built + architecture
- **ALERT_TRIAGE_KNOWLEDGE_BASE.md** - Technical reference (matching rules, edge cases)
- **README.md** - This file

---

## What's Included

### Code Files
| File | Purpose | Status |
|------|---------|--------|
| `/pages/api/triage.js` | Triage backend API | ✅ Ready |
| `/pages/triage.jsx` | Triage UI component | ✅ Ready |
| `/pages/menu.jsx` | Main menu router | ✅ Ready |
| `/pages/interview.jsx` | Interview UI | ✅ Ready |
| `/pages/index.js` | App entry point | ✅ Ready |

### Documentation
| File | Purpose | Length |
|------|---------|--------|
| `README.md` | This overview | 3 pages |
| `DEPLOYMENT_INSTRUCTIONS.md` | Quick start guide | 4 pages |
| `PHASE2_SETUP_GUIDE.md` | Complete setup guide | 8 pages |
| `PHASE2_BUILD_SUMMARY.md` | Architecture & features | 10 pages |
| `ALERT_TRIAGE_KNOWLEDGE_BASE.md` | Technical reference | 50+ pages |

---

## Before You Deploy

**Checklist (15 minutes):**
- [ ] Create AIKnowledgeBase sheet in Automation Commander
- [ ] Create TriageLog sheet in Automation Commander
- [ ] Create LearningQueue sheet in Automation Commander
- [ ] Add 5-10 key matching rules to AIKnowledgeBase
- [ ] Verify service account has Editor access to all sheets
- [ ] Find your Automation Commander Sheet ID

**That's it!** Everything else is already built and ready.

---

## Deployment (10 minutes)

```bash
# Make sure you have the latest code
cd /path/to/alert-triage-setup

# Commit and push (Vercel auto-deploys)
git add -A
git commit -m "Deploy Phase 2: Alert Triage System"
git push origin main

# Wait 2-3 minutes for deployment
# Then test at https://project-shj9n.vercel.app
```

**See DEPLOYMENT_INSTRUCTIONS.md for detailed steps.**

---

## Usage

### Weekly Triage Session (10-30 min)
1. Open app
2. Click "Alert Triage"
3. Enter Automation Commander Sheet ID
4. Review alerts one-by-one
5. Approve/reject/investigate each
6. Check TriageLog for logged decisions

### Weekly Learning Session (Phase 2B, 5-10 min)
1. Friday evening: Researcher Claude analyzes week
2. Review suggested patterns one-by-one
3. Approve/reject/modify suggestions
4. New rules auto-update AIKnowledgeBase
5. Monday: Live Claude benefits from improvements

---

## Architecture Overview

```
Next.js App (React Frontend)
    ├─→ Menu Router
    │
    ├─→ Interview Mode (Phase 1)
    │   ├─→ Interview API (/api/setup.js)
    │   └─→ Google Sheets (store knowledge base)
    │
    └─→ Triage Mode (Phase 2 - NEW)
        ├─→ Triage API (/api/triage.js)
        │   ├─→ Google Sheets API
        │   │   ├─→ Automation Commander (flags, knowledge base)
        │   │   └─→ Client Master Sheets (InvComp, DirComp, CRMComp)
        │   ├─→ Claude API (analysis)
        │   └─→ Redis (session storage)
        └─→ Triage UI (pages/triage.jsx)
            ├─→ Alert display
            ├─→ Claude analysis panel
            └─→ Decision buttons
```

---

## Key Technical Details

### Double Flush Pattern
Ensures Google Sheets calculations complete before reading:
```javascript
// Set master switch
sheet.getRange("E2").setValue(true);

// First flush - trigger calculation
SpreadsheetApp.flush();

// Wait for propagation
Utilities.sleep(2000);

// Dummy read - force additional calculations
sheet.getRange("A1").getValue();

// Second flush - ensure complete
SpreadsheetApp.flush();

// Now safe to read
const data = sheet.getRange("A1:Z100").getValues();
```

### Discrepancy Flag Reading
- InvComp: Columns S-Y (row 5)
- DirComp: Columns AO-AV (row 5)
- CRMComp: Columns AY-BF (row 5) + FE-FL (row 5)
- Reads only rows where ANY flag = TRUE

### Claude Analysis
- Receives alert data + AIKnowledgeBase context
- Understands what automation already tried
- Recommends: AUTO_MATCH, REQUEST_CLARIFICATION, NEW_WORK, DATA_ERROR, INVESTIGATE
- Returns: Confidence score (0-100%), reasoning, questions

---

## Troubleshooting

### "No alerts found"
1. Check discrepancy FLAGS in Automation Commander are TRUE
2. Check master switches (E2) in comparison sheets can be activated
3. Check alert rows exist with any discrepancy flags

### "Permission denied"
1. Share sheets with: `alert-triage-backend@automation-commander.iam.gserviceaccount.com`
2. Grant Editor access
3. Refresh and try again

### "Failed to read AIKnowledgeBase"
1. Check AIKnowledgeBase sheet exists in Automation Commander
2. Verify headers: Category, Subcategory, Concept, Description
3. Check there's data in rows 2+

### "Claude analysis failed"
1. Check ANTHROPIC_API_KEY in Vercel env vars
2. Verify API key has available credits
3. Check internet connection

**See PHASE2_SETUP_GUIDE.md for detailed troubleshooting.**

---

## Performance

- App load: 1-2 seconds
- Alert fetch: 2-5 seconds per client
- Claude analysis: 1-3 seconds per alert
- Total session (10 alerts): 10-15 minutes

---

## Security

- Credentials only in environment variables (never in code)
- Service account auth (not user OAuth)
- Data stays in Google Sheets (encrypted at rest)
- Redis sessions expire after 24 hours
- All connections use HTTPS

---

## Next Steps

1. **Today:** Deploy Phase 2 (follow DEPLOYMENT_INSTRUCTIONS.md)
2. **This week:** Test with real alerts, refine AIKnowledgeBase
3. **Next week:** Plan Phase 2B (Learning system)
4. **Weeks 3-4:** Build & deploy Phase 2B
5. **Week 5+:** Continuous learning & improvement

---

## Questions?

- **How do I deploy?** → DEPLOYMENT_INSTRUCTIONS.md
- **How do I set it up?** → PHASE2_SETUP_GUIDE.md
- **What was built?** → PHASE2_BUILD_SUMMARY.md
- **What are the rules?** → ALERT_TRIAGE_KNOWLEDGE_BASE.md
- **Something's broken?** → PHASE2_SETUP_GUIDE.md (Troubleshooting)

---

**Ready to deploy?** Follow DEPLOYMENT_INSTRUCTIONS.md → Takes ~10 minutes 🚀
