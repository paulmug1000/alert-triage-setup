/**
 * ============================================================================
 * CRM SUGGESTIONS SERVICE (services/crmSuggestionsService.js)
 * ============================================================================
 * 
 * Automates the CRM setup process:
 * 1. suggestCrmMappings:
 *    - Ingests 100+ sample deals from Master Sheet DataFromCRM!A1:ZZ.
 *    - Detects CRM tool from headers or KeyInfo!Q8.
 *    - Fuzzy matches 13 Pulse fields (CRMList!AB2:AN2) against standard and custom headers:
 *      * Client, Job, Project code, Revenue, Direct costs, Start date, End date,
 *      * Likelihood, Status, Project / retainer, Lead source, Date added to pipeline, Product line.
 *    - Inspects sample data formats to suggest transformation rules (CRMList!A2:M2):
 *      * Revenue: "Strip value" if currency symbols/commas present, else "Actual".
 *      * Likelihood: "Divide by 100" if decimal 0-1, else "Actual".
 *      * Start date: "Convert US" if US date format detected, else "Actual".
 *      * End date: "2MonthsForAll" if missing/blank, "Months" if numeric duration, else "Actual".
 *      * Project / Retainer: "From CRM" if column mapped, else "All project".
 *    - Derives Confirmed job definition (CRMList!DD2:DH2) and pipeline exclusions (CRMList!EE2):
 *      * Won status: Scans Status column for "Closed Won", "Won", "Signed", etc.
 *      * Likelihood: "100%", Operator: "Or".
 *      * Excluded statuses: Detects "Closed Lost", "Lost", "Archived", etc.
 * 2. applyCrmMappings:
 *    - Writes confirmed field mappings, transformation rules, and job definitions
 *      to Master Sheet CRMList!AB2:AN2, CRMList!A2:M2, CRMList!DD2:DH2, CRMList!EE2.
 */

import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { CRM_PULSE_FIELDS, saveClientSettings } from "./clientSettingsService.js";

/**
 * Known standard headers across supported CRMs for high-confidence mapping.
 */
const CRM_KNOWN_FIELD_MATCHERS = {
  client: [
    /^client$/i,
    /^organization$/i,
    /^org_name$/i,
    /^company$/i,
    /^customer$/i,
    /^client\s*\(party\)$/i,
    /^party\s*name$/i,
    /^lead\s*name$/i,
    /^account$/i,
    /^person$/i
  ],
  job: [
    /^deal\s*name$/i,
    /^title$/i,
    /^task\s*name$/i,
    /^opportunity\s*name$/i,
    /^job$/i,
    /^job\s*name$/i,
    /^name$/i
  ],
  projectCode: [
    /^project\s*code$/i,
    /^job\s*code$/i,
    /^custom\s*id$/i,
    /^code$/i,
    /^deal\s*id$/i,
    /^opportunity\s*id$/i,
    /^task\s*id$/i,
    /^id$/i
  ],
  revenue: [
    /^amount$/i,
    /^value$/i,
    /^deal\s*value$/i,
    /^expected\s*value$/i,
    /^revenue$/i,
    /^budget$/i,
    /^fee$/i,
    /^total$/i
  ],
  directCosts: [
    /^direct\s*costs?$/i,
    /^costs?$/i,
    /^cogs$/i,
    /^pass\s*through$/i,
    /^external\s*costs?$/i,
    /^disbursements?$/i,
    /^expenses?$/i
  ],
  startDate: [
    /^start\s*date$/i,
    /^won\s*time$/i,
    /^won\s*date$/i,
    /^closed\s*date$/i,
    /^close\s*date$/i,
    /^expected\s*close$/i,
    /^add\s*time$/i,
    /^created\s*date$/i,
    /^created\s*at$/i,
    /^date\s*created$/i,
    /^date$/i
  ],
  endDate: [
    /^end\s*date$/i,
    /^due\s*date$/i,
    /^delivery\s*date$/i,
    /^completion\s*date$/i,
    /^finish\s*date$/i
  ],
  likelihood: [
    /^probability\s*%?$/i,
    /^likelihood$/i,
    /^confidence$/i,
    /^win\s*probability$/i,
    /^chance$/i
  ],
  status: [
    /^stage$/i,
    /^deal\s*stage$/i,
    /^status$/i,
    /^status\s*\(milestone\)$/i,
    /^pipeline\s*stage$/i,
    /^state$/i
  ],
  projectRetainer: [
    /^project\s*\/?\s*retainer$/i,
    /^job\s*type$/i,
    /^type$/i,
    /^billing\s*type$/i,
    /^contract\s*type$/i,
    /^engagement\s*type$/i
  ],
  leadSource: [
    /^lead\s*source$/i,
    /^source$/i,
    /^original\s*source$/i,
    /^channel$/i,
    /^referral$/i,
    /^utm_source$/i
  ],
  dateAddedToPipeline: [
    /^date\s*added\s*to\s*pipeline$/i,
    /^add\s*time$/i,
    /^date\s*created$/i,
    /^created\s*date$/i,
    /^created\s*at$/i
  ],
  productLine: [
    /^product\s*line$/i,
    /^product$/i,
    /^line\s*of\s*business$/i,
    /^service$/i,
    /^offering$/i,
    /^category$/i
  ]
};

/**
 * Inspects a column's sample values to evaluate formatting and quality.
 */
function inspectColumnData(values) {
  const nonBlank = values.map(v => String(v || "").trim()).filter(Boolean);
  if (nonBlank.length === 0) {
    return { count: 0, hasCurrency: false, isNumeric: false, isDecimal0to1: false, isUSDate: false, uniqueValues: [] };
  }

  let currencyCount = 0;
  let numericCount = 0;
  let decimal0to1Count = 0;
  let usDateCount = 0;
  const uniqueSet = new Set();

  nonBlank.forEach(val => {
    uniqueSet.add(val);

    // Currency check (£, $, €, EUR, GBP, commas in numbers)
    if (/[£$€]|\b(eur|gbp|usd)\b/i.test(val) || (/^\s*[\d,]+\.\d{2}\s*$/.test(val) && val.includes(","))) {
      currencyCount++;
    }

    // Pure numeric check
    const cleanNum = val.replace(/[£$€,\s%]/g, "");
    const num = parseFloat(cleanNum);
    if (!isNaN(num)) {
      numericCount++;
      if (num > 0 && num <= 1.0) {
        decimal0to1Count++;
      }
    }

    // US Date pattern check (MM/DD/YYYY where MM <= 12 and DD > 12)
    const usDateMatch = val.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (usDateMatch) {
      const part1 = parseInt(usDateMatch[1], 10);
      const part2 = parseInt(usDateMatch[2], 10);
      if (part1 <= 12 && part2 > 12) {
        usDateCount++;
      }
    }
  });

  return {
    count: nonBlank.length,
    hasCurrency: currencyCount / nonBlank.length > 0.15,
    isNumeric: numericCount / nonBlank.length > 0.6,
    isDecimal0to1: decimal0to1Count / nonBlank.length > 0.5,
    isUSDate: usDateCount > 0,
    uniqueValues: Array.from(uniqueSet)
  };
}

/**
 * Scores how well an available CRM header matches a Pulse target field.
 */
function scoreHeaderMatch(header, targetFieldKey) {
  const matchers = CRM_KNOWN_FIELD_MATCHERS[targetFieldKey] || [];
  const cleanHeader = String(header || "").trim();

  for (let i = 0; i < matchers.length; i++) {
    if (matchers[i].test(cleanHeader)) {
      // Priority based on index in list (earlier is higher confidence)
      return 100 - i * 5;
    }
  }

  // Substring fuzzy matching
  const lowerHeader = cleanHeader.toLowerCase();
  const lowerKey = targetFieldKey.toLowerCase();
  if (lowerHeader.includes(lowerKey)) return 50;

  return 0;
}

/**
 * Suggests CRM field mappings, transformation rules, and confirmed job definitions.
 */
export async function suggestCrmMappings({ clientName, masterSheetId }) {
  if (!clientName || !masterSheetId) {
    throw new Error("Missing clientName or masterSheetId parameter.");
  }
  const cleanMasterId = extractSheetIdFromUrl(masterSheetId) || masterSheetId;
  const sheets = await getSheetsClient();

  // 1. Fetch available CRM headers and up to 150 rows of data from DataFromCRM!A1:ZZ150
  // Also read existing CRMList mappings (CRMList!AB2:AN2, CRMList!A2:M2, CRMList!DD2:DH2, CRMList!EE2)
  const [dataResp, crmListResp] = await Promise.all([
    withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "DataFromCRM!A1:ZZ150"
    })).catch(() => ({ data: { values: [] } })),
    withRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      ranges: [
        "CRMList!AB2:AN2",
        "CRMList!A2:M2",
        "CRMList!DD2:DH2",
        "CRMList!EE2"
      ]
    })).catch(() => ({ data: { valueRanges: [] } }))
  ]);

  const rawRows = dataResp.data.values || [];
  const rawHeaders = (rawRows[0] || []).map(h => String(h || "").trim());
  const sampleDataRows = rawRows.slice(1);

  // Available non-empty headers
  const availableHeaders = rawHeaders.filter(Boolean);

  // Read existing mappings
  const valRanges = crmListResp.data.valueRanges || [];
  const existingMappedCols = (valRanges[0]?.values?.[0] || []).map(c => String(c || "").trim());
  const existingFormatRules = (valRanges[1]?.values?.[0] || []).map(c => String(c || "").trim());
  const dd2dh2 = valRanges[2]?.values?.[0] || [];
  const existingConfirmedLikelihood = String(dd2dh2[0] || "").trim();
  const existingConfirmedStatus = String(dd2dh2[2] || "").trim();
  const existingConfirmedOperator = String(dd2dh2[4] || "Or").trim();
  const existingPipelineExcluded = String(valRanges[3]?.values?.[0]?.[0] || "").trim();

  // Column inspection cache (index in rawHeaders -> inspected details)
  const columnDataMap = new Map();
  rawHeaders.forEach((header, colIdx) => {
    if (!header) return;
    const colVals = sampleDataRows.map(row => row[colIdx]);
    columnDataMap.set(header, inspectColumnData(colVals));
  });

  // 2. Perform field matching for each of the 13 Pulse fields
  const assignedHeaders = new Set();
  const suggestedFieldMappings = [];

  CRM_PULSE_FIELDS.forEach((field, fieldIdx) => {
    let bestHeader = "";
    let highestScore = 0;

    // Check existing mapping first
    const existingHeader = existingMappedCols[fieldIdx];
    if (existingHeader && availableHeaders.includes(existingHeader)) {
      bestHeader = existingHeader;
      highestScore = 999; // Preserve current configuration if valid
    } else {
      availableHeaders.forEach(header => {
        if (assignedHeaders.has(header)) return;
        const score = scoreHeaderMatch(header, field.key);
        if (score > highestScore) {
          highestScore = score;
          bestHeader = header;
        }
      });
    }

    if (bestHeader && highestScore >= 40) {
      assignedHeaders.add(bestHeader);
    } else {
      bestHeader = "";
    }

    // Determine suggested format rule
    let formatRule = field.defaultFormat || "";
    const existingRule = existingFormatRules[fieldIdx];

    if (existingRule && field.formatOptions.includes(existingRule)) {
      formatRule = existingRule;
    } else if (bestHeader) {
      const colInfo = columnDataMap.get(bestHeader);

      if (field.key === "revenue") {
        if (colInfo?.hasCurrency) {
          formatRule = "Strip value";
        } else {
          formatRule = "Actual";
        }
      } else if (field.key === "likelihood") {
        if (colInfo?.isDecimal0to1) {
          formatRule = "Divide by 100";
        } else {
          formatRule = "Actual";
        }
      } else if (field.key === "startDate") {
        if (colInfo?.isUSDate) {
          formatRule = "Convert US";
        } else {
          formatRule = "Actual";
        }
      } else if (field.key === "endDate") {
        if (!colInfo || colInfo.count === 0) {
          formatRule = "2MonthsForAll";
        } else if (colInfo.isNumeric && !colInfo.hasCurrency) {
          formatRule = "Months";
        } else {
          formatRule = "Actual";
        }
      } else if (field.key === "projectRetainer") {
        formatRule = bestHeader ? "From CRM" : "All project";
      } else if (field.key === "leadSource" || field.key === "productLine") {
        formatRule = "Mapped";
      }
    } else if (field.key === "endDate") {
      formatRule = "2MonthsForAll";
    } else if (field.key === "projectRetainer") {
      formatRule = "All project";
    }

    suggestedFieldMappings.push({
      key: field.key,
      label: field.label,
      crmField: bestHeader,
      formatRule,
      formatOptions: field.formatOptions,
      matchConfidence: highestScore >= 80 ? "high" : highestScore >= 50 ? "medium" : "low"
    });
  });

  // 3. Inspect Status column for Confirmed Job Definition & Excluded Pipeline Statuses
  const statusMapping = suggestedFieldMappings.find(f => f.key === "status");
  const statusHeader = statusMapping?.crmField;
  const statusInfo = statusHeader ? columnDataMap.get(statusHeader) : null;
  const uniqueStatuses = statusInfo?.uniqueValues || [];

  let suggestedConfirmedStatus = existingConfirmedStatus || "";
  let suggestedConfirmedLikelihood = existingConfirmedLikelihood || "100%";
  let suggestedConfirmedOperator = existingConfirmedOperator || "Or";
  let suggestedPipelineExcluded = existingPipelineExcluded || "";

  if (!suggestedConfirmedStatus && uniqueStatuses.length > 0) {
    const wonStatus = uniqueStatuses.find(s => /^(closed won|won|signed|completed|active|confirmed|live)$/i.test(s.trim()))
      || uniqueStatuses.find(s => /won|signed/i.test(s));
    if (wonStatus) {
      suggestedConfirmedStatus = wonStatus;
    } else {
      suggestedConfirmedStatus = uniqueStatuses[0] || "Won";
    }
  }

  if (!suggestedPipelineExcluded && uniqueStatuses.length > 0) {
    const lostStatuses = uniqueStatuses.filter(s =>
      /^(closed lost|lost|archived|cancelled|dead|disqualified|rejected)$/i.test(s.trim()) ||
      /lost|dead|archive|cancel/i.test(s)
    );
    if (lostStatuses.length > 0) {
      suggestedPipelineExcluded = lostStatuses.join(", ");
    }
  }

  // Detect likely CRM tool
  let detectedCrmTool = "Custom / Google Sheets";
  const headerString = availableHeaders.join(" ").toLowerCase();
  if (headerString.includes("pipedrive") || (headerString.includes("deal id") && headerString.includes("won time"))) {
    detectedCrmTool = "Pipedrive";
  } else if (headerString.includes("hubspot") || (headerString.includes("deal name") && headerString.includes("deal stage"))) {
    detectedCrmTool = "HubSpot";
  } else if (headerString.includes("clickup") || (headerString.includes("task name") && headerString.includes("custom id"))) {
    detectedCrmTool = "ClickUp";
  } else if (headerString.includes("close") || (headerString.includes("lead name") && headerString.includes("expected value"))) {
    detectedCrmTool = "Close";
  } else if (headerString.includes("capsule") || headerString.includes("client (party)")) {
    detectedCrmTool = "Capsule";
  } else if (headerString.includes("monday")) {
    detectedCrmTool = "Monday.com";
  }

  return {
    success: true,
    detectedCrmTool,
    totalRecordsAnalysed: sampleDataRows.length,
    availableHeaders,
    uniqueStatusOptions: uniqueStatuses,
    fieldMappings: suggestedFieldMappings,
    jobDefinitions: {
      confirmedLikelihood: suggestedConfirmedLikelihood,
      confirmedStatus: suggestedConfirmedStatus,
      confirmedOperator: suggestedConfirmedOperator,
      pipelineExcludedStatuses: suggestedPipelineExcluded
    }
  };
}

/**
 * Writes approved CRM field mappings, format rules, and job definitions to Master Sheet.
 */
export async function applyCrmMappings({
  clientName,
  masterSheetId,
  fieldMappings,
  jobDefinitions
}) {
  if (!clientName || !masterSheetId) {
    throw new Error("Missing clientName or masterSheetId parameter.");
  }
  const cleanMasterId = extractSheetIdFromUrl(masterSheetId) || masterSheetId;

  // Use saveClientSettings to update CRMList!AB2:AN2, CRMList!A2:M2, CRMList!DD2:DH2, CRMList!EE2
  await saveClientSettings({
    clientName,
    masterSheetId: cleanMasterId,
    settings: {
      crm: {
        fieldMappings,
        jobDefinitions
      }
    }
  });

  return { success: true, message: "CRM field mappings and job definitions successfully applied to Master Sheet." };
}
