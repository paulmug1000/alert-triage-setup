import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import Spinner from "./Spinner";
import EditClientSelector from "./EditClientSelector";

const SECTIONS = [
  { id: "main", label: "Main", icon: "🏢", adminOnly: true },
  { id: "customisation", label: "Customisation", icon: "🎨" },
  { id: "accounting", label: "Accounting", icon: "📊" },
  { id: "crm", label: "CRM", icon: "👥" },
  { id: "jobs", label: "Jobs", icon: "📁" },
  { id: "automation", label: "Automations", icon: "⚡", adminOnly: true },
  { id: "pulse", label: "Pulse portal", icon: "📱" }
];

// Exact options matching Google Sheets data validation
const VAT_QUARTERS_OPTIONS = [
  "Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec",
  "Feb-Apr, May-Jul, Aug-Oct, Nov-Jan",
  "Mar-May, Jun-Aug, Sep-Nov, Dec-Feb"
];

const VAT_PAYMENT_SCHEME_OPTIONS = [
  "Accrual",
  "Cash"
];

const PRIMARY_CURRENCY_OPTIONS = [
  "GBP",
  "EUR",
  "USD"
];

const TAX_PAYMENT_METHOD_OPTIONS = [
  "Standard",
  "Transfers"
];

const CURRENCY_SYMBOL_OPTIONS = ["£", "$", "€"];
const THOUSANDS_SEPARATOR_OPTIONS = [",", "."];
const INVOICE_METHOD_OPTIONS = ["Whole", "Lines"];
const REVENUE_FOCUS_OPTIONS = ["Revenue", "Income"];
const PAYE_CYCLE_OPTIONS = ["Monthly", "Quarterly"];
const YES_NO_OPTIONS = ["Yes", "No"];

const PROFIT_SHARE_ACCRUE_OPTIONS = ["None", "Monthly"];
const PROFIT_SHARE_PAYMENT_OPTIONS = [
  "None",
  "YearlyM12",
  "YearlyM13",
  "YearlyM14",
  "YearlyM15",
  "YearlyM16"
];

const ACCOUNTING_TOOL_OPTIONS = ["None", "Xero", "Quickbooks"];

const CRM_TOOL_OPTIONS = [
  "None",
  "ClickUp",
  "Close",
  "Capsule",
  "Pipedrive",
  "Monday",
  "Google Sheet",
  "HubSpot",
  "Excel"
];

const CRM_DRIVES_OPTIONS = ["NA", "Pipeline", "PipeAndConf"];

const PROJECT_DATE_ADJUST_OPTIONS = [
  "Raw dates",
  "5-day adjust",
  "10-day adjust",
  "15-day adjust"
];

const RETAINER_DATES_OPTIONS = [
  "Raw date",
  "10-day min",
  "15-day min",
  "20-day min"
];

const RETAINER_DUR_OPTIONS = [
  "Raw date rounding",
  "Any day down bias",
  "25-day down bias",
  "20-day down bias",
  "10-day up bias",
  "5-day up bias",
  "Any day up bias"
];

const MOVE_CRM_DATES_OPTIONS = [
  "No",
  "Yes - to curr month",
  "Yes - to next month",
  "Yes - to m+2",
  "Yes - curr if before 20th"
];

const CRM_START_DATE_RULES = ["1", "2", "3", "4", "5", "6"];

const FREQUENCY_OPTIONS = [
  "30 mins",
  "1 hr",
  "2 hrs",
  "4 hrs",
  "8 hrs",
  "12 hrs",
  "24 hrs",
  "Week",
  "2 weeks",
  "4 weeks",
  "Month on 1st",
  "Month on 5th",
  "Month on 10th"
];

const MONTHS_COMPARE_OPTIONS = ["1", "3", "6", "7", "12", "13"];

const INVOICE_HANDLING_METHOD_OPTIONS = [
  "None",
  "Look for slot",
  "Create new job",
  "Look then create"
];

const EXPENSE_HANDLING_METHOD_OPTIONS = [
  "None",
  "Look for slot",
  "Look then create"
];

const DEFAULT_INVOICING_DETAILS_OPTIONS = [
  "None",
  "100 at end",
  "50-50",
  "50-25-25",
  "25-25-50",
  "25-75",
  "33-33-33",
  "Even-Split"
];

const DISCREPANCY_GAS_OPTIONS = ["Include", "Exclude", "Ignore"];
const DISCREPANCY_PMA_OPTIONS = ["Include", "Ignore"];

const INVOICE_NUMBER_FORMATTING_OPTIONS = [
  { value: "StripPre", label: "Strip prefix (StripPre)" },
  { value: "Full", label: "Full reference (Full)" },
  { value: "Right5", label: "Right-hand 5 digits (Right5)" },
  { value: "Right4", label: "Right-hand 4 digits (Right4)" },
  { value: "Right3", label: "Right-hand 3 digits (Right3)" }
];

const EXPENSE_STATUS_MAPPING_OPTIONS = [
  { value: "Actual", label: "Actual" },
  { value: "Xero conv", label: "Xero conv" },
  { value: "QB conv", label: "QB conv" }
];

const CRM_PULSE_FIELDS = [
  { key: "client", label: "Client", colLetter: "A", crmColLetter: "AB", defaultFormat: "Other", formatOptions: ["Other", "String"] },
  { key: "job", label: "Job", colLetter: "B", crmColLetter: "AC", defaultFormat: "", formatOptions: [] },
  { key: "projectCode", label: "Project code", colLetter: "C", crmColLetter: "AD", defaultFormat: "", formatOptions: [] },
  { key: "revenue", label: "Revenue", colLetter: "D", crmColLetter: "AE", defaultFormat: "Actual", formatOptions: ["Actual", "Strip value"] },
  { key: "directCosts", label: "Direct costs", colLetter: "E", crmColLetter: "AF", defaultFormat: "", formatOptions: [] },
  { key: "startDate", label: "Start date", colLetter: "F", crmColLetter: "AG", defaultFormat: "Actual", formatOptions: ["Actual", "Convert US", "Actual OR by Status"] },
  {
    key: "endDate",
    label: "End date",
    colLetter: "G",
    crmColLetter: "AH",
    defaultFormat: "Actual",
    formatOptions: [
      "Actual",
      "Months",
      "AddRetEnd",
      "2MonthsForAll",
      "3MonthsForAll",
      "4MonthsForAll",
      "ActualOr2MonthsForAll",
      "ActualOr3MonthsForAll",
      "ActualOr4MonthsForAll",
      "MonthsOr2MonthsForAll",
      "MonthsOr3MonthsForAll",
      "MonthsOr4MonthsForAll",
      "2MonthsProj6MonthsRet",
      "ActualOrAddRetEndOr2MonthsProj",
      "ActualOrAddRetEndOr3MonthsProj",
      "ActualOrAddRetEndOr4MonthsProj"
    ]
  },
  { key: "likelihood", label: "Likelihood", colLetter: "H", crmColLetter: "AI", defaultFormat: "Actual", formatOptions: ["Actual", "Divide by 100", "Mapped", "ActualOrMappedByStatus"] },
  { key: "status", label: "Status", colLetter: "I", crmColLetter: "AJ", defaultFormat: "", formatOptions: [] },
  {
    key: "projectRetainer",
    label: "Project / retainer",
    colLetter: "J",
    crmColLetter: "AK",
    defaultFormat: "From CRM",
    formatOptions: [
      "From CRM",
      "All project",
      "All retainer",
      "FromCRMOrAllProject",
      "FromCRMOrAllRetainer",
      "FromCRMConvertOrAllProject",
      "FromCRMConvertOrAllRetainer"
    ]
  },
  { key: "leadSource", label: "Lead source", colLetter: "K", crmColLetter: "AL", defaultFormat: "Mapped", formatOptions: ["Mapped", "Actual"] },
  { key: "dateAddedToPipeline", label: "Date added to pipeline", colLetter: "L", crmColLetter: "AM", defaultFormat: "", formatOptions: [] },
  { key: "productLine", label: "Product line", colLetter: "M", crmColLetter: "AN", defaultFormat: "Mapped", formatOptions: ["Mapped", "Actual"] }
];

function formatInvoiceNumber(raw, setting) {
  if (!raw) return "";
  const str = String(raw).trim();
  switch (setting) {
    case "Full":
      return str;
    case "StripPre":
      return str.replace(/^[^-]+-/, "");
    case "Right5":
      return str.slice(-5);
    case "Right4": {
      const match = str.match(/\d+/g);
      const digits = match ? match.join("") : str;
      return digits.slice(-4);
    }
    case "Right3": {
      const match = str.match(/\d+/g);
      const digits = match ? match.join("") : str;
      return digits.slice(-3);
    }
    default:
      return str;
  }
}

function parseDateToJsDate(val) {
  if (val === undefined || val === null) return null;
  const str = String(val).trim();
  if (!str) return null;

  // 1. Check for numeric Excel serial number (30000 to 60000) or epoch ms/seconds
  const num = parseFloat(str);
  if (!isNaN(num) && /^\d+(\.\d+)?$/.test(str)) {
    if (num > 30000 && num < 60000) {
      return new Date(Math.round((num - 25569) * 86400 * 1000));
    }
    if (num > 1000000000000 && num < 2500000000000) {
      return new Date(num);
    }
    if (num > 1000000000 && num < 2500000000) {
      return new Date(num * 1000);
    }
  }

  // 2. Separate date part from time part if present (e.g. "15/04/2026 15:33", "2026-04-15 15:33:00", "2026-04-15T15:33:00.000Z")
  let datePart = str;
  if (str.includes("T")) {
    datePart = str.split("T")[0];
  } else if (str.includes(" ")) {
    datePart = str.split(" ")[0];
  }

  // 3. Try DD/MM/YYYY or DD-MM-YYYY or YYYY-MM-DD
  const parts = datePart.split(/[\/\-\.]/);
  if (parts.length === 3) {
    const p0 = parseInt(parts[0], 10);
    const p1 = parseInt(parts[1], 10);
    const p2Str = parts[2];
    const p0Str = parts[0];

    if (p0Str.length === 4) {
      const year = p0;
      const month = p1 - 1;
      const day = parseInt(p2Str, 10);
      if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
        const testDate = new Date(year, month, day);
        if (!isNaN(testDate.getTime())) return testDate;
      }
    } else {
      const day = p0;
      const month = p1 - 1;
      const year = parseInt(p2Str.length === 2 ? "20" + p2Str : p2Str, 10);
      if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
        const testDate = new Date(year, month, day);
        if (!isNaN(testDate.getTime())) return testDate;
      }
    }
  }

  // 4. Try month name format: e.g. 15-Apr-2026, 15-Apr-26, 15 Apr 2026
  const monthNameMatch = str.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})/);
  if (monthNameMatch) {
    const day = parseInt(monthNameMatch[1], 10);
    const mStr = monthNameMatch[2].slice(0, 3).toLowerCase();
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(mStr);
    const yStr = monthNameMatch[3];
    const year = parseInt(yStr.length === 2 ? "20" + yStr : yStr, 10);
    if (month !== -1 && day >= 1 && day <= 31) {
      const testDate = new Date(year, month, day);
      if (!isNaN(testDate.getTime())) return testDate;
    }
  }

  const d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  return null;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatJsDate(date) {
  if (!date || isNaN(date.getTime())) return "";
  const d = date.getDate();
  const m = MONTH_NAMES[date.getMonth()];
  const y = String(date.getFullYear()).slice(-2);
  return `${d}-${m}-${y}`;
}

function edate(date, months) {
  const d = new Date(date.getTime());
  const targetMonth = d.getMonth() + months;
  d.setMonth(targetMonth);
  const expectedMonth = ((targetMonth % 12) + 12) % 12;
  if (d.getMonth() !== expectedMonth) {
    d.setDate(0);
  }
  return d;
}

function formatExcelOrStringDate(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  const parsed = parseDateToJsDate(raw);
  if (parsed) return formatJsDate(parsed);
  return String(raw).trim();
}

function transformCrmRows({
  headers = [],
  rawRows = [],
  fieldMappings = [],
  jobDefinitions = {},
  crmStatusMappings = [],
  leadSourceMappings = [],
  productLineMappings = []
}) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return { mappedJobs: [], confirmedJobs: [], pipelineJobs: [] };
  }

  const colIndexMap = {};
  headers.forEach((h, idx) => {
    if (h) colIndexMap[String(h).trim().toLowerCase()] = idx;
  });

  const getRawVal = (row, fieldHeader) => {
    if (!fieldHeader) return "";
    const idx = colIndexMap[String(fieldHeader).trim().toLowerCase()];
    if (idx === undefined || idx === -1) return "";
    return row[idx] !== undefined && row[idx] !== null ? String(row[idx]).trim() : "";
  };

  const statusLookup = {};
  (crmStatusMappings || []).forEach(m => {
    if (m?.status) statusLookup[String(m.status).trim().toLowerCase()] = m;
  });

  const leadLookup = {};
  (leadSourceMappings || []).forEach(m => {
    const raw = String(m?.crmSource || m?.crmValue || "").trim().toLowerCase();
    if (raw) leadLookup[raw] = m.mappedTo || m.mappedSource || "";
  });

  const productLookup = {};
  (productLineMappings || []).forEach(m => {
    const raw = String(m?.crmProductLine || m?.crmValue || "").trim().toLowerCase();
    if (raw) productLookup[raw] = m.mappedTo || m.productLine || "";
  });

  const getMappingForField = (fieldKey, defaultFormat) => {
    const found = fieldMappings.find(m => m.key === fieldKey);
    return {
      crmField: found?.crmField || "",
      formatRule: found?.formatRule !== undefined ? found.formatRule : defaultFormat
    };
  };

  const mClient = getMappingForField("client", "Other");
  const mJob = getMappingForField("job", "");
  const mProjCode = getMappingForField("projectCode", "");
  const mRevenue = getMappingForField("revenue", "Actual");
  const mCosts = getMappingForField("directCosts", "");
  const mStartDate = getMappingForField("startDate", "Actual");
  const mEndDate = getMappingForField("endDate", "Actual");
  const mLikelihood = getMappingForField("likelihood", "Actual");
  const mStatus = getMappingForField("status", "");
  const mProjRet = getMappingForField("projectRetainer", "From CRM");
  const mLead = getMappingForField("leadSource", "Mapped");
  const mDateAdded = getMappingForField("dateAddedToPipeline", "");
  const mProdLine = getMappingForField("productLine", "Mapped");

  const mappedJobs = [];

  for (let r = 0; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || !row.some(cell => String(cell).trim() !== "")) continue;

    // Field 1: Client
    let clientVal = getRawVal(row, mClient.crmField);
    if (mClient.formatRule === "String") {
      const parts = clientVal.split('"');
      if (parts.length >= 8) clientVal = parts[7] || clientVal;
    }

    // Field 2: Job
    const jobVal = getRawVal(row, mJob.crmField);
    if (!clientVal && !jobVal) continue;

    // Field 3: Project code
    const projCodeVal = getRawVal(row, mProjCode.crmField);

    // Field 4: Revenue
    let revVal = getRawVal(row, mRevenue.crmField);
    if (mRevenue.formatRule === "Strip value") {
      const match = revVal.match(/(\d*\.?\d+)/);
      if (match) revVal = match[1];
    }

    // Field 5: Direct costs
    let costVal = getRawVal(row, mCosts.crmField);
    if (!revVal) {
      costVal = "";
    } else if (!costVal) {
      costVal = "0.00";
    }

    // Field 9: Status
    const statusVal = getRawVal(row, mStatus.crmField);

    // Field 6: Start date
    let rawStart = getRawVal(row, mStartDate.crmField);
    let startDateObj = null;
    if (mStartDate.formatRule === "Actual OR by Status") {
      if (!rawStart && statusVal) {
        const found = statusLookup[statusVal.toLowerCase()];
        const offsetMonths = found?.startDateRule ? parseInt(found.startDateRule, 10) : 0;
        const now = new Date();
        startDateObj = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1);
      } else {
        startDateObj = parseDateToJsDate(rawStart);
      }
    } else if (mStartDate.formatRule === "Convert US") {
      const parts = rawStart.split(/[\/,]/);
      if (parts.length >= 3) {
        const m = parseInt(parts[0], 10) - 1;
        const d = parseInt(parts[1], 10);
        const y = parseInt(parts[2].length === 2 ? "20" + parts[2] : parts[2], 10);
        startDateObj = new Date(y, m, d);
      } else {
        startDateObj = parseDateToJsDate(rawStart);
      }
    } else {
      startDateObj = parseDateToJsDate(rawStart);
    }
    const startVal = startDateObj ? formatJsDate(startDateObj) : (rawStart ? formatExcelOrStringDate(rawStart) : "");

    // Field 10: Project / Retainer
    let rawProjRet = getRawVal(row, mProjRet.crmField);
    let projRetVal = rawProjRet;
    const prRule = mProjRet.formatRule || "From CRM";
    if (prRule === "All project") projRetVal = "Project";
    else if (prRule === "All retainer") projRetVal = "Retainer";
    else if (prRule === "FromCRMOrAllProject") projRetVal = rawProjRet || "Project";
    else if (prRule === "FromCRMOrAllRetainer") projRetVal = rawProjRet || "Retainer";
    else if (prRule === "FromCRMConvertOrAllProject") {
      const lower = rawProjRet.toLowerCase();
      if (!rawProjRet) projRetVal = "Project";
      else if (lower.includes("retain")) projRetVal = "Retainer";
      else if (lower.includes("proj")) projRetVal = "Project";
    } else if (prRule === "FromCRMConvertOrAllRetainer") {
      const lower = rawProjRet.toLowerCase();
      if (!rawProjRet) projRetVal = "Retainer";
      else if (lower.includes("retain")) projRetVal = "Retainer";
      else if (lower.includes("proj")) projRetVal = "Project";
      else projRetVal = "Retainer";
    }

    // Field 7: End date
    let endVal = "";
    const rawEnd = getRawVal(row, mEndDate.crmField);
    const endRule = mEndDate.formatRule || "Actual";

    if (startDateObj) {
      const parseRawEndDate = () => {
        const parsed = parseDateToJsDate(rawEnd);
        return parsed ? formatJsDate(parsed) : "";
      };

      const monthsNum = parseFloat(rawEnd);
      const hasValidMonths = !isNaN(monthsNum) && monthsNum > 0;

      const edateMinusOneStr = (m) => {
        const ed = edate(startDateObj, m);
        ed.setDate(ed.getDate() - 1);
        return formatJsDate(ed);
      };

      const edateStr = (m) => {
        return formatJsDate(edate(startDateObj, m));
      };

      const isRetainer = projRetVal === "Retainer";

      switch (endRule) {
        case "Actual":
          endVal = rawEnd ? parseRawEndDate() : "";
          break;
        case "Months":
          endVal = (rawEnd && hasValidMonths) ? edateMinusOneStr(monthsNum) : "";
          break;
        case "AddRetEnd":
          if (!rawEnd && isRetainer) {
            endVal = "No end date";
          } else {
            endVal = rawEnd ? parseRawEndDate() : "";
          }
          break;
        case "2MonthsForAll":
          endVal = edateStr(2);
          break;
        case "3MonthsForAll":
          endVal = edateStr(3);
          break;
        case "4MonthsForAll":
          endVal = edateStr(4);
          break;
        case "ActualOr2MonthsForAll":
          endVal = rawEnd ? parseRawEndDate() : edateStr(2);
          break;
        case "ActualOr3MonthsForAll":
          endVal = rawEnd ? parseRawEndDate() : edateStr(3);
          break;
        case "ActualOr4MonthsForAll":
          endVal = rawEnd ? parseRawEndDate() : edateStr(4);
          break;
        case "MonthsOr2MonthsForAll":
          endVal = (rawEnd && hasValidMonths) ? edateMinusOneStr(monthsNum) : edateStr(2);
          break;
        case "MonthsOr3MonthsForAll":
          endVal = (rawEnd && hasValidMonths) ? edateMinusOneStr(monthsNum) : edateStr(3);
          break;
        case "MonthsOr4MonthsForAll":
          endVal = (rawEnd && hasValidMonths) ? edateMinusOneStr(monthsNum) : edateStr(4);
          break;
        case "2MonthsProj6MonthsRet":
          endVal = isRetainer ? edateStr(6) : edateStr(2);
          break;
        case "ActualOrAddRetEndOr2MonthsProj":
          if (!rawEnd) {
            endVal = isRetainer ? "No end date" : edateStr(2);
          } else {
            endVal = parseRawEndDate();
          }
          break;
        case "ActualOrAddRetEndOr3MonthsProj":
          if (!rawEnd) {
            endVal = isRetainer ? "No end date" : edateStr(3);
          } else {
            endVal = parseRawEndDate();
          }
          break;
        case "ActualOrAddRetEndOr4MonthsProj":
          if (!rawEnd) {
            endVal = isRetainer ? "No end date" : edateStr(4);
          } else {
            endVal = parseRawEndDate();
          }
          break;
        default:
          endVal = rawEnd ? parseRawEndDate() : "";
          break;
      }
      if (/^(31[-/\s]Dec[-/\s](?:20)?50|2050-12-31|31\/12\/(?:20)?50)$/i.test(String(endVal || "").trim())) {
        endVal = "No end date";
      }
    }

    // Field 8: Likelihood
    let rawLike = getRawVal(row, mLikelihood.crmField);
    let likeVal = rawLike;
    const lkRule = mLikelihood.formatRule || "Actual";
    if (lkRule === "Mapped") {
      const found = statusLookup[rawLike.toLowerCase()] || statusLookup[statusVal.toLowerCase()];
      if (found?.likelihood) likeVal = found.likelihood;
    } else if (lkRule === "Divide by 100") {
      const num = parseFloat(String(rawLike).replace("%", ""));
      if (!isNaN(num)) {
        const pct = Math.round((num / 100) * 10000) / 100;
        likeVal = `${pct}%`;
      }
    } else if (lkRule === "ActualOrMappedByStatus") {
      if (!rawLike) {
        const found = statusLookup[statusVal.toLowerCase()];
        if (found?.likelihood) likeVal = found.likelihood;
      }
    }

    // Field 11: Lead source
    let leadVal = getRawVal(row, mLead.crmField);
    if (mLead.formatRule === "Mapped" && leadVal) {
      leadVal = leadLookup[leadVal.toLowerCase()] || leadVal;
    }

    // Field 12: Date added
    const rawDateAdded = getRawVal(row, mDateAdded.crmField);
    const dateAddedObj = parseDateToJsDate(rawDateAdded);
    const dateAddedVal = dateAddedObj ? formatJsDate(dateAddedObj) : (rawDateAdded ? formatExcelOrStringDate(rawDateAdded) : "");

    // Field 13: Product line
    let prodLineVal = getRawVal(row, mProdLine.crmField);
    if (mProdLine.formatRule === "Mapped" && prodLineVal) {
      prodLineVal = productLookup[prodLineVal.toLowerCase()] || prodLineVal;
    }

    mappedJobs.push([
      clientVal,
      jobVal,
      projCodeVal,
      revVal,
      costVal,
      startVal,
      endVal,
      likeVal,
      statusVal,
      projRetVal,
      leadVal,
      dateAddedVal,
      prodLineVal,
      r
    ]);
  }

  // Classification for Confirmed and Pipeline
  const confirmedJobs = [];
  const pipelineJobs = [];

  const confStatusList = (jobDefinitions.confirmedStatus || "")
    .split(/[,;\n]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const exclStatusList = (jobDefinitions.pipelineExcludedStatuses || "")
    .split(/[,;\n]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const require100 = jobDefinitions.confirmedLikelihood === "Likelihood 100%";
  const operator = jobDefinitions.confirmedOperator || "Or";

  for (const deal of mappedJobs) {
    // Master Sheet CA4 logic: deals require both Start date and End date to be classified as Confirmed or Pipeline
    if (!deal[5] || !deal[6]) continue;

    const likeStr = String(deal[7] || "").trim();
    const statStr = String(deal[8] || "").trim().toLowerCase();

    let numLike = parseFloat(likeStr.replace("%", ""));
    if (!isNaN(numLike) && likeStr.includes("%")) numLike = numLike / 100;
    else if (!isNaN(numLike) && numLike > 1) numLike = numLike / 100;

    const is100 = !isNaN(numLike) && numLike >= 1;
    // Case-insensitive "status includes" check
    const hasConfStatus = confStatusList.length > 0 && confStatusList.some(s => statStr.includes(s));

    let isConfirmed = false;
    if (operator === "And") {
      isConfirmed = (require100 ? is100 : true) && (confStatusList.length > 0 ? hasConfStatus : true);
    } else {
      isConfirmed = (require100 && is100) || (confStatusList.length > 0 && hasConfStatus);
    }

    if (isConfirmed) {
      confirmedJobs.push(deal);
    } else {
      // Case-insensitive "status includes" check for pipeline excluded statuses
      const isExcluded = exclStatusList.length > 0 && exclStatusList.some(s => statStr.includes(s));
      if (!isExcluded) {
        pipelineJobs.push(deal);
      }
    }
  }

  // Sort confirmed and pipeline jobs by job start date (earliest first), maintaining stable sheet order on date tie
  const sortByStartDate = (list) => {
    return [...list].sort((a, b) => {
      const dateA = parseDateToJsDate(a[5]);
      const dateB = parseDateToJsDate(b[5]);
      const timeA = dateA && !isNaN(dateA.getTime()) ? dateA.getTime() : Infinity;
      const timeB = dateB && !isNaN(dateB.getTime()) ? dateB.getTime() : Infinity;
      if (timeA !== timeB) return timeA - timeB;
      const idxA = typeof a[13] === "number" ? a[13] : 0;
      const idxB = typeof b[13] === "number" ? b[13] : 0;
      return idxA - idxB;
    });
  };

  return {
    mappedJobs,
    confirmedJobs: sortByStartDate(confirmedJobs),
    pipelineJobs: sortByStartDate(pipelineJobs)
  };
}

function ChipInput({ values = [], onChange, placeholder = "Type and press Enter or comma..." }) {
  const [inputValue, setInputValue] = useState("");

  const addChips = (text) => {
    if (!text) return;
    const items = text
      .split(/[,;\n]+/)
      .map(s => s.trim())
      .filter(s => s && !values.includes(s));
    if (items.length > 0) {
      onChange([...values, ...items]);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addChips(inputValue);
      setInputValue("");
    } else if (e.key === "Backspace" && !inputValue && values.length > 0) {
      e.preventDefault();
      onChange(values.slice(0, -1));
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text");
    addChips(pasted);
  };

  const removeChip = (idxToRemove) => {
    onChange(values.filter((_, idx) => idx !== idxToRemove));
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px",
        padding: "6px 10px",
        borderRadius: "6px",
        border: "1px solid #CBD5E1",
        background: "#FFFFFF",
        minHeight: "38px",
        boxSizing: "border-box"
      }}
    >
      {values.map((chip, idx) => (
        <span
          key={idx}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            background: "#EFF6FF",
            border: "1px solid #BFDBFE",
            color: "#1E40AF",
            padding: "2px 8px",
            borderRadius: "4px",
            fontSize: "12px",
            fontWeight: "600",
            lineHeight: 1.4
          }}
        >
          <span>{chip}</span>
          <button
            type="button"
            onClick={() => removeChip(idx)}
            style={{
              background: "none",
              border: "none",
              color: "#6B7280",
              cursor: "pointer",
              padding: 0,
              fontSize: "12px",
              lineHeight: 1,
              display: "flex",
              alignItems: "center"
            }}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={() => {
          if (inputValue.trim()) {
            addChips(inputValue);
            setInputValue("");
          }
        }}
        placeholder={values.length === 0 ? placeholder : "Add more..."}
        style={{
          border: "none",
          outline: "none",
          fontSize: "12px",
          color: "#0F172A",
          flex: 1,
          minWidth: "120px",
          padding: "2px 0",
          background: "transparent"
        }}
      />
    </div>
  );
}

export default function ClientSettingsView({
  allClients = [],
  managedClient = null,
  initialClientName = "",
  initialSection = "main",
  initialSubsection = "",
  onSelectClient,
  onSelectSection,
  user,
  isAdmin = false,
  onRegisterNavGuard
}) {
  const router = useRouter();
  const effectiveIsAdmin = Boolean(isAdmin || user?.isAdmin || user?.role === "Admin");

  // Client selection - user must actively select a client unless managedClient or initialClientName is set
  const [selectedClientName, setSelectedClientName] = useState(() => {
    if (managedClient?.clientName) return managedClient.clientName;
    if (initialClientName) return initialClientName;
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const c = p.get("client");
      if (c) return c;
    }
    return "";
  });

  // Active section in left sidebar
  const [activeSection, setActiveSection] = useState(() => {
    if (initialSection) return initialSection;
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const s = p.get("section");
      if (s) return s;
    }
    return "main";
  });

  // Data states
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [saveSuccessMsg, setSaveSuccessMsg] = useState("");
  const [settings, setSettings] = useState(null);
  const [initialSettingsSnapshot, setInitialSettingsSnapshot] = useState(null);
  const [isDirty, setIsDirty] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  // Unsaved changes modal state
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);
  const [pendingNavAction, setPendingNavAction] = useState(null);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalSaveError, setModalSaveError] = useState("");

  // Admin Cell Reference visibility toggle
  const [showCellRefs, setShowCellRefs] = useState(true);

  // Show/hide Excel Client Secret
  const [showClientSecret, setShowClientSecret] = useState(false);

  // Bank accounts fetch & modal state
  const [fetchingBankAccounts, setFetchingBankAccounts] = useState(false);
  const [bankAccountsError, setBankAccountsError] = useState("");
  const [bankAccountsSuccess, setBankAccountsSuccess] = useState("");
  const [showBankModal, setShowBankModal] = useState(false);
  const [bankModalTarget, setBankModalTarget] = useState("cash"); // "cash" or "non-cash"
  const [potentialBankAccounts, setPotentialBankAccounts] = useState([]);
  const [resolvedAccountingTool, setResolvedAccountingTool] = useState("");
  const [bankSearchQuery, setBankSearchQuery] = useState("");
  const [tempSelectedBankAccounts, setTempSelectedBankAccounts] = useState([]);
  const [newManualAccountName, setNewManualAccountName] = useState("");
  const [newManualNonCashAccountName, setNewManualNonCashAccountName] = useState("");

  // CRM mappings testing & preview states
  const [testingCrm, setTestingCrm] = useState(false);
  const [crmTestSuccessMsg, setCrmTestSuccessMsg] = useState("");
  const [crmTestErrorMsg, setCrmTestErrorMsg] = useState("");
  const [previewJobTab, setPreviewJobTab] = useState("confirmed"); // "confirmed" or "pipeline"
  const [checkingStatuses, setCheckingStatuses] = useState(false);
  const [statusCheckMsg, setStatusCheckMsg] = useState("");
  const [statusCheckError, setStatusCheckError] = useState("");

  // CRM Product lines checking
  const [checkingProductLines, setCheckingProductLines] = useState(false);
  const [productLinesMsg, setProductLinesMsg] = useState("");
  const [productLinesError, setProductLinesError] = useState("");

  // CRM Lead sources checking
  const [checkingLeadSources, setCheckingLeadSources] = useState(false);
  const [leadSourcesMsg, setLeadSourcesMsg] = useState("");
  const [leadSourcesError, setLeadSourcesError] = useState("");

  // Accounting Chart of accounts fetch
  const [fetchingCoa, setFetchingCoa] = useState(false);
  const [coaMsg, setCoaMsg] = useState("");
  const [coaError, setCoaError] = useState("");

  // Accounting P&L pull
  const [pullingPl, setPullingPl] = useState(false);
  const [plMsg, setPlMsg] = useState("");
  const [plError, setPlError] = useState("");

  // Live dynamic CRM transformation engine - instantly updates in 0ms on any dropdown change
  const dynamicCrmData = useMemo(() => {
    const rawRows = settings?.crm?.rawCrmRows;
    const headers = settings?.crm?.availableCrmHeaders || [];
    const mappings = settings?.crm?.fieldMappings || CRM_PULSE_FIELDS.map(f => ({ key: f.key, label: f.label, crmField: "", formatRule: f.defaultFormat }));
    const jobDefs = settings?.crm?.jobDefinitions || {};
    const statusMappings = settings?.crmStatusMapping || [];
    const leadMappings = settings?.jobs?.leadSourceMappings || [];
    const prodMappings = settings?.jobs?.productLineMappings || [];

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return {
        mappedJobs: settings?.crm?.previewMappedJobs || [],
        confirmedJobs: settings?.crm?.previewConfirmedJobs || [],
        pipelineJobs: settings?.crm?.previewPipelineJobs || []
      };
    }

    return transformCrmRows({
      headers,
      rawRows,
      fieldMappings: mappings,
      jobDefinitions: jobDefs,
      crmStatusMappings: statusMappings,
      leadSourceMappings: leadMappings,
      productLineMappings: prodMappings
    });
  }, [
    settings?.crm?.rawCrmRows,
    settings?.crm?.availableCrmHeaders,
    settings?.crm?.fieldMappings,
    settings?.crm?.jobDefinitions,
    settings?.crmStatusMapping,
    settings?.jobs?.leadSourceMappings,
    settings?.jobs?.productLineMappings,
    settings?.crm?.previewMappedJobs,
    settings?.crm?.previewConfirmedJobs,
    settings?.crm?.previewPipelineJobs
  ]);

  const displayedMappedJobs = dynamicCrmData.mappedJobs;
  const displayedConfirmedJobs = dynamicCrmData.confirmedJobs;
  const displayedPipelineJobs = dynamicCrmData.pipelineJobs;
  // Resolve active client object
  const activeClientObj = useMemo(() => {
    if (managedClient?.clientName === selectedClientName) return managedClient;
    return allClients.find(c => c.clientName === selectedClientName) || null;
  }, [allClients, managedClient, selectedClientName]);

  // Handle client selection switch with clean modal confirmation if changes are pending
  const handleClientChange = useCallback((nextClient) => {
    if (nextClient === selectedClientName) return;
    if (isDirty) {
      setPendingNavAction(() => () => {
        setSettings(null);
        setIsDirty(false);
        setSaveSuccessMsg("");
        setErrorMsg("");
        setStatusCheckMsg("");
        setStatusCheckError("");
        setProductLinesMsg("");
        setProductLinesError("");
        setLeadSourcesMsg("");
        setLeadSourcesError("");
        setCoaMsg("");
        setCoaError("");
        setPlMsg("");
        setPlError("");
        setLastSyncedAt(null);
        setSelectedClientName(nextClient);
        onSelectClient?.(nextClient);
      });
      setModalSaveError("");
      setShowUnsavedModal(true);
      return;
    }
    // Clear old client settings immediately so they disappear while new client loads
    setSettings(null);
    setIsDirty(false);
    setSaveSuccessMsg("");
    setErrorMsg("");
    setStatusCheckMsg("");
    setStatusCheckError("");
    setProductLinesMsg("");
    setProductLinesError("");
    setLeadSourcesMsg("");
    setLeadSourcesError("");
    setCoaMsg("");
    setCoaError("");
    setPlMsg("");
    setPlError("");
    setLastSyncedAt(null);
    setSelectedClientName(nextClient);
    onSelectClient?.(nextClient);
  }, [isDirty, selectedClientName, onSelectClient]);

  const prevInitialClientNameRef = useRef(initialClientName);
  // Keep selectedClientName synced with managedClient or initialClientName
  useEffect(() => {
    if (managedClient?.clientName && managedClient.clientName !== selectedClientName) {
      setSettings(null);
      setIsDirty(false);
      setSaveSuccessMsg("");
      setErrorMsg("");
      setLastSyncedAt(null);
      setSelectedClientName(managedClient.clientName);
    } else if (initialClientName !== prevInitialClientNameRef.current) {
      prevInitialClientNameRef.current = initialClientName;
      if (initialClientName && initialClientName !== selectedClientName && !managedClient) {
        setSettings(null);
        setIsDirty(false);
        setSaveSuccessMsg("");
        setErrorMsg("");
        setLastSyncedAt(null);
        setSelectedClientName(initialClientName);
      }
    }
  }, [managedClient, initialClientName, selectedClientName]);

  const prevInitialSectionRef = useRef(initialSection);
  useEffect(() => {
    if (initialSection !== prevInitialSectionRef.current) {
      prevInitialSectionRef.current = initialSection;
      if (initialSection && initialSection !== activeSection) {
        setActiveSection(initialSection);
      }
    }
  }, [initialSection, activeSection]);

  // Auto-scroll to requested subsection (e.g. #settings-integration-tools)
  useEffect(() => {
    let targetSub = initialSubsection;
    if (!targetSub && typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      targetSub = p.get("subsection") || "";
    }
    if (targetSub === "integration-tools" && settings && activeSection === "main") {
      const timer = setTimeout(() => {
        const el = document.getElementById("settings-integration-tools");
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.style.transition = "background-color 0.4s ease, border-color 0.4s ease";
          el.style.backgroundColor = "rgba(14, 165, 233, 0.08)";
          el.style.borderRadius = "8px";
          el.style.padding = "16px";
          setTimeout(() => {
            el.style.backgroundColor = "transparent";
            el.style.padding = "20px 0 0 0";
          }, 2400);
        }
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [initialSubsection, settings, activeSection]);

  // Register navigation guard with parent views (e.g. NavShell tabs, PMA System settings tab)
  useEffect(() => {
    if (isDirty) {
      const guard = (proceedFn) => {
        setPendingNavAction(() => proceedFn);
        setModalSaveError("");
        setShowUnsavedModal(true);
      };
      onRegisterNavGuard?.(guard);
      return () => {
        onRegisterNavGuard?.(null);
      };
    } else {
      onRegisterNavGuard?.(null);
    }
  }, [isDirty, onRegisterNavGuard]);

  // Window beforeunload prompt (browser refresh, close tab, etc.)
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "You have unsaved changes. Are you sure you want to leave?";
        return e.returnValue;
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  // Next.js router route change interception
  useEffect(() => {
    if (!router?.events) return;
    const handleRouteChange = (url) => {
      if (isDirty) {
        const answer = window.confirm(`You have unsaved changes for ${selectedClientName}. Are you sure you want to discard them and navigate away?`);
        if (!answer) {
          router.events.emit("routeChangeError");
          throw "Abort route change due to unsaved changes";
        }
      }
    };
    router.events.on("routeChangeStart", handleRouteChange);
    return () => router.events.off("routeChangeStart", handleRouteChange);
  }, [isDirty, selectedClientName, router]);

  // Fetch settings from API
  const fetchSettings = useCallback(async (bypassCache = false) => {
    if (!activeClientObj?.clientName || !activeClientObj?.masterSheetId) {
      setSettings(null);
      return;
    }

    setSettings(prev => {
      // Clear settings immediately if switching to a different client
      if (prev && prev.clientName !== activeClientObj.clientName) {
        return null;
      }
      return prev;
    });

    setLoading(true);
    setErrorMsg("");
    setSaveSuccessMsg("");

    try {
      const q = new URLSearchParams({
        clientName: activeClientObj.clientName,
        masterSheetId: activeClientObj.masterSheetId,
        clientSheetId: activeClientObj.clientSheetId || "",
        bypassCache: bypassCache ? "true" : "false"
      });

      const res = await fetch(`/api/client-settings?${q.toString()}`);
      const data = await res.json();

      if (data.success && data.settings) {
        setSettings(data.settings);
        setInitialSettingsSnapshot(JSON.stringify(data.settings));
        setIsDirty(false);
        setFromCache(Boolean(data.settings.fromCache));
        setLastSyncedAt(data.settings.lastSyncedAt || new Date().toISOString());
      } else {
        setErrorMsg(data.error || "Failed to load client settings.");
      }
    } catch (err) {
      setErrorMsg("Error: " + err.message);
    } finally {
      setLoading(false);
    }
  }, [activeClientObj]);

  // Initial load on client change - only load when client is actively selected
  useEffect(() => {
    if (selectedClientName) {
      fetchSettings(false);
    } else {
      setSettings(null);
      setLoading(false);
    }
  }, [selectedClientName, fetchSettings]);

  // Dirty check
  const updateSettingsField = useCallback((updaterFn) => {
    setSettings(prev => {
      if (!prev) return prev;
      const next = typeof updaterFn === "function" ? updaterFn(prev) : { ...prev, ...updaterFn };
      setIsDirty(JSON.stringify(next) !== initialSettingsSnapshot);
      return next;
    });
  }, [initialSettingsSnapshot]);

  // Save handler - returns boolean success status
  const handleSave = async (options = {}) => {
    if (!settings || !activeClientObj) return false;

    setSaving(true);
    setErrorMsg("");
    setSaveSuccessMsg("");

    try {
      const payload = {
        clientName: activeClientObj.clientName,
        masterSheetId: activeClientObj.masterSheetId,
        clientSheetId: activeClientObj.clientSheetId || "",
        settings,
        resetKpiToParent: Boolean(options.resetKpiToParent)
      };

      const res = await fetch("/api/client-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (data.success) {
        setSaveSuccessMsg("✓ All settings saved successfully to sheets and cache");
        setIsDirty(false);
        setInitialSettingsSnapshot(JSON.stringify(settings));
        setLastSyncedAt(data.savedAt || new Date().toISOString());
        setTimeout(() => setSaveSuccessMsg(""), 4000);
        return true;
      } else {
        const msg = data.error || "Failed to save settings.";
        setErrorMsg(msg);
        return false;
      }
    } catch (err) {
      const msg = "Save error: " + err.message;
      setErrorMsg(msg);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleModalSaveAndContinue = async () => {
    setModalSaving(true);
    setModalSaveError("");
    const success = await handleSave();
    setModalSaving(false);
    if (success) {
      setShowUnsavedModal(false);
      setIsDirty(false);
      const action = pendingNavAction;
      setPendingNavAction(null);
      if (typeof action === "function") {
        action();
      }
    } else {
      setModalSaveError("Failed to save changes. Please try again or discard.");
    }
  };

  const handleModalDiscardAndContinue = () => {
    setShowUnsavedModal(false);
    setIsDirty(false);
    setModalSaveError("");
    const action = pendingNavAction;
    setPendingNavAction(null);
    if (typeof action === "function") {
      action();
    }
  };

  const handleModalCancel = () => {
    setShowUnsavedModal(false);
    setPendingNavAction(null);
    setModalSaveError("");
  };

  // Undo / cancel all unsaved modifications
  const handleCancelChanges = () => {
    if (!initialSettingsSnapshot) return;
    try {
      const original = JSON.parse(initialSettingsSnapshot);
      setSettings(original);
      setIsDirty(false);
      setErrorMsg("");
      setSaveSuccessMsg("");
    } catch (err) {
      console.error("Failed to cancel changes:", err);
    }
  };

  // KPI reset to system defaults handler
  const handleResetKpi = async () => {
    if (!window.confirm("Are you sure you want to reset KPI colouring rules to system defaults? This will restore the live template formula.")) {
      return;
    }
    await handleSave({ resetKpiToParent: true });
    await fetchSettings(true);
  };

  // Cell reference badge helper (Only visible to Admins)
  const renderCellRef = (cell) => {
    if (!effectiveIsAdmin || !showCellRefs || !cell) return null;
    return (
      <div style={{ fontSize: "11px", color: "#94A3B8", marginTop: "3px", fontFamily: "monospace" }}>
        Cell: {cell}
      </div>
    );
  };

  // Switch helper
  const renderToggle = (label, checked, onChange, subtitle = null, cell = null) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #F1F5F9" }}>
      <div>
        <div style={{ fontSize: "13px", fontWeight: "600", color: "#1E293B" }}>{label}</div>
        {subtitle && <div style={{ fontSize: "12px", color: "#64748B", marginTop: "2px" }}>{subtitle}</div>}
        {renderCellRef(cell)}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          width: "44px",
          height: "24px",
          borderRadius: "12px",
          background: checked ? "#0066CC" : "#CBD5E1",
          border: "none",
          cursor: "pointer",
          position: "relative",
          transition: "background 0.2s ease",
          padding: 0
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "2px",
            left: checked ? "22px" : "2px",
            width: "20px",
            height: "20px",
            borderRadius: "10px",
            background: "#FFFFFF",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
            transition: "left 0.2s ease"
          }}
        />
      </button>
    </div>
  );

  // Bank accounts helpers & handlers
  const combinedModalAccounts = useMemo(() => {
    const list = [...potentialBankAccounts];
    const seenNames = new Set(list.map(a => String(a.name || "").toLowerCase().trim()));
    const existingList = bankModalTarget === "non-cash"
      ? (settings?.accounting?.nonCashBankAccounts || [])
      : (settings?.accounting?.bankAccounts || []);
    existingList.forEach(existingName => {
      const clean = String(existingName || "").toLowerCase().trim();
      if (clean && !seenNames.has(clean)) {
        list.push({
          id: `custom-${clean}`,
          name: existingName,
          code: "",
          currency: "",
          status: "MANUAL",
          subType: "Manual entry"
        });
        seenNames.add(clean);
      }
    });
    return list;
  }, [potentialBankAccounts, settings?.accounting?.bankAccounts, settings?.accounting?.nonCashBankAccounts, bankModalTarget]);

  const filteredModalAccounts = useMemo(() => {
    if (!bankSearchQuery.trim()) return combinedModalAccounts;
    const q = bankSearchQuery.toLowerCase().trim();
    return combinedModalAccounts.filter(acc =>
      (acc.name && acc.name.toLowerCase().includes(q)) ||
      (acc.code && acc.code.toLowerCase().includes(q)) ||
      (acc.currency && acc.currency.toLowerCase().includes(q)) ||
      (acc.subType && acc.subType.toLowerCase().includes(q))
    );
  }, [combinedModalAccounts, bankSearchQuery]);

  const handleFetchBankAccounts = async (target = "cash") => {
    if (!activeClientObj?.clientName) return;
    setBankModalTarget(target);
    setFetchingBankAccounts(true);
    setBankAccountsError("");
    setBankAccountsSuccess("");

    try {
      const q = new URLSearchParams({
        clientName: activeClientObj.clientName,
        masterSheetId: activeClientObj.masterSheetId || "",
        tool: settings?.accounting?.toolInUse || ""
      });

      const res = await fetch(`/api/client-settings/bank-accounts?${q.toString()}`);
      const data = await res.json();

      if (data.success && Array.isArray(data.accounts)) {
        setResolvedAccountingTool(data.tool || "accounting tool");
        setPotentialBankAccounts(data.accounts);
        if (target === "non-cash") {
          setTempSelectedBankAccounts([...(settings?.accounting?.nonCashBankAccounts || [])]);
        } else {
          setTempSelectedBankAccounts([...(settings?.accounting?.bankAccounts || [])]);
        }
        setBankSearchQuery("");
        setShowBankModal(true);
      } else {
        setBankAccountsError(data.error || "Failed to fetch bank accounts from accounting tool.");
      }
    } catch (err) {
      setBankAccountsError("Error: " + err.message);
    } finally {
      setFetchingBankAccounts(false);
    }
  };

  const handleToggleBankAccount = (name) => {
    if (!name) return;
    const maxLimit = bankModalTarget === "non-cash" ? 6 : 10;
    const cellRange = bankModalTarget === "non-cash" ? "KeyInfo!H23:I28" : "KeyInfo!H12:I21";
    const label = bankModalTarget === "non-cash" ? "non-cash bank accounts" : "bank accounts";

    setTempSelectedBankAccounts(prev => {
      const exists = prev.includes(name);
      if (exists) {
        return prev.filter(n => n !== name);
      } else {
        if (prev.length >= maxLimit) {
          alert(`Maximum ${maxLimit} ${label} allowed (${cellRange}). Please uncheck an account before selecting another.`);
          return prev;
        }
        return [...prev, name];
      }
    });
  };

  const handleApplyBankSelection = () => {
    const details = tempSelectedBankAccounts.map(name => {
      const match = potentialBankAccounts.find(p => p.name === name);
      return match || { name, id: "" };
    });

    if (bankModalTarget === "non-cash") {
      updateSettingsField(prev => ({
        ...prev,
        accounting: {
          ...prev.accounting,
          nonCashBankAccounts: tempSelectedBankAccounts,
          nonCashBankAccountDetails: details
        }
      }));
      setShowBankModal(false);
      setBankAccountsSuccess(`Updated non-cash bank accounts list (${tempSelectedBankAccounts.length} selected). Remember to click "Save changes" to persist to sheets.`);
    } else {
      updateSettingsField(prev => ({
        ...prev,
        accounting: {
          ...prev.accounting,
          bankAccounts: tempSelectedBankAccounts,
          bankAccountDetails: details
        }
      }));
      setShowBankModal(false);
      setBankAccountsSuccess(`Updated bank accounts list (${tempSelectedBankAccounts.length} selected). Remember to click "Save changes" to persist to sheets.`);
    }
  };

  const handleAddManualBankAccount = () => {
    const trimmed = (newManualAccountName || "").trim();
    if (!trimmed) return;
    const currentList = settings?.accounting?.bankAccounts || [];
    if (currentList.length >= 10) {
      alert("Maximum 10 bank accounts allowed (KeyInfo!H12:I21).");
      return;
    }
    if (currentList.includes(trimmed)) {
      alert("This bank account is already in the list.");
      return;
    }
    const currentDetails = settings?.accounting?.bankAccountDetails || [];
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        bankAccounts: [...currentList, trimmed],
        bankAccountDetails: [...currentDetails, { name: trimmed, id: "" }]
      }
    }));
    setNewManualAccountName("");
  };

  const handleRemoveBankAccount = (index) => {
    const currentList = [...(settings?.accounting?.bankAccounts || [])];
    const removedName = currentList.splice(index, 1)[0];
    const currentDetails = [...(settings?.accounting?.bankAccountDetails || [])].filter(d => d.name !== removedName);
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        bankAccounts: currentList,
        bankAccountDetails: currentDetails
      }
    }));
  };

  const handleUpdateBankAccountName = (index, newName) => {
    const currentList = [...(settings?.accounting?.bankAccounts || [])];
    const oldName = currentList[index];
    currentList[index] = newName;
    const currentDetails = [...(settings?.accounting?.bankAccountDetails || [])].map(d => {
      if (d.name === oldName) return { ...d, name: newName };
      return d;
    });
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        bankAccounts: currentList,
        bankAccountDetails: currentDetails
      }
    }));
  };

  const handleMoveBankAccount = (fromIdx, toIdx) => {
    const currentList = [...(settings?.accounting?.bankAccounts || [])];
    if (toIdx < 0 || toIdx >= currentList.length) return;
    const item = currentList.splice(fromIdx, 1)[0];
    currentList.splice(toIdx, 0, item);

    const detailsMap = new Map((settings?.accounting?.bankAccountDetails || []).map(d => [d.name, d]));
    const newDetails = currentList.map(name => detailsMap.get(name) || { name, id: "" });

    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        bankAccounts: currentList,
        bankAccountDetails: newDetails
      }
    }));
  };

  const handleAddManualNonCashBankAccount = () => {
    const trimmed = (newManualNonCashAccountName || "").trim();
    if (!trimmed) return;
    const currentList = settings?.accounting?.nonCashBankAccounts || [];
    if (currentList.length >= 6) {
      alert("Maximum 6 non-cash bank accounts allowed (KeyInfo!H23:I28).");
      return;
    }
    if (currentList.includes(trimmed)) {
      alert("This non-cash account is already in the list.");
      return;
    }
    const currentDetails = settings?.accounting?.nonCashBankAccountDetails || [];
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        nonCashBankAccounts: [...currentList, trimmed],
        nonCashBankAccountDetails: [...currentDetails, { name: trimmed, id: "" }]
      }
    }));
    setNewManualNonCashAccountName("");
  };

  const handleRemoveNonCashBankAccount = (index) => {
    const currentList = [...(settings?.accounting?.nonCashBankAccounts || [])];
    const removedName = currentList.splice(index, 1)[0];
    const currentDetails = [...(settings?.accounting?.nonCashBankAccountDetails || [])].filter(d => d.name !== removedName);
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        nonCashBankAccounts: currentList,
        nonCashBankAccountDetails: currentDetails
      }
    }));
  };

  const handleUpdateNonCashBankAccountName = (index, newName) => {
    const currentList = [...(settings?.accounting?.nonCashBankAccounts || [])];
    const oldName = currentList[index];
    currentList[index] = newName;
    const currentDetails = [...(settings?.accounting?.nonCashBankAccountDetails || [])].map(d => {
      if (d.name === oldName) return { ...d, name: newName };
      return d;
    });
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        nonCashBankAccounts: currentList,
        nonCashBankAccountDetails: currentDetails
      }
    }));
  };

  const handleMoveNonCashBankAccount = (fromIdx, toIdx) => {
    const currentList = [...(settings?.accounting?.nonCashBankAccounts || [])];
    if (toIdx < 0 || toIdx >= currentList.length) return;
    const item = currentList.splice(fromIdx, 1)[0];
    currentList.splice(toIdx, 0, item);
    const details = settings?.accounting?.nonCashBankAccountDetails || [];
    const newDetails = currentList.map(name => {
      const match = details.find(d => d.name === name);
      return match || { name, id: "" };
    });
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        nonCashBankAccounts: currentList,
        nonCashBankAccountDetails: newDetails
      }
    }));
  };

  const handleTestCrmMappings = async () => {
    if (!settings || !activeClientObj?.masterSheetId) return;
    setTestingCrm(true);
    setCrmTestSuccessMsg("");
    setCrmTestErrorMsg("");

    try {
      const res = await fetch("/api/client-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test_crm_mappings",
          clientName: selectedClientName,
          masterSheetId: activeClientObj.masterSheetId,
          clientSheetId: activeClientObj.clientSheetId || "",
          settings
        })
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to test CRM mappings");
      }

      updateSettingsField(prev => ({
        ...prev,
        crm: {
          ...prev.crm,
          previewMappedJobs: data.previewMappedJobs || [],
          previewConfirmedJobs: data.previewConfirmedJobs || [],
          previewPipelineJobs: data.previewPipelineJobs || []
        }
      }));

      setCrmTestSuccessMsg("✓ Settings applied and preview refreshed from Google Sheets!");
      setTimeout(() => setCrmTestSuccessMsg(""), 6000);
    } catch (err) {
      setCrmTestErrorMsg(err.message || "Failed to test CRM mappings");
      setTimeout(() => setCrmTestErrorMsg(""), 8000);
    } finally {
      setTestingCrm(false);
    }
  };

  const handleCheckCrmStatuses = async () => {
    if (!settings) return;
    setCheckingStatuses(true);
    setStatusCheckMsg("");
    setStatusCheckError("");

    try {
      const candidateStatuses = [];
      const seenCandidate = new Set();

      const addCandidate = (val) => {
        if (!val) return;
        const trimmed = String(val).trim();
        if (!trimmed) return;
        const lower = trimmed.toLowerCase();
        if (!seenCandidate.has(lower)) {
          seenCandidate.add(lower);
          candidateStatuses.push(trimmed);
        }
      };

      // 1. Gather statuses from live in-memory mapped jobs
      (displayedMappedJobs || []).forEach(row => {
        addCandidate(row[8]);
      });

      // 2. Gather statuses from raw mapped jobs in CRMList!A4:M
      (settings?.crm?.previewMappedJobs || []).forEach(row => {
        addCandidate(row[8]);
      });

      // 3. If masterSheetId is present, also fetch directly from CRMList!I4:I in the sheet
      if (activeClientObj?.masterSheetId) {
        try {
          const res = await fetch("/api/client-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "fetch_crm_statuses",
              clientName: selectedClientName,
              masterSheetId: activeClientObj.masterSheetId,
              settings
            })
          });
          const data = await res.json();
          if (data.success && Array.isArray(data.statuses)) {
            data.statuses.forEach(s => addCandidate(s));
          }
        } catch (apiErr) {
          console.warn("Could not fetch remote CRMList statuses:", apiErr);
        }
      }

      if (candidateStatuses.length === 0) {
        setStatusCheckMsg("No opportunities or statuses found in CRM data.");
        setTimeout(() => setStatusCheckMsg(""), 6000);
        return;
      }

      // Existing statuses in settings.crmStatusMapping
      const currentList = settings.crmStatusMapping || [];
      const existingLookup = new Set(
        currentList.map(item => String(item.status || "").trim().toLowerCase()).filter(Boolean)
      );

      const updatedList = [...currentList];
      let addedCount = 0;

      candidateStatuses.forEach(s => {
        const lower = s.toLowerCase();
        if (!existingLookup.has(lower)) {
          existingLookup.add(lower);
          updatedList.push({
            status: s,
            likelihood: "",
            startDateRule: "",
            fromCrm: true
          });
          addedCount++;
        } else {
          const idx = updatedList.findIndex(item => String(item.status || "").trim().toLowerCase() === lower);
          if (idx >= 0 && !updatedList[idx].isManual) {
            updatedList[idx] = { ...updatedList[idx], fromCrm: true };
          }
        }
      });

      updateSettingsField(prev => ({
        ...prev,
        crmStatusMapping: updatedList
      }));

      if (addedCount > 0) {
        setStatusCheckMsg(`✓ Found ${candidateStatuses.length} statuses in CRM data (${addedCount} new added).`);
      } else {
        setStatusCheckMsg(`✓ All ${candidateStatuses.length} statuses from CRM data are already in the list.`);
      }
      setTimeout(() => setStatusCheckMsg(""), 6000);
    } catch (err) {
      console.error("Error checking CRM statuses:", err);
      setStatusCheckError("Error checking CRM statuses: " + (err.message || String(err)));
      setTimeout(() => setStatusCheckError(""), 8000);
    } finally {
      setCheckingStatuses(false);
    }
  };

  // Known CRM data values for checking editability of rows
  const knownCrmStatuses = useMemo(() => {
    const set = new Set();
    (displayedMappedJobs || []).forEach(r => { if (r && r[8]) set.add(String(r[8]).trim().toLowerCase()); });
    (settings?.crm?.previewMappedJobs || []).forEach(r => { if (r && r[8]) set.add(String(r[8]).trim().toLowerCase()); });
    return set;
  }, [displayedMappedJobs, settings?.crm?.previewMappedJobs]);

  const knownCrmProductLines = useMemo(() => {
    const set = new Set();
    const rawRows = settings?.crm?.rawCrmRows || [];
    const headers = settings?.crm?.availableCrmHeaders || [];
    const prodField = (settings?.crm?.fieldMappings || []).find(f => f.key === "productLine")?.crmField;
    if (prodField) {
      const idx = headers.indexOf(prodField);
      if (idx >= 0) {
        rawRows.forEach(r => { if (r && r[idx]) set.add(String(r[idx]).trim().toLowerCase()); });
      }
    }
    (displayedMappedJobs || []).forEach(r => { if (r && r[12]) set.add(String(r[12]).trim().toLowerCase()); });
    (settings?.crm?.previewMappedJobs || []).forEach(r => { if (r && r[12]) set.add(String(r[12]).trim().toLowerCase()); });
    return set;
  }, [settings?.crm?.rawCrmRows, settings?.crm?.availableCrmHeaders, settings?.crm?.fieldMappings, displayedMappedJobs, settings?.crm?.previewMappedJobs]);

  const knownCrmLeadSources = useMemo(() => {
    const set = new Set();
    const rawRows = settings?.crm?.rawCrmRows || [];
    const headers = settings?.crm?.availableCrmHeaders || [];
    const leadField = (settings?.crm?.fieldMappings || []).find(f => f.key === "leadSource")?.crmField;
    if (leadField) {
      const idx = headers.indexOf(leadField);
      if (idx >= 0) {
        rawRows.forEach(r => { if (r && r[idx]) set.add(String(r[idx]).trim().toLowerCase()); });
      }
    }
    (displayedMappedJobs || []).forEach(r => { if (r && r[10]) set.add(String(r[10]).trim().toLowerCase()); });
    (settings?.crm?.previewMappedJobs || []).forEach(r => { if (r && r[10]) set.add(String(r[10]).trim().toLowerCase()); });
    return set;
  }, [settings?.crm?.rawCrmRows, settings?.crm?.availableCrmHeaders, settings?.crm?.fieldMappings, displayedMappedJobs, settings?.crm?.previewMappedJobs]);

  // Available product lines from KeyInfo!B23:B37 with their PL codes (e.g. "PL1 - Discovery")
  const availableProductLines = useMemo(() => {
    return (settings?.jobs?.productLines || [])
      .map((pl, i) => {
        const name = String(pl || "").trim();
        if (!name) return null;
        return {
          name,
          code: `PL${i + 1} - ${name}`,
          index: i + 1
        };
      })
      .filter(Boolean);
  }, [settings?.jobs?.productLines]);

  // Combined available lead sources (Standard from KeyInfo!G32:G60 + Client Specific from KeyInfo!G63:G72)
  const allAvailableLeadSources = useMemo(() => {
    const standard = settings?.jobs?.standardLeadSources || [];
    const clientSpecific = (settings?.jobs?.leadSources || []).filter(Boolean);
    const combined = [...standard, ...clientSpecific];
    const seen = new Set();
    const unique = [];
    combined.forEach(s => {
      const trimmed = String(s || "").trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        unique.push(trimmed);
      }
    });
    return unique;
  }, [settings?.jobs?.standardLeadSources, settings?.jobs?.leadSources]);

  // Categories Mapping mutual exclusivity
  const usedPlCategoriesSet = useMemo(() => {
    const set = new Set();
    const mappings = settings?.accounting?.mappings || {};
    Object.values(mappings).forEach(arr => {
      if (Array.isArray(arr)) {
        arr.forEach(cat => {
          const t = String(cat || "").trim();
          if (t) set.add(t);
        });
      }
    });
    return set;
  }, [settings?.accounting?.mappings]);

  const remainingPlCategories = useMemo(() => {
    const all = settings?.accounting?.plCategories || [];
    return all.filter(cat => !usedPlCategoriesSet.has(cat));
  }, [settings?.accounting?.plCategories, usedPlCategoriesSet]);

  const handleCheckCrmProductLines = async () => {
    if (!settings) return;
    setCheckingProductLines(true);
    setProductLinesMsg("");
    setProductLinesError("");

    try {
      const candidateList = [];
      const seen = new Set();
      const addCandidate = (val) => {
        if (!val) return;
        const trimmed = String(val).trim();
        if (!trimmed) return;
        const lower = trimmed.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          candidateList.push(trimmed);
        }
      };

      knownCrmProductLines.forEach(item => addCandidate(item));

      if (activeClientObj?.masterSheetId) {
        try {
          const res = await fetch("/api/client-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "fetch_crm_product_lines",
              clientName: selectedClientName,
              masterSheetId: activeClientObj.masterSheetId,
              settings
            })
          });
          const data = await res.json();
          if (data.success && Array.isArray(data.productLines)) {
            data.productLines.forEach(pl => addCandidate(pl));
          }
        } catch (apiErr) {
          console.warn("Could not fetch remote CRM product lines:", apiErr);
        }
      }

      if (candidateList.length === 0) {
        setProductLinesMsg("No product lines found in CRM data.");
        setTimeout(() => setProductLinesMsg(""), 6000);
        return;
      }

      const currentMappings = settings.jobs?.productLineMappings || [];
      const existingLookup = new Set(
        currentMappings.map(m => String(m.crmProductLine || "").trim().toLowerCase()).filter(Boolean)
      );

      const updatedMappings = [...currentMappings];
      let addedCount = 0;

      candidateList.forEach(cand => {
        const lower = cand.toLowerCase();
        if (!existingLookup.has(lower)) {
          existingLookup.add(lower);
          updatedMappings.push({
            crmProductLine: cand,
            mappedTo: "",
            fromCrm: true
          });
          addedCount++;
        } else {
          const idx = updatedMappings.findIndex(m => String(m.crmProductLine || "").trim().toLowerCase() === lower);
          if (idx >= 0 && !updatedMappings[idx].isManual) {
            updatedMappings[idx] = { ...updatedMappings[idx], fromCrm: true };
          }
        }
      });

      updateSettingsField(prev => ({
        ...prev,
        jobs: { ...prev.jobs, productLineMappings: updatedMappings }
      }));

      if (addedCount > 0) {
        setProductLinesMsg(`✓ Found ${candidateList.length} product lines in CRM (${addedCount} new added).`);
      } else {
        setProductLinesMsg(`✓ All ${candidateList.length} product lines from CRM data are already in the list.`);
      }
      setTimeout(() => setProductLinesMsg(""), 6000);
    } catch (err) {
      console.error("Error checking CRM product lines:", err);
      setProductLinesError("Failed to check CRM product lines: " + (err.message || String(err)));
      setTimeout(() => setProductLinesError(""), 8000);
    } finally {
      setCheckingProductLines(false);
    }
  };

  const handleCheckCrmLeadSources = async () => {
    if (!settings) return;
    setCheckingLeadSources(true);
    setLeadSourcesMsg("");
    setLeadSourcesError("");

    try {
      const candidateList = [];
      const seen = new Set();
      const addCandidate = (val) => {
        if (!val) return;
        const trimmed = String(val).trim();
        if (!trimmed) return;
        const lower = trimmed.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          candidateList.push(trimmed);
        }
      };

      knownCrmLeadSources.forEach(item => addCandidate(item));

      if (activeClientObj?.masterSheetId) {
        try {
          const res = await fetch("/api/client-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "fetch_crm_lead_sources",
              clientName: selectedClientName,
              masterSheetId: activeClientObj.masterSheetId,
              settings
            })
          });
          const data = await res.json();
          if (data.success && Array.isArray(data.leadSources)) {
            data.leadSources.forEach(ls => addCandidate(ls));
          }
        } catch (apiErr) {
          console.warn("Could not fetch remote CRM lead sources:", apiErr);
        }
      }

      if (candidateList.length === 0) {
        setLeadSourcesMsg("No lead sources found in CRM data.");
        setTimeout(() => setLeadSourcesMsg(""), 6000);
        return;
      }

      const currentMappings = settings.jobs?.leadSourceMappings || [];
      const existingLookup = new Set(
        currentMappings.map(m => String(m.crmSource || "").trim().toLowerCase()).filter(Boolean)
      );

      const updatedMappings = [...currentMappings];
      let addedCount = 0;

      candidateList.forEach(cand => {
        const lower = cand.toLowerCase();
        if (!existingLookup.has(lower)) {
          existingLookup.add(lower);
          updatedMappings.push({
            crmSource: cand,
            mappedTo: "",
            fromCrm: true
          });
          addedCount++;
        } else {
          const idx = updatedMappings.findIndex(m => String(m.crmSource || "").trim().toLowerCase() === lower);
          if (idx >= 0 && !updatedMappings[idx].isManual) {
            updatedMappings[idx] = { ...updatedMappings[idx], fromCrm: true };
          }
        }
      });

      updateSettingsField(prev => ({
        ...prev,
        jobs: { ...prev.jobs, leadSourceMappings: updatedMappings }
      }));

      if (addedCount > 0) {
        setLeadSourcesMsg(`✓ Found ${candidateList.length} lead sources in CRM (${addedCount} new added).`);
      } else {
        setLeadSourcesMsg(`✓ All ${candidateList.length} lead sources from CRM data are already in the list.`);
      }
      setTimeout(() => setLeadSourcesMsg(""), 6000);
    } catch (err) {
      console.error("Error checking CRM lead sources:", err);
      setLeadSourcesError("Failed to check CRM lead sources: " + (err.message || String(err)));
      setTimeout(() => setLeadSourcesError(""), 8000);
    } finally {
      setCheckingLeadSources(false);
    }
  };

  const handleFetchChartOfAccounts = async () => {
    if (!activeClientObj?.masterSheetId) return;
    setFetchingCoa(true);
    setCoaMsg("");
    setCoaError("");

    try {
      const res = await fetch("/api/client-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "refresh_chart_of_accounts",
          clientName: selectedClientName,
          masterSheetId: activeClientObj.masterSheetId,
          settings
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to refresh chart of accounts");
      }

      const updatedAccounts = Array.isArray(data.chartOfAccounts) ? data.chartOfAccounts : [];
      updateSettingsField(prev => ({
        ...prev,
        accounting: {
          ...prev.accounting,
          chartOfAccounts: updatedAccounts
        }
      }));

      setCoaMsg(`✓ Refreshed ${updatedAccounts.length} accounts from Chart of Accounts.`);
      setTimeout(() => setCoaMsg(""), 6000);
    } catch (err) {
      console.error("Error refreshing chart of accounts:", err);
      setCoaError("Failed to fetch chart of accounts: " + (err.message || String(err)));
      setTimeout(() => setCoaError(""), 8000);
    } finally {
      setFetchingCoa(false);
    }
  };

  const handlePullFreshPL = async () => {
    if (!activeClientObj?.masterSheetId) return;
    setPullingPl(true);
    setPlMsg("");
    setPlError("");

    try {
      const res = await fetch("/api/client-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pull_fresh_pl",
          clientName: selectedClientName,
          masterSheetId: activeClientObj.masterSheetId,
          settings
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to pull fresh P&L data");
      }

      const updatedCategories = Array.isArray(data.plCategories) ? data.plCategories : [];
      updateSettingsField(prev => ({
        ...prev,
        accounting: {
          ...prev.accounting,
          plCategories: updatedCategories,
          sheetRemainingCategories: Array.isArray(data.sheetRemainingCategories) ? data.sheetRemainingCategories : prev.accounting?.sheetRemainingCategories
        }
      }));

      setPlMsg(`✓ Successfully pulled ${updatedCategories.length} categories from P&L.`);
      setTimeout(() => setPlMsg(""), 6000);
    } catch (err) {
      console.error("Error pulling P&L:", err);
      setPlError("Failed to pull P&L: " + (err.message || String(err)));
      setTimeout(() => setPlError(""), 8000);
    } finally {
      setPullingPl(false);
    }
  };

  const renderProgressiveInputs = ({
    items,
    max,
    placeholderPrefix,
    labelPrefix,
    onChange
  }) => {
    const active = (items || []).filter(v => v !== undefined && String(v).trim() !== "");
    const slotCount = Math.min(max, active.length + 1);

    return (
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px", marginTop: "8px" }}>
          {Array.from({ length: slotCount }, (_, i) => {
            const val = active[i] || "";
            return (
              <div key={i} style={{ position: "relative" }}>
                <label style={{ fontSize: "11px", color: "#64748B", display: "block", marginBottom: "2px" }}>
                  {labelPrefix} {i + 1}
                </label>
                <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                  <input
                    type="text"
                    value={val}
                    onChange={(e) => {
                      const newVal = e.target.value;
                      const next = [...active];
                      if (newVal.trim() === "") {
                        const filtered = active.filter((_, idx) => idx !== i);
                        onChange(filtered);
                      } else {
                        next[i] = newVal;
                        onChange(next);
                      }
                    }}
                    placeholder={placeholderPrefix ? `${placeholderPrefix} ${i + 1}` : "Enter name..."}
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      borderRadius: "4px",
                      border: "1px solid #CBD5E1",
                      fontSize: "12px",
                      boxSizing: "border-box",
                      background: val ? "#FFFFFF" : "#F8FAFC"
                    }}
                  />
                  {val && (
                    <button
                      type="button"
                      onClick={() => {
                        const filtered = active.filter((_, idx) => idx !== i);
                        onChange(filtered);
                      }}
                      title="Clear this slot"
                      style={{
                        background: "none",
                        border: "none",
                        color: "#94A3B8",
                        cursor: "pointer",
                        fontSize: "12px",
                        padding: "2px 4px"
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: "11px", color: "#64748B", marginTop: "6px" }}>
          {active.length} / {max} slots used
        </div>
      </div>
    );
  };

  const renderProgressiveDropdowns = ({
    items,
    max,
    options,
    emptyOptionText = "-- Select category --",
    usedSet,
    onChange
  }) => {
    const active = (items || []).filter(v => v !== undefined && String(v).trim() !== "");
    const slotCount = Math.min(max, active.length + 1);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%", minWidth: 0, boxSizing: "border-box" }}>
        {Array.from({ length: slotCount }, (_, i) => {
          const val = active[i] || "";
          const availableOpts = usedSet
            ? options.filter(opt => opt === val || !usedSet.has(opt))
            : options;

          return (
            <div key={i} style={{ display: "flex", gap: "6px", alignItems: "center", width: "100%", minWidth: 0, boxSizing: "border-box" }}>
              <select
                value={val}
                onChange={(e) => {
                  const newVal = e.target.value;
                  if (!newVal) {
                    const filtered = active.filter((_, idx) => idx !== i);
                    onChange(filtered);
                  } else {
                    const next = [...active];
                    next[i] = newVal;
                    onChange(next);
                  }
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  border: "1px solid #CBD5E1",
                  fontSize: "12px",
                  boxSizing: "border-box",
                  background: val ? "#FFFFFF" : "#F8FAFC",
                  color: val ? "#0F172A" : "#64748B",
                  textOverflow: "ellipsis",
                  overflow: "hidden",
                  whiteSpace: "nowrap"
                }}
              >
                <option value="">{emptyOptionText}</option>
                {availableOpts.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
              {val && (
                <button
                  type="button"
                  onClick={() => {
                    const filtered = active.filter((_, idx) => idx !== i);
                    onChange(filtered);
                  }}
                  title="Remove this category"
                  style={{
                    background: "none",
                    border: "none",
                    color: "#DC2626",
                    cursor: "pointer",
                    fontSize: "13px",
                    padding: "2px 4px",
                    flexShrink: 0
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        <div style={{ fontSize: "11px", color: active.length >= max ? "#DC2626" : "#64748B", marginTop: "2px" }}>
          {active.length} / {max} slots used
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginTop: "10px", width: "100%", maxWidth: "100%", boxSizing: "border-box", minWidth: 0 }}>
      {/* ── TOP CONTROL BAR (shown when a client is selected) ──────────────── */}
      {(selectedClientName || managedClient) && (
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          background: "#FFFFFF",
          border: "1px solid #E2E8F0",
          borderRadius: "10px",
          padding: "12px 18px",
          marginBottom: "16px",
          boxShadow: "0 1px 2px rgba(0,0,0,0.03)"
        }}>
          {/* Left: Back button + Active Client Name */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            {!managedClient && (allClients || []).length > 1 && (
              <button
                type="button"
                onClick={() => handleClientChange("")}
                disabled={loading || saving}
                style={{
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  cursor: (loading || saving) ? "not-allowed" : "pointer",
                  padding: "6px 12px",
                  fontSize: "16px",
                  color: "#475569",
                  lineHeight: 1,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.15s ease",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                }}
                onMouseEnter={(e) => {
                  if (!loading && !saving) {
                    e.currentTarget.style.backgroundColor = "#f1f5f9";
                    e.currentTarget.style.borderColor = "#94a3b8";
                    e.currentTarget.style.color = "#0f172a";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!loading && !saving) {
                    e.currentTarget.style.backgroundColor = "#ffffff";
                    e.currentTarget.style.borderColor = "#cbd5e1";
                    e.currentTarget.style.color = "#475569";
                  }
                }}
                title="Back to client list"
              >
                ←
              </button>
            )}
            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "15px", fontWeight: "700", color: "#0047AB" }}>
                {managedClient ? managedClient.clientName : selectedClientName}
              </span>
              {managedClient && (
                <span style={{ fontSize: "11px", color: "#64748B", fontStyle: "italic" }}>
                  (managed client mode)
                </span>
              )}
            </div>

            {settings && lastSyncedAt && !loading && (
              <span style={{ fontSize: "11px", color: "#64748B", marginLeft: "6px" }}>
                {fromCache ? "Loaded from cache" : "Loaded from database"}
                {" · "}
                {new Date(lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
            {loading && (
              <span style={{ fontSize: "11px", color: "#0066CC", marginLeft: "6px", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                <Spinner size={10} color="#0066CC" /> Loading...
              </span>
            )}
          </div>

          {/* Right: Actions */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {effectiveIsAdmin && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#64748B", cursor: "pointer", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={showCellRefs}
                  onChange={(e) => setShowCellRefs(e.target.checked)}
                />
                Show cell refs
              </label>
            )}

            {isDirty && (
              <span style={{ fontSize: "12px", color: "#B45309", background: "#FEF3F2", padding: "4px 10px", borderRadius: "12px", fontWeight: "600", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                ● Unsaved changes
              </span>
            )}

            <button
              type="button"
              onClick={() => fetchSettings(true)}
              disabled={!selectedClientName || loading || saving}
              title={selectedClientName ? "Bypass cache and reload fresh data directly from Google Sheets" : "Select a client first"}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: "600",
                color: selectedClientName ? "#334155" : "#94A3B8",
                background: "#F1F5F9",
                border: "1px solid #CBD5E1",
                borderRadius: "6px",
                cursor: (!selectedClientName || loading || saving) ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                opacity: selectedClientName ? 1 : 0.6
              }}
            >
              {loading ? <Spinner size={12} color="#0066CC" /> : "↻"} Reload sheets
            </button>

            {isDirty && (
              <button
                type="button"
                onClick={handleCancelChanges}
                disabled={loading || saving}
                title="Undo all unsaved modifications and revert to last saved state"
                style={{
                  padding: "7px 14px",
                  fontSize: "13px",
                  fontWeight: "600",
                  color: "#64748B",
                  background: "#F8FAFC",
                  border: "1px solid #CBD5E1",
                  borderRadius: "6px",
                  cursor: (loading || saving) ? "not-allowed" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  transition: "all 0.15s ease"
                }}
                onMouseEnter={(e) => {
                  if (!loading && !saving) {
                    e.currentTarget.style.color = "#0F172A";
                    e.currentTarget.style.background = "#F1F5F9";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!loading && !saving) {
                    e.currentTarget.style.color = "#64748B";
                    e.currentTarget.style.background = "#F8FAFC";
                  }
                }}
              >
                Cancel changes
              </button>
            )}

            <button
              type="button"
              onClick={() => handleSave()}
              disabled={!selectedClientName || !isDirty || saving || loading}
              style={{
                padding: "7px 18px",
                fontSize: "13px",
                fontWeight: "600",
                color: "#FFFFFF",
                background: (selectedClientName && isDirty) ? "#0066CC" : "#94A3B8",
                border: "none",
                borderRadius: "6px",
                cursor: (!selectedClientName || !isDirty || saving || loading) ? "default" : "pointer",
                boxShadow: (selectedClientName && isDirty) ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                transition: "all 0.15s ease",
                opacity: (selectedClientName && isDirty) ? 1 : 0.7
              }}
            >
              {saving ? <><Spinner size={12} color="#FFFFFF" /> Saving...</> : "Save changes"}
            </button>
          </div>
        </div>
      )}

      {/* ── UNSAVED CHANGES MODAL ────────────────────────────────────────── */}
      {showUnsavedModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.65)",
          backdropFilter: "blur(3px)",
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px"
        }}>
          <div style={{
            background: "#FFFFFF",
            borderRadius: "14px",
            border: "1px solid #E2E8F0",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 10px 10px -5px rgba(0, 0, 0, 0.08)",
            width: "100%",
            maxWidth: "480px",
            padding: "24px 26px",
            boxSizing: "border-box"
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "14px", marginBottom: "16px" }}>
              <div style={{
                width: "42px",
                height: "42px",
                borderRadius: "50%",
                background: "#FEF3C7",
                color: "#D97706",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "22px",
                flexShrink: 0
              }}>
                ⚠️
              </div>
              <div>
                <h3 style={{ margin: "0 0 6px", fontSize: "17px", fontWeight: "700", color: "#0F172A" }}>
                  Save pending changes?
                </h3>
                <p style={{ margin: 0, fontSize: "13.5px", color: "#475569", lineHeight: "1.5" }}>
                  You have unsaved changes for <strong>{selectedClientName || "this client"}</strong>. Would you like to save them before leaving?
                </p>
              </div>
            </div>

            {modalSaveError && (
              <div style={{ background: "#FEE2E2", border: "1px solid #FECACA", color: "#991B1B", padding: "10px 14px", borderRadius: "8px", fontSize: "12.5px", marginBottom: "16px" }}>
                {modalSaveError}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "10px", marginTop: "22px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={handleModalCancel}
                disabled={modalSaving}
                style={{
                  padding: "8px 16px",
                  fontSize: "13px",
                  fontWeight: "600",
                  color: "#475569",
                  background: "#F1F5F9",
                  border: "1px solid #CBD5E1",
                  borderRadius: "6px",
                  cursor: modalSaving ? "not-allowed" : "pointer",
                  transition: "all 0.15s ease"
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleModalDiscardAndContinue}
                disabled={modalSaving}
                style={{
                  padding: "8px 16px",
                  fontSize: "13px",
                  fontWeight: "600",
                  color: "#DC2626",
                  background: "#FEF2F2",
                  border: "1px solid #FCA5A5",
                  borderRadius: "6px",
                  cursor: modalSaving ? "not-allowed" : "pointer",
                  transition: "all 0.15s ease"
                }}
              >
                Discard changes
              </button>

              <button
                type="button"
                onClick={handleModalSaveAndContinue}
                disabled={modalSaving}
                style={{
                  padding: "8px 20px",
                  fontSize: "13px",
                  fontWeight: "600",
                  color: "#FFFFFF",
                  background: "#0066CC",
                  border: "none",
                  borderRadius: "6px",
                  cursor: modalSaving ? "wait" : "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  transition: "all 0.15s ease"
                }}
              >
                {modalSaving ? (
                  <>
                    <Spinner size={12} color="#FFFFFF" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Save changes</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notifications */}
      {errorMsg && (
        <div style={{ background: "#FEE2E2", border: "1px solid #FECACA", color: "#991B1B", padding: "10px 14px", borderRadius: "8px", fontSize: "13px", marginBottom: "16px" }}>
          {errorMsg}
        </div>
      )}
      {saveSuccessMsg && (
        <div style={{ background: "#DCFCE7", border: "1px solid #BBF7D0", color: "#166534", padding: "10px 14px", borderRadius: "8px", fontSize: "13px", fontWeight: "600", marginBottom: "16px" }}>
          {saveSuccessMsg}
        </div>
      )}

      {/* Client Selection Screen when no client has been chosen yet */}
      {!selectedClientName && !managedClient && !loading && (
        <EditClientSelector
          clients={allClients || []}
          onSelectClient={(c) => handleClientChange(c.clientName)}
          loading={loading}
          title="Select a client to view and manage settings:"
        />
      )}

      {/* Loading state when switching client or on initial load */}
      {loading && !settings && (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "80px 24px",
          background: "#FFFFFF",
          borderRadius: "10px",
          border: "1px solid #E2E8F0",
          boxShadow: "0 1px 3px rgba(0,0,0,0.02)",
          minHeight: "360px",
          textAlign: "center"
        }}>
          <Spinner size={32} color="#0066CC" />
          <div style={{ marginTop: "16px", fontSize: "15px", fontWeight: "600", color: "#0F172A" }}>
            Loading settings for {selectedClientName}...
          </div>
          <div style={{ marginTop: "6px", fontSize: "13px", color: "#64748B" }}>
            Retrieving configuration parameters and sheet mappings
          </div>
        </div>
      )}

      {!loading && !settings && !errorMsg && selectedClientName && (
        <div style={{
          padding: "60px 24px",
          background: "#FFFFFF",
          borderRadius: "10px",
          border: "1px solid #E2E8F0",
          textAlign: "center",
          color: "#64748B"
        }}>
          <div style={{ fontSize: "15px", fontWeight: "600", color: "#0F172A", marginBottom: "6px" }}>
            No settings loaded
          </div>
          <div style={{ fontSize: "13px" }}>
            Please select a client from the menu above to view and manage settings.
          </div>
        </div>
      )}

      {/* ── TWO-COLUMN SETTINGS LAYOUT ──────────────────────────────────────── */}
      {settings && (
        <div style={{
          position: "relative",
          opacity: loading ? 0.45 : 1,
          pointerEvents: loading ? "none" : "auto",
          transition: "opacity 0.2s ease"
        }}>
          {loading && (
            <div style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 30,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "flex-start",
              paddingTop: "140px",
              background: "rgba(255, 255, 255, 0.5)",
              backdropFilter: "blur(2px)",
              borderRadius: "10px"
            }}>
              <div style={{
                background: "#FFFFFF",
                padding: "14px 22px",
                borderRadius: "8px",
                boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
                border: "1px solid #E2E8F0",
                display: "flex",
                alignItems: "center",
                gap: "12px",
                color: "#0F172A",
                fontSize: "14px",
                fontWeight: "600"
              }}>
                <Spinner size={18} color="#0066CC" />
                Updating settings from Google Sheets...
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "240px minmax(0, 1fr)", gap: "20px", alignItems: "start" }}>
            {/* Left Navigation Sidebar */}
            <div style={{
              background: "#FFFFFF",
              borderRadius: "10px",
              border: "1px solid #E2E8F0",
              padding: "8px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.02)"
            }}>
              {SECTIONS.map(s => {
                const active = activeSection === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setActiveSection(s.id);
                      onSelectSection?.(s.id);
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "9px 12px",
                      borderRadius: "6px",
                      border: "none",
                      background: active ? "#EFF6FF" : "transparent",
                      color: active ? "#0066CC" : "#334155",
                      fontSize: "13px",
                      fontWeight: active ? 700 : 500,
                      cursor: "pointer",
                      textAlign: "left",
                      marginBottom: "2px",
                      transition: "all 0.1s ease"
                    }}
                    onMouseEnter={(e) => {
                      if (!active) e.currentTarget.style.background = "#F8FAFC";
                    }}
                    onMouseLeave={(e) => {
                      if (!active) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span>{s.icon}</span>
                      <span>{s.label}</span>
                    </span>
                    {s.adminOnly && (
                      <span style={{ fontSize: "10px", fontWeight: "700", color: "#64748B", background: "#F1F5F9", padding: "1px 5px", borderRadius: "4px" }}>
                        Admin
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Right Content Panel */}
            <div style={{
              background: "#FFFFFF",
              borderRadius: "12px",
              border: "1px solid #E2E8F0",
              padding: "24px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
              minHeight: "500px",
              minWidth: 0,
              maxWidth: "100%",
              boxSizing: "border-box"
            }}>

              {/* ── 1. MAIN (ADMIN ONLY) ────────────────────────────────────── */}
              {activeSection === "main" && (
                <div>
                  <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                    <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Main settings</h3>
                    <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                      Core company financial anchors, VAT cycles, currency, employment allowances, reporting preferences, integration tools, and automation frequencies.
                    </p>
                  </div>

                  {/* Sub-group A: Core financial settings */}
                  <div style={{ marginBottom: "24px" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Core financial settings</h4>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Pulse start date
                        </label>
                        <input
                          type="text"
                          value={settings.main?.pulseStartDate || ""}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, pulseStartDate: e.target.value } }))}
                          placeholder="e.g. 1-Apr-2026"
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B2")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Primary currency
                        </label>
                        <select
                          value={settings.main?.primaryCurrency || "GBP"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, primaryCurrency: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {PRIMARY_CURRENCY_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!B17")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          VAT quarters
                        </label>
                        <select
                          value={settings.main?.vatQuarters || VAT_QUARTERS_OPTIONS[0]}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, vatQuarters: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {VAT_QUARTERS_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!B6")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          VAT payment scheme
                        </label>
                        <select
                          value={settings.main?.vatPaymentScheme || "Accrual"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, vatPaymentScheme: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {VAT_PAYMENT_SCHEME_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!B8")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          VAT rate
                        </label>
                        <input
                          type="text"
                          value={settings.main?.vatRate || "20%"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, vatRate: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B9")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          PAYE cycle
                        </label>
                        <select
                          value={settings.main?.payeCycle || "Monthly"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, payeCycle: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {PAYE_CYCLE_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!B12")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Eligible for employment allowance?
                        </label>
                        <select
                          value={settings.main?.employmentAllowanceEligible || "Yes"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, employmentAllowanceEligible: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {YES_NO_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!B18")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Employment allowance amount
                        </label>
                        <input
                          type="text"
                          value={settings.main?.employmentAllowanceAmount || "£10,500"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, employmentAllowanceAmount: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B19")}
                      </div>
                    </div>
                  </div>

                  {/* Sub-group B: Reporting & customisation (Admin only) */}
                  <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #F1F5F9", marginBottom: "24px" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Reporting & customisation</h4>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Revenue or income focus
                        </label>
                        <select
                          value={settings.customisation?.revenueFocus || "Revenue"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, revenueFocus: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {REVENUE_FOCUS_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!B15")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Tax payment method
                        </label>
                        <select
                          value={settings.customisation?.taxPaymentMethod || "Standard"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, taxPaymentMethod: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {TAX_PAYMENT_METHOD_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!B10")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Currency symbol
                        </label>
                        <select
                          value={settings.customisation?.currencySymbol || "£"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, currencySymbol: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {CURRENCY_SYMBOL_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!D4")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Thousands separator
                        </label>
                        <select
                          value={settings.customisation?.thousandsSeparator || ","}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, thousandsSeparator: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {THOUSANDS_SEPARATOR_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt === "," ? "Comma ( , )" : "Dot ( . )"}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!D5")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Invoice method
                        </label>
                        <select
                          value={settings.customisation?.invoiceMethod || "Lines"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, invoiceMethod: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {INVOICE_METHOD_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!F8")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Profit share %
                        </label>
                        <input
                          type="text"
                          value={settings.customisation?.profitSharePercent || "0%"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, profitSharePercent: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!F11")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Profit share accrual method
                        </label>
                        <select
                          value={settings.customisation?.profitShareAccrual || "Monthly"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, profitShareAccrual: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {PROFIT_SHARE_ACCRUE_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!F12")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Profit share payment
                        </label>
                        <select
                          value={settings.customisation?.profitSharePayment || "YearlyM13"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, profitSharePayment: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {PROFIT_SHARE_PAYMENT_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!F13")}
                      </div>
                    </div>
                  </div>

                  {/* Sub-group C: Integration tools (Admin only) */}
                  <div id="settings-integration-tools" style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #F1F5F9", marginBottom: "24px" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Integration tools</h4>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginBottom: "16px" }}>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Accounting tool in use
                        </label>
                        <select
                          value={settings.accounting?.toolInUse || "None"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, accounting: { ...prev.accounting, toolInUse: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {ACCOUNTING_TOOL_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!Q4")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          CRM in use
                        </label>
                        <select
                          value={settings.crm?.toolInUse || "None"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, toolInUse: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {CRM_TOOL_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!Q8")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          CRM drives
                        </label>
                        <select
                          value={settings.crm?.crmDrives || "Pipeline"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, crmDrives: e.target.value } }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {CRM_DRIVES_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!Q9")}
                      </div>
                    </div>

                    {/* Tool-specific configuration */}
                    {settings.crm?.toolInUse && settings.crm.toolInUse !== "None" && (
                      <div style={{ background: "#F8FAFC", borderRadius: "10px", padding: "16px", border: "1px solid #E2E8F0" }}>
                        <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", marginBottom: "12px" }}>
                          {settings.crm.toolInUse} connection settings
                        </div>

                        {/* Google Sheet CRM */}
                        {settings.crm.toolInUse === "Google Sheet" && (
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                            <div>
                              <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                                Google Sheet CRM URL
                              </label>
                              <input
                                type="text"
                                value={settings.crm.googleSheetUrl || ""}
                                onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, googleSheetUrl: e.target.value } }))}
                                placeholder="https://docs.google.com/spreadsheets/d/..."
                                style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                              />
                              {renderCellRef("KeyInfo!X11")}
                            </div>
                            <div>
                              <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                                CRM tab name
                              </label>
                              <input
                                type="text"
                                value={settings.crm.googleSheetTab || ""}
                                onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, googleSheetTab: e.target.value } }))}
                                placeholder="e.g. Leads or Pipeline"
                                style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                              />
                              {renderCellRef("KeyInfo!X12")}
                            </div>
                            <div>
                              <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                                Header column row
                              </label>
                              <input
                                type="text"
                                value={settings.crm.googleSheetHeaderRow || "1"}
                                onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, googleSheetHeaderRow: e.target.value } }))}
                                placeholder="1"
                                style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                              />
                              {renderCellRef("KeyInfo!X14")}
                            </div>
                            <div>
                              <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                                Key headers
                              </label>
                              <input
                                type="text"
                                value={settings.crm.googleSheetKeyHeaders || ""}
                                onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, googleSheetKeyHeaders: e.target.value } }))}
                                placeholder="Client, Job Name, Value, Start, End, Likelihood"
                                style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                              />
                              {renderCellRef("KeyInfo!X13")}
                            </div>
                          </div>
                        )}

                        {/* ClickUp */}
                        {settings.crm.toolInUse === "ClickUp" && (
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                            <div>
                              <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                                ClickUp list ID
                              </label>
                              <input
                                type="text"
                                value={settings.crm.clickUpListId || ""}
                                onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, clickUpListId: e.target.value } }))}
                                placeholder="e.g. 9012345678"
                                style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                              />
                              {renderCellRef("KeyInfo!X16")}
                            </div>
                            <div>
                              <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                                ClickUp view ID
                              </label>
                              <input
                                type="text"
                                value={settings.crm.clickUpViewId || ""}
                                onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, clickUpViewId: e.target.value } }))}
                                placeholder="e.g. 9012345678-v"
                                style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                              />
                              {renderCellRef("KeyInfo!X17")}
                            </div>
                          </div>
                        )}

                        {/* Monday */}
                        {settings.crm.toolInUse === "Monday" && (
                          <div>
                            <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                              Monday board ID
                            </label>
                            <input
                              type="text"
                              value={settings.crm.mondayBoardId || ""}
                              onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, mondayBoardId: e.target.value } }))}
                              placeholder="e.g. 1234567890"
                              style={{ width: "320px", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                            />
                            {renderCellRef("KeyInfo!X24")}
                          </div>
                        )}

                        {/* Excel / Azure */}
                        {settings.crm.toolInUse === "Excel" && (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
                            {[
                              { key: "azureTenantId", label: "Azure tenant ID", cell: "KeyInfo!X33" },
                              { key: "azureClientId", label: "Azure client ID", cell: "KeyInfo!X34" },
                              { key: "driveId", label: "Drive ID", cell: "KeyInfo!X36" },
                              { key: "fileId", label: "File ID", cell: "KeyInfo!X37" },
                              { key: "worksheetName", label: "Worksheet name", cell: "KeyInfo!X38" },
                              { key: "range", label: "Excel range", cell: "KeyInfo!X39" },
                              { key: "columnRow", label: "Column row", cell: "KeyInfo!X40" },
                              { key: "keyHeaders", label: "Key headers", cell: "KeyInfo!X41" }
                            ].map(f => (
                              <div key={f.key}>
                                <label style={{ fontSize: "11px", fontWeight: "600", color: "#475569", display: "block", marginBottom: "3px" }}>
                                  {f.label}
                                </label>
                                <input
                                  type="text"
                                  value={settings.crm.excel?.[f.key] || ""}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    updateSettingsField(prev => ({
                                      ...prev,
                                      crm: {
                                        ...prev.crm,
                                        excel: { ...prev.crm.excel, [f.key]: val }
                                      }
                                    }));
                                  }}
                                  style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                                />
                                {renderCellRef(f.cell)}
                              </div>
                            ))}

                            {/* Azure Client Secret */}
                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                                <label style={{ fontSize: "11px", fontWeight: "600", color: "#475569" }}>Azure client secret</label>
                                <button
                                  type="button"
                                  onClick={() => setShowClientSecret(v => !v)}
                                  style={{ background: "none", border: "none", color: "#0066CC", fontSize: "11px", cursor: "pointer", padding: 0 }}
                                >
                                  {showClientSecret ? "Hide" : "Show"}
                                </button>
                              </div>
                              <input
                                type={showClientSecret ? "text" : "password"}
                                value={settings.crm.excel?.azureClientSecret || ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateSettingsField(prev => ({
                                    ...prev,
                                    crm: {
                                      ...prev.crm,
                                      excel: { ...prev.crm.excel, azureClientSecret: val }
                                    }
                                  }));
                                }}
                                style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                              />
                              {renderCellRef("KeyInfo!X35")}
                            </div>
                          </div>
                        )}

                        {/* OAuth CRMs */}
                        {["HubSpot", "Pipedrive", "Close", "Capsule"].includes(settings.crm.toolInUse) && (
                          <div style={{ fontSize: "13px", color: "#334155", lineHeight: "1.5" }}>
                            <p style={{ margin: "0 0 6px" }}>
                              🔒 <strong>{settings.crm.toolInUse}</strong> connects via secure centralized OAuth tokens stored in the Pulse Vault.
                            </p>
                            <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                              OAuth handshakes, status monitoring, and tenant credentials are automatically maintained via the central token broker.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Sub-group D: Automation frequencies (Admin only) */}
                  <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Automation frequencies</h4>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
                      {[
                        { key: "invoices", label: "Invoices frequency", cell: "DataChgAlert!Y2" },
                        { key: "crm", label: "CRM frequency", cell: "DataChgAlert!Y3" },
                        { key: "expenses", label: "Expenses frequency", cell: "DataChgAlert!Y4" }
                      ].map(f => (
                        <div key={f.key} style={{ background: "#F8FAFC", padding: "14px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                          <label style={{ fontSize: "12px", fontWeight: "600", color: "#1E293B", display: "block", marginBottom: "4px" }}>
                            {f.label}
                          </label>
                          <select
                            value={settings.automation?.frequencies?.[f.key] || ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              updateSettingsField(prev => ({
                                ...prev,
                                automation: {
                                  ...prev.automation,
                                  frequencies: { ...prev.automation.frequencies, [f.key]: val }
                                }
                              }));
                            }}
                            style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                          >
                            <option value="">-- Blank --</option>
                            {FREQUENCY_OPTIONS.map(opt => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                          {renderCellRef(f.cell)}
                        </div>
                      ))}
                    </div>
                  </div>

                </div>
              )}

              {/* ── 2. CUSTOMISATION ────────────────────────────────────────── */}
              {activeSection === "customisation" && (
                <div>
                  <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                    <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Customisation</h3>
                    <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                      Health KPI colouring thresholds determining green, orange, and red indicators across the dashboard.
                    </p>
                  </div>

                  {/* KPI Colouring Rules Card */}
                  <div style={{ background: "#F8FAFC", borderRadius: "10px", border: "1px solid #E2E8F0", padding: "18px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
                      <div>
                        <h4 style={{ margin: "0 0 4px", fontSize: "15px", fontWeight: "700", color: "#0F172A" }}>
                          KPI colouring rules
                        </h4>
                        <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                          Thresholds determining green, orange, and red indicators across the dashboard.
                        </p>
                        {renderCellRef("KeyInfo!A120:B140")}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {settings.customisation?.kpiColouring?.isParentFormula ? (
                          <span style={{ fontSize: "11px", fontWeight: "600", color: "#166534", background: "#DCFCE7", padding: "4px 9px", borderRadius: "6px" }}>
                            ✓ Using system defaults
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={handleResetKpi}
                            style={{
                              padding: "5px 10px",
                              fontSize: "11px",
                              fontWeight: "600",
                              color: "#0066CC",
                              background: "#FFFFFF",
                              border: "1px solid #CBD5E1",
                              borderRadius: "6px",
                              cursor: "pointer"
                            }}
                          >
                            ↺ Reset to system defaults
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
                      {/* Gross Profit */}
                      <div style={{ background: "#FFFFFF", padding: "12px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                        <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>Gross profit</div>
                        <div style={{ marginBottom: "6px" }}>
                          <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Green is above:</label>
                          <input
                            type="text"
                            value={settings.customisation?.kpiColouring?.grossProfit?.greenAbove || ""}
                            onChange={(e) => updateSettingsField(prev => ({
                              ...prev,
                              customisation: {
                                ...prev.customisation,
                                kpiColouring: {
                                  ...prev.customisation.kpiColouring,
                                  grossProfit: { ...prev.customisation.kpiColouring.grossProfit, greenAbove: e.target.value }
                                }
                              }
                            }))}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!B123")}
                        </div>
                        <div>
                          <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Orange is above / red below:</label>
                          <input
                            type="text"
                            value={settings.customisation?.kpiColouring?.grossProfit?.orangeAbove || ""}
                            onChange={(e) => updateSettingsField(prev => ({
                              ...prev,
                              customisation: {
                                ...prev.customisation,
                                kpiColouring: {
                                  ...prev.customisation.kpiColouring,
                                  grossProfit: { ...prev.customisation.kpiColouring.grossProfit, orangeAbove: e.target.value }
                                }
                              }
                            }))}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!B124")}
                        </div>
                      </div>

                      {/* Overheads */}
                      <div style={{ background: "#FFFFFF", padding: "12px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                        <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>Overheads</div>
                        <div style={{ marginBottom: "6px" }}>
                          <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Red is above:</label>
                          <input
                            type="text"
                            value={settings.customisation?.kpiColouring?.overheads?.redAbove || ""}
                            onChange={(e) => updateSettingsField(prev => ({
                              ...prev,
                              customisation: {
                                ...prev.customisation,
                                kpiColouring: {
                                  ...prev.customisation.kpiColouring,
                                  overheads: { ...prev.customisation.kpiColouring.overheads, redAbove: e.target.value }
                                }
                              }
                            }))}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!B128")}
                        </div>
                        <div>
                          <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Orange below, green above:</label>
                          <input
                            type="text"
                            value={settings.customisation?.kpiColouring?.overheads?.greenAbove || ""}
                            onChange={(e) => updateSettingsField(prev => ({
                              ...prev,
                              customisation: {
                                ...prev.customisation,
                                kpiColouring: {
                                  ...prev.customisation.kpiColouring,
                                  overheads: { ...prev.customisation.kpiColouring.overheads, greenAbove: e.target.value }
                                }
                              }
                            }))}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!B129")}
                        </div>
                      </div>

                      {/* Operating Profit */}
                      <div style={{ background: "#FFFFFF", padding: "12px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                        <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>Operating profit</div>
                        <div style={{ marginBottom: "6px" }}>
                          <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Green is above:</label>
                          <input
                            type="text"
                            value={settings.customisation?.kpiColouring?.operatingProfit?.greenAbove || ""}
                            onChange={(e) => updateSettingsField(prev => ({
                              ...prev,
                              customisation: {
                                ...prev.customisation,
                                kpiColouring: {
                                  ...prev.customisation.kpiColouring,
                                  operatingProfit: { ...prev.customisation.kpiColouring.operatingProfit, greenAbove: e.target.value }
                                }
                              }
                            }))}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!B133")}
                        </div>
                        <div>
                          <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Orange above, red below:</label>
                          <input
                            type="text"
                            value={settings.customisation?.kpiColouring?.operatingProfit?.orangeAbove || ""}
                            onChange={(e) => updateSettingsField(prev => ({
                              ...prev,
                              customisation: {
                                ...prev.customisation,
                                kpiColouring: {
                                  ...prev.customisation.kpiColouring,
                                  operatingProfit: { ...prev.customisation.kpiColouring.operatingProfit, orangeAbove: e.target.value }
                                }
                              }
                            }))}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!B134")}
                        </div>
                      </div>

                      {/* Staff Costs Ratio */}
                      <div style={{ background: "#FFFFFF", padding: "12px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                        <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>Staff costs ratio</div>
                        <div style={{ marginBottom: "4px" }}>
                          <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Red is above:</label>
                          <input
                            type="text"
                            value={settings.customisation?.kpiColouring?.staffCostsRatio?.redAbove || ""}
                            onChange={(e) => updateSettingsField(prev => ({
                              ...prev,
                              customisation: {
                                ...prev.customisation,
                                kpiColouring: {
                                  ...prev.customisation.kpiColouring,
                                  staffCostsRatio: { ...prev.customisation.kpiColouring.staffCostsRatio, redAbove: e.target.value }
                                }
                              }
                            }))}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!B138")}
                        </div>
                        <div style={{ marginBottom: "4px" }}>
                          <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Orange is above:</label>
                          <input
                            type="text"
                            value={settings.customisation?.kpiColouring?.staffCostsRatio?.orangeAbove || ""}
                            onChange={(e) => updateSettingsField(prev => ({
                              ...prev,
                              customisation: {
                                ...prev.customisation,
                                kpiColouring: {
                                  ...prev.customisation.kpiColouring,
                                  staffCostsRatio: { ...prev.customisation.kpiColouring.staffCostsRatio, orangeAbove: e.target.value }
                                }
                              }
                            }))}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!B139")}
                        </div>
                        <div>
                          <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Green above, orange below:</label>
                          <input
                            type="text"
                            value={settings.customisation?.kpiColouring?.staffCostsRatio?.greenAbove || ""}
                            onChange={(e) => updateSettingsField(prev => ({
                              ...prev,
                              customisation: {
                                ...prev.customisation,
                                kpiColouring: {
                                  ...prev.customisation.kpiColouring,
                                  staffCostsRatio: { ...prev.customisation.kpiColouring.staffCostsRatio, greenAbove: e.target.value }
                                }
                              }
                            }))}
                            style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!B140")}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── 3. ACCOUNTING ───────────────────────────────────────────── */}
              {activeSection === "accounting" && (
                <div>
                  <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                    <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Accounting categories & mappings</h3>
                    <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                      Configure bank accounts, category classifications for P&L, pass-through, and staff costs.
                    </p>
                  </div>

                  {/* Unified Bank Accounts Card (KeyInfo!H12:I28) */}
                  <div style={{ marginBottom: "28px", background: "#FFFFFF", borderRadius: "10px", padding: "20px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
                    <div style={{ marginBottom: "18px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                      <h4 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                        Bank accounts
                      </h4>
                      <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                        Configure cash bank accounts for cashflow reconciliation and non-cash accounts (such as corporate credit cards) for automated P&amp;L clearing.
                      </p>
                    </div>

                    {/* Feedback alerts */}
                    {bankAccountsError && (
                      <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: "6px", padding: "10px 12px", fontSize: "12px", color: "#B91C1C", marginBottom: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>⚠️ {bankAccountsError}</span>
                        <button type="button" onClick={() => setBankAccountsError("")} style={{ background: "none", border: "none", color: "#B91C1C", cursor: "pointer", fontWeight: "bold" }}>✕</button>
                      </div>
                    )}

                    {bankAccountsSuccess && (
                      <div style={{ background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: "6px", padding: "10px 12px", fontSize: "12px", color: "#166534", marginBottom: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>✓ {bankAccountsSuccess}</span>
                        <button type="button" onClick={() => setBankAccountsSuccess("")} style={{ background: "none", border: "none", color: "#166534", cursor: "pointer", fontWeight: "bold" }}>✕</button>
                      </div>
                    )}

                    {/* ── Sub-section 1: Cash bank accounts ── */}
                    <div style={{ marginBottom: "24px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "14px" }}>
                        <div>
                          <h5 style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>
                            Cash bank accounts
                          </h5>
                          <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                            Select and prioritize the company bank accounts included in cash flow, management reporting, and end-of-month tools. Names in KeyInfo!H12:H21, Accounting Tool IDs in KeyInfo!I12:I21.
                          </p>
                          {renderCellRef("KeyInfo!H12:I21")}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <button
                            type="button"
                            onClick={() => handleFetchBankAccounts("cash")}
                            disabled={fetchingBankAccounts}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              padding: "7px 13px",
                              borderRadius: "6px",
                              border: "1px solid #0066CC",
                              background: "#EFF6FF",
                              color: "#0066CC",
                              fontSize: "12px",
                              fontWeight: "600",
                              cursor: fetchingBankAccounts ? "not-allowed" : "pointer",
                              opacity: fetchingBankAccounts ? 0.7 : 1,
                              transition: "all 0.15s ease"
                            }}
                          >
                            {fetchingBankAccounts && bankModalTarget === "cash" ? (
                              <>
                                <span style={{ display: "inline-block", width: "12px", height: "12px", border: "2px solid #0066CC", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                                <span>Fetching accounts...</span>
                              </>
                            ) : (
                              <>
                                <span>🏦</span>
                                <span>Show accounts in {settings.accounting?.toolInUse && settings.accounting?.toolInUse !== "None" ? settings.accounting?.toolInUse : "accounting tool"}</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Active Accounts List */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "14px" }}>
                        {(settings.accounting?.bankAccounts || []).length === 0 ? (
                          <div style={{ padding: "20px", background: "#F8FAFC", borderRadius: "8px", border: "1px dashed #CBD5E1", textAlign: "center", color: "#64748B", fontSize: "13px" }}>
                            <p style={{ margin: "0 0 6px", fontWeight: "600", color: "#334155" }}>No bank accounts configured</p>
                            <p style={{ margin: 0, fontSize: "12px" }}>
                              Click &quot;Show accounts in {settings.accounting?.toolInUse && settings.accounting?.toolInUse !== "None" ? settings.accounting?.toolInUse : "accounting tool"}&quot; to fetch accounts or type an account name below.
                            </p>
                          </div>
                        ) : (
                          (settings.accounting?.bankAccounts || []).map((accountName, idx) => {
                            const cellRow = 12 + idx;
                            const matchDetail = (settings.accounting?.bankAccountDetails || []).find(d => d.name === accountName);
                            return (
                              <div
                                key={idx}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "10px",
                                  background: "#F8FAFC",
                                  padding: "7px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #E2E8F0"
                                }}
                              >
                                <span style={{ fontSize: "11px", fontWeight: "700", color: "#64748B", width: "52px", flexShrink: 0, fontFamily: "monospace" }}>
                                  #{idx + 1} <span style={{ fontSize: "10px", color: "#94A3B8" }}>(H{cellRow})</span>
                                </span>

                                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "8px" }}>
                                  <input
                                    type="text"
                                    value={accountName}
                                    onChange={(e) => handleUpdateBankAccountName(idx, e.target.value)}
                                    placeholder="Bank account name"
                                    style={{
                                      flex: 1,
                                      padding: "6px 10px",
                                      borderRadius: "5px",
                                      border: "1px solid #CBD5E1",
                                      fontSize: "13px",
                                      background: "#FFFFFF",
                                      boxSizing: "border-box"
                                    }}
                                  />
                                  {matchDetail?.id && (
                                    <span
                                      style={{
                                        fontSize: "10px",
                                        fontFamily: "monospace",
                                        color: "#475569",
                                        background: "#F1F5F9",
                                        border: "1px solid #E2E8F0",
                                        padding: "2px 6px",
                                        borderRadius: "4px",
                                        whiteSpace: "nowrap"
                                      }}
                                      title={`Accounting Tool ID stored in KeyInfo!I${cellRow}`}
                                    >
                                      ID: {matchDetail.id}
                                    </span>
                                  )}
                                </div>

                                {/* Reorder Buttons */}
                                <div style={{ display: "flex", gap: "2px", flexShrink: 0 }}>
                                  <button
                                    type="button"
                                    onClick={() => handleMoveBankAccount(idx, idx - 1)}
                                    disabled={idx === 0}
                                    title="Move up"
                                    style={{
                                      padding: "4px 7px",
                                      borderRadius: "4px",
                                      border: "1px solid #CBD5E1",
                                      background: idx === 0 ? "#F1F5F9" : "#FFFFFF",
                                      color: idx === 0 ? "#CBD5E1" : "#475569",
                                      cursor: idx === 0 ? "not-allowed" : "pointer",
                                      fontSize: "10px"
                                    }}
                                  >
                                    ▲
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleMoveBankAccount(idx, idx + 1)}
                                    disabled={idx === (settings.accounting?.bankAccounts || []).length - 1}
                                    title="Move down"
                                    style={{
                                      padding: "4px 7px",
                                      borderRadius: "4px",
                                      border: "1px solid #CBD5E1",
                                      background: idx === (settings.accounting?.bankAccounts || []).length - 1 ? "#F1F5F9" : "#FFFFFF",
                                      color: idx === (settings.accounting?.bankAccounts || []).length - 1 ? "#CBD5E1" : "#475569",
                                      cursor: idx === (settings.accounting?.bankAccounts || []).length - 1 ? "not-allowed" : "pointer",
                                      fontSize: "10px"
                                    }}
                                  >
                                    ▼
                                  </button>
                                </div>

                                {/* Delete Button */}
                                <button
                                  type="button"
                                  onClick={() => handleRemoveBankAccount(idx)}
                                  title="Remove account"
                                  style={{
                                    padding: "4px 8px",
                                    borderRadius: "4px",
                                    border: "1px solid #FCA5A5",
                                    background: "#FEF2F2",
                                    color: "#DC2626",
                                    cursor: "pointer",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    flexShrink: 0
                                  }}
                                >
                                  ✕
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>

                      {/* Manual add input row (if under 10) */}
                      {(settings.accounting?.bankAccounts || []).length < 10 && (
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <input
                            type="text"
                            value={newManualAccountName}
                            onChange={(e) => setNewManualAccountName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleAddManualBankAccount();
                              }
                            }}
                            placeholder="Enter bank account name to add manually..."
                            style={{
                              flex: 1,
                              padding: "7px 10px",
                              borderRadius: "6px",
                              border: "1px solid #CBD5E1",
                              fontSize: "12px",
                              boxSizing: "border-box"
                            }}
                          />
                          <button
                            type="button"
                            onClick={handleAddManualBankAccount}
                            disabled={!newManualAccountName.trim()}
                            style={{
                              padding: "7px 12px",
                              borderRadius: "6px",
                              border: "1px solid #CBD5E1",
                              background: newManualAccountName.trim() ? "#F8FAFC" : "#F1F5F9",
                              color: newManualAccountName.trim() ? "#0F172A" : "#94A3B8",
                              fontSize: "12px",
                              fontWeight: "600",
                              cursor: newManualAccountName.trim() ? "pointer" : "not-allowed",
                              flexShrink: 0
                            }}
                          >
                            + Add cash account
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Divider between Cash and Non-Cash */}
                    <div style={{ borderTop: "1px solid #E2E8F0", margin: "24px 0" }} />

                    {/* ── Sub-section 2: Non-cash bank accounts ── */}
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "14px" }}>
                        <div>
                          <h5 style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>
                            Non-cash bank accounts
                          </h5>
                          <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                            Accounts (e.g. corporate credit cards, Capital on Tap, or loan cards) tracked strictly for matching and clearing unreconciled P&amp;L additions. Transactions from these accounts are never added to the main cash flow bank reconciliation. Names in KeyInfo!H23:H28, Accounting Tool IDs in KeyInfo!I23:I28.
                          </p>
                          {renderCellRef("KeyInfo!H23:I28")}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <button
                            type="button"
                            onClick={() => handleFetchBankAccounts("non-cash")}
                            disabled={fetchingBankAccounts}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              padding: "7px 13px",
                              borderRadius: "6px",
                              border: "1px solid #7C3AED",
                              background: "#F5F3FF",
                              color: "#7C3AED",
                              fontSize: "12px",
                              fontWeight: "600",
                              cursor: fetchingBankAccounts ? "not-allowed" : "pointer",
                              opacity: fetchingBankAccounts ? 0.7 : 1,
                              transition: "all 0.15s ease"
                            }}
                          >
                            {fetchingBankAccounts && bankModalTarget === "non-cash" ? (
                              <>
                                <span style={{ display: "inline-block", width: "12px", height: "12px", border: "2px solid #7C3AED", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                                <span>Fetching accounts...</span>
                              </>
                            ) : (
                              <>
                                <span>💳</span>
                                <span>Show accounts in {settings.accounting?.toolInUse && settings.accounting?.toolInUse !== "None" ? settings.accounting?.toolInUse : "accounting tool"}</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Active Non-Cash Accounts List */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "14px" }}>
                        {(settings.accounting?.nonCashBankAccounts || []).length === 0 ? (
                          <div style={{ padding: "16px", background: "#F8FAFC", borderRadius: "8px", border: "1px dashed #CBD5E1", textAlign: "center", color: "#64748B", fontSize: "12px" }}>
                            <p style={{ margin: "0 0 4px", fontWeight: "600", color: "#334155" }}>No non-cash bank accounts configured</p>
                            <p style={{ margin: 0 }}>
                              Type a credit card or non-cash account name below (e.g. &quot;Capital on Tap - Credit Card&quot;) to enable automated P&L clearing.
                            </p>
                          </div>
                        ) : (
                          (settings.accounting?.nonCashBankAccounts || []).map((accountName, idx) => {
                            const cellRow = 23 + idx;
                            const matchDetail = (settings.accounting?.nonCashBankAccountDetails || []).find(d => d.name === accountName);
                            return (
                              <div
                                key={idx}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "10px",
                                  padding: "8px 12px",
                                  background: "#F8FAFC",
                                  borderRadius: "6px",
                                  border: "1px solid #E2E8F0"
                                }}
                              >
                                <span style={{ fontSize: "11px", fontWeight: "700", color: "#6B7280", minWidth: "55px" }}>
                                  H{cellRow}:
                                </span>
                                <span style={{ fontSize: "14px" }}>💳</span>
                                <input
                                  type="text"
                                  value={accountName}
                                  onChange={(e) => handleUpdateNonCashBankAccountName(idx, e.target.value)}
                                  style={{
                                    flex: 1,
                                    padding: "5px 8px",
                                    borderRadius: "4px",
                                    border: "1px solid #CBD5E1",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    color: "#0F172A",
                                    background: "#FFFFFF"
                                  }}
                                />
                                {matchDetail?.id && (
                                  <span style={{ fontSize: "10px", color: "#64748B", background: "#E2E8F0", padding: "2px 6px", borderRadius: "4px", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`Tool ID: ${matchDetail.id}`}>
                                    ID: {matchDetail.id}
                                  </span>
                                )}
                                <div style={{ display: "flex", gap: "2px" }}>
                                  <button
                                    type="button"
                                    onClick={() => handleMoveNonCashBankAccount(idx, idx - 1)}
                                    disabled={idx === 0}
                                    title="Move up"
                                    style={{
                                      padding: "4px 7px",
                                      borderRadius: "4px",
                                      border: "1px solid #CBD5E1",
                                      background: idx === 0 ? "#F1F5F9" : "#FFFFFF",
                                      color: idx === 0 ? "#CBD5E1" : "#475569",
                                      cursor: idx === 0 ? "not-allowed" : "pointer",
                                      fontSize: "10px"
                                    }}
                                  >
                                    ▲
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleMoveNonCashBankAccount(idx, idx + 1)}
                                    disabled={idx === (settings.accounting?.nonCashBankAccounts || []).length - 1}
                                    title="Move down"
                                    style={{
                                      padding: "4px 7px",
                                      borderRadius: "4px",
                                      border: "1px solid #CBD5E1",
                                      background: idx === (settings.accounting?.nonCashBankAccounts || []).length - 1 ? "#F1F5F9" : "#FFFFFF",
                                      color: idx === (settings.accounting?.nonCashBankAccounts || []).length - 1 ? "#CBD5E1" : "#475569",
                                      cursor: idx === (settings.accounting?.nonCashBankAccounts || []).length - 1 ? "not-allowed" : "pointer",
                                      fontSize: "10px"
                                    }}
                                  >
                                    ▼
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveNonCashBankAccount(idx)}
                                  title="Remove non-cash account"
                                  style={{
                                    padding: "4px 8px",
                                    borderRadius: "4px",
                                    border: "1px solid #FCA5A5",
                                    background: "#FEF2F2",
                                    color: "#DC2626",
                                    cursor: "pointer",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    flexShrink: 0
                                  }}
                                >
                                  ✕
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>

                      {/* Manual add input row (if under 6) */}
                      {(settings.accounting?.nonCashBankAccounts || []).length < 6 && (
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <input
                            type="text"
                            value={newManualNonCashAccountName}
                            onChange={(e) => setNewManualNonCashAccountName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleAddManualNonCashBankAccount();
                              }
                            }}
                            placeholder="Enter non-cash bank account name to add (e.g. Capital on Tap)..."
                            style={{
                              flex: 1,
                              padding: "7px 10px",
                              borderRadius: "6px",
                              border: "1px solid #CBD5E1",
                              fontSize: "12px",
                              boxSizing: "border-box"
                            }}
                          />
                          <button
                            type="button"
                            onClick={handleAddManualNonCashBankAccount}
                            disabled={!newManualNonCashAccountName.trim()}
                            style={{
                              padding: "7px 12px",
                              borderRadius: "6px",
                              border: "1px solid #CBD5E1",
                              background: newManualNonCashAccountName.trim() ? "#F8FAFC" : "#F1F5F9",
                              color: newManualNonCashAccountName.trim() ? "#0F172A" : "#94A3B8",
                              fontSize: "12px",
                              fontWeight: "600",
                              cursor: newManualNonCashAccountName.trim() ? "pointer" : "not-allowed",
                              flexShrink: 0
                            }}
                          >
                            + Add non-cash account
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Invoice number formatting (InvAppList!F1) */}
                  <div style={{ marginBottom: "28px", background: "#FFFFFF", borderRadius: "10px", padding: "20px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
                    <div style={{ marginBottom: "16px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                      <h4 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                        Invoice number formatting
                      </h4>
                      <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                        Configure how invoice reference numbers are formatted for comparison and display in Pulse.
                      </p>
                      {renderCellRef("InvAppList!F1")}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "24px", alignItems: "start" }}>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "6px" }}>
                          Formatting rule
                        </label>
                        <select
                          value={settings.accounting?.invoiceNumberFormatting || "StripPre"}
                          onChange={(e) => {
                            updateSettingsField(prev => ({
                              ...prev,
                              accounting: {
                                ...prev.accounting,
                                invoiceNumberFormatting: e.target.value
                              }
                            }));
                          }}
                          style={{
                            width: "100%",
                            padding: "9px 12px",
                            borderRadius: "6px",
                            border: "1px solid #CBD5E1",
                            fontSize: "13px",
                            color: "#0F172A",
                            background: "#FFFFFF",
                            boxSizing: "border-box"
                          }}
                        >
                          {INVOICE_NUMBER_FORMATTING_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <div style={{ fontSize: "11px", color: "#64748B", marginTop: "6px" }}>
                          Stored in Master Sheet cell <code style={{ background: "#F1F5F9", padding: "1px 4px", borderRadius: "4px" }}>InvAppList!F1</code>
                        </div>
                      </div>

                      <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: "8px", padding: "14px 18px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                          <span style={{ fontSize: "12px", fontWeight: "700", color: "#334155" }}>
                            Live preview
                          </span>
                          {(settings.accounting?.sampleInvoiceNumbers || []).length > 0 ? (
                            <span style={{ fontSize: "11px", color: "#166534", background: "#DCFCE7", border: "1px solid #86EFAC", padding: "2px 8px", borderRadius: "10px", fontWeight: "600" }}>
                              ✓ Live client invoices
                            </span>
                          ) : (
                            <span style={{ fontSize: "11px", color: "#475569", background: "#E2E8F0", padding: "2px 8px", borderRadius: "10px" }}>
                              Illustrative preview
                            </span>
                          )}
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          {((settings.accounting?.sampleInvoiceNumbers || []).length > 0
                            ? settings.accounting.sampleInvoiceNumbers
                            : ["INV-1065", "INV-5067"]
                          ).map((rawInv, idx) => {
                            const formatted = formatInvoiceNumber(rawInv, settings.accounting?.invoiceNumberFormatting || "StripPre");
                            return (
                              <div key={idx} style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "12px", fontFamily: "monospace" }}>
                                <span style={{ color: "#475569", fontWeight: "600", minWidth: "95px" }}>{rawInv}</span>
                                <span style={{ color: "#0066CC", fontWeight: "700" }}>➔</span>
                                <span style={{ color: "#0F172A", fontWeight: "700", background: "#EFF6FF", padding: "3px 8px", borderRadius: "4px", border: "1px solid #BFDBFE" }}>
                                  {formatted || "—"}
                                </span>
                              </div>
                            );
                          })}
                        </div>

                        {(settings.accounting?.sampleInvoiceNumbers || []).length === 0 && (
                          <div style={{ fontSize: "11px", color: "#64748B", marginTop: "10px", fontStyle: "italic", borderTop: "1px dashed #CBD5E1", paddingTop: "8px" }}>
                            Live invoices from your accounting tool will appear here once connected and synced.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expense status mapping (JnlAppList!F2) - Admin only */}
                  {effectiveIsAdmin && (
                    <div style={{ marginBottom: "28px", background: "#FFFFFF", borderRadius: "10px", padding: "20px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
                      <div style={{ marginBottom: "16px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <h4 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                            Expense status mapping
                          </h4>
                          <span style={{ fontSize: "10px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.05em", color: "#7C3AED", background: "#F5F3FF", border: "1px solid #DDD6FE", padding: "2px 6px", borderRadius: "4px" }}>
                            Admin only
                          </span>
                        </div>
                        <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                          Configure how journal and expense statuses are mapped from your accounting tool.
                        </p>
                        {renderCellRef("JnlAppList!F2")}
                      </div>

                      <div style={{ maxWidth: "340px" }}>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "6px" }}>
                          Mapping rule
                        </label>
                        <select
                          value={settings.accounting?.expenseStatusMapping || "Actual"}
                          disabled={!effectiveIsAdmin}
                          onChange={(e) => {
                            if (!effectiveIsAdmin) return;
                            updateSettingsField(prev => ({
                              ...prev,
                              accounting: {
                                ...prev.accounting,
                                expenseStatusMapping: e.target.value
                              }
                            }));
                          }}
                          style={{
                            width: "100%",
                            padding: "9px 12px",
                            borderRadius: "6px",
                            border: "1px solid #CBD5E1",
                            fontSize: "13px",
                            color: "#0F172A",
                            background: "#FFFFFF",
                            boxSizing: "border-box"
                          }}
                        >
                          {EXPENSE_STATUS_MAPPING_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <div style={{ fontSize: "11px", color: "#64748B", marginTop: "6px" }}>
                          Stored in Master Sheet cell <code style={{ background: "#F1F5F9", padding: "1px 4px", borderRadius: "4px" }}>JnlAppList!F2</code>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Manual Tracking Categories (KeyInfo!AT4:AT40) */}
                  <div style={{ marginBottom: "28px", background: "#F8FAFC", borderRadius: "10px", padding: "16px", border: "1px solid #E2E8F0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "14px" }}>
                      <div>
                        <h4 style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>
                          Manual category tracking
                        </h4>
                        <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                          Select categories from your Chart of Accounts to track contractors and other pass-through outgoings.
                        </p>
                        {coaMsg && (
                          <div style={{ marginTop: "4px", fontSize: "12px", color: "#166534", fontWeight: "600" }}>
                            {coaMsg}
                          </div>
                        )}
                        {coaError && (
                          <div style={{ marginTop: "4px", fontSize: "12px", color: "#DC2626", fontWeight: "600" }}>
                            {coaError}
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={handleFetchChartOfAccounts}
                        disabled={fetchingCoa}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "6px 12px",
                          background: "#EFF6FF",
                          color: "#0066CC",
                          border: "1px solid #0066CC",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: fetchingCoa ? "not-allowed" : "pointer",
                          opacity: fetchingCoa ? 0.7 : 1,
                          transition: "all 0.15s ease"
                        }}
                      >
                        {fetchingCoa ? (
                          <>
                            <span style={{ display: "inline-block", width: "11px", height: "11px", border: "2px solid #0066CC", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                            <span>Fetching Chart of Accounts...</span>
                          </>
                        ) : (
                          <>
                            <span>🔄</span>
                            <span>Fetch updated chart of accounts</span>
                          </>
                        )}
                      </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px", width: "100%", minWidth: 0, boxSizing: "border-box" }}>
                      <div style={{ background: "#FFFFFF", padding: "14px", borderRadius: "8px", border: "1px solid #E2E8F0", minWidth: 0, width: "100%", boxSizing: "border-box" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", minWidth: 0, gap: "6px" }}>
                          <label style={{ fontSize: "12px", fontWeight: "700", color: "#1E293B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            Contractors (max 19)
                          </label>
                          {renderCellRef("KeyInfo!AT4:AT22")}
                        </div>
                        {renderProgressiveDropdowns({
                          items: settings.accounting?.contractorsManual,
                          max: 19,
                          options: settings.accounting?.chartOfAccounts || [],
                          emptyOptionText: "-- Select contractor account --",
                          onChange: (next) => updateSettingsField(prev => ({ ...prev, accounting: { ...prev.accounting, contractorsManual: next } }))
                        })}
                      </div>

                      <div style={{ background: "#FFFFFF", padding: "14px", borderRadius: "8px", border: "1px solid #E2E8F0", minWidth: 0, width: "100%", boxSizing: "border-box" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", minWidth: 0, gap: "6px" }}>
                          <label style={{ fontSize: "12px", fontWeight: "700", color: "#1E293B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            Other pass-through (max 17)
                          </label>
                          {renderCellRef("KeyInfo!AT24:AT40")}
                        </div>
                        {renderProgressiveDropdowns({
                          items: settings.accounting?.passThroughManual,
                          max: 17,
                          options: settings.accounting?.chartOfAccounts || [],
                          emptyOptionText: "-- Select pass-through account --",
                          onChange: (next) => updateSettingsField(prev => ({ ...prev, accounting: { ...prev.accounting, passThroughManual: next } }))
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Accounting Categories Mapping (KeyInfo!BA2:BA180) */}
                  <div style={{ background: "#FFFFFF", borderRadius: "10px", border: "1px solid #E2E8F0", padding: "16px", boxSizing: "border-box", width: "100%", minWidth: 0, overflow: "hidden" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "16px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                      <div>
                        <h4 style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>
                          Category mapping rules
                        </h4>
                        <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                          Assign categories from your P&amp;L into Pulse financial categories. Each P&amp;L category can only be selected once.
                        </p>
                        {plMsg && (
                          <div style={{ marginTop: "4px", fontSize: "12px", color: "#166534", fontWeight: "600" }}>
                            {plMsg}
                          </div>
                        )}
                        {plError && (
                          <div style={{ marginTop: "4px", fontSize: "12px", color: "#DC2626", fontWeight: "600" }}>
                            {plError}
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={handlePullFreshPL}
                        disabled={pullingPl}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "6px 12px",
                          background: "#EFF6FF",
                          color: "#0066CC",
                          border: "1px solid #0066CC",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: pullingPl ? "not-allowed" : "pointer",
                          opacity: pullingPl ? 0.7 : 1,
                          transition: "all 0.15s ease"
                        }}
                      >
                        {pullingPl ? (
                          <>
                            <span style={{ display: "inline-block", width: "11px", height: "11px", border: "2px solid #0066CC", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                            <span>Pulling updated P&amp;L...</span>
                          </>
                        ) : (
                          <>
                            <span>📥</span>
                            <span>Pull updated P&amp;L</span>
                          </>
                        )}
                      </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "14px", width: "100%", minWidth: 0, boxSizing: "border-box" }}>
                      {[
                        { key: "revenue", label: "Revenue", max: 16, cell: "KeyInfo!BA2:BA17" },
                        { key: "cosStaffCosts", label: "COS staff costs", max: 10, cell: "KeyInfo!BA19:BA28" },
                        { key: "nonCosStaffCosts", label: "Non-COS staff costs", max: 9, cell: "KeyInfo!BA35:BA43" },
                        { key: "corporationTax", label: "Corporation tax", max: 3, cell: "KeyInfo!BA50:BA52" },
                        { key: "depreciation", label: "Depreciation", max: 3, cell: "KeyInfo!BA54:BA56" },
                        { key: "otherCostOfSale", label: "Other costs of sale", max: 20, cell: "KeyInfo!BA59:BA78" },
                        { key: "nonOperatingIncome", label: "Non-operating income", max: 13, cell: "KeyInfo!BA81:BA93" },
                        { key: "nonOperatingExpenses", label: "Non-operating expenses", max: 10, cell: "KeyInfo!BA101:BA110" },
                        { key: "ignore", label: "Ignore / exclude", max: 53, cell: "KeyInfo!BA128:BA180" }
                      ].map(group => {
                        return (
                          <div key={group.key} style={{ background: "#F8FAFC", padding: "12px 14px", borderRadius: "8px", border: "1px solid #E2E8F0", minWidth: 0, width: "100%", boxSizing: "border-box" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px", minWidth: 0, gap: "6px" }}>
                              <label style={{ fontSize: "12px", fontWeight: "700", color: "#1E293B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.label}</label>
                              {renderCellRef(group.cell)}
                            </div>
                            {renderProgressiveDropdowns({
                              items: settings.accounting?.mappings?.[group.key],
                              max: group.max,
                              options: settings.accounting?.plCategories || [],
                              emptyOptionText: "-- Select category --",
                              usedSet: usedPlCategoriesSet,
                              onChange: (next) => updateSettingsField(prev => ({
                                ...prev,
                                accounting: {
                                  ...prev.accounting,
                                  mappings: { ...prev.accounting.mappings, [group.key]: next }
                                }
                              }))
                            })}
                          </div>
                        );
                      })}
                    </div>

                    {/* Remaining Categories Box */}
                    <div style={{ marginTop: "24px", background: "#F8FAFC", borderRadius: "10px", padding: "16px", border: "1px solid #E2E8F0", boxSizing: "border-box", width: "100%", minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <div>
                          <div style={{ fontSize: "14px", fontWeight: "700", color: "#0F172A", display: "flex", alignItems: "center", gap: "8px" }}>
                            <span>Categories remaining</span>
                            <span style={{ fontSize: "11px", fontWeight: "700", padding: "2px 8px", background: remainingPlCategories.length > 0 ? "#FEF3C7" : "#DCFCE7", color: remainingPlCategories.length > 0 ? "#92400E" : "#166534", borderRadius: "12px", border: remainingPlCategories.length > 0 ? "1px solid #FCD34D" : "1px solid #86EFAC" }}>
                              {remainingPlCategories.length} remaining
                            </span>
                          </div>
                          <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#64748B" }}>
                            Categories remaining. Note: These categories will be classed as non-delivery expenses
                          </p>
                        </div>
                        {renderCellRef("KeyInfo!BG2:BG")}
                      </div>

                      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", maxHeight: "160px", overflowY: "auto", padding: "6px 0" }}>
                        {remainingPlCategories.length === 0 ? (
                          <div style={{ fontSize: "12px", color: "#166534", fontStyle: "italic", padding: "6px 0" }}>
                            ✓ All categories from P&amp;L have been mapped.
                          </div>
                        ) : (
                          remainingPlCategories.map(cat => (
                            <span
                              key={cat}
                              style={{
                                fontSize: "11px",
                                padding: "4px 10px",
                                borderRadius: "16px",
                                background: "#FFFFFF",
                                border: "1px solid #CBD5E1",
                                color: "#334155",
                                display: "inline-block"
                              }}
                            >
                              {cat}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── 4. CRM (MERGED) ─────────────────────────────────────────── */}
              {activeSection === "crm" && (
                <div>
                  {/* Global Feedback for CRM tests */}
                  {crmTestSuccessMsg && (
                    <div style={{ background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: "6px", padding: "10px 14px", fontSize: "13px", color: "#166534", marginBottom: "18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>{crmTestSuccessMsg}</span>
                      <button type="button" onClick={() => setCrmTestSuccessMsg("")} style={{ background: "none", border: "none", color: "#166534", cursor: "pointer", fontWeight: "bold" }}>✕</button>
                    </div>
                  )}
                  {crmTestErrorMsg && (
                    <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: "6px", padding: "10px 14px", fontSize: "13px", color: "#B91C1C", marginBottom: "18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>⚠️ {crmTestErrorMsg}</span>
                      <button type="button" onClick={() => setCrmTestErrorMsg("")} style={{ background: "none", border: "none", color: "#B91C1C", cursor: "pointer", fontWeight: "bold" }}>✕</button>
                    </div>
                  )}

                  {/* ── Subsection 1: CRM field mapping & live preview ── */}
                  <div style={{ marginBottom: "32px", background: "#FFFFFF", borderRadius: "10px", padding: "20px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.02)", boxSizing: "border-box", maxWidth: "100%", minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "16px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                          <h4 style={{ margin: "0", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                            CRM field mapping &amp; live preview
                          </h4>
                          <span style={{ fontSize: "11px", fontWeight: "700", color: "#0066CC", background: "#EFF6FF", border: "1px solid #BFDBFE", padding: "2px 8px", borderRadius: "12px" }}>
                            {displayedMappedJobs.length} deals mapped
                          </span>
                        </div>
                        <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748B" }}>
                          Map fields pulled from your CRM tool to the 13 required Pulse fields. Dropdown changes horizontally align with each column and update the preview instantly.
                        </p>
                        <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                          {renderCellRef("CRMList!AB2:AN3")}
                          {renderCellRef("CRMList!A2:M3")}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={handleTestCrmMappings}
                        disabled={testingCrm}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "8px 14px",
                          borderRadius: "6px",
                          border: "1px solid #0066CC",
                          background: "#EFF6FF",
                          color: "#0066CC",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: testingCrm ? "not-allowed" : "pointer",
                          opacity: testingCrm ? 0.7 : 1,
                          transition: "all 0.15s ease"
                        }}
                      >
                        {testingCrm ? (
                          <>
                            <span style={{ display: "inline-block", width: "12px", height: "12px", border: "2px solid #0066CC", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                            <span>Recalculating sheet...</span>
                          </>
                        ) : (
                          <>
                            <span>⚡</span>
                            <span>Apply &amp; Test Mappings</span>
                          </>
                        )}
                      </button>
                    </div>

                    {/* Unified Horizontal Mapping Header + Live Data Table */}
                    <div style={{
                      border: "1px solid #CBD5E1",
                      borderRadius: "8px",
                      overflow: "auto",
                      maxHeight: "580px",
                      background: "#FFFFFF",
                      position: "relative"
                    }}>
                      <table style={{ width: "100%", minWidth: "2860px", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                        <thead style={{ position: "sticky", top: 0, zIndex: 5, background: "#F8FAFC", boxShadow: "0 2px 4px rgba(0,0,0,0.06)" }}>
                          <tr>
                            {CRM_PULSE_FIELDS.map((f, idx) => {
                              const mapping = (settings.crm?.fieldMappings || []).find(m => m.key === f.key) || {
                                key: f.key,
                                label: f.label,
                                crmField: "",
                                formatRule: f.defaultFormat
                              };

                              const availableHeaders = settings.crm?.availableCrmHeaders || [];
                              const optionsList = Array.from(new Set(
                                [...availableHeaders, mapping.crmField].filter(Boolean)
                              ));

                              return (
                                <th
                                  key={f.key}
                                  style={{
                                    padding: "10px 12px",
                                    borderRight: idx < CRM_PULSE_FIELDS.length - 1 ? "1px solid #E2E8F0" : "none",
                                    borderBottom: "2px solid #CBD5E1",
                                    width: "220px",
                                    minWidth: "220px",
                                    verticalAlign: "top",
                                    background: "#F8FAFC"
                                  }}
                                >
                                  {/* Field Title & Ref */}
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                                    <span style={{ fontWeight: "700", color: "#0F172A", fontSize: "12.5px" }}>
                                      {f.label}
                                    </span>
                                    {showCellRefs && (
                                      <span style={{ fontSize: "10px", color: "#94A3B8", fontFamily: "monospace" }}>
                                        {f.colLetter} / {f.crmColLetter}
                                      </span>
                                    )}
                                  </div>

                                  {/* CRM Data Field Dropdown */}
                                  <div style={{ marginBottom: f.formatOptions.length > 0 ? "6px" : "0px" }}>
                                    <label style={{ display: "block", fontSize: "10px", fontWeight: "600", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "2px" }}>
                                      CRM DATA FIELD:
                                    </label>
                                    <select
                                      value={mapping.crmField || ""}
                                      onChange={(e) => {
                                        const nextField = e.target.value;
                                        updateSettingsField(prev => {
                                          const currentMappings = prev.crm?.fieldMappings || CRM_PULSE_FIELDS.map(item => ({
                                            key: item.key,
                                            label: item.label,
                                            crmField: "",
                                            formatRule: item.defaultFormat
                                          }));
                                          const updated = currentMappings.map(item => item.key === f.key ? { ...item, crmField: nextField } : item);
                                          return { ...prev, crm: { ...prev.crm, fieldMappings: updated } };
                                        });
                                      }}
                                      style={{
                                        width: "100%",
                                        padding: "5px 8px",
                                        borderRadius: "5px",
                                        border: "1px solid #CBD5E1",
                                        fontSize: "11.5px",
                                        color: mapping.crmField ? "#0F172A" : "#94A3B8",
                                        background: "#FFFFFF",
                                        fontWeight: mapping.crmField ? "600" : "normal"
                                      }}
                                    >
                                      <option value="">-- Not mapped --</option>
                                      {optionsList.map(h => (
                                        <option key={h} value={h}>{h}</option>
                                      ))}
                                    </select>
                                  </div>

                                  {/* Transformation Rule Dropdown (only rendered if field has transformation options) */}
                                  {f.formatOptions.length > 0 && (
                                    <div>
                                      <label style={{ display: "block", fontSize: "10px", fontWeight: "600", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "2px" }}>
                                        TRANSFORMATION RULE:
                                      </label>
                                      <select
                                        value={mapping.formatRule !== undefined ? mapping.formatRule : f.defaultFormat}
                                        onChange={(e) => {
                                          const nextRule = e.target.value;
                                          updateSettingsField(prev => {
                                            const currentMappings = prev.crm?.fieldMappings || CRM_PULSE_FIELDS.map(item => ({
                                              key: item.key,
                                              label: item.label,
                                              crmField: "",
                                              formatRule: item.defaultFormat
                                            }));
                                            const updated = currentMappings.map(item => item.key === f.key ? { ...item, formatRule: nextRule } : item);
                                            return { ...prev, crm: { ...prev.crm, fieldMappings: updated } };
                                          });
                                        }}
                                        style={{
                                          width: "100%",
                                          padding: "5px 8px",
                                          borderRadius: "5px",
                                          border: "1px solid #CBD5E1",
                                          fontSize: "11.5px",
                                          color: "#0F172A",
                                          background: "#FFFFFF"
                                        }}
                                      >
                                        {f.formatOptions.map(opt => (
                                          <option key={opt} value={opt}>
                                            {opt || "(Raw)"}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                  )}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>

                        <tbody>
                          {displayedMappedJobs.length === 0 ? (
                            <tr>
                              <td colSpan={13} style={{ padding: "36px", textAlign: "center", color: "#94A3B8", fontStyle: "italic" }}>
                                No deals mapped yet or no raw rows found in DataFromCRM.
                              </td>
                            </tr>
                          ) : (
                            displayedMappedJobs.map((row, rIdx) => (
                              <tr key={rIdx} style={{ borderBottom: "1px solid #F1F5F9", background: rIdx % 2 === 0 ? "#FFFFFF" : "#FBFCFD" }}>
                                {Array.from({ length: 13 }).map((_, cIdx) => {
                                  let cellVal = row[cIdx];
                                  if ((cIdx === 5 || cIdx === 6 || cIdx === 11) && cellVal) {
                                    cellVal = formatExcelOrStringDate(cellVal) || cellVal;
                                  }
                                  return (
                                    <td
                                      key={cIdx}
                                      style={{
                                        padding: "7px 12px",
                                        borderRight: cIdx < 12 ? "1px solid #F1F5F9" : "none",
                                        color: cIdx === 0 ? "#0F172A" : "#334155",
                                        fontWeight: cIdx === 0 ? "600" : "normal",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        maxWidth: "220px"
                                      }}
                                    >
                                      {cellVal || "—"}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* ── Subsection 2: Confirmed / pipeline job definitions (CRMList!DD2, DF2, DH2, EE2) ── */}
                  <div style={{ marginBottom: "32px", background: "#FFFFFF", borderRadius: "10px", padding: "20px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.02)", boxSizing: "border-box", maxWidth: "100%", minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "18px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                      <div>
                        <h4 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                          Confirmed / pipeline job definitions
                        </h4>
                        <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                          Configure what constitutes a &quot;Confirmed&quot; job, and define additional exclusions for &quot;Pipeline&quot; jobs.
                        </p>
                        <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                          {renderCellRef("CRMList!DD2, DF2, DH2, EE2")}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={handleTestCrmMappings}
                        disabled={testingCrm}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "8px 14px",
                          borderRadius: "6px",
                          border: "1px solid #0066CC",
                          background: "#EFF6FF",
                          color: "#0066CC",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: testingCrm ? "not-allowed" : "pointer",
                          opacity: testingCrm ? 0.7 : 1,
                          transition: "all 0.15s ease"
                        }}
                      >
                        {testingCrm ? (
                          <>
                            <span style={{ display: "inline-block", width: "12px", height: "12px", border: "2px solid #0066CC", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                            <span>Recalculating sheet...</span>
                          </>
                        ) : (
                          <>
                            <span>⚡</span>
                            <span>Apply &amp; Test Definitions</span>
                          </>
                        )}
                      </button>
                    </div>

                    {/* Definition Cards Grid */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "20px", marginBottom: "22px" }}>
                      {/* Card A: Confirmed Definition */}
                      <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: "8px", padding: "16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "12px" }}>
                          <span style={{ fontSize: "14px", fontWeight: "700", color: "#166534" }}>
                            Confirmed Job Definition
                          </span>
                          <span style={{ fontSize: "11px", background: "#DCFCE7", color: "#166534", padding: "1px 6px", borderRadius: "10px", fontWeight: "600" }}>
                            CZ4:DL
                          </span>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px" }}>
                            <div>
                              <label style={{ fontSize: "11px", fontWeight: "600", color: "#374151", display: "block", marginBottom: "4px" }}>
                                Likelihood criteria (DD2)
                              </label>
                              <select
                                value={settings.crm?.jobDefinitions?.confirmedLikelihood || ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateSettingsField(prev => ({
                                    ...prev,
                                    crm: {
                                      ...prev.crm,
                                      jobDefinitions: {
                                        ...prev.crm?.jobDefinitions,
                                        confirmedLikelihood: val
                                      }
                                    }
                                  }));
                                }}
                                style={{
                                  width: "100%",
                                  padding: "6px 8px",
                                  borderRadius: "6px",
                                  border: "1px solid #CBD5E1",
                                  fontSize: "12px",
                                  background: "#FFFFFF",
                                  color: "#0F172A"
                                }}
                              >
                                <option value="Likelihood 100%">Likelihood 100%</option>
                                <option value="">None (Don&apos;t require 100%)</option>
                              </select>
                            </div>

                            <div>
                              <label style={{ fontSize: "11px", fontWeight: "600", color: "#374151", display: "block", marginBottom: "4px" }}>
                                Logic Operator (DH2)
                              </label>
                              <select
                                value={settings.crm?.jobDefinitions?.confirmedOperator || "Or"}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateSettingsField(prev => ({
                                    ...prev,
                                    crm: {
                                      ...prev.crm,
                                      jobDefinitions: {
                                        ...prev.crm?.jobDefinitions,
                                        confirmedOperator: val
                                      }
                                    }
                                  }));
                                }}
                                style={{
                                  width: "100%",
                                  padding: "6px 8px",
                                  borderRadius: "6px",
                                  border: "1px solid #CBD5E1",
                                  fontSize: "12px",
                                  background: "#FFFFFF",
                                  color: "#0F172A"
                                }}
                              >
                                <option value="Or">Or (Likelihood OR Status)</option>
                                <option value="And">And (Likelihood AND Status)</option>
                              </select>
                            </div>
                          </div>

                          <div>
                            <label style={{ fontSize: "11px", fontWeight: "600", color: "#374151", display: "block", marginBottom: "4px" }}>
                              Status includes (DF2)
                            </label>
                            <ChipInput
                              values={(settings.crm?.jobDefinitions?.confirmedStatus || "")
                                .split(/,\s*/)
                                .map(s => s.trim())
                                .filter(Boolean)}
                              onChange={(newChips) => {
                                updateSettingsField(prev => ({
                                  ...prev,
                                  crm: {
                                    ...prev.crm,
                                    jobDefinitions: {
                                      ...prev.crm?.jobDefinitions,
                                      confirmedStatus: newChips.join(", ")
                                    }
                                  }
                                }));
                              }}
                              placeholder="Type status (e.g. Won) & press Enter..."
                            />
                            <div style={{ fontSize: "11px", color: "#4B5563", marginTop: "3px" }}>
                              Deals matching these status names are classified as Confirmed.
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Card B: Pipeline Definition */}
                      <div style={{ background: "#F5F3FF", border: "1px solid #DDD6FE", borderRadius: "8px", padding: "16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "12px" }}>
                          <span style={{ fontSize: "14px", fontWeight: "700", color: "#5B21B6" }}>
                            Pipeline Job Definition
                          </span>
                          <span style={{ fontSize: "11px", background: "#EDE9FE", color: "#5B21B6", padding: "1px 6px", borderRadius: "10px", fontWeight: "600" }}>
                            DU4:EG
                          </span>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                          <div style={{ background: "#FFFFFF", border: "1px dashed #C4B5FD", borderRadius: "6px", padding: "8px 12px", fontSize: "11px", color: "#6D28D9" }}>
                            <strong>Fixed Base Logic:</strong> Automatically derived from Confirmed rules. Includes deals with <code>Likelihood &lt; 100%</code> and excludes any deal with a Confirmed status (<code>{settings.crm?.jobDefinitions?.confirmedStatus || "Won"}</code>).
                          </div>

                          <div>
                            <label style={{ fontSize: "11px", fontWeight: "600", color: "#374151", display: "block", marginBottom: "4px" }}>
                              Additional statuses to EXCLUDE from pipeline (EE2)
                            </label>
                            <ChipInput
                              values={(settings.crm?.jobDefinitions?.pipelineExcludedStatuses || "")
                                .split(/,\s*/)
                                .map(s => s.trim())
                                .filter(Boolean)}
                              onChange={(newChips) => {
                                updateSettingsField(prev => ({
                                  ...prev,
                                  crm: {
                                    ...prev.crm,
                                    jobDefinitions: {
                                      ...prev.crm?.jobDefinitions,
                                      pipelineExcludedStatuses: newChips.join(", ")
                                    }
                                  }
                                }));
                              }}
                              placeholder="Type status (e.g. Lost, Blocked) & press Enter..."
                            />
                            <div style={{ fontSize: "11px", color: "#4B5563", marginTop: "3px" }}>
                              Exclude non-viable opportunities (e.g. Blocked, Lost, Unqualified).
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Classification Preview Table */}
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                            Job Classification Output:
                          </span>
                          <div style={{ display: "inline-flex", background: "#F1F5F9", borderRadius: "6px", padding: "2px" }}>
                            <button
                              type="button"
                              onClick={() => setPreviewJobTab("confirmed")}
                              style={{
                                padding: "4px 10px",
                                borderRadius: "4px",
                                border: "none",
                                fontSize: "12px",
                                fontWeight: "600",
                                cursor: "pointer",
                                background: previewJobTab === "confirmed" ? "#FFFFFF" : "transparent",
                                color: previewJobTab === "confirmed" ? "#166534" : "#64748B",
                                boxShadow: previewJobTab === "confirmed" ? "0 1px 2px rgba(0,0,0,0.05)" : "none"
                              }}
                            >
                              Confirmed Deals ({displayedConfirmedJobs.length})
                            </button>
                            <button
                              type="button"
                              onClick={() => setPreviewJobTab("pipeline")}
                              style={{
                                padding: "4px 10px",
                                borderRadius: "4px",
                                border: "none",
                                fontSize: "12px",
                                fontWeight: "600",
                                cursor: "pointer",
                                background: previewJobTab === "pipeline" ? "#FFFFFF" : "transparent",
                                color: previewJobTab === "pipeline" ? "#5B21B6" : "#64748B",
                                boxShadow: previewJobTab === "pipeline" ? "0 1px 2px rgba(0,0,0,0.05)" : "none"
                              }}
                            >
                              Pipeline Deals ({displayedPipelineJobs.length})
                            </button>
                          </div>
                        </div>
                      </div>

                      <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px", overflowX: "auto", WebkitOverflowScrolling: "touch", maxHeight: "420px" }}>
                        <table style={{ width: "100%", minWidth: "850px", borderCollapse: "collapse", fontSize: "11px", textAlign: "left", whiteSpace: "nowrap" }}>
                          <thead>
                            <tr style={{ background: previewJobTab === "confirmed" ? "#F0FDF4" : "#F5F3FF", borderBottom: "1px solid #E2E8F0", position: "sticky", top: 0, zIndex: 1 }}>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>Client</th>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>Job</th>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>Revenue</th>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>Direct costs</th>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>
                                Start date <span style={{ fontSize: "10px", color: "#64748B" }}>↑</span>
                              </th>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>End date</th>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>Likelihood</th>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>Status</th>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>Type</th>
                              <th style={{ padding: "7px 10px", fontWeight: "700", color: "#475569" }}>Lead source</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(() => {
                              const list = previewJobTab === "confirmed"
                                ? displayedConfirmedJobs
                                : displayedPipelineJobs;

                              if (list.length === 0) {
                                return (
                                  <tr>
                                    <td colSpan={10} style={{ padding: "20px", textAlign: "center", color: "#94A3B8", fontStyle: "italic" }}>
                                      No deals currently classified as {previewJobTab === "confirmed" ? "Confirmed" : "Pipeline"}.
                                    </td>
                                  </tr>
                                );
                              }

                              return list.map((deal, dIdx) => (
                                <tr key={dIdx} style={{ borderBottom: "1px solid #F1F5F9", background: dIdx % 2 === 0 ? "#FFFFFF" : "#FBFCFD" }}>
                                  <td style={{ padding: "6px 10px", fontWeight: "600", color: "#0F172A" }}>{deal[0] || "—"}</td>
                                  <td style={{ padding: "6px 10px", color: "#334155" }}>{deal[1] || "—"}</td>
                                  <td style={{ padding: "6px 10px", fontWeight: "600", color: "#0F172A" }}>{deal[3] || "—"}</td>
                                  <td style={{ padding: "6px 10px", color: "#64748B" }}>{deal[4] || "—"}</td>
                                  <td style={{ padding: "6px 10px", color: "#334155" }}>{formatExcelOrStringDate(deal[5]) || "—"}</td>
                                  <td style={{ padding: "6px 10px", color: "#334155" }}>{formatExcelOrStringDate(deal[6]) || "—"}</td>
                                  <td style={{ padding: "6px 10px" }}>
                                    <span style={{
                                      fontSize: "10px",
                                      fontWeight: "700",
                                      padding: "1px 5px",
                                      borderRadius: "4px",
                                      background: deal[7] === "100%" || deal[7] === "1" ? "#DCFCE7" : "#F1F5F9",
                                      color: deal[7] === "100%" || deal[7] === "1" ? "#166534" : "#475569"
                                    }}>
                                      {deal[7] || "—"}
                                    </span>
                                  </td>
                                  <td style={{ padding: "6px 10px" }}>
                                    <span style={{
                                      fontSize: "10px",
                                      fontWeight: "600",
                                      padding: "1px 6px",
                                      borderRadius: "10px",
                                      background: previewJobTab === "confirmed" ? "#DCFCE7" : "#EDE9FE",
                                      color: previewJobTab === "confirmed" ? "#166534" : "#5B21B6"
                                    }}>
                                      {deal[8] || "—"}
                                    </span>
                                  </td>
                                  <td style={{ padding: "6px 10px", color: "#475569" }}>{deal[9] || "—"}</td>
                                  <td style={{ padding: "6px 10px", color: "#64748B" }}>{deal[10] || "—"}</td>
                                </tr>
                              ));
                            })()}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  {/* ── Subsection 3: Existing CRM status mapping ── */}
                  <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
                    <div>
                      <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>CRM status mapping</h3>
                      <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                        Maps raw CRM deal/opportunity stages to probability likelihood % and start date adjust rules.
                      </p>
                      <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                        {renderCellRef("KeyInfo!L32:N75")}
                      </div>
                      {statusCheckMsg && (
                        <div style={{ marginTop: "6px", fontSize: "12px", color: "#166534", fontWeight: "600" }}>
                          {statusCheckMsg}
                        </div>
                      )}
                      {statusCheckError && (
                        <div style={{ marginTop: "6px", fontSize: "12px", color: "#DC2626", fontWeight: "600" }}>
                          {statusCheckError}
                        </div>
                      )}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={handleCheckCrmStatuses}
                        disabled={checkingStatuses}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "6px 12px",
                          background: "#EFF6FF",
                          color: "#0066CC",
                          border: "1px solid #0066CC",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: checkingStatuses ? "not-allowed" : "pointer",
                          opacity: checkingStatuses ? 0.7 : 1,
                          transition: "all 0.15s ease"
                        }}
                      >
                        {checkingStatuses ? (
                          <>
                            <span style={{ display: "inline-block", width: "11px", height: "11px", border: "2px solid #0066CC", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                            <span>Checking CRM data...</span>
                          </>
                        ) : (
                          <>
                            <span>🔍</span>
                            <span>Check CRM data for statuses</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          updateSettingsField(prev => ({
                            ...prev,
                            crmStatusMapping: [...(prev.crmStatusMapping || []), { status: "", likelihood: "", startDateRule: "", isManual: true }]
                          }));
                        }}
                        style={{
                          padding: "6px 12px",
                          background: "#0066CC",
                          color: "#FFFFFF",
                          border: "none",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: "pointer"
                        }}
                      >
                        + Add status
                      </button>
                    </div>
                  </div>

                  {(settings.crmStatusMapping || []).length === 0 ? (
                    <div style={{ padding: "30px", textAlign: "center", background: "#F8FAFC", borderRadius: "8px", border: "1px dashed #CBD5E1", color: "#64748B", fontSize: "13px" }}>
                      No CRM statuses mapped yet. Click &quot;Check CRM data for statuses&quot; to populate from opportunities, or click &quot;+ Add status&quot; to add one.
                    </div>
                  ) : (
                    <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                      <table style={{ width: "100%", minWidth: "560px", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                        <thead>
                          <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                            <th style={{ padding: "8px 12px", fontWeight: "600", color: "#475569" }}>CRM status / stage name</th>
                            <th style={{ padding: "8px 12px", fontWeight: "600", color: "#475569", width: "140px" }}>Likelihood %</th>
                            <th style={{ padding: "8px 12px", fontWeight: "600", color: "#475569", width: "210px" }}>Start date rule</th>
                            <th style={{ padding: "8px 12px", width: "60px" }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {settings.crmStatusMapping.map((item, idx) => {
                            const isCrmStatus = item.fromCrm === true || (!item.isManual && knownCrmStatuses.has(String(item.status || "").trim().toLowerCase()));
                            return (
                              <tr key={idx} style={{ borderBottom: "1px solid #F1F5F9" }}>
                                <td style={{ padding: "6px 12px" }}>
                                  <input
                                    type="text"
                                    value={item.status || ""}
                                    readOnly={isCrmStatus}
                                    onChange={(e) => {
                                      if (isCrmStatus) return;
                                      const val = e.target.value;
                                      updateSettingsField(prev => {
                                        const next = [...prev.crmStatusMapping];
                                        next[idx] = { ...next[idx], status: val };
                                        return { ...prev, crmStatusMapping: next };
                                      });
                                    }}
                                    placeholder={isCrmStatus ? "CRM Stage Name" : "e.g. Qualified, Presentation, Closed Won"}
                                    title={isCrmStatus ? "CRM status name is pulled from CRM and is not editable" : "Manually added status name"}
                                    style={{
                                      width: "100%",
                                      padding: "5px 8px",
                                      borderRadius: "4px",
                                      border: isCrmStatus ? "1px solid #E2E8F0" : "1px solid #CBD5E1",
                                      fontSize: "12px",
                                      boxSizing: "border-box",
                                      background: isCrmStatus ? "#F1F5F9" : "#FFFFFF",
                                      color: isCrmStatus ? "#475569" : "#0F172A",
                                      cursor: isCrmStatus ? "not-allowed" : "text"
                                    }}
                                  />
                                </td>
                                <td style={{ padding: "6px 12px" }}>
                                  <input
                                    type="text"
                                    value={item.likelihood || ""}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      updateSettingsField(prev => {
                                        const next = [...prev.crmStatusMapping];
                                        next[idx] = { ...next[idx], likelihood: val };
                                        return { ...prev, crmStatusMapping: next };
                                      });
                                    }}
                                    placeholder="e.g. 50%"
                                    style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                                  />
                                </td>
                                <td style={{ padding: "6px 12px" }}>
                                  <select
                                    value={item.startDateRule || ""}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      updateSettingsField(prev => {
                                        const next = [...prev.crmStatusMapping];
                                        next[idx] = { ...next[idx], startDateRule: val };
                                        return { ...prev, crmStatusMapping: next };
                                      });
                                    }}
                                    style={{
                                      width: "100%",
                                      padding: "5px 8px",
                                      borderRadius: "4px",
                                      border: "1px solid #CBD5E1",
                                      fontSize: "12px",
                                      boxSizing: "border-box",
                                      background: "#FFFFFF",
                                      color: item.startDateRule ? "#0F172A" : "#64748B"
                                    }}
                                  >
                                    <option value="">-- None --</option>
                                    {CRM_START_DATE_RULES.map(r => (
                                      <option key={r} value={r}>
                                        {r} {r === "1" ? "month" : "months"} in the future
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td style={{ padding: "6px 12px", textAlign: "right" }}>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      updateSettingsField(prev => ({
                                        ...prev,
                                        crmStatusMapping: prev.crmStatusMapping.filter((_, i) => i !== idx)
                                      }));
                                    }}
                                    style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontSize: "14px" }}
                                    title="Delete row"
                                  >
                                    ✕
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* ── 5. JOBS (ALL DISPLAYED WITH HEADERS) ────────────────────── */}
              {activeSection === "jobs" && (
                <div>
                  <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                    <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Jobs configuration</h3>
                    <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                      Project date adjustments, product line definitions, and client lead source mappings.
                    </p>
                  </div>

                  {/* Sub-section 1: Date adjustments */}
                  <div style={{ marginBottom: "28px" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Date adjustments</h4>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Project start date
                        </label>
                        <select
                          value={settings.jobs?.dateAdjustment?.projectStartDate || PROJECT_DATE_ADJUST_OPTIONS[1]}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, projectStartDate: e.target.value } }
                          }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {PROJECT_DATE_ADJUST_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!F15")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Project end date
                        </label>
                        <select
                          value={settings.jobs?.dateAdjustment?.projectEndDate || PROJECT_DATE_ADJUST_OPTIONS[2]}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, projectEndDate: e.target.value } }
                          }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {PROJECT_DATE_ADJUST_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!F16")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Retainer dates
                        </label>
                        <select
                          value={settings.jobs?.dateAdjustment?.retainerDates || RETAINER_DATES_OPTIONS[1]}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, retainerDates: e.target.value } }
                          }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {RETAINER_DATES_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!F17")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Retainer duration
                        </label>
                        <select
                          value={settings.jobs?.dateAdjustment?.retainerDur || RETAINER_DUR_OPTIONS[0]}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, retainerDur: e.target.value } }
                          }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {RETAINER_DUR_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!F18")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          Move CRM dates if in past?
                        </label>
                        <select
                          value={settings.jobs?.dateAdjustment?.moveCrmDatesIfPast || MOVE_CRM_DATES_OPTIONS[1]}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, moveCrmDatesIfPast: e.target.value } }
                          }))}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {MOVE_CRM_DATES_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("KeyInfo!F19")}
                      </div>

                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                          No end date retainer months (bookings &amp; pipeline)
                        </label>
                        <input
                          type="number"
                          min="1"
                          max="120"
                          step="1"
                          value={settings.jobs?.dateAdjustment?.noEndDateRetainerMonths ?? 18}
                          onChange={(e) => {
                            const val = e.target.value === "" ? "" : Math.max(1, parseInt(e.target.value, 10) || 18);
                            updateSettingsField(prev => ({
                              ...prev,
                              jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs?.dateAdjustment, noEndDateRetainerMonths: val } }
                            }));
                          }}
                          style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!D18")}
                      </div>
                    </div>
                  </div>

                  {/* Sub-section 2: Product lines */}
                  <div style={{ marginBottom: "28px", paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Product lines</h4>

                    {/* 15 Product Lines */}
                    <div style={{ marginBottom: "20px" }}>
                      <div style={{ fontSize: "12px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                        Product line names (up to 15)
                      </div>
                      {renderCellRef("KeyInfo!B23:B37")}
                      {renderProgressiveInputs({
                        items: settings.jobs?.productLines,
                        max: 15,
                        placeholderPrefix: "PL",
                        labelPrefix: "Product line",
                        onChange: (next) => updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, productLines: next } }))
                      })}
                    </div>

                    {/* Product Line Mappings */}
                    <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "16px", border: "1px solid #E2E8F0" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "12px" }}>
                        <div>
                          <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                            CRM product line mappings
                          </div>
                          {renderCellRef("KeyInfo!E23:F62")}
                          {productLinesMsg && (
                            <div style={{ marginTop: "4px", fontSize: "12px", color: "#166534", fontWeight: "600" }}>
                              {productLinesMsg}
                            </div>
                          )}
                          {productLinesError && (
                            <div style={{ marginTop: "4px", fontSize: "12px", color: "#DC2626", fontWeight: "600" }}>
                              {productLinesError}
                            </div>
                          )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            onClick={handleCheckCrmProductLines}
                            disabled={checkingProductLines}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              padding: "4px 10px",
                              background: "#EFF6FF",
                              color: "#0066CC",
                              border: "1px solid #0066CC",
                              borderRadius: "4px",
                              fontSize: "11px",
                              fontWeight: "600",
                              cursor: checkingProductLines ? "not-allowed" : "pointer",
                              opacity: checkingProductLines ? 0.7 : 1,
                              transition: "all 0.15s ease"
                            }}
                          >
                            {checkingProductLines ? (
                              <>
                                <span style={{ display: "inline-block", width: "10px", height: "10px", border: "2px solid #0066CC", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                                <span>Checking CRM...</span>
                              </>
                            ) : (
                              <>
                                <span>🔍</span>
                                <span>Check CRM data for product lines</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              updateSettingsField(prev => ({
                                ...prev,
                                jobs: {
                                  ...prev.jobs,
                                  productLineMappings: [...(prev.jobs?.productLineMappings || []), { crmProductLine: "", mappedTo: "", isManual: true }]
                                }
                              }));
                            }}
                            style={{ padding: "4px 10px", background: "#0066CC", color: "#fff", border: "none", borderRadius: "4px", fontSize: "11px", fontWeight: "600", cursor: "pointer" }}
                          >
                            + Add mapping
                          </button>
                        </div>
                      </div>

                      <div style={{ maxHeight: "280px", overflowY: "auto" }}>
                        {(settings.jobs?.productLineMappings || []).length === 0 ? (
                          <div style={{ padding: "16px", textAlign: "center", color: "#64748B", fontSize: "12px" }}>
                            No product line mappings yet. Click &quot;Check CRM data for product lines&quot; or &quot;+ Add mapping&quot;.
                          </div>
                        ) : (
                          (settings.jobs?.productLineMappings || []).map((m, idx) => {
                            const isCrmPl = m.fromCrm === true || (!m.isManual && knownCrmProductLines.has(String(m.crmProductLine || "").trim().toLowerCase()));
                            const matchingOpt = availableProductLines.find(
                              p => p.code === m.mappedTo || p.name === m.mappedTo || (m.mappedTo && m.mappedTo.toLowerCase().endsWith(" - " + p.name.toLowerCase()))
                            );
                            const currentVal = matchingOpt ? matchingOpt.code : (m.mappedTo || "");
                            return (
                              <div key={idx} style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px" }}>
                                <input
                                  type="text"
                                  value={m.crmProductLine || ""}
                                  readOnly={isCrmPl}
                                  onChange={(e) => {
                                    if (isCrmPl) return;
                                    const next = [...settings.jobs.productLineMappings];
                                    next[idx] = { ...next[idx], crmProductLine: e.target.value };
                                    updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, productLineMappings: next } }));
                                  }}
                                  placeholder={isCrmPl ? "CRM Product Line" : "Raw CRM product name..."}
                                  title={isCrmPl ? "Product line name is pulled from CRM and is not editable" : "Manually added product line"}
                                  style={{
                                    flex: 1,
                                    padding: "6px 8px",
                                    borderRadius: "4px",
                                    border: isCrmPl ? "1px solid #E2E8F0" : "1px solid #CBD5E1",
                                    fontSize: "12px",
                                    background: isCrmPl ? "#F1F5F9" : "#FFFFFF",
                                    color: isCrmPl ? "#475569" : "#0F172A",
                                    cursor: isCrmPl ? "not-allowed" : "text"
                                  }}
                                />
                                <span style={{ color: "#94A3B8" }}>→</span>
                                <select
                                  value={currentVal}
                                  onChange={(e) => {
                                    const next = [...settings.jobs.productLineMappings];
                                    next[idx] = { ...next[idx], mappedTo: e.target.value };
                                    updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, productLineMappings: next } }));
                                  }}
                                  style={{
                                    flex: 1,
                                    padding: "6px 8px",
                                    borderRadius: "4px",
                                    border: "1px solid #CBD5E1",
                                    fontSize: "12px",
                                    background: "#FFFFFF",
                                    color: currentVal ? "#0F172A" : "#64748B"
                                  }}
                                >
                                  <option value="">-- Select product line --</option>
                                  {availableProductLines.map(p => (
                                    <option key={p.code} value={p.code}>{p.code}</option>
                                  ))}
                                  {currentVal && !availableProductLines.some(p => p.code === currentVal) && (
                                    <option value={currentVal}>{currentVal}</option>
                                  )}
                                </select>
                                <button
                                  type="button"
                                  onClick={() => {
                                    updateSettingsField(prev => ({
                                      ...prev,
                                      jobs: {
                                        ...prev.jobs,
                                        productLineMappings: prev.jobs.productLineMappings.filter((_, i) => i !== idx)
                                      }
                                    }));
                                  }}
                                  style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontSize: "14px" }}
                                  title="Delete mapping"
                                >
                                  ✕
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Sub-section 3: Lead sources */}
                  <div style={{ paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Lead sources</h4>

                    {/* Client-specific lead sources */}
                    <div style={{ marginBottom: "20px" }}>
                      <div style={{ fontSize: "12px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                        Client-specific lead sources (max 10)
                      </div>
                      {renderCellRef("KeyInfo!G63:G72")}
                      {renderProgressiveInputs({
                        items: settings.jobs?.leadSources,
                        max: 10,
                        placeholderPrefix: "Source",
                        labelPrefix: "Lead source",
                        onChange: (next) => updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, leadSources: next } }))
                      })}
                    </div>

                    {/* Lead Sources Mappings */}
                    <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "16px", border: "1px solid #E2E8F0" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "12px" }}>
                        <div>
                          <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                            Lead source mappings
                          </div>
                          {renderCellRef("KeyInfo!I32:J75")}
                          {leadSourcesMsg && (
                            <div style={{ marginTop: "4px", fontSize: "12px", color: "#166534", fontWeight: "600" }}>
                              {leadSourcesMsg}
                            </div>
                          )}
                          {leadSourcesError && (
                            <div style={{ marginTop: "4px", fontSize: "12px", color: "#DC2626", fontWeight: "600" }}>
                              {leadSourcesError}
                            </div>
                          )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            onClick={handleCheckCrmLeadSources}
                            disabled={checkingLeadSources}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              padding: "4px 10px",
                              background: "#EFF6FF",
                              color: "#0066CC",
                              border: "1px solid #0066CC",
                              borderRadius: "4px",
                              fontSize: "11px",
                              fontWeight: "600",
                              cursor: checkingLeadSources ? "not-allowed" : "pointer",
                              opacity: checkingLeadSources ? 0.7 : 1,
                              transition: "all 0.15s ease"
                            }}
                          >
                            {checkingLeadSources ? (
                              <>
                                <span style={{ display: "inline-block", width: "10px", height: "10px", border: "2px solid #0066CC", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                                <span>Checking CRM...</span>
                              </>
                            ) : (
                              <>
                                <span>🔍</span>
                                <span>Check CRM data for lead sources</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              updateSettingsField(prev => ({
                                ...prev,
                                jobs: {
                                  ...prev.jobs,
                                  leadSourceMappings: [...(prev.jobs?.leadSourceMappings || []), { crmSource: "", mappedTo: "", isManual: true }]
                                }
                              }));
                            }}
                            style={{ padding: "4px 10px", background: "#0066CC", color: "#fff", border: "none", borderRadius: "4px", fontSize: "11px", fontWeight: "600", cursor: "pointer" }}
                          >
                            + Add mapping
                          </button>
                        </div>
                      </div>

                      <div style={{ maxHeight: "280px", overflowY: "auto" }}>
                        {(settings.jobs?.leadSourceMappings || []).length === 0 ? (
                          <div style={{ padding: "16px", textAlign: "center", color: "#64748B", fontSize: "12px" }}>
                            No lead source mappings yet. Click &quot;Check CRM data for lead sources&quot; or &quot;+ Add mapping&quot;.
                          </div>
                        ) : (
                          (settings.jobs?.leadSourceMappings || []).map((m, idx) => {
                            const isCrmLs = m.fromCrm === true || (!m.isManual && knownCrmLeadSources.has(String(m.crmSource || "").trim().toLowerCase()));
                            return (
                              <div key={idx} style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px" }}>
                                <input
                                  type="text"
                                  value={m.crmSource || ""}
                                  readOnly={isCrmLs}
                                  onChange={(e) => {
                                    if (isCrmLs) return;
                                    const next = [...settings.jobs.leadSourceMappings];
                                    next[idx] = { ...next[idx], crmSource: e.target.value };
                                    updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, leadSourceMappings: next } }));
                                  }}
                                  placeholder={isCrmLs ? "CRM Lead Source" : "Raw CRM source..."}
                                  title={isCrmLs ? "Lead source name is pulled from CRM and is not editable" : "Manually added lead source"}
                                  style={{
                                    flex: 1,
                                    padding: "6px 8px",
                                    borderRadius: "4px",
                                    border: isCrmLs ? "1px solid #E2E8F0" : "1px solid #CBD5E1",
                                    fontSize: "12px",
                                    background: isCrmLs ? "#F1F5F9" : "#FFFFFF",
                                    color: isCrmLs ? "#475569" : "#0F172A",
                                    cursor: isCrmLs ? "not-allowed" : "text"
                                  }}
                                />
                                <span style={{ color: "#94A3B8" }}>→</span>
                                <select
                                  value={m.mappedTo || ""}
                                  onChange={(e) => {
                                    const next = [...settings.jobs.leadSourceMappings];
                                    next[idx] = { ...next[idx], mappedTo: e.target.value };
                                    updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, leadSourceMappings: next } }));
                                  }}
                                  style={{
                                    flex: 1,
                                    padding: "6px 8px",
                                    borderRadius: "4px",
                                    border: "1px solid #CBD5E1",
                                    fontSize: "12px",
                                    background: "#FFFFFF",
                                    color: m.mappedTo ? "#0F172A" : "#64748B"
                                  }}
                                >
                                  <option value="">-- Select lead source --</option>
                                  {allAvailableLeadSources.map(src => (
                                    <option key={src} value={src}>{src}</option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  onClick={() => {
                                    updateSettingsField(prev => ({
                                      ...prev,
                                      jobs: {
                                        ...prev.jobs,
                                        leadSourceMappings: prev.jobs.leadSourceMappings.filter((_, i) => i !== idx)
                                      }
                                    }));
                                  }}
                                  style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontSize: "14px" }}
                                  title="Delete mapping"
                                >
                                  ✕
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>

                </div>
              )}

              {/* ── 6. AUTOMATIONS (ADMIN ONLY - ALL DISPLAYED WITH HEADERS) ── */}
              {activeSection === "automation" && (
                <div>
                  <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                    <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Automations & tolerances</h3>
                    <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                      Comparison rolling windows, tolerance thresholds, and discrepancy rules.
                    </p>
                  </div>

                  {/* Sub-section 1: Invoices */}
                  <div style={{ marginBottom: "28px" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Invoices</h4>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px", marginBottom: "20px" }}>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Months to compare</label>
                        <select
                          value={String(settings.automation?.invoices?.monthsToCompare || "6")}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, monthsToCompare: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {MONTHS_COMPARE_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt} months</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B32")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Months for others</label>
                        <select
                          value={String(settings.automation?.invoices?.monthsForOthers || "6")}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, monthsForOthers: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {MONTHS_COMPARE_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt} months</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B33")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Handling method</label>
                        <select
                          value={settings.automation?.invoices?.handlingMethod || INVOICE_HANDLING_METHOD_OPTIONS[1]}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, handlingMethod: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {INVOICE_HANDLING_METHOD_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!D39")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Month tolerance</label>
                        <input
                          type="text"
                          value={settings.automation?.invoices?.monthTolerance || "0"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, monthTolerance: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("DataChgAlert!F39")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Include half/third amounts?</label>
                        <select
                          value={settings.automation?.invoices?.includeHalfThird || "Yes"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, includeHalfThird: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {YES_NO_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!H39")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default project invoicing</label>
                        <select
                          value={settings.automation?.invoices?.defaultProjectInvoiceDetails || DEFAULT_INVOICING_DETAILS_OPTIONS[2]}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, defaultProjectInvoiceDetails: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {DEFAULT_INVOICING_DETAILS_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B50")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default retainer invoice date</label>
                        <input
                          type="text"
                          value={settings.automation?.invoices?.defaultRetainerInvoiceDate || "28"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, defaultRetainerInvoiceDate: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("DataChgAlert!B51")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default days to pay</label>
                        <input
                          type="text"
                          value={settings.automation?.invoices?.defaultDaysToPay || "30"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, defaultDaysToPay: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("DataChgAlert!B52")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Update days to pay on new month</label>
                        <select
                          value={settings.automation?.invoices?.updateDaysToPayNewMonth || "Yes"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, updateDaysToPayNewMonth: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {YES_NO_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B47")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Create invoices for retainers</label>
                        <select
                          value={settings.automation?.invoices?.createInvoiceRowsRetainers || "Yes"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, createInvoiceRowsRetainers: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {YES_NO_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B48")}
                      </div>
                    </div>

                    {/* Discrepancy Rules for Invoices */}
                    <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "16px", border: "1px solid #E2E8F0" }}>
                      <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", marginBottom: "12px" }}>
                        Invoice discrepancy rules (dashboard compare)
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                        {[
                          { key: "missingInvoice", label: "Missing invoice?", cell: "DataChgAlert!B39" },
                          { key: "clientMismatch", label: "Client mismatch", cell: "DataChgAlert!B40" },
                          { key: "invAmtMismatch", label: "Inv amt mismatch?", cell: "DataChgAlert!B41" },
                          { key: "sentDateMismatch", label: "Sent date mismatch?", cell: "DataChgAlert!B42" },
                          { key: "duplicateInvNo", label: "Duplicate inv no?", cell: "DataChgAlert!B43" },
                          { key: "fullyPaidMismatch", label: "Fully paid on mismatch?", cell: "DataChgAlert!B44" },
                          { key: "statusMismatch", label: "Status mismatch?", cell: "DataChgAlert!B45" }
                        ].map(r => (
                          <div key={r.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FFFFFF", padding: "6px 10px", borderRadius: "6px", border: "1px solid #E2E8F0" }}>
                            <div>
                              <span style={{ fontSize: "12px", color: "#334155" }}>{r.label}</span>
                              {renderCellRef(r.cell)}
                            </div>
                            <select
                              value={settings.automation?.invoices?.discrepancies?.[r.key] || "Include"}
                              onChange={(e) => {
                                const val = e.target.value;
                                updateSettingsField(prev => ({
                                  ...prev,
                                  automation: {
                                    ...prev.automation,
                                    invoices: {
                                      ...prev.automation.invoices,
                                      discrepancies: { ...prev.automation.invoices.discrepancies, [r.key]: val }
                                    }
                                  }
                                }));
                              }}
                              style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                            >
                              {DISCREPANCY_GAS_OPTIONS.map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Sub-section 2: Expenses */}
                  <div style={{ marginBottom: "28px", paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Expenses</h4>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px", marginBottom: "20px" }}>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Months to compare</label>
                        <select
                          value={String(settings.automation?.expenses?.monthsToCompare || "6")}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, monthsToCompare: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {MONTHS_COMPARE_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt} months</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B101")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Months for others</label>
                        <select
                          value={String(settings.automation?.expenses?.monthsForOthers || "6")}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, monthsForOthers: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {MONTHS_COMPARE_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt} months</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B102")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default direct cost receiving</label>
                        <select
                          value={settings.automation?.expenses?.defaultDirectCostDetails || DEFAULT_INVOICING_DETAILS_OPTIONS[2]}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, defaultDirectCostDetails: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {DEFAULT_INVOICING_DETAILS_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B105")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default retainer expense date</label>
                        <input
                          type="text"
                          value={settings.automation?.expenses?.defaultRetainerExpenseDate || "28"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, defaultRetainerExpenseDate: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("DataChgAlert!B106")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Handling method</label>
                        <select
                          value={settings.automation?.expenses?.handlingMethod || EXPENSE_HANDLING_METHOD_OPTIONS[1]}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, handlingMethod: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {EXPENSE_HANDLING_METHOD_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!H111")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Month tolerance</label>
                        <input
                          type="text"
                          value={settings.automation?.expenses?.monthTolerance || "0"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, monthTolerance: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("DataChgAlert!J111")}
                      </div>
                    </div>

                    {/* Discrepancy Rules for Expenses */}
                    <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "16px", border: "1px solid #E2E8F0" }}>
                      <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", marginBottom: "12px" }}>
                        Expense discrepancy rules (dashboard compare)
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                        {[
                          { key: "missingCost", label: "Missing cost?", cell: "DataChgAlert!B111" },
                          { key: "duplicateAppId", label: "Duplicate app ID?", cell: "DataChgAlert!B112" },
                          { key: "descrMismatch", label: "Descr. mismatch?", cell: "DataChgAlert!B113" },
                          { key: "amountMismatch", label: "Amount mismatch?", cell: "DataChgAlert!B114" },
                          { key: "vatMismatch", label: "VAT mismatch?", cell: "DataChgAlert!B115" },
                          { key: "recDateMismatch", label: "Rec date mismatch?", cell: "DataChgAlert!B116" },
                          { key: "payDateMismatch", label: "Pay date mismatch?", cell: "DataChgAlert!B117" },
                          { key: "statusMismatch", label: "Status mismatch?", cell: "DataChgAlert!B118" }
                        ].map(r => (
                          <div key={r.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FFFFFF", padding: "6px 10px", borderRadius: "6px", border: "1px solid #E2E8F0" }}>
                            <div>
                              <span style={{ fontSize: "12px", color: "#334155" }}>{r.label}</span>
                              {renderCellRef(r.cell)}
                            </div>
                            <select
                              value={settings.automation?.expenses?.discrepancies?.[r.key] || "Include"}
                              onChange={(e) => {
                                const val = e.target.value;
                                updateSettingsField(prev => ({
                                  ...prev,
                                  automation: {
                                    ...prev.automation,
                                    expenses: {
                                      ...prev.automation.expenses,
                                      discrepancies: { ...prev.automation.expenses.discrepancies, [r.key]: val }
                                    }
                                  }
                                }));
                              }}
                              style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                            >
                              {DISCREPANCY_GAS_OPTIONS.map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Sub-section 3: CRM Discrepancy Rules */}
                  <div style={{ paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                    <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>CRM discrepancy rules</h4>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "18px" }}>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>CRM months to compare</label>
                        <select
                          value={String(settings.automation?.crm?.monthsToCompare || "6")}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, crm: { ...prev.automation.crm, monthsToCompare: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {MONTHS_COMPARE_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt} months</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B55")}
                      </div>
                      <div>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Pipeline mode - add jobs to confirmed?</label>
                        <select
                          value={settings.automation?.crm?.pipelineAddJobsToConf || "Yes"}
                          onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, crm: { ...prev.automation.crm, pipelineAddJobsToConf: e.target.value } } }))}
                          style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        >
                          {YES_NO_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef("DataChgAlert!B82")}
                      </div>
                    </div>

                    {/* Dual Action Tables */}
                    {[
                      { key: "dashPipe", title: "Pipeline: dashboard compare", cell: "DataChgAlert!A59:C66" },
                      { key: "dashConf", title: "Confirmed: dashboard compare", cell: "DataChgAlert!D59:F66" },
                      { key: "crmPipe", title: "Pipeline: CRM app compare", cell: "DataChgAlert!A72:C79" },
                      { key: "crmConf", title: "Confirmed: CRM app compare", cell: "DataChgAlert!D72:F79" }
                    ].map(table => {
                      const rules = settings.automation?.crm?.rules?.[table.key] || [];
                      return (
                        <div key={table.key} style={{ background: "#F8FAFC", borderRadius: "8px", padding: "14px", border: "1px solid #E2E8F0", marginBottom: "14px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                            <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                              {table.title}
                            </div>
                            {renderCellRef(table.cell)}
                          </div>
                          <div style={{ border: "1px solid #E2E8F0", borderRadius: "6px", overflow: "hidden", background: "#FFFFFF" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                              <thead>
                                <tr style={{ background: "#F1F5F9", borderBottom: "1px solid #E2E8F0", textAlign: "left" }}>
                                  <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569" }}>Discrepancy rule</th>
                                  <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "140px" }}>GAS automation</th>
                                  <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "140px" }}>PMA alerts</th>
                                </tr>
                              </thead>
                              <tbody>
                                {rules.map((r, rIdx) => (
                                  <tr key={rIdx} style={{ borderBottom: "1px solid #F1F5F9" }}>
                                    <td style={{ padding: "6px 10px", color: "#334155", fontWeight: "500" }}>{r.label}</td>
                                    <td style={{ padding: "6px 10px" }}>
                                      <select
                                        value={r.gasAction || "Include"}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          updateSettingsField(prev => {
                                            const nextRules = [...(prev.automation?.crm?.rules?.[table.key] || [])];
                                            nextRules[rIdx] = { ...nextRules[rIdx], gasAction: val };
                                            return {
                                              ...prev,
                                              automation: {
                                                ...prev.automation,
                                                crm: {
                                                  ...prev.automation.crm,
                                                  rules: { ...prev.automation.crm.rules, [table.key]: nextRules }
                                                }
                                              }
                                            };
                                          });
                                        }}
                                        style={{ padding: "3px 6px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                                      >
                                        {DISCREPANCY_GAS_OPTIONS.map(opt => (
                                          <option key={opt} value={opt}>{opt}</option>
                                        ))}
                                      </select>
                                    </td>
                                    <td style={{ padding: "6px 10px" }}>
                                      <select
                                        value={r.pmaAction || "Include"}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          updateSettingsField(prev => {
                                            const nextRules = [...(prev.automation?.crm?.rules?.[table.key] || [])];
                                            nextRules[rIdx] = { ...nextRules[rIdx], pmaAction: val };
                                            return {
                                              ...prev,
                                              automation: {
                                                ...prev.automation,
                                                crm: {
                                                  ...prev.automation.crm,
                                                  rules: { ...prev.automation.crm.rules, [table.key]: nextRules }
                                                }
                                              }
                                            };
                                          });
                                        }}
                                        style={{ padding: "3px 6px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                                      >
                                        {DISCREPANCY_PMA_OPTIONS.map(opt => (
                                          <option key={opt} value={opt}>{opt}</option>
                                        ))}
                                      </select>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── 7. PULSE (CLIENT SHEET APPDATA) ─────────────────────────── */}
              {activeSection === "pulse" && (
                <div>
                  <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                    <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Pulse portal features</h3>
                    <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                      Configure client-facing navigation menus, chart views, and financial ratios displayed in the Pulse portal.
                    </p>
                  </div>

                  <div style={{ background: "#F8FAFC", borderRadius: "10px", padding: "16px 20px", border: "1px solid #E2E8F0" }}>
                    {renderToggle(
                      "Show staff costs to revenue / income ratio?",
                      settings.pulse?.showStaffCostsRatio === "Yes",
                      (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showStaffCostsRatio: v ? "Yes" : "No" } })),
                      "Controls visibility of the staff costs efficiency ratio card in the client portal.",
                      "AppData!W42"
                    )}

                    {renderToggle(
                      "Show cash menu?",
                      settings.pulse?.showCashMenu === "Yes",
                      (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showCashMenu: v ? "Yes" : "No" } })),
                      "Enables access to the rolling cash forecast screen in the client navigation.",
                      "AppData!W43"
                    )}

                    {renderToggle(
                      "Show budget functionality?",
                      settings.pulse?.showBudget === "Yes",
                      (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showBudget: v ? "Yes" : "No" } })),
                      "Enables the annual budget and variance reporting view.",
                      "AppData!W44"
                    )}

                    {renderToggle(
                      "Show cashflow chart?",
                      settings.pulse?.showCashflowChart === "Yes",
                      (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showCashflowChart: v ? "Yes" : "No" } })),
                      "Renders the interactive cashflow chart on the Cash screen.",
                      "AppData!G59"
                    )}

                    {renderToggle(
                      "Show 'last 12 months' chart?",
                      settings.pulse?.showLast12MonthsChart === "Yes",
                      (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showLast12MonthsChart: v ? "Yes" : "No" } })),
                      "Displays historical 12-month performance trajectory charts.",
                      "AppData!G71"
                    )}

                    {renderToggle(
                      "Show trendlines?",
                      settings.pulse?.showTrendlines === "Yes",
                      (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showTrendlines: v ? "Yes" : "No" } })),
                      "Plots trendline regressions across monthly performance charts.",
                      "AppData!I71"
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: PULL & SELECT BANK ACCOUNTS FROM ACCOUNTING TOOL ─────────── */}
      {showBankModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.6)",
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px"
        }}>
          <div style={{
            background: "#FFFFFF",
            borderRadius: "12px",
            width: "100%",
            maxWidth: "580px",
            maxHeight: "85vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
            overflow: "hidden"
          }}>
            {/* Modal Header */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h3 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                  {bankModalTarget === "non-cash"
                    ? `Select non-cash bank accounts from ${resolvedAccountingTool}`
                    : `Select bank accounts from ${resolvedAccountingTool}`}
                </h3>
                <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                  {bankModalTarget === "non-cash"
                    ? "Check accounts (credit cards, loans, non-cash accounts) to track for clearing unreconciled P&L additions. Stored in KeyInfo!H23:H28, IDs in KeyInfo!I23:I28. Maximum 6 accounts."
                    : "Check the accounts to include in Pulse. Names stored in KeyInfo!H12:H21, Accounting Tool IDs in KeyInfo!I12:I21. Maximum 10 accounts."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBankModal(false)}
                style={{ background: "none", border: "none", fontSize: "18px", color: "#64748B", cursor: "pointer", padding: "0 4px" }}
              >
                ✕
              </button>
            </div>

            {/* Modal Filter & Selection Toolbar */}
            <div style={{ padding: "12px 20px", background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
              <input
                type="text"
                value={bankSearchQuery}
                onChange={(e) => setBankSearchQuery(e.target.value)}
                placeholder="Filter accounts by name, code, currency..."
                style={{
                  flex: 1,
                  padding: "7px 10px",
                  borderRadius: "6px",
                  border: "1px solid #CBD5E1",
                  fontSize: "12px",
                  background: "#FFFFFF",
                  boxSizing: "border-box"
                }}
              />

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                {(() => {
                  const maxLimit = bankModalTarget === "non-cash" ? 6 : 10;
                  const isOver = tempSelectedBankAccounts.length > maxLimit;
                  const isFull = tempSelectedBankAccounts.length === maxLimit;
                  return (
                    <span style={{
                      fontSize: "12px",
                      fontWeight: "700",
                      color: isOver ? "#DC2626" : (isFull ? "#D97706" : (bankModalTarget === "non-cash" ? "#7C3AED" : "#0066CC")),
                      background: isOver ? "#FEF2F2" : (bankModalTarget === "non-cash" ? "#F5F3FF" : "#EFF6FF"),
                      padding: "3px 8px",
                      borderRadius: "6px"
                    }}>
                      {tempSelectedBankAccounts.length} / {maxLimit} selected
                    </span>
                  );
                })()}
                {tempSelectedBankAccounts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTempSelectedBankAccounts([])}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#64748B",
                      fontSize: "11px",
                      cursor: "pointer",
                      textDecoration: "underline"
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Accounts Checklist Content */}
            <div style={{ padding: "12px 20px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
              {filteredModalAccounts.length === 0 ? (
                <div style={{ padding: "30px", textAlign: "center", color: "#64748B", fontSize: "13px" }}>
                  No accounts found matching &quot;{bankSearchQuery}&quot;.
                </div>
              ) : (
                filteredModalAccounts.map((acc) => {
                  const maxLimit = bankModalTarget === "non-cash" ? 6 : 10;
                  const isChecked = tempSelectedBankAccounts.includes(acc.name);
                  const isMaxReached = !isChecked && tempSelectedBankAccounts.length >= maxLimit;
                  const themeColor = bankModalTarget === "non-cash" ? "#7C3AED" : "#0066CC";
                  const themeBg = bankModalTarget === "non-cash" ? "#F5F3FF" : "#EFF6FF";
                  const themeBadgeBg = bankModalTarget === "non-cash" ? "#EDE9FE" : "#DBEAFE";

                  return (
                    <div
                      key={acc.id || acc.name}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (!isMaxReached || isChecked) {
                          handleToggleBankAccount(acc.name);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (!isMaxReached || isChecked) {
                            handleToggleBankAccount(acc.name);
                          }
                        }
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: isChecked ? `1.5px solid ${themeColor}` : "1px solid #E2E8F0",
                        background: isChecked ? themeBg : "#FFFFFF",
                        cursor: isMaxReached && !isChecked ? "not-allowed" : "pointer",
                        opacity: isMaxReached && !isChecked ? 0.6 : 1,
                        transition: "all 0.12s ease",
                        userSelect: "none"
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1 }}>
                        <div
                          style={{
                            width: "20px",
                            height: "20px",
                            borderRadius: "5px",
                            border: isChecked ? `2px solid ${themeColor}` : "2px solid #CBD5E1",
                            background: isChecked ? themeColor : "#FFFFFF",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            transition: "all 0.15s ease",
                            boxShadow: isChecked ? `0 1px 2px ${themeColor}40` : "none"
                          }}
                        >
                          {isChecked && (
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="2.5 6 5 8.5 9.5 3.5" />
                            </svg>
                          )}
                        </div>
                        <div>
                          <div style={{ fontSize: "13px", fontWeight: isChecked ? "700" : "500", color: "#0F172A" }}>
                            {acc.name}
                          </div>
                          <div style={{ fontSize: "11px", color: "#64748B", marginTop: "2px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            {acc.code && <span style={{ background: "#F1F5F9", padding: "1px 6px", borderRadius: "4px", color: "#334155" }}>Code: {acc.code}</span>}
                            {acc.accountNumber && <span>Acct: ••••{acc.accountNumber.slice(-4)}</span>}
                            {acc.currency && <span style={{ background: "#E0E7FF", color: "#3730A3", padding: "1px 5px", borderRadius: "4px", fontWeight: "600" }}>{acc.currency}</span>}
                            {acc.subType && <span>{acc.subType}</span>}
                          </div>
                        </div>
                      </div>

                      {isChecked && (
                        <span style={{ fontSize: "11px", fontWeight: "700", color: themeColor, background: themeBadgeBg, padding: "2px 8px", borderRadius: "10px" }}>
                          ✓ Included
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Modal Footer */}
            <div style={{ padding: "14px 20px", borderTop: "1px solid #E2E8F0", background: "#F8FAFC", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button
                type="button"
                onClick={() => setShowBankModal(false)}
                style={{
                  padding: "7px 14px",
                  borderRadius: "6px",
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  color: "#475569",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>

              {(() => {
                const maxLimit = bankModalTarget === "non-cash" ? 6 : 10;
                const isOver = tempSelectedBankAccounts.length > maxLimit;
                const themeBtnColor = bankModalTarget === "non-cash" ? "#7C3AED" : "#0066CC";
                return (
                  <button
                    type="button"
                    onClick={handleApplyBankSelection}
                    disabled={isOver}
                    style={{
                      padding: "7px 16px",
                      borderRadius: "6px",
                      border: "none",
                      background: isOver ? "#94A3B8" : themeBtnColor,
                      color: "#FFFFFF",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: isOver ? "not-allowed" : "pointer"
                    }}
                  >
                    Apply selection ({tempSelectedBankAccounts.length} accounts)
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
