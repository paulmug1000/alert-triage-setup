# Alert Triage System - Comprehensive Knowledge Base

**Created:** March 21, 2026  
**System Version:** Automation Commander v3.8+  
**Purpose:** Detailed technical specification for Claude AI to analyze and resolve automation alerts

---

## EXECUTIVE SUMMARY

This system automatically syncs financial data (invoices, expenses, CRM entries) from multiple accounting and CRM tools into Google Sheets, then attempts to match them against planned jobs. When matches fail, alerts are generated for manual review.

The triage system's job is to analyze these alerts and suggest whether they represent:
- **Legitimate mismatches** that need manual intervention
- **Close-enough matches** that can be auto-approved
- **Data entry errors** that can be corrected
- **System configuration issues** that need fixing

---

## PART 1: DATA ARCHITECTURE

### Data Sources & Normalization

The system pulls data from multiple tools and normalizes everything into Google Sheets:

**Accounting Tools:**
- **Xero**: Invoice data via API, paginated fetch, sorted by date DESC
- **QuickBooks**: Similar invoice and expense data via API

**CRM Tools:**
- Pipedrive, ClickUp, Capsule, Close, Monday.com - all via APIs

**Data Integration:**
All raw data is fetched into intermediate sheets (`InvFromApp`, `ExpFromApp`, etc.) then normalized and moved to comparison sheets (`InvComp`, `DirComp`, `CRMComp`).

### Three Core Comparison Sheets

#### 1. **InvComp** (Invoice Comparison - Master Sheet)
Contains invoices fetched from accounting tools that haven't been matched yet.

**Key Columns:**
- `Invoice no` - Unique invoice reference from accounting tool
- `Client` - Client name (normalized)
- `Job` - Job name (if captured in accounting tool)
- `Total excl VAT` - Invoice amount
- `Sent date` - When invoice was issued
- `Fully paid on` - Payment date
- `Status` - DRAFT, APPROVED, PAID, etc.
- `Missing invoice?` - Flag column (TRUE when no match found)
- `Currency` - Currency code

**Critical Columns for Matching:**
- `Months` (cell A2) - Tolerance in months for date matching
- Push flag - Whether to push resolved invoice back to client sheet

---

#### 2. **CRMComp** (CRM Comparison - Master Sheet)
Contains job data from CRM tools that haven't been matched to planned work.

**Key Columns:**
- `Project code` - Unique job ID from CRM
- `Client` - Client name
- `Job name` - Job/deal name
- `Revenue` - Expected revenue amount
- `Start date` - Job start date
- `End date` - Job end date
- `Copied to confirmed tab?` - Whether it was copied to Confirmed tab

**Alert Triggers:**
- Job in CRM but not in Confirmed Pipeline
- Revenue mismatch between CRM and planned revenue

---

#### 3. **DirComp** (Direct/Expense Comparison - Master Sheet)
Contains expenses from accounting tools that haven't been matched.

**Key Columns:**
- `Expense ref` - Reference from accounting tool
- `Client` - Client name
- `Vendor` - Vendor/supplier name
- `Amount` - Expense amount
- `Date` - Expense date
- `Category` - Expense category
- `Status` - DRAFT, APPROVED, PAID
- `Unrecon gaps?` - Flag for unmatched expenses

---

### Target Matching Sheets (Client Sheet)

#### 1. **Confirmed Tab**
Contains all planned invoices, jobs, and expenses that the business is tracking.

**Structure:**
```
Row 1: Headers
Row 2+: Planned jobs/invoices, one job per row

Key Columns:
- Client (exact match required first)
- Job name (for context)
- Project / retainer (type indicator)
- Start date / End date (job date range)
- Revenue (Proj total / Ongoing pm) (excl VAT) - Total planned revenue
- Inv 1 ref, Inv 2 ref, Inv 3 ref - Invoice reference slots (empty = unmatched)
- Project invoice 1 / monthly retainer (excl VAT) - Planned amount for slot 1
- Project invoice 2 (excl VAT) - Planned amount for slot 2
- Project invoice 3 (excl VAT) - Planned amount for slot 3
- Inv 1 SEND date / Inv 2 SEND date / Inv 3 SEND date - Expected send dates
- (Optional) Job name for child rows (retainer invoices create child rows)
```

**Important:** Project jobs can have up to 3 invoice slots. Retainer jobs can have unlimited child rows.

#### 2. **Pipeline Tab**
Forward-looking job opportunities not yet confirmed.

**Structure:** Similar to Confirmed tab, contains prospective jobs waiting for confirmation.

#### 3. **Outgoings Tab**
Planned and actual expenses, organized by category and month.

**Structure:**
```
Columns: Dates (monthly) across the top
Rows: Expense categories
Cells: Amounts for each category by month
Notes: App ID embedded in cell notes {App ID: ...} to track which expense was reconciled
```

---

## PART 2: MATCHING LOGIC

### INVOICE MATCHING PIPELINE

**Step 1: Extract Invoice Data from InvComp**
- Fetch: Invoice number, Client name, Amount (excl VAT), Sent date, Currency

**Step 2: Client Matching (Required)**
Invoices are ONLY matched within the same client. Client matching uses:
1. Exact match (case-insensitive, trimmed)
2. Substring match (if both > 3 chars, either is substring of other)

```javascript
// Pseudo-code
targetClient = "ABC Ltd"
sourceClient = "ABC"
// Substring match: "ABC" is in "ABC Ltd" → MATCH

sourceClient = "ABC Ltd"
targetClient = "ABC Ltd"
// Exact match → MATCH
```

**Step 3: Duplicate Guard**
Before fuzzy matching, check if invoice number already exists in Confirmed:
- Loop through Inv 1 ref, Inv 2 ref, Inv 3 ref
- If invoice number found → Skip this invoice (already matched)

**Step 4a: EXACT MATCH (High Confidence)**
Look for planned jobs where:
1. Client matches (required)
2. Invoice amount = Planned amount (same slot)
3. Slot is EMPTY (ref field is empty or 0)
4. Date is within tolerance of planned send date

```
Invoice: ABC Ltd, £2,000, 15-Mar-2024
Planned: ABC Ltd, Job A, Slot 1 = £2,000, Planned date = 15-Mar-2024
Result: EXACT MATCH → Fill Inv 1 ref with invoice number
```

**Step 4b: FUZZY MATCH (With Tolerance)**
If no exact match found, use `findSlotWithTolerance()`:

**Pass 1 - Check All Planned Slots:**

For each job with matching client:

1. **Check if slot has existing amount:**
   - Amount tolerance: 5 pennies for same currency, 10% for foreign currency
   - Date tolerance: ±X months (from cell A2 of InvComp)
   - Can skip MANUAL-INV entries

2. **If no amount in slot, check job's empty slot:**
   - Look for first empty slot in job
   - For projects: Match against total job revenue OR remaining revenue (if split)
   - Handle child rows: Look up parent row for revenue if child row has none
   - Capacity check: Can't exceed total job revenue

3. **Return: Row, Slot (1-3), Match Type**

**Pass 2 - Split Matches (If Enabled):**
If Pass 1 fails and split matching is enabled:
- Look for jobs where invoice = 50% of revenue → Half match
- Look for jobs where invoice = 33% of revenue → Third match
- Schedule future invoices for slots 2 and 3

**Match Result States:**
- `matchType: 'Existing'` - Invoice number already exists
- `matchType: 'Full'` - Matches planned amount exactly
- `matchType: 'Half'` - Matches 50% of revenue (split match)
- `matchType: 'Third'` - Matches 33% of revenue (split match)
- `null` - No match found → Alert generated

---

### EXPENSE MATCHING PIPELINE

**Step 1: Extract from DirComp/QuickBooks**
- Expense ref, Client, Vendor/Description, Amount, Date, Category

**Step 2: Target Location**
Expenses can go to either:
- **Confirmed tab** - Direct job expenses
- **Outgoings tab** - P&L category expenses

**Step 3: Find Outgoings Match** (for Outgoings tab)

```javascript
findOutgoingsMatch_(data, headers, notes, appData, tolerance, searchStart, searchEnd, mode)
```

Logic:
1. Find columns with dates within tolerance of expense date (±X months)
2. Match by description: Fuzzy match between app description and row description
3. Amount match: Exact match (within 5 pennies) OR empty slot (if mode = "create")
4. Check notes: Can't overwrite occupied cells or manual entries

**Step 4: Find Confirmed Match** (for Confirmed tab)

Similar logic but matches against job expenses:
- Find job with matching client
- Match expense amount against planned expense
- Check date tolerance

---

### CRM MATCHING PIPELINE

**Step 1: Extract from CRMComp**
- Project code (CRM job ID), Client, Job name, Revenue, Start/End dates
- CRMComp has a Pipeline/Confirmed mode toggle (top-left)

**Step 2: Determine Target Sheet**
The CRMComp sheet has a toggle that determines which sheet CRM jobs are matched against:
- **CONFIRMED mode**: All CRM jobs are compared only to the Confirmed tab
- **PIPELINE mode**: All CRM jobs are compared only to the Pipeline tab

This mode controls where Claude should look for matches.

**Step 3: Client Matching**
Must match client name (same rules as invoices)

**Step 4: Find Matching Job**
Look for job in the target sheet (either Confirmed or Pipeline, based on mode toggle) where:
- Client matches
- Job name matches (or similar)
- Revenue similar (within tolerance)
- Date overlaps

**Step 5: Report Status**
- **If match found** in target sheet: Job is already tracked
- **If no match found** in target sheet: CRM job is not in the planned pipeline/confirmed work

**Inter-sheet transitions:**
The only time CRM matching relates to both sheets:
- If a Pipeline job reaches 100% likelihood and gets copied to Confirmed, it gets tracked in both
- If a job in Confirmed drops below 100% likelihood, it may be removed from Confirmed (back to Pipeline)

---

## PART 3A: FLAGS vs ALERTS (Critical Distinction)

**Important:** Do not confuse the automation system's "flags" with the "alerts" Claude will analyze.

### Flags (in Automation Commander Sheet)
"Flags" are metadata in the Automation Commander master sheet that track system status:
- Located in the **AutoUpdates** tab of Automation Commander
- Examples: Data has changed, run has completed, permissions updated
- These are internal system signals, not items for manual review
- They control whether/how the automation runs

### Alerts (in Comparison Sheets - What Claude Analyzes)
"Alerts" are unmatched items that have been flagged in InvComp, DirComp, or CRMComp:
- Located in comparison sheets on the MASTER sheet for each client
- Examples: Invoice with no match found, Expense not reconciled, CRM job not in pipeline
- These are the items that Claude should review and make decisions about
- Marked with TRUE in columns like "Missing invoice?" or "Unrecon gaps?"

**Claude's Role:**
Analyze ALERTS (unmatched items) and determine if they represent:
- Legitimate exceptions needing human intervention
- Matches the automation missed (potential learning opportunity)
- Data quality issues to be corrected
- System configuration problems

---

## PART 3: "SAFE" MATCHING APPROACH

The system uses a **conservative matching strategy**:

**What is NOT a match:**
- Amount alone is not enough
- Client name alone is not enough
- Date alone is not enough

**What IS a match:**
- Client name + Correct amount + Date in tolerance → **Likely match**
- Client name + Approximate amount (within tolerance) + Date in range → **Possible match**
- Client name + ONLY (without amount/date) → **NOT a match** → Alert

**Therefore, exceptions that Claude should review are:**
1. **Same client, similar amount, but date is way off** - Is it for a different period?
2. **Same client, correct amount, but job name doesn't match** - Is it a coded job?
3. **Same amount, similar date, but client name is abbreviated/variant** - Is it the same client?
4. **Amount is close but not exact** - Could this be partial payment or multi-currency?
5. **Multiple possible matches** - Which one is correct?

---

## PART 4: DATA STRUCTURE SPECIFICS

### Invoice Amount Handling

**Parsing:**
- Remove commas: "9,500" → 9500
- Convert to cents: 2000.50 → 200050 (for precise comparison)
- Trailing/leading spaces trimmed

**Currency Handling:**
- Same currency: Match within 5 pennies (£2000.00 vs £2000.03 = OK)
- Foreign currency: Match within 10% (allows for exchange rate variance)

**Credit Notes:**
- Xero invoices can have credits applied
- Effective amount = Original invoice - Credits applied
- Fully credited invoices are SKIPPED (not included in matches)

**VAT:**
- All comparisons done on amounts EXCL VAT
- VAT status tracked separately
- Invoice totals in Confirmed are marked (excl VAT) or (incl VAT)

---

### Date Handling

**Tolerance Mechanism:**
- Cell A2 in InvComp contains tolerance in months (e.g., 2 = ±2 months)
- All date matching uses this tolerance

**Date Matching Rules:**
1. If slot has specific "Send date" → Use slot-level tolerance
2. If slot has no date → Use job's start/end date range + tolerance

**Example:**
```
Job: Start 01-Jan-2024, End 31-Dec-2024, Tolerance = 2 months
Effective date range: 01-Nov-2023 to 29-Feb-2025

Invoice sent 15-Oct-2023: OUTSIDE range → NO MATCH
Invoice sent 15-Nov-2023: INSIDE range → POSSIBLE MATCH (if amount matches)
```

---

### Client Name Matching

**Algorithm:**
```javascript
targetClient = "ABC Ltd"
sourceClient = "ABC"

1. Exact match (case-insensitive, trimmed)?
   "abc ltd" === "abc"? NO
   
2. Substring match (if both > 3 chars)?
   Both > 3 chars? NO (sourceClient = 3 chars)
   
Result: NO MATCH

---

targetClient = "ABC Limited"  
sourceClient = "ABC Ltd"

1. Exact match? NO
2. Substring match?
   Both > 3 chars? YES
   "abc ltd" includes "abc limited"? NO
   "abc limited" includes "abc ltd"? YES → MATCH!

Result: MATCH
```

---

## PART 5: ALERT TRIGGERS

### When Does an Alert Get Created?

An alert is created when:
1. Data fetched from accounting/CRM tool
2. Moved to comparison sheet (InvComp, DirComp, CRMComp)
3. Matching logic runs
4. **No match found** OR **Multiple possible matches** OR **Match confidence low**

### Alert Flags in Comparison Sheets

**InvComp:**
- `Missing invoice?` = TRUE → Invoice exists in accounting tool but not matched to Confirmed

**DirComp:**
- `Unrecon gaps?` = TRUE → Expense exists but not matched or partially matched

**CRMComp:**
- Implicit flag (job in CRM but not in Confirmed Pipeline)

---

## PART 6: WHAT CLAUDE SHOULD ANALYZE

**Critical:** If the matches were easy and obvious, the existing automation would have found them. Claude's job is to find the patterns and exceptions the automation missed.

When Claude receives an alert about an unmatched invoice/expense/CRM entry, Claude should:

### For Invoices

**Provided Data:**
```
InvComp Row:
- Invoice Number
- Client
- Amount (excl VAT)
- Sent Date
- Job Name (if captured in Xero)
- Currency
- Status
- Fully Paid On (if applicable)

Target Sheets (ALL data):
- Confirmed Tab: All rows for all clients (not just that client)
- Pipeline Tab: All pending jobs
- Previous years' data for context
```

**Claude Should Analyze:**
1. **Why did the automation fail to match this?**
   - Client name typo/variant (automation missed substring match)?
   - Amount calculation issue (VAT handling, currency conversion)?
   - Date completely outside tolerance (system date error)?
   - Duplicate invoice already matched (skip this one)?

2. **Are there pattern matches the automation missed?**
   - Client name similar but spelled differently?
   - Amount is close (within 5%) - could be a rounding issue?
   - Date is close (within 3 months) - could be a late invoice?
   - Job might be under different name or code?
   - Could this invoice belong to a different client (wrong routing)?

3. **Use historical context:**
   - Has this client had invoices before? How were they structured?
   - Is this a repeat job with similar pattern?
   - What's the typical payment frequency for this client?

4. **Make a recommendation:**
   - Auto-match to specific row/slot with confidence level
   - Request clarification (ask which of multiple candidates)
   - Flag as data error (typo in invoice or sheet)
   - Flag as new work (legitimate new job not in Confirmed)

### For Expenses

**Provided Data:**
```
DirComp Row:
- Expense Ref
- Client
- Vendor/Description  
- Amount
- Date
- Category

Target Sheets (ALL data):
- Outgoings Tab: All expense categories and months
- Confirmed Tab: All job expense line items
- Historical expense data
```

**Claude Should Analyze:**
1. **Why did the automation fail to match this?**
   - Vendor name variation (nickname vs full name)?
   - Category miscoded in accounting tool?
   - Amount is approximate (split payment or partial expense)?
   - Date is in different month than expected?

2. **Pattern recognition:**
   - Does vendor appear in historical expenses?
   - Is this category typically associated with specific clients?
   - Is the amount consistent with previous similar expenses?
   - Could this be a recurring vendor (retainer, subscription)?

3. **Make a recommendation:**
   - Match to specific row/column in Outgoings or Confirmed
   - Flag as miscategorized (suggest correct category)
   - Flag as duplicate (already recorded elsewhere)
   - Flag as new vendor/category

### For CRM Entries

**Provided Data:**
```
CRMComp Row:
- Project Code
- Client
- Job Name
- Revenue
- Start/End Dates
- Status in CRM

Target Sheets (based on mode):
- Confirmed Tab (if in Confirmed mode): All jobs
- Pipeline Tab (if in Pipeline mode): All prospective jobs
- Historical job data
```

**Claude Should Analyze:**
1. **Why didn't the automation find a match?**
   - Job name completely different in sheet vs CRM?
   - Client name doesn't match despite being same company?
   - Revenue significantly different (scope change)?
   - Date ranges don't overlap (scheduled vs actual)?

2. **Pattern analysis:**
   - Is this a repeat client? How were previous jobs named?
   - Is the revenue realistic for this client type?
   - Does the date range make sense (normal project duration)?
   - Is this genuinely new work or an updated version of existing job?

3. **Make a recommendation:**
   - Match to existing job in target sheet (may need to explain name difference)
   - Suggest creating new job in target sheet
   - Flag as internal naming issue (CRM vs sheet inconsistency)
   - Flag as scope change (if matched job but revenue very different)

---

## PART 7: KEY COLUMN MAPPINGS (Confirmed Tab)

| Purpose | Column Header | Required | Notes |
|---------|---------------|----------|-------|
| Job Identifier | Client | Yes | Must match invoices/expenses |
| | Job name | Yes | For context and CRM matching |
| | Project / retainer | Yes | Determines matching rules |
| | Start date | Yes | For date tolerance checks |
| | End date | Yes | For date tolerance checks |
| Revenue | Revenue (Proj total / Ongoing pm) (excl VAT) | Yes | Total job revenue for capacity checks |
| Invoice Slot 1 | Inv 1 ref | Yes | Stores invoice number when matched |
| | Project invoice 1 / monthly retainer (excl VAT) | Yes | Planned amount for this slot |
| | Inv 1 SEND date | No | If present, used for precise date matching |
| Invoice Slot 2 | Inv 2 ref | Yes | Second invoice slot |
| | Project invoice 2 (excl VAT) | Yes | Planned amount |
| | Inv 2 SEND date | No | |
| Invoice Slot 3 | Inv 3 ref | Yes | Third invoice slot |
| | Project invoice 3 (excl VAT) | Yes | Planned amount |
| | Inv 3 SEND date | No | |

---

## PART 8: SPECIAL CASES & EDGE CONDITIONS

### Parent Rows & Child Rows Architecture

**Both job types use Parent Rows + Child Rows:**

Each job has:
- **ONE PARENT ROW**: Contains basic job info (Client, Job name, Dates, Revenue) + first 3 invoices/expenses
- **ZERO OR MORE CHILD ROWS**: Contain additional invoices/expenses (slots cycle through 1-3 again)

Child rows automatically inherit from parent:
- Client name
- Job name
- VAT status (critical for accurate calculations)

Each row (parent or child) has:
- **3 invoice slots** (inv 1, inv 2, inv 3)
- **3 expense slots** (dirInv 1, dirInv 2, dirInv 3)

**Project Jobs - Invoice Structure:**
- Parent row: invoices 1-3
- Child row 1 (if needed): invoices 4-6
- Child row 2 (if needed): invoices 7-9
- Etc.

Example: Project with 7 invoices:
```
Parent Row:  [inv1] [inv2] [inv3]
Child Row 1: [inv4] [inv5] [inv6]
Child Row 2: [inv7] [empty] [empty]
```

**Retainer Jobs - Invoice Structure (Two Modes):**

*Mode A - SUMMARY MODE (1 invoice total):*
- Parent row has invoice in slot 1 (represents all monthly invoices combined)
- No child rows needed

*Mode B - INDIVIDUAL MODE (2+ invoices):*
- Parent row: slots 1-3 are EMPTY (no invoices on parent)
- Child row 1: invoice in slot 1 only
- Child row 2: invoice in slot 1 only
- Child row 3: invoice in slot 1 only
- Etc. (each invoice gets its own child row, all in slot 1)

**Transition between modes:**
When user adds a 2nd invoice to a retainer that has 1 invoice on the parent:
1. Move parent invoice to child row 1
2. Add new invoice to child row 2
3. Parent invoice slot becomes empty

Why? Retainer invoices represent monthly recurring payments. One invoice = summary of all months. Multiple invoices = tracking individual months, so each gets its own row.

**Expense Rules (Same for Both Job Types):**
- Parent row: expenses 1-3
- Child row 1 (if needed): expenses 4-6
- Etc.

**Alert Implication:**
- If job has more than 3 invoices/expenses, look for child rows
- When matching, need to find correct row and slot combination

### Credit Notes & Adjustments

**In Xero:**
- Credit notes reduce invoice amount
- System calculates "Net of Credit" value
- If fully credited → Invoice skipped entirely

**Alert Implication:**
- If invoice amount seems low, check if credits were applied
- May need to look at original pre-credit amount

### Split Payments

**When invoice doesn't match exactly:**
1. Check if it's 50% of job revenue (split payment)
2. Check if it's 33% of job revenue (split payment)
3. If split match found, system schedules future invoices for slots 2/3

**Alert Implication:**
- If first invoice is exactly 50% of job → Expect second invoice of ~50%
- Don't match second invoice to full job revenue

### Child Rows for Projects

**Structure:**
```
Row 100: ABC Ltd, Job A, Start 01-Jan, End 31-Dec, Revenue £3000
Row 101: (empty), (empty), (empty), (empty), (empty)
         Slot 1 = £1000
```

**When matching invoices:**
- Parent row (row 100) has job metadata and slot 1 planned amount
- Child row (row 101) might have additional slots
- If parent slot is full, try child row's empty slots

**Matching Logic:**
- If job has 0 revenue but non-zero slot amount → Might be child row
- Look upward to find parent row with actual revenue

---

## PART 9: CONFIDENCE SCORING (For Claude's Analysis)

When Claude analyzes an alert, use this framework:

### HIGH CONFIDENCE MATCH (90%+) - Auto-Approve
- ✓ Client name exact match
- ✓ Amount exact match
- ✓ Date within ±1 month tolerance
- ✓ Single clear candidate in Confirmed

Example:
```
Invoice: ABC Ltd, £5,000, 15-Mar-2024
Confirmed Job: ABC Ltd, "Project X", Slot 1 = £5,000, Planned send 15-Mar-2024
→ AUTO-APPROVE
```

### MEDIUM CONFIDENCE MATCH (60-90%) - Flag for Review
- ✓ Client match (exact or substring)
- ✓ Amount match (within tolerance)
- ? Date is approximate (±2-3 months)
- OR: Multiple possible matches
- OR: Slot has specific amount but different date

Example:
```
Invoice: ABC Ltd, £5,000, 15-Mar-2024
Confirmed Job: ABC Ltd, "Project X", Slot 1 = £5,000, Planned send 01-Feb-2024
Tolerance = 3 months
→ Within tolerance but 6 weeks late - FLAG FOR REVIEW
"Was this invoice delayed, or is it for a different project?"
```

### LOW CONFIDENCE (< 60%) - Request Clarification
- ✓ Client match
- ? Amount is approximate (within 10% for same currency)
- ? Date is way off (> 6 months)
- OR: No candidate found in Confirmed
- OR: Multiple candidates with similar amounts

Example:
```
Invoice: ABC Ltd, £5,200, 15-Mar-2024
Confirmed Jobs with ABC Ltd:
  - Job A: £5,000, Planned date 15-Jan-2024 (2 months earlier)
  - Job B: £5,100, Planned date 30-May-2024 (2.5 months later)
→ REQUEST CLARIFICATION
"Is this Job A (£200 over) late, or Job B (£100 under) early?
Or is it a new project not yet in Confirmed?"
```

### NO MATCH FOUND (0%) - New Invoice Alert
- ✓ Client found in Confirmed
- ? But no job with matching amount/date
- OR: Client not found in Confirmed at all

Example:
```
Invoice: ABC Ltd, £3,500, 15-Mar-2024
Confirmed Jobs with ABC Ltd:
  - Job A: £5,000 (too much)
  - Job B: £2,000 (too little)
  - Job C: dated 2023 (too old)
→ NEW INVOICE - FLAG
"Is this for a new project not yet added to Confirmed?
Or is the client name slightly different?"
```

---

## PART 10: RECOMMENDATION ACTIONS FOR CLAUDE

When analyzing an alert, Claude should recommend one of:

1. **AUTO-MATCH** - Invoice is clear match, fill ref automatically
   - Provide: Row number, Slot number, Action

2. **REQUEST CLARIFICATION** - User needs to confirm
   - Provide: Possible matches, Ask which is correct

3. **REJECT MATCH** - Invoice doesn't belong to any planned job
   - Provide: Reason why, Suggest new job creation?

4. **CORRECT DATA** - Invoice has typo/issue
   - Provide: Which field, What should it be, Why

5. **INVESTIGATE FURTHER** - Need more information
   - Provide: What additional data would help, Where to find it

---

## PART 11: EXAMPLE WORKFLOWS - THE HARD CASES

**Note:** The examples below represent exceptions that the automation MISSED. Simple, obvious matches were already handled automatically. These are the tricky cases where Claude adds value through pattern recognition and historical context.

### Example 1: Variant Client Name (Why Automation Missed It)


```
Input Alert:
  Invoice: INV-2024-0500
  Client: "A B Corp" (from Xero)
  Amount: £2,500.00
  Date: 15-Mar-2024

Confirmed Tab has:
  Row 45: ABC Corporation | Project X | Slot 1: £2,500 (empty ref)

Why Automation Missed It:
  - Client names don't match exactly: "A B Corp" vs "ABC Corporation"
  - Substring match failed (both > 3 chars, but neither contains the other)

Claude Analysis:
  - Pattern recognition: "A B Corp" likely abbreviation/variant of "ABC Corporation"
  - Historical context: Check if this client appears elsewhere with similar patterns
  - Amount matches exactly
  - Date matches exactly
  
Recommendation:
  CONFIDENCE: 85% - REQUEST CLARIFICATION
  QUESTION: "Is 'A B Corp' the same as 'ABC Corporation'?"
  If confirmed yes: Match to Row 45, Slot 1
```

### Example 2: Amount Close But Not Exact (Why Automation Missed It)

```
Input Alert:
  Invoice: INV-2024-0501
  Client: ABC Ltd  
  Amount: £3,000.00
  Date: 15-May-2024
  Status: PENDING

Confirmed Tab Search:
  Row 46: ABC Ltd | Project Y | Start 01-Feb | End 30-Jun
    Slot 1: £3,000 | Send date: 15-Mar-2024 (empty ref)
  
Tolerance: 2 months

Analysis:
  ✓ Client exact match
  ✓ Amount exact match
  ~ Date is 2 months late (05-15 vs 03-15, tolerance = 2 months)
  ✓ Slot empty
  ~ Could be deliberately delayed
  
Recommendation:
  CONFIDENCE: 75% - FLAG FOR REVIEW
  QUESTION: "Invoice is 2 months late. Is this correct, or was it for a different project?"
  If OK: Match to Inv 1 ref
  If NOT: Check if there's a later job with same amount
```

### Example 3: Variant Client Name

```
Input Alert:
  Invoice: INV-2024-0501
  Client: ABC Ltd
  Amount: £3,050.00 (comes from Xero with VAT handling)
  Date: 15-May-2024

Confirmed Tab has:
  Row 46: ABC Ltd | Project Y | Slot 1: £3,000 (empty ref)

Why Automation Missed It:
  - Amount mismatch: £3,050 vs £3,000 (£50 difference)
  - Automation requires exact match (±5 pennies for same currency)
  - This is 1.67% difference - outside tolerance

Claude Analysis:
  - Pattern: Could be VAT handling issue (invoice was VAT inclusive, planned was exclusive)?
  - Or: Exchange rate variance if multi-currency deal?
  - Or: Planned was estimate, actual is slightly different?
  - Historical context: Check if this client has other invoices with similar variance patterns
  - Date matches, client matches, amount is very close
  
Recommendation:
  CONFIDENCE: 70% - FLAG FOR REVIEW
  QUESTION: "Is the £50 difference due to VAT, currency, or a scope change?"
  If VAT/currency issue: Match to Row 46, Slot 1
  If scope change: Request clarification on actual expected amount
```

### Example 3: Date Way Off (Why Automation Missed It)

```
Input Alert:
  Invoice: INV-2024-0503
  Client: ABC Ltd
  Amount: £2,750.00
  Date: 15-Apr-2024

Confirmed Tab Search:
  Row 48: ABC Ltd | Project Z | Slot 1: £2,500 (empty ref)
  Row 49: ABC Ltd | Project Z | Slot 2: £3,000 (empty ref)

Analysis:
  ✓ Client exact match
  ? Amount doesn't match exactly
    - Slot 1: £2,500 (£250 over)
    - Slot 2: £3,000 (£250 under)
  ✓ Date within tolerance for both
  
Recommendation:
  CONFIDENCE: 60% - REQUEST CLARIFICATION
  QUESTIONS:
  - Is this invoice for Slot 1 (£2,500) but issued for £250 more?
  - Or is this for Slot 2 (£3,000) but discounted by £250?
  - Or is it a partial payment towards a larger invoice?
  Suggest: Check original invoice in Xero for notes
```

### Example 4: Split Invoice Across Multiple Jobs (Why Automation Missed It)

```
Input Alert:
  Invoice: INV-2024-0504
  Client: ABC Ltd
  Amount: £4,200.00
  Date: 15-May-2024
  Description: "Monthly retainer - 3 x Project X service"

Confirmed Tab has:
  Row 48: ABC Ltd | Project X (Retainer) | Parent row (no invoices)
  Row 49: ABC Ltd | Project X (Retainer) | Child Row 1, Slot 1: £1,400 (empty ref)
  Row 50: ABC Ltd | Project X (Retainer) | Child Row 2, Slot 1: £1,400 (empty ref)
  Row 51: ABC Ltd | Project X (Retainer) | Child Row 3, Slot 1: £1,400 (empty ref)

Why Automation Missed It:
  - Invoice amount (£4,200) = sum of 3 separate child rows (£1,400 × 3)
  - Automation matches invoice-to-single-row, doesn't aggregate across child rows
  - This is a case where Xero combined 3 monthly retainer invoices into one

Claude Analysis:
  - Pattern recognition: Description mentions "3 x Project X" - suspicious
  - Historical context: Is this client's retainer typically invoiced as monthly (3 rows) or quarterly (1 invoice)?
  - Job structure: Retainer with multiple child rows, each expecting £1,400
  - Math: £4,200 ÷ 3 = £1,400 exactly - perfect match to each row
  
Recommendation:
  CONFIDENCE: 80% - MATCH TO MULTIPLE ROWS
  ACTION: Split this invoice across 3 child rows
    - Row 49, Slot 1: INV-2024-0504 (Part 1 of 3)
    - Row 50, Slot 1: INV-2024-0504 (Part 2 of 3)
    - Row 51, Slot 1: INV-2024-0504 (Part 3 of 3)
  Reason: Amount perfectly divides into 3 child row amounts
  Note: Flag in system to indicate this invoice spans multiple rows
```

### Example 5: Job Name Coded Differently (Why Automation Missed It)

```
Input Alert:
  Invoice: INV-2024-0505
  Client: ABC Ltd
  Amount: £1,800.00
  Date: 20-May-2024
  Description: "Code 037 - Training delivery"

Confirmed Tab has:
  Row 52: ABC Ltd | Staff Training Q2 2024 | Slot 1: £1,800 (empty ref)
  Row 53: ABC Ltd | Code 037 | Slot 1: £1,800 (empty ref)

Why Automation Missed It:
  - Xero description says "Code 037" (internal project code)
  - Confirmed tab Row 52 has the full description "Staff Training Q2 2024"
  - Confirmed tab Row 53 has just the code "Code 037"
  - Automation couldn't match "Code 037" to "Staff Training Q2 2024"
  - But it also couldn't match to Row 53 (invoice date is May, maybe planned for different month)

Claude Analysis:
  - Pattern recognition: Invoice description matches Row 53's job name exactly
  - But Row 52 is also the same amount for what looks like the same work
  - Historical context: Check if this client uses codes or descriptions, which is correct?
  - Should clarify which row is the real planned job
  
Recommendation:
  CONFIDENCE: 85% - MATCH TO CODE 037
  ACTION: Match to Row 53 (Code 037)
  Reason: Invoice description explicitly mentions "Code 037"
  Note: Flag that Row 52 (Staff Training Q2 2024) may be duplicate entry
```

### Example 6: Legitimate New Work (Why Automation Missed It)

```
Input Alert:
  Invoice: INV-2024-0506
  Client: ABC Ltd
  Amount: £5,500.00
  Date: 12-June-2024
  Description: "Additional consulting - not previously quoted"

Confirmed Tab Search for ABC Ltd:
  Row 45: Project X | Start Jan, End Dec | Slots full
  Row 46: Project Y | Start Feb, End Jun | Slots full
  Row 52: Code 037 | Start May, End May | Slots full
  → No empty slots matching amount/date

Why Automation Missed It:
  - This invoice doesn't match any planned job
  - Amount is unique (no other job has £5,500)
  - Date falls outside ranges of current jobs
  - Description indicates unplanned work

Claude Analysis:
  - No match found in Confirmed - this appears to be new work
  - Not in Pipeline either (checked)
  - Description explicitly says "not previously quoted"
  - This is legitimate additional scope
  
Recommendation:
  CONFIDENCE: 95% - NEW WORK ALERT
  ACTION: Create new job row in Confirmed
  Suggested Job Name: "Additional Consulting June 2024"
  Client: ABC Ltd
  Slot 1 Invoice: INV-2024-0506, Amount £5,500
  Then match invoice to new row
```

---

## PART 12: LIMITATIONS & WHEN TO ESCALATE

Claude should recognize when to escalate rather than match:

### Escalate to Human Review
1. **Multiple equally valid matches** - Can't determine which is correct
2. **Client name is ambiguous** - Could be same company or different subsidiary
3. **Amount difference > 10%** - Suggests different invoice or data entry error
4. **Date difference > 6 months** - Likely different project or period
5. **Missing critical data** - Can't determine if match without more info
6. **Potential duplicate** - Same invoice appears in multiple places
7. **Currency complications** - Exchange rates make amount match unclear

### Red Flags That Indicate Issues
- Invoice number already exists in Confirmed (duplicate)
- Client not found anywhere in system (typo or new client)
- Amount is zero (data entry error)
- Date is in future (data entry error)
- Job exists in CRM but not in Confirmed (backlog item)
- Expense category doesn't match any category in Outgoings (miscoded)

---

## SUMMARY FOR CLAUDE

**Core Principle:**
Match invoices/expenses to planned jobs using a "safe" approach:
- Client name MUST match (required)
- Amount should match (within tolerance)
- Date should be reasonable (within tolerance)

**When in doubt: Ask for clarification rather than guessing.**

**Confidence levels:**
- 90%+ → Auto-approve
- 60-90% → Flag for review
- <60% → Request clarification

**Your job is to reduce false positives (wrong matches) not maximize matches.**

---

## PART 13: PHASE 2 TRIAGE SYSTEM - DATA READING PROTOCOL

### Master Switches & Data Freshness

Each comparison sheet (InvComp, DirComp, CRMComp) on each client's master sheet has a master switch in cell **E2**.

**The Problem:** When you set E2 = TRUE, it triggers formulas and calculations in the sheet. But we can't immediately read the data - we need to wait for all calculations to complete.

**The Solution: Google Sheets Flush Mechanism**

The `SpreadsheetApp.flush()` function in Google Apps Script forces Google Sheets to complete all pending calculations. But a single flush isn't always enough - we use a "double flush" pattern:

```javascript
// Set the master switch to TRUE (check the checkbox)
sheet.getRange("E2").setValue(true);

// FLUSH 1: Trigger initial recalculation
SpreadsheetApp.flush();

// SLEEP: 2-second buffer for calculations to propagate
Utilities.sleep(2000);

// DUMMY READ: Force additional calculation cycle
sheet.getRange("A1").getValue();

// FLUSH 2: Ensure ALL calculations complete
SpreadsheetApp.flush();

// NOW: Data is fresh and ready to read
const data = sheet.getRange("A1:Z100").getValues();
```

**Why Double Flush?**
- First flush triggers initial recalculations
- Sleep gives time for cascading calculations
- Dummy read pokes the sheet to force additional cycles
- Second flush ensures everything is truly complete
- Only then is data guaranteed to be fresh

### Reading Discrepancy Sheets in Phase 2

**For InvComp (Invoice Discrepancies):**

1. Check FLAG in Automation Commander (AutoUpdates tab)
   - If "invoice discrepancies" FLAG = FALSE → Skip this client entirely
   - If FLAG = TRUE → Proceed to next steps

2. Set master switch & flush:
   ```javascript
   const invCompSheet = clientMasterSheet.getSheetByName("InvComp");
   invCompSheet.getRange("E2").setValue(true);
   SpreadsheetApp.flush();
   Utilities.sleep(2000);
   invCompSheet.getRange("A1").getValue();
   SpreadsheetApp.flush();
   ```

3. Read discrepancy flag columns (S-Y, row 5):
   - Missing invoice?
   - Client mismatch?
   - Inv amt mismatch?
   - Sent date mismatch?
   - Duplicate inv no?
   - Fully paid on mismatch?
   - Status mismatch?

4. Read all rows where ANY of these flags = TRUE

5. For each flagged row, read the full invoice details and pass to Claude

**For DirComp (Expense Discrepancies):**

Same process as InvComp, but discrepancy columns are AO-AV (row 5):
   - Missing cost?
   - Duplicate app ID?
   - Descr. mismatch?
   - Amount mismatch?
   - VAT mismatch?
   - Rec date mismatch?
   - Pay date mismatch?
   - Status mismatch?

**For CRMComp (CRM Discrepancies):**

Read BOTH sections:

Left section (Dashboard vs CRM):
- Master switch: E2
- Discrepancy columns: AY-BF (row 5)
- Flags: Missing job? Client mismatch? Job name mismatch? Revenue mismatch? Direct costs mismatch? Start date mismatch? End date mismatch? % likel. mismatch?

Right section (CRM vs Dashboard):
- Master switch: E2 (same as left)
- Discrepancy columns: FE-FL (row 5)
- Same flag columns as left section

### Timeline for Phase 2

Phase 2 runs in a loop:

```
Every run:
1. Connect to each client's master sheet
2. For each sheet type (InvComp, DirComp, CRMComp):
   a. Check FLAG in Automation Commander
   b. If TRUE: Set E2, double flush, read discrepancies
   c. If FALSE: Skip this sheet
3. Collect all flagged alert rows
4. Pass to Claude (with AIKnowledgeBase context)
5. Log decisions to TriageLog
6. Present to user (one at a time)
```

---

## APPENDIX: Script File Reference

| File | Purpose |
|------|---------|
| 1_Core_and_Xero.gs | Xero API integration, invoice fetching, P&L sync |
| 2_Internal_Sheet_Logic.gs | Matching logic (findSlotWithTolerance, findExactMatch), sheet manipulation |
| 3_QuickBooks_and_Starters.gs | QuickBooks integration, initial sheet setup |
| 4_CRM_Tasks.gs | CRM integration (Pipedrive, ClickUp, etc.), CRM job matching |
| 5_Agent_Receiver.gs | Webhook receiver for external triggers, data routing |
| 6_Routing_Logic.gs | Decision routing for which data goes where |
| 7_Cost_Sync.gs | Expense/cost syncing, Outgoings tab updates |
| 8_AI_Features.gs | AI/Claude integration hooks (if any) |

