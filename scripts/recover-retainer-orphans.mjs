/**
 * Race-free recovery script for Eleven & Thrive Recruitment Marketing Confirmed tabs.
 *
 * Defaults to --dry-run (zero mutations). Pass --apply to execute repairs directly on the live
 * Google Sheet via rawSheets under a per-client Redis Bridge lock, then atomically reseed
 * Supabase virtual sheets + relational jobs + Bridge baseline via seedClientSheetToSupabase,
 * and auto-resolve stale retainerInvoicesCreated rows in alert_memory.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { redisClient } from "../services/redisClient.js";
import { getSupabaseAdmin } from "../services/supabaseClient.js";
import { getPrimaryRawGoogleClients, getSheetsClient } from "../services/sheetsClient.js";
import {
  flushImmediateAndScheduleBackgroundClientRecomputes,
  resolveSupabaseSheetContext,
  seedClientSheetToSupabase,
} from "../services/masterEngineService.js";
import { clearPendingStructuralOpsById_ } from "../services/clientSheetBridgeService.js";
import {
  verifyRelationalJobsParity,
  verifyRelationalJobsReadParity,
} from "../services/relationalJobsService.js";
import { invalidatePmaClientCache } from "../services/cacheService.js";
import { retRowHasRealData, retFindTrueLastRow } from "../services/retainers.js";
import { buildJobRowClearAndRestorePlan, isJobCostingStyle } from "../utils/helpers.js";

const COL_VAT = 34; // Col AI
const COL_SEND_DATE = 43; // Col AR
const LOCK_TTL_SECONDS = 300;

async function withSheetsRetry(fn, label = "sheets") {
  const retryCodes = new Set([429, 500, 502, 503, 504]);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = Number(err?.code || err?.status || err?.response?.status || 0);
      if (attempt < 4 && retryCodes.has(code)) {
        const waitMs = 2000 * Math.pow(2, attempt);
        console.warn(`  [retry] ${label} hit HTTP ${code}; retrying in ${waitMs}ms...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

function wrapRawSheetsWithRetry(rawSheets) {
  return {
    spreadsheets: {
      get: (p) => withSheetsRetry(() => rawSheets.spreadsheets.get(p), "spreadsheets.get"),
      batchUpdate: (p) => withSheetsRetry(() => rawSheets.spreadsheets.batchUpdate(p), "spreadsheets.batchUpdate"),
      values: {
        get: (p) => withSheetsRetry(() => rawSheets.spreadsheets.values.get(p), "values.get"),
        batchUpdate: (p) => withSheetsRetry(() => rawSheets.spreadsheets.values.batchUpdate(p), "values.batchUpdate"),
        batchClear: (p) => withSheetsRetry(() => rawSheets.spreadsheets.values.batchClear(p), "values.batchClear"),
      },
    },
  };
}

function norm(val) {
  return String(val ?? "").trim();
}

function normLower(val) {
  return norm(val).toLowerCase();
}

function normalizeBridgeKey(clientName) {
  return String(clientName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Check only user-editable / data columns cleared by buildJobRowClearAndRestorePlan
// (excludes formula columns like BW / col 74 which evaluate to "-" even on empty template rows).
function rowHasAnyNonEmptyCell(row = []) {
  for (let c = 0; c < row.length; c++) {
    if (c === 10 || (c >= 12 && c <= 14) || c === 20 || c === 32 || c === 33 || c === 37 || c === 38 || c === 40 || (c >= 62 && c <= 74)) {
      continue;
    }
    if (norm(row[c]) !== "") return true;
  }
  return false;
}

function summarizeRow(rowNum, row = []) {
  const cols = [];
  if (norm(row[0])) cols.push(`A="${norm(row[0])}"`);
  if (norm(row[1])) cols.push(`B="${norm(row[1])}"`);
  if (norm(row[2])) cols.push(`C="${norm(row[2])}"`);
  if (norm(row[34])) cols.push(`AI="${norm(row[34])}"`);
  if (norm(row[41])) cols.push(`AP=${norm(row[41])}`);
  if (norm(row[42])) cols.push(`AQ="${norm(row[42])}"`);
  if (norm(row[43])) cols.push(`AR=${norm(row[43])}`);
  if (norm(row[44])) cols.push(`AS=${norm(row[44])}`);
  if (norm(row[45])) cols.push(`AT="${norm(row[45])}"`);
  return `R${rowNum}: [${cols.join(", ") || "blank"}]`;
}

function findJobParentRow(rows, { client, projectCode = "", jobSubstr = "" }) {
  const wantClient = normLower(client);
  const wantCode = normLower(projectCode);
  const wantJobSub = normLower(jobSubstr);

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const colA = normLower(r[0]);
    const colB = normLower(r[1]);
    if (!colA || !colB || colA !== wantClient) continue;

    if (wantCode) {
      if (r.slice(0, 10).some((v) => normLower(v) === wantCode)) {
        return i + 1;
      }
      continue;
    }
    if (wantJobSub && colB.includes(wantJobSub)) {
      return i + 1;
    }
  }
  return null;
}

function inspectJobBlock(rows, parentRowNum) {
  const parentIdx = parentRowNum - 1;
  const parentRow = rows[parentIdx] || [];
  const parentClient = norm(parentRow[0]);
  const parentJob = norm(parentRow[1]);

  let lastValidChildRowNum = parentRowNum;
  let cursor = parentIdx + 1;
  while (cursor < rows.length) {
    const r = rows[cursor] || [];
    if (
      normLower(r[0]) === parentClient.toLowerCase() &&
      normLower(r[1]) === parentJob.toLowerCase()
    ) {
      lastValidChildRowNum = cursor + 1;
      cursor++;
    } else {
      break;
    }
  }

  const gapStartRowNum = lastValidChildRowNum + 1;
  let gapEndRowNum = gapStartRowNum - 1;
  let nextRealJobRowNum = null;
  let scan = cursor;
  while (scan < rows.length) {
    const r = rows[scan] || [];
    if (norm(r[1])) {
      nextRealJobRowNum = scan + 1;
      break;
    }
    if (!norm(r[0]) && !rowHasAnyNonEmptyCell(r)) {
      let foundSoon = false;
      for (let p = scan + 1; p < Math.min(rows.length, scan + 16); p++) {
        if (norm(rows[p]?.[1]) || rowHasAnyNonEmptyCell(rows[p])) {
          foundSoon = true;
          break;
        }
      }
      if (!foundSoon) break;
    }
    gapEndRowNum = scan + 1;
    scan++;
  }

  return {
    parentRowNum,
    parentClient,
    parentJob,
    parentVat: norm(parentRow[COL_VAT]),
    lastValidChildRowNum,
    gapStartRowNum,
    gapEndRowNum,
    nextRealJobRowNum,
  };
}

async function waitForRedisOpen() {
  if (redisClient.isOpen) return;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (redisClient.isOpen) return;
  }
  throw new Error("Redis connection did not open within 3s");
}

async function acquireClientBridgeLock(clientKey) {
  await waitForRedisOpen();
  const lockKey = `pulse:sheet_bridge_lock:${clientKey}`;
  const token = `recovery_${process.pid}_${crypto.randomBytes(6).toString("hex")}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await redisClient.set(lockKey, token, { NX: true, EX: LOCK_TTL_SECONDS });
    if (res) return { lockKey, token };
    if (attempt < 19) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`Lock ${lockKey} is currently held by another process; aborting without mutation`);
}

async function releaseClientBridgeLock({ lockKey, token }) {
  try {
    if (!redisClient.isOpen) return;
    const cur = await redisClient.get(lockKey).catch(() => null);
    if (cur === token) {
      await redisClient.del(lockKey).catch(() => {});
    }
  } catch {
    // ignore release failures
  }
}

async function clearBridgeQueuesForClient(clientKey) {
  await clearPendingStructuralOpsById_(clientKey, null);
  if (redisClient.isOpen) {
    await redisClient.del(`pulse:sheet_bridge_dirty:${clientKey}`).catch(() => {});
  }
}

async function fetchConfirmedMetaAndRows(rawSheets, clientSheetId) {
  const [metaResp, valResp] = await Promise.all([
    rawSheets.spreadsheets.get({
      spreadsheetId: clientSheetId,
      fields: "sheets(properties.sheetId,properties.title,properties.gridProperties,rowGroups)",
    }),
    rawSheets.spreadsheets.values.get({
      spreadsheetId: clientSheetId,
      range: "Confirmed!A1:CR5000",
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);
  const confirmedSheet = (metaResp.data.sheets || []).find((s) => s.properties?.title === "Confirmed");
  assert(confirmedSheet, `Confirmed tab not found on ${clientSheetId}`);
  return {
    gridSheetId: confirmedSheet.properties.sheetId,
    rowCount: Number(confirmedSheet.properties?.gridProperties?.rowCount || 0),
    rowGroups: confirmedSheet.rowGroups || [],
    rows: valResp.data.values || [],
  };
}

async function detectJobCosting(rawSheets, clientSheetId, headers) {
  let keyInfoD11 = "";
  try {
    const ki = await rawSheets.spreadsheets.values.get({
      spreadsheetId: clientSheetId,
      range: "KeyInfo!D11",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    keyInfoD11 = norm(ki.data.values?.[0]?.[0]);
  } catch {
    // ignore
  }
  return isJobCostingStyle({ headers: headers || [], keyInfoD11 });
}

function buildDeleteOverlappingGroupRequests(rowGroups, gridSheetId, startIdx0Inclusive, endIdx0Exclusive) {
  return (rowGroups || [])
    .filter(
      (g) =>
        g?.range &&
        g.range.dimension !== "COLUMNS" &&
        g.range.startIndex < endIdx0Exclusive &&
        g.range.endIndex > startIdx0Inclusive
    )
    .map((g) => ({
      deleteDimensionGroup: {
        range: {
          sheetId: gridSheetId,
          dimension: "ROWS",
          startIndex: g.range.startIndex,
          endIndex: g.range.endIndex,
        },
      },
    }));
}

function buildCollapsedGroupRequests(gridSheetId, parentRowNum, lastChildRowNum) {
  if (!parentRowNum || !lastChildRowNum || lastChildRowNum <= parentRowNum) return [];
  return [
    {
      addDimensionGroup: {
        range: {
          sheetId: gridSheetId,
          dimension: "ROWS",
          startIndex: parentRowNum,
          endIndex: lastChildRowNum,
        },
      },
    },
    {
      updateDimensionGroup: {
        dimensionGroup: {
          range: {
            sheetId: gridSheetId,
            dimension: "ROWS",
            startIndex: parentRowNum,
            endIndex: lastChildRowNum,
          },
          depth: 1,
          collapsed: true,
        },
        fields: "collapsed",
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId: gridSheetId,
          dimension: "ROWS",
          startIndex: parentRowNum,
          endIndex: lastChildRowNum,
        },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser",
      },
    },
  ];
}

async function ensureSheetRowCount(rawSheets, clientSheetId, gridSheetId, curRowCount, neededMinRowCount) {
  if (curRowCount >= neededMinRowCount) return curRowCount;
  const addCount = neededMinRowCount - curRowCount + 10;
  await rawSheets.spreadsheets.batchUpdate({
    spreadsheetId: clientSheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: gridSheetId,
              dimension: "ROWS",
              startIndex: curRowCount,
              endIndex: curRowCount + addCount,
            },
            inheritFromBefore: true,
          },
        },
      ],
    },
  });
  return curRowCount + addCount;
}

async function moveGapOrphansToBottomAndClear({
  rawSheets,
  clientSheetId,
  clientName,
  label,
  client,
  projectCode = "",
  jobSubstr = "",
  keepBlankSeparator = true,
  isJobCosting,
  apply,
}) {
  const { gridSheetId, rowCount, rowGroups, rows } = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
  const parentRowNum = findJobParentRow(rows, { client, projectCode, jobSubstr });
  assert(parentRowNum, `${clientName}: parent row not found for ${label}`);
  const info = inspectJobBlock(rows, parentRowNum);

  const gapRows = [];
  for (let rNum = info.gapStartRowNum; rNum <= info.gapEndRowNum; rNum++) {
    const r = rows[rNum - 1] || [];
    assert(!norm(r[1]), `${clientName} ${label} R${rNum} has non-empty Col B ("${norm(r[1])}")`);
    assert(!retRowHasRealData(r), `${clientName} ${label} R${rNum} has real invoice/expense data!`);
    gapRows.push({ rowNum: rNum, row: r, hasAnyData: rowHasAnyNonEmptyCell(r) });
  }

  const moveRowNums = [];
  const clearInPlaceRowNums = [];
  if (gapRows.length > 0) {
    if (keepBlankSeparator && info.nextRealJobRowNum) {
      for (let i = 0; i < gapRows.length - 1; i++) {
        moveRowNums.push(gapRows[i].rowNum);
      }
      const sep = gapRows[gapRows.length - 1];
      if (sep.hasAnyData) clearInPlaceRowNums.push(sep.rowNum);
    } else {
      for (const g of gapRows) moveRowNums.push(g.rowNum);
    }
  }

  const overlapStart = parentRowNum - 1;
  const overlapEnd = Math.max(info.gapEndRowNum, info.lastValidChildRowNum);
  const delGroupReqs = buildDeleteOverlappingGroupRequests(rowGroups, gridSheetId, overlapStart, overlapEnd);

  console.log(`  [Orphan Plan] ${label}`);
  console.log(`    Parent: ${summarizeRow(parentRowNum, rows[parentRowNum - 1])}`);
  console.log(`    Last valid child: ${summarizeRow(info.lastValidChildRowNum, rows[info.lastValidChildRowNum - 1])}`);
  console.log(`    Next real job: ${info.nextRealJobRowNum ? summarizeRow(info.nextRealJobRowNum, rows[info.nextRealJobRowNum - 1]) : "none"}`);
  for (const g of gapRows) {
    const tag = moveRowNums.includes(g.rowNum)
      ? "MOVE+CLEAR"
      : clearInPlaceRowNums.includes(g.rowNum)
      ? "CLEAR_IN_PLACE_SEPARATOR"
      : "KEEP_BLANK_SEPARATOR";
    console.log(`    Gap [${tag}] ${summarizeRow(g.rowNum, g.row)}`);
  }

  if (!apply) return;

  if (delGroupReqs.length > 0) {
    await rawSheets.spreadsheets.batchUpdate({
      spreadsheetId: clientSheetId,
      requestBody: { requests: delGroupReqs },
    });
  }

  if (clearInPlaceRowNums.length > 0) {
    const sepPlan = buildJobRowClearAndRestorePlan({
      sheetName: "Confirmed",
      rowNums: clearInPlaceRowNums,
      isJobCosting,
      includeCopiedCol: false,
    });
    if (sepPlan.clearRanges.length > 0) {
      await rawSheets.spreadsheets.values.batchClear({
        spreadsheetId: clientSheetId,
        requestBody: { ranges: sepPlan.clearRanges },
      });
    }
    if (sepPlan.restoreData.length > 0) {
      await rawSheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: sepPlan.restoreData },
      });
    }
  }

  if (moveRowNums.length > 0) {
    const moveStart = moveRowNums[0];
    const moveEnd = moveRowNums[moveRowNums.length - 1];
    const moveCount = moveRowNums.length;
    assert.equal(moveEnd - moveStart + 1, moveCount, `${label}: expected contiguous move block`);

    const trueLastRow = await retFindTrueLastRow(rawSheets, clientSheetId, rows);
    await ensureSheetRowCount(rawSheets, clientSheetId, gridSheetId, rowCount, trueLastRow + moveCount + 5);

    await rawSheets.spreadsheets.batchUpdate({
      spreadsheetId: clientSheetId,
      requestBody: {
        requests: [
          {
            updateDimensionProperties: {
              range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: moveStart - 1, endIndex: moveEnd },
              properties: { hiddenByUser: false },
              fields: "hiddenByUser",
            },
          },
          {
            moveDimension: {
              source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: moveStart - 1, endIndex: moveEnd },
              destinationIndex: trueLastRow + moveCount,
            },
          },
        ],
      },
    });

    const clearRowNums = Array.from({ length: moveCount }, (_, idx) => trueLastRow + 1 + idx);
    const moveClearPlan = buildJobRowClearAndRestorePlan({
      sheetName: "Confirmed",
      rowNums: clearRowNums,
      isJobCosting,
      includeCopiedCol: false,
    });
    if (moveClearPlan.clearRanges.length > 0) {
      await rawSheets.spreadsheets.values.batchClear({
        spreadsheetId: clientSheetId,
        requestBody: { ranges: moveClearPlan.clearRanges },
      });
    }
    if (moveClearPlan.restoreData.length > 0) {
      await rawSheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: moveClearPlan.restoreData },
      });
    }
    console.log(
      `  [${clientName}] Moved R${moveStart}..R${moveEnd} (${moveCount} row(s)) to R${trueLastRow + 1}..R${trueLastRow + moveCount} & cleared`
    );
  }

  const groupReqs = buildCollapsedGroupRequests(gridSheetId, parentRowNum, info.lastValidChildRowNum);
  if (groupReqs.length > 0) {
    await rawSheets.spreadsheets.batchUpdate({
      spreadsheetId: clientSheetId,
      requestBody: { requests: groupReqs },
    });
  }
}

async function planAndApplyEleven(rawSheets, clientSheetId, apply) {
  const initial = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
  const isJobCosting = await detectJobCosting(rawSheets, clientSheetId, initial.rows[0]);

  // --- Step A: Restore displaced GLOWWA BEAUTY LTD Jan/Feb/Mar 27 rows back into 869F6DPA0 block ---
  {
    const { gridSheetId, rowGroups, rows } = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
    const glowwaParent = findJobParentRow(rows, { client: "GLOWWA BEAUTY LTD", projectCode: "869F6DPA0" });
    assert(glowwaParent, "Eleven: GLOWWA BEAUTY LTD (869F6DPA0) parent not found");
    const glowwaInfo = inspectJobBlock(rows, glowwaParent);
    const twoFlintsRow = findJobParentRow(rows, { client: "Two Flints Brewery", projectCode: "1AMNPWPAUB3" });
    assert(twoFlintsRow, "Eleven: Two Flints Brewery (1AMNPWPAUB3) not found");

    // Check displaced rows below Two Flints Brewery with AR in [46388, 46419, 46447]
    const displacedGlowwaRows = [];
    for (let rNum = twoFlintsRow + 1; rNum <= rows.length; rNum++) {
      const r = rows[rNum - 1] || [];
      if (
        normLower(r[0]) === "glowwa beauty ltd" &&
        normLower(r[1]) === "development, ecommerce, web deisgn" &&
        [46388, 46419, 46447].includes(Number(r[COL_SEND_DATE]))
      ) {
        displacedGlowwaRows.push({ rowNum: rNum, sendSerial: Number(r[COL_SEND_DATE]), row: r });
      }
    }

    // Find Dec 26 child row (AR === 46357) inside GLOWWA block
    let dec26RowNum = null;
    for (let rNum = glowwaParent + 1; rNum <= glowwaInfo.lastValidChildRowNum; rNum++) {
      if (Number(rows[rNum - 1]?.[COL_SEND_DATE]) === 46357) {
        dec26RowNum = rNum;
        break;
      }
    }

    if (displacedGlowwaRows.length > 0) {
      assert.equal(displacedGlowwaRows.length, 3, `Expected 3 displaced GLOWWA rows, found ${displacedGlowwaRows.length}`);
      assert(dec26RowNum, "Eleven: GLOWWA Dec 26 (46357) row not found");
      const srcStart = displacedGlowwaRows[0].rowNum;
      const srcEnd = displacedGlowwaRows[displacedGlowwaRows.length - 1].rowNum;
      assert.equal(srcEnd - srcStart + 1, 3, "Expected displaced GLOWWA rows to be contiguous");

      console.log(
        `  [Step A — GLOWWA Restore] Move R${srcStart}..R${srcEnd} (Jan/Feb/Mar 27) UP to right after R${dec26RowNum} (1 Dec 26), set AI="Yes", rebuild group`
      );
      if (apply) {
        const delReqs = buildDeleteOverlappingGroupRequests(
          rowGroups,
          gridSheetId,
          glowwaParent - 1,
          glowwaInfo.lastValidChildRowNum
        );
        if (delReqs.length > 0) {
          await rawSheets.spreadsheets.batchUpdate({
            spreadsheetId: clientSheetId,
            requestBody: { requests: delReqs },
          });
        }
        await rawSheets.spreadsheets.batchUpdate({
          spreadsheetId: clientSheetId,
          requestBody: {
            requests: [
              {
                updateDimensionProperties: {
                  range: { sheetId: gridSheetId, dimension: "ROWS", startIndex: srcStart - 1, endIndex: srcEnd },
                  properties: { hiddenByUser: false },
                  fields: "hiddenByUser",
                },
              },
              {
                moveDimension: {
                  source: { sheetId: gridSheetId, dimension: "ROWS", startIndex: srcStart - 1, endIndex: srcEnd },
                  destinationIndex: dec26RowNum,
                },
              },
            ],
          },
        });
        const after = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
        const freshGlowwa = inspectJobBlock(after.rows, findJobParentRow(after.rows, { client: "GLOWWA BEAUTY LTD", projectCode: "869F6DPA0" }));
        const vatUpdates = [];
        for (let rNum = freshGlowwa.parentRowNum + 1; rNum <= freshGlowwa.lastValidChildRowNum; rNum++) {
          if (!norm(after.rows[rNum - 1]?.[COL_VAT])) {
            vatUpdates.push({ range: `Confirmed!AI${rNum}`, values: [["Yes"]] });
          }
        }
        if (vatUpdates.length > 0) {
          await rawSheets.spreadsheets.values.batchUpdate({
            spreadsheetId: clientSheetId,
            requestBody: { valueInputOption: "USER_ENTERED", data: vatUpdates },
          });
        }
        const rebuildReqs = [
          ...buildDeleteOverlappingGroupRequests(after.rowGroups, after.gridSheetId, freshGlowwa.parentRowNum - 1, freshGlowwa.lastValidChildRowNum),
          ...buildCollapsedGroupRequests(after.gridSheetId, freshGlowwa.parentRowNum, freshGlowwa.lastValidChildRowNum),
        ];
        await rawSheets.spreadsheets.batchUpdate({
          spreadsheetId: clientSheetId,
          requestBody: { requests: rebuildReqs },
        });
        console.log(`  [Eleven] Restored GLOWWA BEAUTY LTD contiguous block R${freshGlowwa.parentRowNum}..R${freshGlowwa.lastValidChildRowNum}`);
      }
    } else {
      console.log(`  [Step A — GLOWWA Restore] Already contiguous at R${glowwaParent}..R${glowwaInfo.lastValidChildRowNum}`);
    }
  }

  // --- Step B: Clean orphans after 869ef04vd & restore displaced The Dog-G8 + PHIZZ back after 869ef04vd ---
  {
    const cur = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
    const pressParent = findJobParentRow(cur.rows, { client: "Naturally Better Nutrition Ltd", projectCode: "869ef04vd" });
    assert(pressParent, "Eleven: Naturally Better (869ef04vd) parent not found");
    const pressInfo = inspectJobBlock(cur.rows, pressParent);
    const dogG8Parent = findJobParentRow(cur.rows, { client: "The Dog-G8 Company Ltd", projectCode: "869b423fb" });
    const phizzParent = findJobParentRow(cur.rows, { client: "PHIZZ LTD", projectCode: "869b6qe4p" });
    const twoFlintsRow = findJobParentRow(cur.rows, { client: "Two Flints Brewery", projectCode: "1AMNPWPAUB3" });
    assert(dogG8Parent && phizzParent && twoFlintsRow, "Eleven: missing The Dog-G8, PHIZZ, or Two Flints");

    const dogG8Displaced = dogG8Parent > twoFlintsRow;
    if (dogG8Displaced) {
      // First clean any gap orphans between #1571 and next real job (Marmoris Srl) without leaving double blanks
      const marmorisParent = findJobParentRow(cur.rows, { client: "Marmoris Srl", projectCode: "869c01acd" });
      assert(marmorisParent, "Eleven: Marmoris Srl (869c01acd) not found");
      if (pressInfo.gapEndRowNum >= pressInfo.gapStartRowNum) {
        await moveGapOrphansToBottomAndClear({
          rawSheets,
          clientSheetId,
          clientName: "Eleven",
          label: "869ef04vd pre-restore gap",
          client: "Naturally Better Nutrition Ltd",
          projectCode: "869ef04vd",
          keepBlankSeparator: false,
          isJobCosting,
          apply,
        });
      }

      const fresh = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
      const fPress = inspectJobBlock(fresh.rows, findJobParentRow(fresh.rows, { client: "Naturally Better Nutrition Ltd", projectCode: "869ef04vd" }));
      const fDog = inspectJobBlock(fresh.rows, findJobParentRow(fresh.rows, { client: "The Dog-G8 Company Ltd", projectCode: "869b423fb" }));
      const fPhizz = inspectJobBlock(fresh.rows, findJobParentRow(fresh.rows, { client: "PHIZZ LTD", projectCode: "869b6qe4p" }));
      const fMarmorisRow = findJobParentRow(fresh.rows, { client: "Marmoris Srl", projectCode: "869c01acd" });

      assert.equal(fDog.lastValidChildRowNum - fDog.parentRowNum + 1, 4, "Expected 4 The Dog-G8 rows");
      assert.equal(fPhizz.lastValidChildRowNum - fPhizz.parentRowNum + 1, 2, "Expected 2 PHIZZ rows");
      assert.equal(fPhizz.parentRowNum, fDog.lastValidChildRowNum + 2, "Expected 1 blank row between The Dog-G8 and PHIZZ");
      assert(!rowHasAnyNonEmptyCell(fresh.rows[fDog.parentRowNum - 2]), `Expected blank row before The Dog-G8 at R${fDog.parentRowNum - 1}`);

      const needsTrailingBlank = apply ? fMarmorisRow === fPress.lastValidChildRowNum + 1 : true;
      const moveStart = fDog.parentRowNum - 1; // leading blank row
      const moveEnd = needsTrailingBlank ? fPhizz.lastValidChildRowNum + 1 : fPhizz.lastValidChildRowNum;
      if (needsTrailingBlank) {
        if (apply) {
          await ensureSheetRowCount(rawSheets, clientSheetId, fresh.gridSheetId, fresh.rowCount, moveEnd + 5);
        }
        assert(
          !rowHasAnyNonEmptyCell(fresh.rows[moveEnd - 1]),
          `Expected blank trailing row at R${moveEnd} to move with The Dog-G8 + PHIZZ`
        );
      }

      console.log(
        `  [Step B — Restore Dog-G8 & PHIZZ] Move R${moveStart}..R${moveEnd} (${moveEnd - moveStart + 1} row(s)) UP to right after R${fPress.lastValidChildRowNum} (before Marmoris R${fMarmorisRow})`
      );
      if (apply) {
        const delReqs = [
          ...buildDeleteOverlappingGroupRequests(fresh.rowGroups, fresh.gridSheetId, fPress.parentRowNum - 1, fPress.lastValidChildRowNum),
          ...buildDeleteOverlappingGroupRequests(fresh.rowGroups, fresh.gridSheetId, moveStart - 1, moveEnd),
        ];
        if (delReqs.length > 0) {
          await rawSheets.spreadsheets.batchUpdate({
            spreadsheetId: clientSheetId,
            requestBody: { requests: delReqs },
          });
        }
        await rawSheets.spreadsheets.batchUpdate({
          spreadsheetId: clientSheetId,
          requestBody: {
            requests: [
              {
                updateDimensionProperties: {
                  range: { sheetId: fresh.gridSheetId, dimension: "ROWS", startIndex: moveStart - 1, endIndex: moveEnd },
                  properties: { hiddenByUser: false },
                  fields: "hiddenByUser",
                },
              },
              {
                moveDimension: {
                  source: { sheetId: fresh.gridSheetId, dimension: "ROWS", startIndex: moveStart - 1, endIndex: moveEnd },
                  destinationIndex: fPress.lastValidChildRowNum,
                },
              },
            ],
          },
        });

        const after = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
        const aPress = inspectJobBlock(after.rows, findJobParentRow(after.rows, { client: "Naturally Better Nutrition Ltd", projectCode: "869ef04vd" }));
        const aDog = inspectJobBlock(after.rows, findJobParentRow(after.rows, { client: "The Dog-G8 Company Ltd", projectCode: "869b423fb" }));
        const aPhizz = inspectJobBlock(after.rows, findJobParentRow(after.rows, { client: "PHIZZ LTD", projectCode: "869b6qe4p" }));
        const aMarm = findJobParentRow(after.rows, { client: "Marmoris Srl", projectCode: "869c01acd" });

        assert.equal(aDog.parentRowNum, aPress.lastValidChildRowNum + 2, "Expected 1 blank after 869ef04vd");
        assert.equal(aPhizz.parentRowNum, aDog.lastValidChildRowNum + 2, "Expected 1 blank after The Dog-G8");
        assert.equal(aMarm, aPhizz.lastValidChildRowNum + 2, "Expected 1 blank after PHIZZ before Marmoris Srl");

        const groupReqs = [
          ...buildDeleteOverlappingGroupRequests(after.rowGroups, after.gridSheetId, aPress.parentRowNum - 1, aMarm),
          ...buildCollapsedGroupRequests(after.gridSheetId, aPress.parentRowNum, aPress.lastValidChildRowNum),
          ...buildCollapsedGroupRequests(after.gridSheetId, aDog.parentRowNum, aDog.lastValidChildRowNum),
          ...buildCollapsedGroupRequests(after.gridSheetId, aPhizz.parentRowNum, aPhizz.lastValidChildRowNum),
        ];
        if (groupReqs.length > 0) {
          await rawSheets.spreadsheets.batchUpdate({
            spreadsheetId: clientSheetId,
            requestBody: { requests: groupReqs },
          });
        }
        console.log(
          `  [Eleven] Restored R${aPress.parentRowNum}..R${aPress.lastValidChildRowNum} (869ef04vd) -> R${aDog.parentRowNum}..R${aDog.lastValidChildRowNum} (The Dog-G8) -> R${aPhizz.parentRowNum}..R${aPhizz.lastValidChildRowNum} (PHIZZ) -> R${aMarm} (Marmoris)`
        );
      }
    } else {
      await moveGapOrphansToBottomAndClear({
        rawSheets,
        clientSheetId,
        clientName: "Eleven",
        label: "Naturally Better Nutrition Ltd — 869ef04vd",
        client: "Naturally Better Nutrition Ltd",
        projectCode: "869ef04vd",
        keepBlankSeparator: true,
        isJobCosting,
        apply,
      });
    }
  }

  // --- Step C: Clean Lousin (869E82R3A) orphans + stray blank-B rows below Two Flints Brewery ---
  {
    await moveGapOrphansToBottomAndClear({
      rawSheets,
      clientSheetId,
      clientName: "Eleven",
      label: "Lousin Apparel Limited — 869E82R3A",
      client: "Lousin Apparel Limited",
      projectCode: "869E82R3A",
      keepBlankSeparator: true,
      isJobCosting,
      apply,
    });

    const afterLousin = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
    const twoFlintsRow = findJobParentRow(afterLousin.rows, { client: "Two Flints Brewery", projectCode: "1AMNPWPAUB3" });
    assert(twoFlintsRow, "Eleven: Two Flints Brewery not found after Lousin cleanup");

    const strayBottomRows = [];
    for (let rNum = twoFlintsRow + 1; rNum <= Math.min(afterLousin.rows.length, 550); rNum++) {
      const r = afterLousin.rows[rNum - 1] || [];
      if (!rowHasAnyNonEmptyCell(r)) continue;
      if (norm(r[1])) continue; // keep real jobs if any exist below
      assert(!retRowHasRealData(r), `Eleven bottom row R${rNum} unexpectedly has real data: ${summarizeRow(rNum, r)}`);
      strayBottomRows.push({ rowNum: rNum, row: r });
    }
    if (strayBottomRows.length > 0) {
      console.log(`  [Step C — Bottom Pool Orphans] Clearing ${strayBottomRows.length} stray blank-B row(s):`);
      for (const s of strayBottomRows) console.log(`    CLEAR ${summarizeRow(s.rowNum, s.row)}`);
      if (apply) {
        const clearPlan = buildJobRowClearAndRestorePlan({
          sheetName: "Confirmed",
          rowNums: strayBottomRows.map((s) => s.rowNum),
          isJobCosting,
          includeCopiedCol: false,
        });
        if (clearPlan.clearRanges.length > 0) {
          await rawSheets.spreadsheets.values.batchClear({
            spreadsheetId: clientSheetId,
            requestBody: { ranges: clearPlan.clearRanges },
          });
        }
        if (clearPlan.restoreData.length > 0) {
          await rawSheets.spreadsheets.values.batchUpdate({
            spreadsheetId: clientSheetId,
            requestBody: { valueInputOption: "USER_ENTERED", data: clearPlan.restoreData },
          });
        }
      }
    }
  }

  // --- Step D: Restore missing Col AI = "Yes" across all affected retainers/blocks ---
  {
    const fresh = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
    const vatTargets = [
      { label: "TRIP DRINK LTD — Retainer (Nov 26-)", client: "TRIP DRINK LTD", jobSubstr: "Retainer (Nov 26-)", includeParent: false },
      { label: "FRAHM Technical Limited — 869CRCAKP", client: "FRAHM Technical Limited", projectCode: "869CRCAKP", includeParent: false },
      { label: "Naturally Better Nutrition Ltd — 869fgq4kr", client: "Naturally Better Nutrition Ltd", projectCode: "869fgq4kr", includeParent: false },
      { label: "The Dog-G8 Company Ltd — 869b423fb", client: "The Dog-G8 Company Ltd", projectCode: "869b423fb", includeParent: false },
      { label: "GLOWWA BEAUTY LTD — 869F6DPA0", client: "GLOWWA BEAUTY LTD", projectCode: "869F6DPA0", includeParent: false },
      { label: "PHIZZ LTD — 869b6qe4p", client: "PHIZZ LTD", projectCode: "869b6qe4p", includeParent: true },
    ];
    const vatBatch = [];
    for (const vt of vatTargets) {
      const pRow = findJobParentRow(fresh.rows, vt);
      if (!pRow) throw new Error(`Eleven: missing VAT target ${vt.label}`);
      const info = inspectJobBlock(fresh.rows, pRow);
      const startRow = vt.includeParent ? pRow : pRow + 1;
      const missingRows = [];
      for (let rNum = startRow; rNum <= info.lastValidChildRowNum; rNum++) {
        if (!norm(fresh.rows[rNum - 1]?.[COL_VAT])) {
          missingRows.push(rNum);
          vatBatch.push({ range: `Confirmed!AI${rNum}`, values: [["Yes"]] });
        }
      }
      console.log(`  [Step D — VAT Plan] ${vt.label} (R${pRow}..R${info.lastValidChildRowNum}): fill AI="Yes" on ${JSON.stringify(missingRows)}`);
    }

    // Diagnostic check for any other retainer parents missing VAT on child rows
    const otherVatGaps = [];
    const coveredParents = new Set(vatTargets.map((vt) => findJobParentRow(fresh.rows, vt)));
    for (let i = 1; i < fresh.rows.length - 1; i++) {
      const r = fresh.rows[i] || [];
      if (normLower(r[COL_VAT]) !== "yes" || !norm(r[0]) || !norm(r[1])) continue;
      if (normLower(fresh.rows[i - 1]?.[0]) === normLower(r[0]) && normLower(fresh.rows[i - 1]?.[1]) === normLower(r[1])) continue;
      if (coveredParents.has(i + 1)) continue;
      const b = inspectJobBlock(fresh.rows, i + 1);
      const miss = [];
      for (let c = b.parentRowNum + 1; c <= b.lastValidChildRowNum; c++) {
        if (!norm(fresh.rows[c - 1]?.[COL_VAT])) miss.push(c);
      }
      if (miss.length > 0) otherVatGaps.push({ parentRowNum: i + 1, client: r[0], job: r[1], missing: miss });
    }
    if (otherVatGaps.length > 0) {
      console.log(`  [Diagnostic] Other child rows missing AI where parent AI="Yes":`, JSON.stringify(otherVatGaps));
    }

    if (apply && vatBatch.length > 0) {
      await rawSheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: vatBatch },
      });
      console.log(`  [Eleven] Restored Col AI="Yes" on ${vatBatch.length} row(s).`);
    }
  }
}

async function planAndApplyThrive(rawSheets, clientSheetId, apply) {
  const initial = await fetchConfirmedMetaAndRows(rawSheets, clientSheetId);
  const isJobCosting = await detectJobCosting(rawSheets, clientSheetId, initial.rows[0]);

  // Bottom-to-top: Full RMO (R156+) first, then Ad hoc support (R34+)
  await moveGapOrphansToBottomAndClear({
    rawSheets,
    clientSheetId,
    clientName: "Thrive Recruitment Marketing",
    label: "Goodman Masson Ltd — Full RMO (from July 2026)",
    client: "Goodman Masson Ltd",
    jobSubstr: "Full RMO (from July 2026)",
    keepBlankSeparator: true,
    isJobCosting,
    apply,
  });

  await moveGapOrphansToBottomAndClear({
    rawSheets,
    clientSheetId,
    clientName: "Thrive Recruitment Marketing",
    label: "Goodman Masson Ltd — Ad hoc support",
    client: "Goodman Masson Ltd",
    jobSubstr: "Ad hoc support",
    keepBlankSeparator: true,
    isJobCosting,
    apply,
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const a of args) {
    if (a !== "--dry-run" && a !== "--apply") {
      console.error(`Unknown argument: ${a}. Usage: node --env-file=.env.local scripts/recover-retainer-orphans.mjs [--dry-run|--apply]`);
      process.exit(1);
    }
  }
  const apply = args.has("--apply");
  console.log(`\n=== Race-Free Retainer & Sheet Recovery (${apply ? "APPLY MODE" : "DRY-RUN MODE"}) ===\n`);

  const [{ rawSheets: unretriedRawSheets }, sheets] = await Promise.all([
    Promise.resolve(getPrimaryRawGoogleClients()),
    getSheetsClient(),
  ]);
  const supabase = getSupabaseAdmin();
  assert(unretriedRawSheets && sheets, "Primary rawSheets or pooled sheets client unavailable");
  const rawSheets = wrapRawSheetsWithRetry(unretriedRawSheets);

  for (const clientName of ["Eleven", "Thrive Recruitment Marketing"]) {
    const ctx = await resolveSupabaseSheetContext({ clientName });
    assert(ctx?.clientSheetId, `Could not resolve clientSheetId for ${clientName}`);
    const clientKey = normalizeBridgeKey(clientName);

    console.log(`--- ${clientName} (clientSheetId: ${ctx.clientSheetId}, key: ${clientKey}) ---`);

    const { data: activeAlerts, error: alertQueryErr } = await supabase
      .from("alert_memory")
      .select("id, alert_summary, status, created_at")
      .eq("client_name", clientName)
      .eq("alert_type", "retainerInvoicesCreated")
      .eq("status", "cached");
    if (alertQueryErr) throw alertQueryErr;
    console.log(`  [Alerts] Active cached retainerInvoicesCreated rows (${(activeAlerts || []).length}):`, JSON.stringify(activeAlerts || []));

    if (!apply) {
      if (clientName === "Eleven") await planAndApplyEleven(rawSheets, ctx.clientSheetId, false);
      else await planAndApplyThrive(rawSheets, ctx.clientSheetId, false);
      console.log("");
      continue;
    }

    const lock = await acquireClientBridgeLock(clientKey);
    try {
      await clearBridgeQueuesForClient(clientKey);

      if (clientName === "Eleven") await planAndApplyEleven(rawSheets, ctx.clientSheetId, true);
      else await planAndApplyThrive(rawSheets, ctx.clientSheetId, true);

      // Flush any in-memory virtual client recomputes then reseed atomically from the live Google Sheet
      await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, clientName).catch(() => {});
      const seedRes = await seedClientSheetToSupabase(sheets, clientName);
      console.log(`  [${clientName}] Reseeded Supabase + baseline + relational jobs:`, JSON.stringify(seedRes));

      await clearBridgeQueuesForClient(clientKey);

      const { data: resolvedAlerts, error: alertErr } = await supabase
        .from("alert_memory")
        .update({ status: "auto_resolved", updated_at: new Date().toISOString() })
        .eq("client_name", clientName)
        .eq("alert_type", "retainerInvoicesCreated")
        .eq("status", "cached")
        .select("id, alert_summary");
      if (alertErr) throw new Error(`${clientName}: alert_memory update failed: ${alertErr.message}`);
      console.log(`  [${clientName}] Auto-resolved ${(resolvedAlerts || []).length} stale retainerInvoicesCreated alert(s).`);

      await invalidatePmaClientCache(ctx.clientSheetId, ctx.masterSheetId, ["jobs", "alerts", "triage", "dashboard"]);
      const [writeParity, readParity] = await Promise.all([
        verifyRelationalJobsParity({ clientName }),
        verifyRelationalJobsReadParity({ clientName }),
      ]);
      console.log(`  [${clientName}] Parity checks:`, JSON.stringify({ writeParity, readParity }));
    } finally {
      await releaseClientBridgeLock(lock);
    }
    console.log("");
  }

  console.log(apply ? "=== RECOVERY APPLIED ===" : "=== DRY-RUN COMPLETE (no changes written; pass --apply to execute) ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Recovery failed:", err);
  process.exit(1);
});
