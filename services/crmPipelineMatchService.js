/**
 * Service for scanning and applying blank-Project-code matches between connected CRM deals
 * (Excel, Google Sheets, or OAuth CRMs) and existing rows on the Client Sheet Pipeline tab.
 */

import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { resolveSupabaseSheetContext } from "./masterEngineService.js";
import { recomputeClientComparisonsInSupabase } from "./masterSyncEngine.js";
import { updateClientChecklistTask } from "./setupService.js";
import { logPmaActivity } from "./pmaLogger.js";
import { resolveMasterSheetIdByClientName } from "./userPermissions.js";
import { sanitizeFormulaInput } from "../utils/helpers.js";
import {
  findBlankCodePipelineMatches,
  parseComparableDateYmd,
  parseComparableNumber,
  parseComparableLikelihood,
} from "../utils/crmPipelineMatcher.js";

function colIndexToLetter(idx0) {
  let temp = idx0 + 1;
  let letter = "";
  while (temp > 0) {
    const mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - mod) / 26);
  }
  return letter;
}

function normHdr(h) {
  return String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findHeaderCol(headers, candidates, fallback = -1) {
  const normalized = (headers || []).map(normHdr);
  for (const cand of candidates) {
    const idx = normalized.indexOf(normHdr(cand));
    if (idx !== -1) return idx;
  }
  return fallback;
}

function extractCrmDeals({ crmCompRows, dataFromCrmRows, crmListMappedHeaders }) {
  const byCode = new Map();

  // 1. Prefer CRMComp!A6:M when populated (already transformed through CRMList)
  if (Array.isArray(crmCompRows) && crmCompRows.length > 1) {
    const h = crmCompRows[0] || [];
    const cIdx = findHeaderCol(h, ["Client"], 0);
    const jIdx = findHeaderCol(h, ["Job", "Job name"], 1);
    const idIdx = findHeaderCol(h, ["Project code", "Code"], 2);
    const rIdx = findHeaderCol(h, ["Revenue"], 3);
    const sIdx = findHeaderCol(h, ["Start date"], 5);
    const eIdx = findHeaderCol(h, ["End date"], 6);
    const lIdx = findHeaderCol(h, ["Likelihood", "% likel."], 7);
    const stIdx = findHeaderCol(h, ["Status"], 8);

    for (let i = 1; i < crmCompRows.length; i++) {
      const row = crmCompRows[i] || [];
      const projectCode = String(row[idIdx] ?? "").trim();
      const client = String(row[cIdx] ?? "").trim();
      const job = String(row[jIdx] ?? "").trim();
      if (!projectCode || (!client && !job)) continue;
      byCode.set(projectCode.toUpperCase(), {
        source: "CRMComp",
        projectCode,
        client,
        job,
        revenue: row[rIdx] ?? "",
        startDate: row[sIdx] ?? "",
        endDate: row[eIdx] ?? "",
        likelihood: row[lIdx] ?? "",
        status: row[stIdx] ?? "",
      });
    }
  }

  // 2. Fallback / supplement from DataFromCRM!A1:ZZ using CRMList!AB2:AN2 or header heuristics
  if (Array.isArray(dataFromCrmRows) && dataFromCrmRows.length > 1) {
    const rawHeaders = (dataFromCrmRows[0] || []).map((x) => String(x || "").trim());
    const mapped = Array.isArray(crmListMappedHeaders) ? crmListMappedHeaders : [];
    const findMappedOrHeuristic = (mappedPos, names, regex) => {
      const mHdr = String(mapped[mappedPos] || "").trim();
      if (mHdr) {
        const idx = rawHeaders.findIndex((x) => normHdr(x) === normHdr(mHdr));
        if (idx !== -1) return idx;
      }
      const exactIdx = findHeaderCol(rawHeaders, names, -1);
      if (exactIdx !== -1) return exactIdx;
      return regex ? rawHeaders.findIndex((x) => regex.test(normHdr(x))) : -1;
    };

    const cIdx = findMappedOrHeuristic(0, ["Client name", "Client", "Organization", "Company", "Customer"], /^(client|org|company|customer)/i);
    const jIdx = findMappedOrHeuristic(1, ["Job name", "Job", "Deal name", "Opportunity name", "Task name", "Title", "Name"], /^(job|deal|opportunity|task|title)/i);
    const idIdx = findMappedOrHeuristic(2, ["System ID (Do Not Edit)", "Project code", "Code", "Deal ID", "ID"], /(systemid|projectcode|dealid)/i);
    const rIdx = findMappedOrHeuristic(3, ["Revenue", "Value", "Deal value", "Amount"], /^(revenue|value|amount|fee)/i);
    const sIdx = findMappedOrHeuristic(5, ["Est. start date", "Start date", "Start"], /^(est)?start/i);
    const eIdx = findMappedOrHeuristic(6, ["Est. end date", "End date", "Close date", "End"], /^(est)?end/i);
    const lIdx = findMappedOrHeuristic(7, ["% likelihood", "Likelihood", "Probability"], /(likel|prob)/i);
    const stIdx = findMappedOrHeuristic(8, ["Status", "Stage", "Deal stage"], /^(status|stage)/i);

    if (idIdx !== -1) {
      for (let i = 1; i < dataFromCrmRows.length; i++) {
        const row = dataFromCrmRows[i] || [];
        const projectCode = String(row[idIdx] ?? "").trim();
        const client = cIdx !== -1 ? String(row[cIdx] ?? "").trim() : "";
        const job = jIdx !== -1 ? String(row[jIdx] ?? "").trim() : "";
        if (!projectCode || (!client && !job)) continue;
        if (!byCode.has(projectCode.toUpperCase())) {
          byCode.set(projectCode.toUpperCase(), {
            source: "DataFromCRM",
            projectCode,
            client,
            job,
            revenue: rIdx !== -1 ? (row[rIdx] ?? "") : "",
            startDate: sIdx !== -1 ? (row[sIdx] ?? "") : "",
            endDate: eIdx !== -1 ? (row[eIdx] ?? "") : "",
            likelihood: lIdx !== -1 ? (row[lIdx] ?? "") : "",
            status: stIdx !== -1 ? (row[stIdx] ?? "") : "",
          });
        }
      }
    }
  }

  return Array.from(byCode.values());
}

function extractPipelineRows(pipeValues) {
  if (!Array.isArray(pipeValues) || pipeValues.length < 2) return { codeColIdx: 2, rows: [] };
  const headers = pipeValues[0] || [];
  const cIdx = findHeaderCol(headers, ["Client"], 0);
  const jIdx = findHeaderCol(headers, ["Job name", "Job"], 1);
  const idIdx = findHeaderCol(headers, ["Project code", "Code", "Job ID"], 2);
  const revIdx = findHeaderCol(headers, ["Job revenue", "Revenue (Proj total / Ongoing pm) - excl VAT", "Revenue"], 30);
  const startIdx = findHeaderCol(headers, ["Date job will start", "Start date"], 35);
  const endIdx = findHeaderCol(headers, ["Date job will end", "End date"], 36);
  const likelIdx = findHeaderCol(headers, ["% likel.", "Likelihood"], 39);

  const rows = [];
  for (let r = 1; r < pipeValues.length; r++) {
    const row = pipeValues[r] || [];
    const client = String(row[cIdx] ?? "").trim();
    const job = String(row[jIdx] ?? "").trim();
    const projectCode = String(row[idIdx] ?? "").trim();
    if (!client && !job && !projectCode) continue;
    rows.push({
      rowNum: r + 1,
      client,
      job,
      projectCode,
      revenue: revIdx !== -1 ? (row[revIdx] ?? "") : "",
      startDate: startIdx !== -1 ? (row[startIdx] ?? "") : "",
      endDate: endIdx !== -1 ? (row[endIdx] ?? "") : "",
      likelihood: likelIdx !== -1 ? (row[likelIdx] ?? "") : "",
    });
  }
  return { codeColIdx: idIdx, rows };
}

function formatPreviewRow(deal) {
  return {
    client: deal.client || "",
    job: deal.job || "",
    projectCode: deal.projectCode || "",
    rowNum: deal.rowNum || null,
    revenue: parseComparableNumber(deal.revenue),
    startDate: parseComparableDateYmd(deal.startDate),
    endDate: parseComparableDateYmd(deal.endDate),
    likelihood: parseComparableLikelihood(deal.likelihood),
  };
}

export async function scanBlankCodePipelineMatches({ clientName, masterSheetId }) {
  const sheets = await getSheetsClient();
  const supaCtx = await resolveSupabaseSheetContext({ clientName, spreadsheetId: masterSheetId });
  const cleanClientName = supaCtx?.clientName || clientName;
  let cleanMasterId = supaCtx?.masterSheetId || extractSheetIdFromUrl(masterSheetId) || masterSheetId;
  if (!cleanMasterId) {
    cleanMasterId = await resolveMasterSheetIdByClientName(sheets, cleanClientName);
  }
  if (!cleanMasterId) {
    throw new Error(`Could not resolve Master configuration for "${cleanClientName}".`);
  }

  const masterResp = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: cleanMasterId,
      valueRenderOption: "UNFORMATTED_VALUE",
      ranges: [
        "KeyInfo!Q8:X45",
        "CRMList!AB2:AN2",
        "DataFromCRM!A1:ZZ500",
        "CRMComp!A5:M500",
      ],
    })
  );

  const vRanges = masterResp.data?.valueRanges || [];
  const kiRows = vRanges[0]?.values || [];
  const crmTool = String(kiRows[0]?.[0] || "").trim() || "None"; // KeyInfo!Q8
  const crmDrives = String(kiRows[1]?.[0] || "").trim() || "NA"; // KeyInfo!Q9
  const clientSheetUrlOrId = String(kiRows[20]?.[7] || "").trim(); // KeyInfo!X28
  const cleanClientId = supaCtx?.clientSheetId || extractSheetIdFromUrl(clientSheetUrlOrId) || clientSheetUrlOrId;
  if (!cleanClientId) {
    throw new Error(`Could not locate Client dashboard sheet for "${cleanClientName}".`);
  }

  const pipeResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: cleanClientId,
      range: "Pipeline!A1:DP2000",
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );

  const crmDeals = extractCrmDeals({
    crmCompRows: vRanges[3]?.values || [],
    dataFromCrmRows: vRanges[2]?.values || [],
    crmListMappedHeaders: vRanges[1]?.values?.[0] || [],
  });

  const { rows: pipelineRows } = extractPipelineRows(pipeResp.data?.values || []);
  const result = findBlankCodePipelineMatches({ crmDeals, pipelineRows });

  const blankCodePipelineOptions = pipelineRows
    .filter((r) => !String(r.projectCode || "").trim() && (r.client || r.job))
    .map(formatPreviewRow);

  return {
    success: true,
    clientName: cleanClientName,
    masterMode: supaCtx?.masterMode || "sheet",
    crmTool,
    crmDrives,
    crmDealsCount: crmDeals.length,
    blankCodePipelineCount: result.eligiblePipeCount,
    alreadyLinkedCount: result.alreadyLinked.length,
    clearMatches: result.clearMatches.map((m) => ({
      crmDeal: formatPreviewRow(m.crmDeal),
      pipelineRow: formatPreviewRow(m.pipelineRow),
      score: m.score,
      confidence: m.confidence,
      reasons: m.reasons,
    })),
    possibleMatches: result.possibleMatches.map((m) => ({
      crmDeal: formatPreviewRow(m.crmDeal),
      pipelineRow: formatPreviewRow(m.pipelineRow),
      score: m.score,
      confidence: m.confidence,
      reasons: m.reasons,
    })),
    unmatchedCrmDeals: result.unmatchedCrmDeals.map(formatPreviewRow),
    blankCodePipelineOptions,
  };
}

export async function applyBlankCodePipelineMatches({
  clientName,
  masterSheetId,
  matches = [],
  userEmail = "Admin",
}) {
  if (!Array.isArray(matches) || matches.length === 0) {
    throw new Error("No matches were selected to apply.");
  }

  const sheets = await getSheetsClient();
  const supaCtx = await resolveSupabaseSheetContext({ clientName, spreadsheetId: masterSheetId });
  const cleanClientName = supaCtx?.clientName || clientName;
  let cleanMasterId = supaCtx?.masterSheetId || extractSheetIdFromUrl(masterSheetId) || masterSheetId;
  if (!cleanMasterId) {
    cleanMasterId = await resolveMasterSheetIdByClientName(sheets, cleanClientName);
  }
  const kiResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: cleanMasterId,
      range: "KeyInfo!X28",
    })
  );
  const cleanClientId =
    supaCtx?.clientSheetId ||
    extractSheetIdFromUrl(kiResp.data?.values?.[0]?.[0] || "") ||
    String(kiResp.data?.values?.[0]?.[0] || "").trim();

  if (!cleanClientId) {
    throw new Error(`Could not resolve Client sheet ID for "${cleanClientName}".`);
  }

  const pipeCheckResp = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: cleanClientId,
      range: "Pipeline!A1:F2000",
      valueRenderOption: "UNFORMATTED_VALUE",
    })
  );
  const pipeVals = pipeCheckResp.data?.values || [];
  const pipeHeaders = pipeVals[0] || [];
  const codeColIdx = findHeaderCol(pipeHeaders, ["Project code", "Code", "Job ID"], 2);
  const codeColLetter = colIndexToLetter(codeColIdx);

  const updates = [];
  const skipped = [];
  const seenRows = new Set();
  const seenCodes = new Set();

  for (const item of matches) {
    const rowNum = parseInt(item?.pipelineRow, 10);
    const projectCode = String(item?.projectCode || "").trim();
    if (!rowNum || rowNum < 2 || !projectCode) continue;
    if (seenRows.has(rowNum) || seenCodes.has(projectCode.toUpperCase())) {
      skipped.push({ rowNum, projectCode, reason: "Duplicate selection in request" });
      continue;
    }

    const existingCode = String(pipeVals[rowNum - 1]?.[codeColIdx] ?? "").trim();
    if (existingCode) {
      skipped.push({ rowNum, projectCode, reason: `Row already has code "${existingCode}"` });
      continue;
    }

    seenRows.add(rowNum);
    seenCodes.add(projectCode.toUpperCase());
    updates.push({
      range: `Pipeline!${codeColLetter}${rowNum}`,
      values: [[sanitizeFormulaInput(projectCode)]],
    });
  }

  if (updates.length > 0) {
    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: cleanClientId,
        requestBody: {
          valueInputOption: "RAW",
          data: updates,
        },
      })
    );
  }

  if (supaCtx?.masterMode === "supabase") {
    await recomputeClientComparisonsInSupabase(sheets, cleanClientName).catch((err) => {
      console.warn(`[crmPipelineMatchService] Supabase recompute warning for ${cleanClientName}:`, err.message);
    });
  }

  await updateClientChecklistTask(sheets, {
    clientName: cleanClientName,
    taskId: "p4_review_crm",
    isCompleted: true,
    metadata: `Linked ${updates.length} existing Pipeline job(s)`,
    userEmail,
  }).catch(() => {});

  await logPmaActivity(sheets, {
    clientName: cleanClientName,
    category: "SETUP",
    action: "CRM_PIPELINE_CODES_LINKED",
    summary: `Linked ${updates.length} existing Pipeline job(s) to CRM Project codes for ${cleanClientName}`,
    details: { appliedCount: updates.length, skipped },
    userEmail,
  }).catch(() => {});

  return {
    success: true,
    clientName: cleanClientName,
    appliedCount: updates.length,
    skipped,
  };
}
