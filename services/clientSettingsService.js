/**
 * ============================================================================
 * CLIENT SETTINGS SERVICE
 * ============================================================================
 * 
 * Manages full multi-section client settings across:
 * - Master Sheet: KeyInfo (Main, Customisation, Accounting, CRM, Jobs)
 * - Master Sheet: DataChgAlert (Automation frequencies & discrepancy rules)
 * - Client Sheet: AppData (Pulse portal feature switches)
 * 
 * Features:
 * - Redis-backed caching with automatic stale-while-revalidate TTL
 * - Instant reads (~10ms) and optimistic write-through updates
 * - Parallel batchGet & batchUpdate across Master and Client Google Sheets
 * - Formula preservation & safe 2D array expansion for KPI Colouring rules
 */

import { getSheetsClient, withRetry } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";

const REDIS_SETTINGS_PREFIX = "pulse:client_settings:";
const REDIS_SETTINGS_TTL = 1800; // 30 minutes cache

/**
 * Normalizes a client key for Redis storage.
 */
function getSettingsRedisKey(clientName) {
  const clean = String(clientName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  return `${REDIS_SETTINGS_PREFIX}${clean}`;
}

/**
 * Reads all client settings for a given client from Redis or Google Sheets.
 */
export async function getClientSettings({ clientName, masterSheetId, clientSheetId, bypassCache = false }) {
  if (!clientName || !masterSheetId) {
    throw new Error("Missing required clientName or masterSheetId parameter.");
  }

  const redisKey = getSettingsRedisKey(clientName);

  // 1. Try Redis cache if not bypassing
  if (!bypassCache && redisClient?.isOpen) {
    try {
      const cached = await redisClient.get(redisKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return { ...parsed, fromCache: true };
      }
    } catch (err) {
      console.warn("⚠️ Redis read error in getClientSettings:", err.message);
    }
  }

  // 2. Fetch from Google Sheets in parallel
  const sheets = await getSheetsClient();

  const masterRanges = [
    "KeyInfo!A1:F20",      // [0] Main, Customisation, Date Adjust
    "KeyInfo!Q1:Q10",      // [1] Q4 tool, Q8 CRM, Q9 drives
    "KeyInfo!X14:X41",     // [2] CRM connection parameters
    "KeyInfo!A120:B141",   // [3] KPI Colouring rules
    "KeyInfo!AT4:AT22",    // [4] Contractors manual track
    "KeyInfo!AT24:AT40",   // [5] Other pass-through manual track
    "KeyInfo!BA2:BA180",   // [6] Accounting category mappings
    "KeyInfo!L32:N75",     // [7] CRM status mappings (Status, %, Date rule)
    "KeyInfo!B23:B37",     // [8] Product lines 1-15
    "KeyInfo!D22:E62",     // [9] Product line mappings (CRM -> PL)
    "KeyInfo!G63:G72",     // [10] Client-specific lead sources
    "KeyInfo!I32:J75",     // [11] Lead sources mappings (CRM -> Mapped)
    "KeyInfo!E1",          // [12] Template Sheet Reference URL
    "DataChgAlert!Y1:Y5",  // [13] Frequencies (Y2: Invoices, Y3: CRM, Y4: Expenses)
    "DataChgAlert!A31:J53",// [14] Invoice settings & tolerances
    "DataChgAlert!A58:F80",// [15] CRM discrepancy rules (Pipeline & Confirmed)
    "DataChgAlert!A100:J120", // [16] Expense settings & tolerances
    "DataChgAlert!B82"     // [17] Pipeline mode - add jobs to Conf?
  ];

  const clientRanges = [
    "AppData!W42:W44",     // [0] W42 Staff costs ratio, W43 Cash menu, W44 Budget
    "AppData!G59",         // [1] Cashflow chart toggle
    "AppData!G71",         // [2] Last 12 months chart
    "AppData!I71"          // [3] Trendlines
  ];

  const [masterResp, masterFormulaResp, clientResp] = await Promise.all([
    withRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: masterSheetId,
      ranges: masterRanges,
      valueRenderOption: "FORMATTED_VALUE"
    })),
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "KeyInfo!A120",
      valueRenderOption: "FORMULA"
    })).catch(() => ({ data: { values: [[""]] } })),
    clientSheetId ? withRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: clientSheetId,
      ranges: clientRanges,
      valueRenderOption: "FORMATTED_VALUE"
    })).catch(() => ({ data: { valueRanges: [] } })) : Promise.resolve({ data: { valueRanges: [] } })
  ]);

  const mVals = masterResp.data.valueRanges || [];
  const cVals = clientResp.data?.valueRanges || [];

  const keyA1F20 = mVals[0]?.values || [];
  const keyQ1Q10 = mVals[1]?.values || [];
  const keyX14X41 = mVals[2]?.values || [];
  const keyA120B141 = mVals[3]?.values || [];
  const keyATContr = mVals[4]?.values || [];
  const keyATPass = mVals[5]?.values || [];
  const keyBA = mVals[6]?.values || [];
  const keyL32N75 = mVals[7]?.values || [];
  const keyB23B37 = mVals[8]?.values || [];
  const keyD22E62 = mVals[9]?.values || [];
  const keyG63G72 = mVals[10]?.values || [];
  const keyI32J75 = mVals[11]?.values || [];
  const keyE1 = mVals[12]?.values?.[0]?.[0] || "";

  const dcaY1Y5 = mVals[13]?.values || [];
  const dcaInv = mVals[14]?.values || [];
  const dcaCrmRules = mVals[15]?.values || [];
  const dcaExp = mVals[16]?.values || [];
  const dcaB82 = mVals[17]?.values?.[0]?.[0] || "";

  // Check if A120 is an IMPORTRANGE formula
  const formulaA120 = String(masterFormulaResp.data?.values?.[0]?.[0] || "");
  const isKpiParentFormula = formulaA120.toLowerCase().includes("importrange");

  // Client AppData ranges
  const appDataW = cVals[0]?.values || [];
  const appDataG59 = cVals[1]?.values?.[0]?.[0] || "";
  const appDataG71 = cVals[2]?.values?.[0]?.[0] || "";
  const appDataI71 = cVals[3]?.values?.[0]?.[0] || "";

  // --------------------------------------------------------------------------
  // Parse Accounting Categories Mapping (BA2:BA180)
  // --------------------------------------------------------------------------
  const getSliceValues = (startRow, endRow) => {
    const out = [];
    for (let r = startRow; r <= endRow; r++) {
      const idx = r - 2; // BA2 is index 0
      const val = String(keyBA[idx]?.[0] || "").trim();
      if (val) out.push(val);
    }
    return out;
  };

  const accountingMappings = {
    revenue: getSliceValues(2, 17),
    cosStaffCosts: getSliceValues(19, 33),
    nonCosStaffCosts: getSliceValues(35, 48),
    corporationTax: getSliceValues(50, 52),
    depreciation: getSliceValues(54, 56),
    otherCostOfSale: getSliceValues(59, 78),
    nonOperatingIncome: getSliceValues(81, 99),
    nonOperatingExpenses: getSliceValues(101, 126),
    ignore: getSliceValues(128, 180)
  };

  // --------------------------------------------------------------------------
  // Parse CRM Status Mappings (KeyInfo!L32:N75)
  // --------------------------------------------------------------------------
  const crmStatusMappings = [];
  (keyL32N75 || []).forEach(row => {
    const status = String(row[0] || "").trim();
    if (status) {
      crmStatusMappings.push({
        status,
        likelihood: String(row[1] || "").trim(),
        startDateRule: String(row[2] || "").trim()
      });
    }
  });

  // --------------------------------------------------------------------------
  // Parse Product Lines & Mappings (B23:B37, D22:E62)
  // --------------------------------------------------------------------------
  const productLines = (keyB23B37 || []).map(r => String(r[0] || "").trim()).filter(Boolean);
  const productLineMappings = [];
  (keyD22E62 || []).forEach(row => {
    const crmProductLine = String(row[0] || "").trim();
    const mappedTo = String(row[1] || "").trim();
    if (crmProductLine || mappedTo) {
      productLineMappings.push({ crmProductLine, mappedTo });
    }
  });

  // --------------------------------------------------------------------------
  // Parse Lead Sources & Mappings (G63:G72, I32:J75)
  // --------------------------------------------------------------------------
  const leadSources = (keyG63G72 || []).map(r => String(r[0] || "").trim()).filter(Boolean);
  const leadSourceMappings = [];
  (keyI32J75 || []).forEach(row => {
    const crmSource = String(row[0] || "").trim();
    const mappedTo = String(row[1] || "").trim();
    if (crmSource || mappedTo) {
      leadSourceMappings.push({ crmSource, mappedTo });
    }
  });

  // --------------------------------------------------------------------------
  // Parse CRM Discrepancy Rules (DataChgAlert!A58:F80)
  // --------------------------------------------------------------------------
  // dcaCrmRules row indices:
  // row 0: headers
  // row 1..8: Dashboard compare (A59:C66 for Pipeline, D59:F66 for Confirmed)
  // row 14: CRM compare headers
  // row 15..22: CRM compare (A72:C79 for Pipeline, D72:F79 for Confirmed)
  const parseRuleRows = (startIdx, count, colOffset) => {
    const list = [];
    for (let i = startIdx; i < startIdx + count; i++) {
      const row = dcaCrmRules[i] || [];
      const label = String(row[colOffset] || "").trim();
      const gasAction = String(row[colOffset + 1] || "Include").trim();
      const pmaAction = String(row[colOffset + 2] || "Include").trim();
      if (label) {
        list.push({ label, gasAction, pmaAction });
      }
    }
    return list;
  };

  const crmDiscrepancyRules = {
    dashPipe: parseRuleRows(1, 8, 0),
    dashConf: parseRuleRows(1, 8, 3),
    crmPipe: parseRuleRows(14, 8, 0),
    crmConf: parseRuleRows(14, 8, 3)
  };

  // --------------------------------------------------------------------------
  // Build Normalized Settings Payload
  // --------------------------------------------------------------------------
  const settings = {
    clientName,
    masterSheetId,
    clientSheetId: clientSheetId || "",
    lastSyncedAt: new Date().toISOString(),

    // 1. MAIN (Admin Only)
    main: {
      pulseStartDate: String(keyA1F20[1]?.[1] || "").trim(), // B2
      vatQuarters: String(keyA1F20[5]?.[1] || "").trim(),    // B6
      vatPaymentScheme: String(keyA1F20[7]?.[1] || "").trim(), // B8
      vatRate: String(keyA1F20[8]?.[1] || "").trim(),        // B9
      payeCycle: String(keyA1F20[11]?.[1] || "").trim(),     // B12
      employmentAllowanceEligible: String(keyA1F20[17]?.[1] || "").trim(), // B18
      employmentAllowanceAmount: String(keyA1F20[18]?.[1] || "").trim(),   // B19
      primaryCurrency: String(keyA1F20[16]?.[1] || "").trim() // B17
    },

    // 2. CUSTOMISATION
    customisation: {
      revenueFocus: String(keyA1F20[14]?.[1] || "Revenue").trim(), // B15
      taxPaymentMethod: String(keyA1F20[9]?.[1] || "Standard").trim(), // B10
      currencySymbol: String(keyA1F20[3]?.[3] || "£").trim(),      // D4
      thousandsSeparator: String(keyA1F20[4]?.[3] || ",").trim(),  // D5
      invoiceMethod: String(keyA1F20[7]?.[5] || "Lines").trim(),   // F8
      profitSharePercent: String(keyA1F20[10]?.[5] || "0%").trim(), // F11
      profitShareAccrual: String(keyA1F20[11]?.[5] || "Monthly").trim(), // F12
      profitSharePayment: String(keyA1F20[12]?.[5] || "YearlyM13").trim(), // F13
      kpiColouring: {
        isParentFormula: isKpiParentFormula,
        parentTemplateUrl: keyE1,
        grossProfit: {
          greenAbove: String(keyA120B141[3]?.[1] || "").trim(),   // B123
          orangeAbove: String(keyA120B141[4]?.[1] || "").trim()   // B124
        },
        overheads: {
          redAbove: String(keyA120B141[8]?.[1] || "").trim(),     // B128
          greenAbove: String(keyA120B141[9]?.[1] || "").trim()    // B129
        },
        operatingProfit: {
          greenAbove: String(keyA120B141[13]?.[1] || "").trim(),  // B133
          orangeAbove: String(keyA120B141[14]?.[1] || "").trim()  // B134
        },
        staffCostsRatio: {
          redAbove: String(keyA120B141[18]?.[1] || "").trim(),    // B138
          orangeAbove: String(keyA120B141[19]?.[1] || "").trim(), // B139
          greenAbove: String(keyA120B141[20]?.[1] || "").trim()   // B140
        }
      }
    },

    // 3. ACCOUNTING
    accounting: {
      toolInUse: String(keyQ1Q10[3]?.[0] || "None").trim(), // Q4
      contractorsManual: (keyATContr || []).map(r => String(r[0] || "").trim()).filter(Boolean),
      passThroughManual: (keyATPass || []).map(r => String(r[0] || "").trim()).filter(Boolean),
      mappings: accountingMappings
    },

    // 4. CRM
    crm: {
      toolInUse: String(keyQ1Q10[7]?.[0] || "None").trim(), // Q8
      crmDrives: String(keyQ1Q10[8]?.[0] || "Pipeline").trim(), // Q9
      googleSheetUrl: String(keyX14X41[0]?.[0] || "").trim(),   // X14
      googleSheetTab: String(keyX14X41[1]?.[0] || "").trim(),   // X15
      clickUpListId: String(keyX14X41[2]?.[0] || "").trim(),    // X16
      clickUpViewId: String(keyX14X41[3]?.[0] || "").trim(),    // X17
      mondayBoardId: String(keyX14X41[10]?.[0] || "").trim(),   // X24
      excel: {
        azureTenantId: String(keyX14X41[19]?.[0] || "").trim(), // X33
        azureClientId: String(keyX14X41[20]?.[0] || "").trim(), // X34
        azureClientSecret: String(keyX14X41[21]?.[0] || "").trim(), // X35
        driveId: String(keyX14X41[22]?.[0] || "").trim(),       // X36
        fileId: String(keyX14X41[23]?.[0] || "").trim(),        // X37
        worksheetName: String(keyX14X41[24]?.[0] || "").trim(), // X38
        range: String(keyX14X41[25]?.[0] || "").trim(),         // X39
        columnRow: String(keyX14X41[26]?.[0] || "").trim(),     // X40
        keyHeaders: String(keyX14X41[27]?.[0] || "").trim()     // X41
      }
    },

    // 5. CRM STATUS MAPPING
    crmStatusMapping: crmStatusMappings,

    // 6. JOBS (Date Adjustment, Product Lines, Lead Sources)
    jobs: {
      dateAdjustment: {
        projectStartDate: String(keyA1F20[14]?.[5] || "").trim(), // F15
        projectEndDate: String(keyA1F20[15]?.[5] || "").trim(),   // F16
        retainerDates: String(keyA1F20[16]?.[5] || "").trim(),    // F17
        retainerDur: String(keyA1F20[17]?.[5] || "").trim(),      // F18
        moveCrmDatesIfPast: String(keyA1F20[18]?.[5] || "").trim() // F19
      },
      productLines: productLines,
      productLineMappings: productLineMappings,
      leadSources: leadSources,
      leadSourceMappings: leadSourceMappings
    },

    // 7. AUTOMATION (Admin Only)
    automation: {
      frequencies: {
        invoices: String(dcaY1Y5[1]?.[0] || "").trim(), // Y2
        crm: String(dcaY1Y5[2]?.[0] || "").trim(),      // Y3
        expenses: String(dcaY1Y5[3]?.[0] || "").trim()  // Y4
      },
      invoices: {
        monthsToCompare: String(dcaInv[1]?.[1] || "6").trim(),     // B32
        monthsForOthers: String(dcaInv[2]?.[1] || "6").trim(),     // B33
        handlingMethod: String(dcaInv[8]?.[3] || "Look for slot").trim(), // D39
        monthTolerance: String(dcaInv[8]?.[5] || "0").trim(),      // F39
        includeHalfThird: String(dcaInv[8]?.[7] || "Yes").trim(),  // H39
        defaultProjectInvoiceDetails: String(dcaInv[19]?.[1] || "50-50").trim(), // B50
        defaultRetainerInvoiceDate: String(dcaInv[20]?.[1] || "28").trim(),      // B51
        defaultDaysToPay: String(dcaInv[21]?.[1] || "30").trim(),                // B52
        updateDaysToPayNewMonth: String(dcaInv[16]?.[1] || "Yes").trim(),        // B47
        createInvoiceRowsRetainers: String(dcaInv[17]?.[1] || "Yes").trim(),     // B48
        discrepancies: {
          missingInvoice: String(dcaInv[8]?.[1] || "Include").trim(),  // B39
          clientMismatch: String(dcaInv[9]?.[1] || "Include").trim(),  // B40
          invAmtMismatch: String(dcaInv[10]?.[1] || "Include").trim(), // B41
          sentDateMismatch: String(dcaInv[11]?.[1] || "Include").trim(), // B42
          duplicateInvNo: String(dcaInv[12]?.[1] || "Ignore").trim(),  // B43
          fullyPaidMismatch: String(dcaInv[13]?.[1] || "Include").trim(), // B44
          statusMismatch: String(dcaInv[14]?.[1] || "Include").trim(), // B45
          selectDuplicateOverride: String(dcaInv[15]?.[1] || "Yes").trim() // B46
        }
      },
      expenses: {
        monthsToCompare: String(dcaExp[1]?.[1] || "6").trim(),      // B101
        monthsForOthers: String(dcaExp[2]?.[1] || "6").trim(),      // B102
        defaultDirectCostDetails: String(dcaExp[5]?.[1] || "50-50").trim(), // B105
        defaultRetainerExpenseDate: String(dcaExp[6]?.[1] || "28").trim(),   // B106
        handlingMethod: String(dcaExp[11]?.[7] || "Look for slot").trim(),   // H111
        monthTolerance: String(dcaExp[11]?.[9] || "0").trim(),      // J111
        discrepancies: {
          missingCost: String(dcaExp[11]?.[1] || "Include").trim(),     // B111
          duplicateAppId: String(dcaExp[12]?.[1] || "Ignore").trim(),   // B112
          descrMismatch: String(dcaExp[13]?.[1] || "Include").trim(),   // B113
          amountMismatch: String(dcaExp[14]?.[1] || "Include").trim(),  // B114
          vatMismatch: String(dcaExp[15]?.[1] || "Include").trim(),     // B115
          recDateMismatch: String(dcaExp[16]?.[1] || "Include").trim(), // B116
          payDateMismatch: String(dcaExp[17]?.[1] || "Include").trim(), // B117
          statusMismatch: String(dcaExp[18]?.[1] || "Include").trim()   // B118
        }
      },
      crm: {
        monthsToCompare: String(dcaInv[24]?.[1] || "6").trim(), // B55
        monthsForOthers: String(dcaInv[25]?.[1] || "6").trim(), // B56 (approx)
        pipelineAddJobsToConf: String(dcaB82 || "Yes").trim(),  // B82
        rules: crmDiscrepancyRules
      }
    },

    // 8. PULSE (Client Sheet AppData)
    pulse: {
      showStaffCostsRatio: String(appDataW[0]?.[0] || "Yes").trim(), // W42
      showCashMenu: String(appDataW[1]?.[0] || "Yes").trim(),        // W43
      showBudget: String(appDataW[2]?.[0] || "Yes").trim(),          // W44
      showCashflowChart: String(appDataG59 || "Yes").trim(),         // G59
      showLast12MonthsChart: String(appDataG71 || "Yes").trim(),     // G71
      showTrendlines: String(appDataI71 || "Yes").trim()             // I71
    }
  };

  // 3. Save to Redis
  if (redisClient?.isOpen) {
    try {
      await redisClient.set(redisKey, JSON.stringify(settings), { EX: REDIS_SETTINGS_TTL });
    } catch (err) {
      console.warn("⚠️ Failed to store client settings in Redis:", err.message);
    }
  }

  return { ...settings, fromCache: false };
}

/**
 * Saves modified client settings to Master and Client Google Sheets,
 * and updates the Redis cache immediately.
 */
export async function saveClientSettings({
  clientName,
  masterSheetId,
  clientSheetId,
  settings,
  resetKpiToParent = false
}) {
  if (!clientName || !masterSheetId || !settings) {
    throw new Error("Missing clientName, masterSheetId, or settings payload.");
  }

  const sheets = await getSheetsClient();
  const masterUpdates = [];
  const clientUpdates = [];

  // Helper for single cell update
  const addMasterCell = (range, val) => {
    if (val !== undefined && val !== null) {
      masterUpdates.push({ range, values: [[String(val)]] });
    }
  };
  const addClientCell = (range, val) => {
    if (val !== undefined && val !== null && clientSheetId) {
      clientUpdates.push({ range, values: [[String(val)]] });
    }
  };

  // Helper for 1D column arrays (e.g. BA2:BA17, AT4:AT22)
  const addMasterColumnSlice = (startColLetter, startRow, endRow, items) => {
    const totalRows = endRow - startRow + 1;
    const values = [];
    for (let i = 0; i < totalRows; i++) {
      values.push([items[i] !== undefined ? String(items[i]) : ""]);
    }
    masterUpdates.push({
      range: `KeyInfo!${startColLetter}${startRow}:${startColLetter}${endRow}`,
      values
    });
  };

  // 1. MAIN (KeyInfo)
  if (settings.main) {
    addMasterCell("KeyInfo!B2", settings.main.pulseStartDate);
    addMasterCell("KeyInfo!B6", settings.main.vatQuarters);
    addMasterCell("KeyInfo!B8", settings.main.vatPaymentScheme);
    addMasterCell("KeyInfo!B9", settings.main.vatRate);
    addMasterCell("KeyInfo!B12", settings.main.payeCycle);
    addMasterCell("KeyInfo!B17", settings.main.primaryCurrency);
    addMasterCell("KeyInfo!B18", settings.main.employmentAllowanceEligible);
    if (settings.main.employmentAllowanceAmount) {
      addMasterCell("KeyInfo!B19", settings.main.employmentAllowanceAmount);
    }
  }

  // 2. CUSTOMISATION (KeyInfo)
  if (settings.customisation) {
    addMasterCell("KeyInfo!B15", settings.customisation.revenueFocus);
    addMasterCell("KeyInfo!B10", settings.customisation.taxPaymentMethod);
    addMasterCell("KeyInfo!D4", settings.customisation.currencySymbol);
    addMasterCell("KeyInfo!D5", settings.customisation.thousandsSeparator);
    addMasterCell("KeyInfo!F8", settings.customisation.invoiceMethod);
    addMasterCell("KeyInfo!F11", settings.customisation.profitSharePercent);
    addMasterCell("KeyInfo!F12", settings.customisation.profitShareAccrual);
    addMasterCell("KeyInfo!F13", settings.customisation.profitSharePayment);

    // KPI Colouring Rules
    if (resetKpiToParent) {
      // Restore the template IMPORTRANGE formula and clear downstream cells
      const clearBlankRows = Array.from({ length: 21 }, () => ["", ""]);
      clearBlankRows[0] = ['=importrange(KeyInfo!$E$1,"KeyInfo!A120:B140")', ""];
      masterUpdates.push({
        range: "KeyInfo!A120:B140",
        values: clearBlankRows
      });
    } else if (settings.customisation.kpiColouring) {
      const k = settings.customisation.kpiColouring;
      // Write full static 2D block to cleanly replace importrange without #REF! spill
      const kpiBlock = [
        ["KPI colouring rules", ""],
        ["", ""],
        ["Gross profit", ""],
        ["Green is above:", String(k.grossProfit?.greenAbove || "")],
        ["Orange is above / red is below", String(k.grossProfit?.orangeAbove || "")],
        ["", ""],
        ["", ""],
        ["Overheads", ""],
        ["Red is above", String(k.overheads?.redAbove || "")],
        ["Orange is below, green is above", String(k.overheads?.greenAbove || "")],
        ["", ""],
        ["", ""],
        ["Operating profit", ""],
        ["Green is above", String(k.operatingProfit?.greenAbove || "")],
        ["Orange is above, red is below", String(k.operatingProfit?.orangeAbove || "")],
        ["", ""],
        ["", ""],
        ["Staff costs to income / revenue ratio", ""],
        ["Red is above", String(k.staffCostsRatio?.redAbove || "")],
        ["Orange is above", String(k.staffCostsRatio?.orangeAbove || "")],
        ["Green is above, orange below", String(k.staffCostsRatio?.greenAbove || "")]
      ];
      masterUpdates.push({
        range: "KeyInfo!A120:B140",
        values: kpiBlock
      });
    }
  }

  // 3. ACCOUNTING (KeyInfo)
  if (settings.accounting) {
    if (settings.accounting.toolInUse) {
      addMasterCell("KeyInfo!Q4", settings.accounting.toolInUse);
    }
    if (Array.isArray(settings.accounting.contractorsManual)) {
      addMasterColumnSlice("AT", 4, 22, settings.accounting.contractorsManual);
    }
    if (Array.isArray(settings.accounting.passThroughManual)) {
      addMasterColumnSlice("AT", 24, 40, settings.accounting.passThroughManual);
    }
    if (settings.accounting.mappings) {
      const m = settings.accounting.mappings;
      if (Array.isArray(m.revenue)) addMasterColumnSlice("BA", 2, 17, m.revenue);
      if (Array.isArray(m.cosStaffCosts)) addMasterColumnSlice("BA", 19, 33, m.cosStaffCosts);
      if (Array.isArray(m.nonCosStaffCosts)) addMasterColumnSlice("BA", 35, 48, m.nonCosStaffCosts);
      if (Array.isArray(m.corporationTax)) addMasterColumnSlice("BA", 50, 52, m.corporationTax);
      if (Array.isArray(m.depreciation)) addMasterColumnSlice("BA", 54, 56, m.depreciation);
      if (Array.isArray(m.otherCostOfSale)) addMasterColumnSlice("BA", 59, 78, m.otherCostOfSale);
      if (Array.isArray(m.nonOperatingIncome)) addMasterColumnSlice("BA", 81, 99, m.nonOperatingIncome);
      if (Array.isArray(m.nonOperatingExpenses)) addMasterColumnSlice("BA", 101, 126, m.nonOperatingExpenses);
      if (Array.isArray(m.ignore)) addMasterColumnSlice("BA", 128, 180, m.ignore);
    }
  }

  // 4. CRM (KeyInfo)
  if (settings.crm) {
    if (settings.crm.toolInUse) addMasterCell("KeyInfo!Q8", settings.crm.toolInUse);
    if (settings.crm.crmDrives) addMasterCell("KeyInfo!Q9", settings.crm.crmDrives);

    // Conditional Tool fields
    addMasterCell("KeyInfo!X14", settings.crm.googleSheetUrl || "");
    addMasterCell("KeyInfo!X15", settings.crm.googleSheetTab || "");
    addMasterCell("KeyInfo!X16", settings.crm.clickUpListId || "");
    addMasterCell("KeyInfo!X17", settings.crm.clickUpViewId || "");
    addMasterCell("KeyInfo!X24", settings.crm.mondayBoardId || "");

    if (settings.crm.excel) {
      const ex = settings.crm.excel;
      addMasterCell("KeyInfo!X33", ex.azureTenantId || "");
      addMasterCell("KeyInfo!X34", ex.azureClientId || "");
      addMasterCell("KeyInfo!X35", ex.azureClientSecret || "");
      addMasterCell("KeyInfo!X36", ex.driveId || "");
      addMasterCell("KeyInfo!X37", ex.fileId || "");
      addMasterCell("KeyInfo!X38", ex.worksheetName || "");
      addMasterCell("KeyInfo!X39", ex.range || "");
      addMasterCell("KeyInfo!X40", ex.columnRow || "");
      addMasterCell("KeyInfo!X41", ex.keyHeaders || "");
    }
  }

  // 5. CRM STATUS MAPPING (KeyInfo!L32:N75)
  if (Array.isArray(settings.crmStatusMapping)) {
    const rows = [];
    for (let r = 0; r < 44; r++) {
      const item = settings.crmStatusMapping[r];
      if (item && item.status) {
        rows.push([item.status, item.likelihood || "", item.startDateRule || ""]);
      } else {
        rows.push(["", "", ""]);
      }
    }
    masterUpdates.push({
      range: "KeyInfo!L32:N75",
      values: rows
    });
  }

  // 6. JOBS (Date Adjustment, Product Lines, Lead Sources)
  if (settings.jobs) {
    if (settings.jobs.dateAdjustment) {
      const da = settings.jobs.dateAdjustment;
      addMasterCell("KeyInfo!F15", da.projectStartDate);
      addMasterCell("KeyInfo!F16", da.projectEndDate);
      addMasterCell("KeyInfo!F17", da.retainerDates);
      addMasterCell("KeyInfo!F18", da.retainerDur);
      addMasterCell("KeyInfo!F19", da.moveCrmDatesIfPast);
    }
    if (Array.isArray(settings.jobs.productLines)) {
      addMasterColumnSlice("B", 23, 37, settings.jobs.productLines);
    }
    if (Array.isArray(settings.jobs.productLineMappings)) {
      const rows = [];
      for (let r = 0; r < 41; r++) {
        const item = settings.jobs.productLineMappings[r];
        if (item && (item.crmProductLine || item.mappedTo)) {
          rows.push([item.crmProductLine || "", item.mappedTo || ""]);
        } else {
          rows.push(["", ""]);
        }
      }
      masterUpdates.push({ range: "KeyInfo!D22:E62", values: rows });
    }
    if (Array.isArray(settings.jobs.leadSources)) {
      addMasterColumnSlice("G", 63, 72, settings.jobs.leadSources);
    }
    if (Array.isArray(settings.jobs.leadSourceMappings)) {
      const rows = [];
      for (let r = 0; r < 44; r++) {
        const item = settings.jobs.leadSourceMappings[r];
        if (item && (item.crmSource || item.mappedTo)) {
          rows.push([item.crmSource || "", item.mappedTo || ""]);
        } else {
          rows.push(["", ""]);
        }
      }
      masterUpdates.push({ range: "KeyInfo!I32:J75", values: rows });
    }
  }

  // 7. AUTOMATION (DataChgAlert)
  if (settings.automation) {
    const a = settings.automation;
    if (a.frequencies) {
      addMasterCell("DataChgAlert!Y2", a.frequencies.invoices);
      addMasterCell("DataChgAlert!Y3", a.frequencies.crm);
      addMasterCell("DataChgAlert!Y4", a.frequencies.expenses);
    }
    if (a.invoices) {
      addMasterCell("DataChgAlert!B32", a.invoices.monthsToCompare);
      addMasterCell("DataChgAlert!B33", a.invoices.monthsForOthers);
      addMasterCell("DataChgAlert!D39", a.invoices.handlingMethod);
      addMasterCell("DataChgAlert!F39", a.invoices.monthTolerance);
      addMasterCell("DataChgAlert!H39", a.invoices.includeHalfThird);
      addMasterCell("DataChgAlert!B50", a.invoices.defaultProjectInvoiceDetails);
      addMasterCell("DataChgAlert!B51", a.invoices.defaultRetainerInvoiceDate);
      addMasterCell("DataChgAlert!B52", a.invoices.defaultDaysToPay);
      addMasterCell("DataChgAlert!B47", a.invoices.updateDaysToPayNewMonth);
      addMasterCell("DataChgAlert!B48", a.invoices.createInvoiceRowsRetainers);
      if (a.invoices.discrepancies) {
        const d = a.invoices.discrepancies;
        addMasterCell("DataChgAlert!B39", d.missingInvoice);
        addMasterCell("DataChgAlert!B40", d.clientMismatch);
        addMasterCell("DataChgAlert!B41", d.invAmtMismatch);
        addMasterCell("DataChgAlert!B42", d.sentDateMismatch);
        addMasterCell("DataChgAlert!B43", d.duplicateInvNo);
        addMasterCell("DataChgAlert!B44", d.fullyPaidMismatch);
        addMasterCell("DataChgAlert!B45", d.statusMismatch);
        addMasterCell("DataChgAlert!B46", d.selectDuplicateOverride);
      }
    }
    if (a.expenses) {
      addMasterCell("DataChgAlert!B101", a.expenses.monthsToCompare);
      addMasterCell("DataChgAlert!B102", a.expenses.monthsForOthers);
      addMasterCell("DataChgAlert!B105", a.expenses.defaultDirectCostDetails);
      addMasterCell("DataChgAlert!B106", a.expenses.defaultRetainerExpenseDate);
      addMasterCell("DataChgAlert!H111", a.expenses.handlingMethod);
      addMasterCell("DataChgAlert!J111", a.expenses.monthTolerance);
      if (a.expenses.discrepancies) {
        const d = a.expenses.discrepancies;
        addMasterCell("DataChgAlert!B111", d.missingCost);
        addMasterCell("DataChgAlert!B112", d.duplicateAppId);
        addMasterCell("DataChgAlert!B113", d.descrMismatch);
        addMasterCell("DataChgAlert!B114", d.amountMismatch);
        addMasterCell("DataChgAlert!B115", d.vatMismatch);
        addMasterCell("DataChgAlert!B116", d.recDateMismatch);
        addMasterCell("DataChgAlert!B117", d.payDateMismatch);
        addMasterCell("DataChgAlert!B118", d.statusMismatch);
      }
    }
    if (a.crm) {
      addMasterCell("DataChgAlert!B55", a.crm.monthsToCompare);
      addMasterCell("DataChgAlert!B56", a.crm.monthsForOthers);
      addMasterCell("DataChgAlert!B82", a.crm.pipelineAddJobsToConf);
      if (a.crm.rules) {
        // Save dual-action CRM rules
        const writeRules = (startRow, colOffset, ruleList) => {
          if (!Array.isArray(ruleList)) return;
          ruleList.forEach((rule, idx) => {
            const rNum = startRow + idx;
            const gasCol = colOffset === 0 ? "B" : "E";
            const pmaCol = colOffset === 0 ? "C" : "F";
            if (rule.gasAction) addMasterCell(`DataChgAlert!${gasCol}${rNum}`, rule.gasAction);
            if (rule.pmaAction) addMasterCell(`DataChgAlert!${pmaCol}${rNum}`, rule.pmaAction);
          });
        };
        writeRules(59, 0, a.crm.rules.dashPipe);
        writeRules(59, 3, a.crm.rules.dashConf);
        writeRules(72, 0, a.crm.rules.crmPipe);
        writeRules(72, 3, a.crm.rules.crmConf);
      }
    }
  }

  // 8. PULSE (Client Sheet AppData)
  if (settings.pulse && clientSheetId) {
    addClientCell("AppData!W42", settings.pulse.showStaffCostsRatio);
    addClientCell("AppData!W43", settings.pulse.showCashMenu);
    addClientCell("AppData!W44", settings.pulse.showBudget);
    addClientCell("AppData!G59", settings.pulse.showCashflowChart);
    addClientCell("AppData!G71", settings.pulse.showLast12MonthsChart);
    addClientCell("AppData!I71", settings.pulse.showTrendlines);
  }

  // Execute Master batchUpdate
  if (masterUpdates.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: masterSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: masterUpdates
      }
    }));
  }

  // Execute Client batchUpdate
  if (clientUpdates.length > 0 && clientSheetId) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: clientSheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: clientUpdates
      }
    }));
  }

  // Update Redis cache immediately
  const redisKey = getSettingsRedisKey(clientName);
  const updatedSettings = {
    ...settings,
    lastSyncedAt: new Date().toISOString()
  };

  if (redisClient?.isOpen) {
    try {
      await redisClient.set(redisKey, JSON.stringify(updatedSettings), { EX: REDIS_SETTINGS_TTL });
    } catch (err) {
      console.warn("⚠️ Failed to update Redis cache after save:", err.message);
    }
  }

  return { success: true, savedAt: updatedSettings.lastSyncedAt };
}
