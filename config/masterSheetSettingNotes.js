export const MASTER_SHEET_SETTING_NOTES = {
  // ── 1. MAIN SETTINGS ────────────────────────────────────────────────────────
  "main.vatPaymentScheme": [
    {
      source: "Calcs!X1",
      text: "Calcs!X (Accrual Output VAT on Invoices for the Month)\nSums Invoice 1 VAT (ConfCalcs!GE) for all rows where the invoice sent month (ConfCalcs!GF to GG) matches this calendar month. Because GG is locked to the invoice issue month, this records output VAT in the exact month the invoice was raised."
    }
  ],
  "main.vatRate": [
    {
      source: "KeyInfo!B9",
      text: "NOT USED YET"
    }
  ],
  "main.revenueFocus": [
    {
      source: "KeyInfo!C9",
      text: "Direct costs in the Confirmed tab CANNOT be treated as \"contractors\" when in Income mode. If this combination is selected, cell D9 will show a \"NOT ALLOWED\" warning."
    },
    {
      source: "Performance!A7",
      text: "In INCOME focus, client only inputs a single income figure per month in the \"NBtoFind\" tab. This is then captured here (in revenue line) but with zero pass-through costs, meaning the \"new business to find - income\" row is the same as the revenue figure."
    },
    {
      source: "Year0Data!A3",
      text: "This section will show REVENUE captured in the accounting app for Year Zero, regardless of whether there is an income or a revenue focus in this sheet"
    }
  ],
  "main.directCostsMode": [
    {
      source: "KeyInfo!C8",
      text: "Determines whether the direct costs column in the Confirmed tab is treated as \"Contractors\" or \"Pass-through costs\".\nManually managed expenses for either category is determined in column AS of this tab."
    },
    {
      source: "KeyInfo!C9",
      text: "Direct costs in the Confirmed tab CANNOT be treated as \"contractors\" when in Income mode. If this combination is selected, cell D9 will show a \"NOT ALLOWED\" warning."
    }
  ],
  "main.taxPaymentMethod": [
    {
      source: "Cash!B21",
      text: "If transfers, insert amount related to previous month"
    }
  ],
  "main.currencySymbol": [
    {
      source: "KeyInfo!D4",
      text: "Used by the applyGlobalCurrencyFormat function (in the client sheet) to format the ranges contained in cell D6 with the currency unit selected in this drop-down, AND used by the Pulse app to correctly format all areas of the app with the currency unit selected in this drop-down."
    },
    {
      source: "KeyInfo!D6",
      text: "Run function applyGlobalCurrencyFormat from the CLIENT sheet, to update all ranges contained in this cell to the correct currency."
    }
  ],
  "main.thousandsSeparator": [
    {
      source: "KeyInfo!D5",
      text: "This is only used within the Pulse app to format everything with the correct separator. To make the change within the spreadsheets, the locale needs to be changed within settings - but this will ALSO change how dates are formatted (i.e. using the foreign language month names) and so is best avoided."
    }
  ],
  "main.invoiceMethod": [
    {
      source: "Calcs!X1",
      text: "Calcs!X (Accrual Output VAT on Invoices for the Month)\nSums Invoice 1 VAT (ConfCalcs!GE) for all rows where the invoice sent month (ConfCalcs!GF to GG) matches this calendar month. Because GG is locked to the invoice issue month, this records output VAT in the exact month the invoice was raised."
    }
  ],
  "main.profitSharePercent": [
    {
      source: "Outgoings!G237",
      text: "Calculating pre-profit share operating profit based ONLY ON CONFIRMED WORK:\n\n(\nTotal revenue / income\nminus\nDirect costs\nminus\nOther expenses - delivery\nminus\nOther expenses - non-delivery\nminus\nSalaries - delivery\nminus\nSalaries - non-delivery\nminus\n** Contractors - delivery  (excluding \nminus\n** Contractors - non delivery\nminus\nDividends - total\nminus\n** Contractors - CONFIRMED ONLY MAKING UP COS (i.e. row 245)\n\n)\n\nMULTIPLIED BY\n\nProfit share % (KeyInfo cell F11)"
    },
    {
      source: "Outgoings!G233",
      text: "Calculating pre-profit share operating profit:\n\nTotal revenue / income\nminus\nDirect costs\nminus\nOther expenses - delivery\nminus\nOther expenses - non-delivery\nminus\nSalaries - delivery\nminus\nSalaries - non-delivery\n\nminus\n\nContractors - delivery\n\nminus\n\nContractors - non delivery\n\nminus\n\nDividends - total"
    }
  ],
  "main.profitShareAccrual": [
    {
      source: "Outgoings!G120",
      text: "13-Mar-26: Includes profit share accrual in here, which won't be included in monthly cashflow (only when profit share scheme is due to pay out)"
    }
  ],
  "main.profitSharePayment": [
    {
      source: "Cash!A8",
      text: "Includes any profit share payments due - see Outgoings row 8"
    },
    {
      source: "Cash!B8",
      text: "13-Mar: Determine any profit-share payments from previous financial year that will be paid during first FY of dashboard"
    }
  ],
  "main.jobTableStyle": [
    {
      source: "KeyInfo!D11",
      text: "Chooses the job table setup style - \"JobCosting\" is the BTB approach of having contractor costs determined by the amounts configured below - i.e. standard charge-out rates and a standard contractor day rate."
    }
  ],
  "main.crmInUse": [
    {
      source: "KeyInfo!Q8",
      text: "If \"None\" is selected here, the CRM automation sequence will still run (based on the frequency setting in DataChgAlert), but without importing data from an external tool."
    }
  ],
  "main.crmDrives": [
    {
      source: "DataChgAlert!F71",
      text: "Change these [Confirmed: CRM compare PMA alerts] to \"Ignore\" if CRM is NOT managing pipeline"
    },
    {
      source: "DataChgAlert!D82",
      text: "Select \"Yes\" here [Pipeline mode - add jobs to Conf? (B82)] to have approved jobs added to the Confirmed tab, even if in CRM pipeline only mode"
    }
  ],
  "main.keyHeaders": [
    {
      source: "KeyInfo!W41",
      text: "Excel Key Headers\n\nThis cell should contain the headers for the following columns, separated by columns (in this order!):\nClient\nJob\nRevenue\nStart date\nEnd date\nLikelihood\n\nFor a match, the automation requires an EXACT client and job match, plus TWO of the remaining FOUR."
    }
  ],
  "main.excelAzureAuth": [
    {
      source: "KeyInfo!W33",
      text: "See instructions in Pulse documentation (EXCEL PIPELINE AZURE SETUP) to get Tenant ID, Client ID and Client Secret\nThen run \"findExcelFieldsUI\" in script file 6 to get the Drive ID and File ID"
    }
  ],
  "main.excelDriveAndFileId": [
    {
      source: "KeyInfo!W36",
      text: "Run \"findExcelFieldsUI\" in script file 6 to get the Drive ID and File ID\n\n----\n\nOR:\n\nStep 1: Generate the API URL in your Browser\nYou can use your browser to run the encoding logic instantly.\n\nOpen a new tab in your web browser (Chrome, Edge, Firefox, etc.).\n\nPress F12 to open the Developer Tools, and click on the Console tab.\n\nPaste the following JavaScript snippet into the console and press Enter:\n\nJavaScript\nconst url = \"    INSERT URL OF FILE      \";\nconst encoded = \"u!\" + btoa(url).replace(/=/g, '').replace(/\\//g, '_').replace(/\\+/g, '-');\nconsole.log(\"https://graph.microsoft.com/v1.0/shares/\" + encoded + \"/driveItem\");\n\nThis will print a complete [https://graph.microsoft.com/](https://graph.microsoft.com/)... URL directly in your console. Copy that resulting URL.\n\nStep 2: Fetch the IDs using Microsoft Graph Explorer\nNow you just need to query that URL using Microsoft's official testing tool.\n\nGo to Microsoft Graph Explorer.\n\nOn the left side, click Sign in to Graph Explorer and sign in with your Microsoft/SharePoint account (the one that has access to the file).\n\nAt the top of the page, ensure the HTTP method dropdown is set to GET.\n\nPaste the URL you copied from your browser console in Step 1 into the query input box.\n\nClick the Run query button.\n\nStep 3: Read your IDs\nScroll down to the Response preview box at the bottom of the page. You will see a JSON response. You can find your IDs right there:\n\nLook for \"id\": \"...\" — this is your File ID.\n\nLook for the \"parentReference\" block, inside it you will find \"driveId\": \"...\" — this is your Drive ID."
    }
  ],
  "main.crmFrequency": [
    {
      source: "KeyInfo!Q8",
      text: "If \"None\" is selected here [CRM in use], the CRM automation sequence will still run (based on the frequency setting in DataChgAlert), but without importing data from an external tool."
    }
  ],
  "main.expensesFrequency": [
    {
      source: "DataChgAlert!X4",
      text: "Not currently used"
    }
  ],

  // ── 2. CUSTOMISATION ────────────────────────────────────────────────────────
  "customisation.makingUpCos": [
    {
      source: "Client Outgoings!A112",
      text: "Adjust this percentage to add a \"Making up CoS\" row and amounts"
    },
    {
      source: "Client Outgoings!D112",
      text: "If the word \"ZERO\" is entered into any month column, that column's \"making up CoS\" row will be hard coded to zero regardless of the actual outcome of the calculation."
    },
    {
      source: "Budget!B142",
      text: "Enter the desired Cost of Sale (NOT required gross profit) for the calculations from column G onwards"
    },
    {
      source: "Budget!G142",
      text: "This formula calculates an amount to make total CoS 50% (i.e. on top of delivery salaries and delivery dividends in lieu of salaries and direct costs (if revenue focus)"
    },
    {
      source: "Outgoings!G245",
      text: "This row calculates the \"making up COS\" based ONLY on confirmed work (whereas the row at the very bottom of the Contractors section above calculates it based on confirmed + pipeline + nb to find)\n\nIf revenue for the month * AO111 %\nMinus dashboard AO13 and AO14 \nMinus AO6 (delivery salaries)\nMinus delivery contractors (excluding the “making up figure)\nMinus delivery dividends\nMinus profit share (see below)\nIs less than zero, insert zero.\nOtherwise, insert the value of the \"if\" calculation.\n\n---\nOne section in here does this:\n\nCalculating pre-profit share operating profit based ONLY ON CONFIRMED WORK:\n\n(Confirmed-only revenue / income\n x\nMaking up CoS %)\n\nminus\n\nDirect costs\nminus\nOther expenses - delivery (DEDUCTING BOTH ROWS 13 AND 14 EVEN IF IN INCOME MODE, AS ROW 14 WILL JUST BE BLANK IN THAT CASE - SO REMOVES THE NEED FOR AN IF STATEMENT)\n\nminus\n\nSalaries - delivery\n\nminus\n\n** Contractors - delivery  (excluding the existing \"making up CoS row\" which includes confirmed AND pipeline)\n\nminus\n\nDividends - delivery only\n\nminus\n\nProfit share - confirmed only (i.e. row 237) & delivery only (multiplying row 237 by proportion of salaries that are delivery)"
    }
  ],

  // ── 3. ACCOUNTING ───────────────────────────────────────────────────────────
  "accounting.cashBankAccounts": [
    {
      source: "KeyInfo!H11",
      text: "List the bank accounts that make up the cash balance we want to track on the Cash tab.\nThese names will be used by the Triage System as part of its \"closing cash balance\" functionality.\n\nNote: At this stage the names do NOT have to exactly match what's in Xero / QB"
    }
  ],
  "accounting.invoiceNumberFormatting": [
    {
      source: "InvAppList!N4",
      text: "Formula forces the string to text, even if (for QB imports with line items) the resulting output (eg 2001-1) might be initially interpreted as a date."
    }
  ],
  "accounting.manualCategoryTracking": [
    {
      source: "KeyInfo!AW1",
      text: "Run function \"refreshAccountingToolChartOfAccounts\" to populate this column"
    },
    {
      source: "KeyInfo!C8",
      text: "Determines whether the direct costs column in the Confirmed tab is treated as \"Contractors\" or \"Pass-through costs\".\nManually managed expenses for either category is determined in column AS of this tab."
    }
  ],
  "accounting.categoryMappingRules": [
    {
      source: "KeyInfo!BA1",
      text: "This mapping is used for the Year 0 and Starter P&L tabs.\n\nIt's not currently used for the PLComp tab, but could be extended to that in future (but that tab would need to be rebuilt)."
    },
    {
      source: "KeyInfo!BE2",
      text: "Collects all categories from P&L pull and Year 0 pull"
    }
  ],
  "accounting.cosStaffCosts": [
    {
      source: "PLComp!B2",
      text: "This list is pulled from the master setup on the KeyInfo tab, column BA."
    }
  ],
  "accounting.depreciation": [
    {
      source: "Outgoings!A250",
      text: "Excludes depreciation expense"
    }
  ],

  // ── 4. CRM ──────────────────────────────────────────────────────────────────
  "crm.field.startDate": [
    {
      source: "KeyInfo!N32",
      text: "Use this column [Start date rule in CRM status mapping] to choose the \"assumed start date\" (i.e. number of months into the future) when \"Actual or by Status\" is chosen in CRMList F2"
    }
  ],
  "crm.field.endDate": [
    {
      source: "CRMList!G2",
      text: "If \"End date\" column AH contains a \"number of months\" project length rather than an end date, choose \"Months\". If it's a date, choose \"Actual\". If retainer end dates are left blank, choose \"AddRetEnd\" to include a fictional end date."
    }
  ],
  "crm.field.likelihood": [
    {
      source: "CRMList!H2",
      text: "Actual - whatever is in column AI\n\nDivide by 100 - whatever is in column AI divided by 100\n\nMapped - takes whatever is in column AI (NOTE THIS IS THE LIKELIHOOD COLUMN - SO IT WILL NEED TO BE SET TO PULL EG A STATUS) and maps it to a percentage based on KeyInfo L32:N75\n\nActualOrMappedByStatus - uses value in column AI if present, or maps value in column AJ (NOTE THIS IS THE STATUS COLUMN) using the same KeyInfo cells as previous option."
    }
  ],
  "crm.field.projectRetainer": [
    {
      source: "CRMList!J2",
      text: "Options self-explanatory.\n\nCRM Convert options: Find close matches for Project and Retainer, and convert them to the correct terms."
    }
  ],
  "crm.def.confirmedOperator": [
    {
      source: "CRMList!DH2",
      text: "If DF2 is left blank, this must be set to \"And\" to avoid EVERYTHING being considered \"Confirmed\" !!"
    }
  ],
  "crm.def.confirmedStatus": [
    {
      source: "CRMList!DF2",
      text: "This can be a comma-separated list of statuses to INCLUDE"
    }
  ],
  "crm.def.pipelineCard": [
    {
      source: "CRMList!DY2",
      text: "These cells are auto-populated based on the definition of Confirmed (to the left), to ensure that the two lists are always mutually exclusive.\nAdditional status exclusions can be added to cell EE2"
    },
    {
      source: "CRMList!EC2",
      text: "This needs to always be set to \"And\", even if DH2 is set to \"Or\"."
    }
  ],
  "crm.def.pipelineExcludedStatuses": [
    {
      source: "CRMList!EE2",
      text: "Optional additional statuses to exclude from the \"Pipeline\" view (eg to restrict pipeline to the more likely statuses)"
    }
  ],
  "crm.statusTable.likelihood": [
    {
      source: "KeyInfo!M32",
      text: "Insert a % likelihood to assign to any CRM pipeline jobs that have the corresponding status in column L"
    }
  ],
  "crm.statusTable.startDateRule": [
    {
      source: "KeyInfo!N32",
      text: "Use this column to choose the \"assumed start date\" (i.e. number of months into the future) when \"Actual or by Status\" is chosen in CRMList F2"
    }
  ],

  // ── 5. JOBS ─────────────────────────────────────────────────────────────────
  "jobs.projectStartDate": [
    {
      source: "KeyInfo!E15",
      text: "Adjusted start month (ConfCalcs and PipeCalcs column EQ)\n\nProject\nUse the setting in KeyInfo F15 to determine what to do with the raw date:\n- Raw dates - use the raw date, and adjust to first day of the month\n- 5-day adjust - if raw start date is within the last five days of the month, make the adjusted start date the first day of the following month\n- 10-day adjust - same but with 10 days\n- 15-day adjust - same but with 15 days"
    }
  ],
  "jobs.projectEndDate": [
    {
      source: "KeyInfo!E16",
      text: "Adjusted project end month (ConfCalcs and PipeCalcs column ER)\n\nProject\nUse the setting in KeyInfo F16 to determine what to do with the raw date:\n- Raw dates - make the adjusted end month the last day of the month in the raw end date\n- 5-day adjust - if raw end date is within the first 5 days of a month, make the adjusted end date the last day of the previous month\n- 10-day adjust - same but within first 10 days\n- 15-day adjust - same but within first 15 days"
    },
    {
      source: "ConfCalcs!ER1",
      text: "Includes safety check so that if calculated end date is BEFORE the start date, the end date is shifted to be AFTER it."
    }
  ],
  "jobs.retainerDates": [
    {
      source: "KeyInfo!E17",
      text: "Adjusted start month (retainer) - ConfCalcs and PipeCalcs column EQ\n\nUse the setting in KeyInfo F17 to determine what to do with the raw retainer start date:\n- Raw dates - use the raw date, and adjust to first day of the month\n- 10-day min - if at least 10 days of the start month are included, count that month as part of the retainer - i.e. make the adjusted start date the first of the month - otherwise make the adjusted start date the 1st of the NEXT month\n- 15-day min - same, but at least 15 days included\n- 20-day min - same, but at least 20 days included"
    },
    {
      source: "ConfCalcs!ER1",
      text: "Retainer\nThe adjusted end date will be the adjusted start date plus the “number of months” calculated based on “retainer duration” (in column ES)\n\nIncludes safety check so that if calculated end date is BEFORE the start date, the end date is shifted to be AFTER it."
    }
  ],
  "jobs.retainerDur": [
    {
      source: "KeyInfo!E18",
      text: "Number of months (ConfCalcs and PipeCalcs column ES)\n\nProject\nBase number of months on the adjusted Start month and End month dates in columns EQ and ER.\n\nRetainer\nBase number of months on the original raw dates, taking into account the setting in KeyInfo F18 regarding what to do if the dates aren't a round number of months (eg always round up, always round down, etc etc):\n- Raw date rounding - calculate duration based on raw dates, and simply round to nearest number of months\n- Any day down bias - if duration based on raw dates is a number of months plus ANY number of days, round DOWN to the next number of months\n- 25-day down bias - if duration based on raw dates is a number of months plus 25 days or less, round DOWN to the next number of months\n- 20-day down bias - same but 20 days or less\n- 10-day up bias - if duration based on raw dates is a number of months plus 10 days or more, round UP to the next number of months\n- 5-day up bias - same but 5 days or more\n- Any day up bias - if duration based on raw dates is a number of months plus ANY number of days, round UP to the next number of months"
    },
    {
      source: "ConfCalcs!ES1",
      text: "Includes safety check so that if calculation ever ends up being zero, it becomes 1."
    }
  ],
  "jobs.moveCrmDatesIfPast": [
    {
      source: "KeyInfo!E19",
      text: "Option chosen here automatically shifts dates in the PipeCalcs tab - i.e. you do NOT need to do anything with CRMComp once option has been chosen."
    }
  ],
  "jobs.noEndDateRetainerMonths": [
    {
      source: "KeyInfo!C18",
      text: "If a retainer has no end date (i.e. stored as 31-Dec-2050), calculations of how much total revenue / income to count for a job (eg in \"Bookings\" or \"Added to pipeline\" calculations in MgmtRep tab) will be based on the number of months included in cell D18."
    }
  ],
  "jobs.productLines": [
    {
      source: "KeyInfo!B23",
      text: "Insert up to four product lines into these cells"
    },
    {
      source: "KeyInfo!B27",
      text: "11-Jun:\nOnly the first four PLs are currently captured in the Product Line summary of the Dashboard tab - need to add the others."
    },
    {
      source: "Calcs!IB1",
      text: "5. Calcs!IB, ID, IF, IH, IJ, IL, IN, IP (Product Lines 1–4 Monthly Breakdown)\nSubtotals monthly revenue and income by product line:\nIB & ID: Product Line 1 (PL1) Revenue & Income\nIF & IH: Product Line 2 (PL2) Revenue & Income\nIJ & IL: Product Line 3 (PL3) Revenue & Income\nIN & IP: Product Line 4 (PL4) Revenue & Income\nEach column applies the same four-stream logic as Calcs!K and Calcs!L, filtered by ConfCalcs!HU = target_pl. Because child invoice rows inherit the parent’s product line in HU, child invoice revenue is properly attributed to that specific division."
    }
  ],
  "jobs.productLineMappings": [
    {
      source: "KeyInfo!E23",
      text: "Copy and paste initial unique values into this cell to overwrite the formula, so that product lines mappings are hard-coded.\nAny new product lines from CRM will then need to be individually mapped."
    },
    {
      source: "KeyInfo!E21",
      text: "Once initial product lines are hard coded below, this cell will list any that are missing - as a way of highlighting if there are any new ones that need to be mapped.\nNOTE: It often says \"1 missing\" even when none are missing."
    }
  ],
  "jobs.leadSources": [
    {
      source: "KeyInfo!G63",
      text: "Insert client-specific lead sources from here"
    },
    {
      source: "KeyInfo!G72",
      text: "Cannot go any lower than this, as Calcs tab only calculates totals for lead sources up to here."
    }
  ],
  "jobs.leadSourceMappings": [
    {
      source: "KeyInfo!I32",
      text: "Copy and paste initial unique values into this cell to overwrite the formula, so that lead source mappings are hard-coded.\nAny new lead sources from CRM will then need to be individually mapped."
    },
    {
      source: "KeyInfo!I29",
      text: "Once initial lead sources are hard coded below, this cell will list any that are missing - as a way of highlighting if there are any new ones that need to be mapped.\nNOTE: It often says \"1 missing\" even when none are missing."
    }
  ],

  // ── 6. AUTOMATIONS ──────────────────────────────────────────────────────────
  "automation.inv.monthsToCompare": [
    {
      source: "DataChgAlert!D32",
      text: "This is the number of months cell A2 of InvComp will be set to initially (options: 1,3,6,7,12,13)"
    }
  ],
  "automation.inv.monthsForOthers": [
    {
      source: "DataChgAlert!D33",
      text: "This is the number of months cell A2 of InvComp will be set to for reporting remaining \"non-simple\" discrepancies (options: 1,3,6,7,12,13)"
    }
  ],
  "automation.inv.monthTolerance": [
    {
      source: "DataChgAlert!F39",
      text: "If \"look for slot\" is selected in D39, the script will look for a matching invoice with an exact client and amount match, and an invoice date within THIS number of months."
    }
  ],
  "automation.inv.includeHalfThird": [
    {
      source: "DataChgAlert!I39",
      text: "If \"Yes\" is selected here (and \"look for slot\"  or \"look then create\" is selected) the script will also look for invoices exactly a half and a third of the total job amount, and add details if other conditions also match. The script will also create blank invoice details in slots 2 and 3 for any amount still to be invoiced as appropriate."
    }
  ],
  "automation.inv.defaultProjectInvoicing": [
    {
      source: "DataChgAlert!D50",
      text: "This is the default project invoicing structure. Note that \"even split\" will split revenue evenly across the months of the project."
    }
  ],
  "automation.inv.defaultRetainerInvoiceDate": [
    {
      source: "DataChgAlert!D51",
      text: "This is the day of the month retainer invoices should be created (0 for no invoice), OR the date of the month that \"evenly split\" project invoices will be sent"
    }
  ],
  "automation.inv.defaultDaysToPay": [
    {
      source: "DataChgAlert!D52",
      text: "This is the default payment terms - i.e. number of days to pay - for any automatically created invoices"
    }
  ],
  "automation.inv.updateDaysToPayNewMonth": [
    {
      source: "DataChgAlert!D47",
      text: "If \"Yes\" is selected here, any invoices with a \"days to pay\" number that creates an expected payment date in a past month will have \"days to pay\" updated to push the payment date into the current month (for cashflow purposes)"
    }
  ],
  "automation.inv.createInvoiceRowsRetainers": [
    {
      source: "DataChgAlert!D48",
      text: "If \"Yes\" is selected here, the invoice update automation will check for any Retainer jobs in the Confirmed tab that don't have any invoice rows created, and will then create them"
    }
  ],
  "automation.inv.invAmtMismatch": [
    {
      source: "InvComp!U5",
      text: "Includes a 2p tolerance to account for rounding"
    },
    {
      source: "DataChgAlert!D46",
      text: "Select rows with invoice mismatches if duplicate invoice number? (B46): This selects what to do if there are invoice amount mismatches with duplicate invoice numbers. Selecting \"yes\" will override any \"inv amt mismatch\" above - but invoice amounts will NOT change (just dates and statuses, etc)"
    }
  ],
  "automation.inv.duplicateInvNo": [
    {
      source: "DataChgAlert!D46",
      text: "Select rows with invoice mismatches if duplicate invoice number? (B46): This selects what to do if there are invoice amount mismatches with duplicate invoice numbers. Selecting \"yes\" will override any \"inv amt mismatch\" above - but invoice amounts will NOT change (just dates and statuses, etc)"
    }
  ],
  "automation.exp.defaultDirectCostDetails": [
    {
      source: "DataChgAlert!D105",
      text: "This is the default direct cost invoicing approach - i.e. how the expenses \"gap\" automation assumes the expense invoices will be received.  Note that \"even split\" will split revenue evenly across the months of the project."
    }
  ],
  "automation.exp.defaultRetainerExpenseDate": [
    {
      source: "DataChgAlert!D106",
      text: "This is the day of the month retainer expenses should have their \"receive date\" set, OR the date of the month that \"evenly split\" project invoices will be sent"
    }
  ],
  "automation.exp.monthTolerance": [
    {
      source: "DataChgAlert!J111",
      text: "If \"look for slot\" is selected in I111, the script will look for a matching expense with a received date within this number of months"
    }
  ],
  "automation.exp.amountAndVatMismatch": [
    {
      source: "DirComp!FM5",
      text: "Amount mismatch and VAT mismatch will be ignored if the App ID is a duplicate. These mismatches will be picked up in the left-hand Dashboard Compare section."
    }
  ],
  "automation.crm.monthsToCompare": [
    {
      source: "DataChgAlert!D55",
      text: "This is the number of months cell A2 of CRMComp will be set to initially (options: 1,3,6,7,12,13)"
    }
  ],
  "automation.crm.pipelineAddJobsToConf": [
    {
      source: "DataChgAlert!D82",
      text: "Select \"Yes\" here to have approved jobs added to the Confirmed tab, even if in CRM pipeline only mode"
    }
  ],
  "automation.crm.table.crmConf": [
    {
      source: "DataChgAlert!F71",
      text: "Change these [PMA alerts column] to \"Ignore\" if CRM is NOT managing pipeline"
    }
  ],
  "automation.crm.col.gasAutomation": [
    {
      source: "DataChgAlert!B58",
      text: "This column determined whether a discrepancy type will be included, excluded or ignored by the triage system when choosing which columns to check during the automation sequence."
    },
    {
      source: "CRMComp!CP4 & FO5",
      text: "Setting these drop-downs to \"Ignore\" will force the CRM automation to entirely ignore the relevant columns.\n\nThese formulas (client, job name, revenue, direct costs, start date, end date, % likelihood) are built to output \"<IGNORE>\" if the relevant switch in the DataChgAlert is set to \"ignore\". When the update function finds \"<IGNORE>\" it doesn't change what's already in the Confirmed / Pipeline tab.\n\nThis means that if another type of discrepancy (that isn't ignored) is present, the updates can still be safely made without touching the ignored field."
    }
  ],
  "automation.crm.col.pmaAlerts": [
    {
      source: "DataChgAlert!C58",
      text: "This column determined whether a discrepancy type will be included or ignored by the triage system when building its list of alerts."
    }
  ],
  "automation.crm.row.crmMissingJob": [
    {
      source: "DataChgAlert!B72",
      text: "Best to leave this (and the Confirmed equivalent in E72) as \"Exclude\", so that jobs that exist in the dashboard but do NOT exist in the CRM are not actioned - i.e. their rows will NOT be checked during the CRM automation sequence."
    }
  ],
  "automation.crm.row.likelihoodMismatch": [
    {
      source: "CRMComp!FL5",
      text: "In Confirmed setting, this column will show a \"1\" if the  matched job in the CRM does NOT meet the definition of \"confirmed\" as defined in CRMList cells DD2, DF2 and DH2.\nIf the column includes a \"1\" it will trigger the item being deleted from the Confirmed tab, via the \"DELETE\" entry in column HC.\n\nIn Pipeline setting, this column will show a \"1\" if the matched job in the CRM DOES meet the definition of confirmed. Then, the formula in column HC will output a \"Yes\" if the CRM job matches the definition of pipeline, meaning that the \"copied to confirmed?\" box will have a \"Yes\" and the job will NOT be counted within pipeline."
    },
    {
      source: "CRMComp!HC5",
      text: "Copied to confirmed tab?:\nIn Confirmed setting, this column will show \"DELETE\" if column FL includes a \"1\", as that would mean that the job no longer meets the definition of \"Confirmed\" and should be removed.\n\nIn Pipeline setting, this column will show a \"Yes\" if the matched job in the CRM meets the definition of confirmed, meaning that the \"copied to confirmed?\" box will have a \"Yes\" and the job will NOT be counted within pipeline."
    }
  ]
};
