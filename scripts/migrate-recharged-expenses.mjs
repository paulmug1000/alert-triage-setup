/**
 * Multi-tenant rollout migration script for Recharged Expenses schema, formulas,
 * KeyInfo!C21:D21 setting, Confirmed columns, Outgoings rows 225:226, and ConfCalcs.
 *
 * Usage (from pulse-management-system/):
 *   node --env-file=.env.local scripts/migrate-recharged-expenses.mjs --dry-run --client="APPTEST"
 *   node --env-file=.env.local scripts/migrate-recharged-expenses.mjs --apply --client="APPTEST"
 *   node --env-file=.env.local scripts/migrate-recharged-expenses.mjs --dry-run --all
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { getSheetsClient } from "../services/sheetsClient.js";
import { getAllClients } from "../services/workspaces.js";
import {
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
} from "../services/masterEngineService.js";

const KEYINFO_C21_NOTE =
  "Recharged expenses delivery % (100% = recharged expenses captured as CoS, 0% = captured within overhead categories)";
const RECHARGED_D6_ENTRIES = [
  "Confirmed | R2:R5002 | 2",
  "Confirmed | AU2:AU5002 | 2",
  "Confirmed | BB2:BB5002 | 2",
  "Confirmed | BI2:BI5002 | 2",
];

const HEADER_BG = { red: 0.45490196, green: 0.105882354, blue: 0.2784314 }; // #741b47
const WHITE = { red: 1, green: 1, blue: 1 };
const BLACK = { red: 0, green: 0, blue: 0 };
const GREY_BG = { red: 239 / 255, green: 239 / 255, blue: 239 / 255 }; // #efefef

const MONTH_BLOCKS = [
  { start: 6, end: 17, totalCol: 19, sumRange: "G{r}:S{r}" },   // G..R, T total
  { start: 21, end: 32, totalCol: 34, sumRange: "V{r}:AH{r}" }, // V..AG, AI total
  { start: 36, end: 47, totalCol: 49, sumRange: "AK{r}:AW{r}" }, // AK..AV, AX total
];

const FORMULA_ERR_RE = /^#(REF|VALUE|NAME|N\/A|ERROR|NUM|DIV\/0)!?/i;

function printUsage() {
  console.log(
    "Usage:\n" +
      "  node --env-file=.env.local scripts/migrate-recharged-expenses.mjs --dry-run --client=\"APPTEST\"\n" +
      "  node --env-file=.env.local scripts/migrate-recharged-expenses.mjs --apply --client=\"APPTEST\"\n" +
      "  node --env-file=.env.local scripts/migrate-recharged-expenses.mjs --dry-run --all\n" +
      "\nFlags:\n" +
      "  --dry-run         Inspect and report changes without writing (default)\n" +
      "  --apply           Execute writes against Google Sheets and Supabase virtual grids\n" +
      "  --client=<name>   Target a single client by name (case-insensitive)\n" +
      "  --all             Target all clients\n"
  );
}

function parseCliArgs(argv) {
  let apply = false;
  let all = false;
  let client = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--all") all = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg.startsWith("--client=")) client = arg.slice("--client=".length).trim();
    else if (arg === "--client" && argv[i + 1]) client = String(argv[++i]).trim();
  }
  return { help: false, apply, all, client };
}

function colIdxToA1(idx0) {
  let n = idx0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isZeroPct(val) {
  if (val === 0) return true;
  const s = String(val ?? "").trim();
  return s === "0" || s === "0%" || s === "0.0%";
}

function mergeKeyInfoD6(existing) {
  const raw = String(existing || "").trim();
  const parts = raw ? raw.split(",").map((p) => p.trim()).filter(Boolean) : [];
  const existingSet = new Set(parts.map((p) => p.toLowerCase()));
  let changed = false;
  for (const entry of RECHARGED_D6_ENTRIES) {
    if (!existingSet.has(entry.toLowerCase())) {
      const cashIdx = parts.findIndex((p) => p.toLowerCase().startsWith("cash |"));
      if (cashIdx >= 0) {
        parts.splice(cashIdx + 1, 0, entry);
      } else {
        parts.push(entry);
      }
      existingSet.add(entry.toLowerCase());
      changed = true;
    }
  }
  return { merged: parts.join(", "), changed };
}

function buildOutgoingsRow225Formula(colLetter) {
  return `=IF(AND(Performance!${colLetter}$2="Forecast", ${colLetter}$300=""), -${colLetter}226, 0)`;
}

function buildOutgoingsRow226Formula(colLetter, maxR = 5002) {
  return `=-LET(
  m_start, ${colLetter}$1,
  m_end, EOMONTH(${colLetter}$1, 0),
  m_tag, LOWER(TEXT(m_start, "mmm-yy")),
  eff_dt_1, ARRAYFORMULA(IF(ISNUMBER(Confirmed!$AV$2:$AV$${maxR}), Confirmed!$AV$2:$AV$${maxR}, IF(Confirmed!$AV$2:$AV$${maxR}="", IF(ISNUMBER(Confirmed!$AR$2:$AR$${maxR}), Confirmed!$AR$2:$AR$${maxR}, -1), -1))),
  s1_std, SUMPRODUCT(ARRAYFORMULA(IF(ISNUMBER(Confirmed!$AU$2:$AU$${maxR}), Confirmed!$AU$2:$AU$${maxR}, 0)) * (eff_dt_1 >= m_start) * (eff_dt_1 <= m_end)),
  s1_spl, SUM(ARRAYFORMULA(IFERROR(VALUE(REGEXEXTRACT(LOWER(FILTER(TO_TEXT(Confirmed!$AV$2:$AV$${maxR}), REGEXMATCH(TO_TEXT(Confirmed!$AV$2:$AV$${maxR}), "^\\[Split\\]"))), m_tag & "\\s*:\\s*(-?[0-9\\.]+)")), 0))),
  eff_dt_2, ARRAYFORMULA(IF(ISNUMBER(Confirmed!$BC$2:$BC$${maxR}), Confirmed!$BC$2:$BC$${maxR}, IF(Confirmed!$BC$2:$BC$${maxR}="", IF(ISNUMBER(Confirmed!$AY$2:$AY$${maxR}), Confirmed!$AY$2:$AY$${maxR}, -1), -1))),
  s2_std, SUMPRODUCT(ARRAYFORMULA(IF(ISNUMBER(Confirmed!$BB$2:$BB$${maxR}), Confirmed!$BB$2:$BB$${maxR}, 0)) * (eff_dt_2 >= m_start) * (eff_dt_2 <= m_end)),
  s2_spl, SUM(ARRAYFORMULA(IFERROR(VALUE(REGEXEXTRACT(LOWER(FILTER(TO_TEXT(Confirmed!$BC$2:$BC$${maxR}), REGEXMATCH(TO_TEXT(Confirmed!$BC$2:$BC$${maxR}), "^\\[Split\\]"))), m_tag & "\\s*:\\s*(-?[0-9\\.]+)")), 0))),
  eff_dt_3, ARRAYFORMULA(IF(ISNUMBER(Confirmed!$BJ$2:$BJ$${maxR}), Confirmed!$BJ$2:$BJ$${maxR}, IF(Confirmed!$BJ$2:$BJ$${maxR}="", IF(ISNUMBER(Confirmed!$BF$2:$BF$${maxR}), Confirmed!$BF$2:$BF$${maxR}, -1), -1))),
  s3_std, SUMPRODUCT(ARRAYFORMULA(IF(ISNUMBER(Confirmed!$BI$2:$BI$${maxR}), Confirmed!$BI$2:$BI$${maxR}, 0)) * (eff_dt_3 >= m_start) * (eff_dt_3 <= m_end)),
  s3_spl, SUM(ARRAYFORMULA(IFERROR(VALUE(REGEXEXTRACT(LOWER(FILTER(TO_TEXT(Confirmed!$BJ$2:$BJ$${maxR}), REGEXMATCH(TO_TEXT(Confirmed!$BJ$2:$BJ$${maxR}), "^\\[Split\\]"))), m_tag & "\\s*:\\s*(-?[0-9\\.]+)")), 0))),
  s1_std + s1_spl + s2_std + s2_spl + s3_std + s3_spl
)`;
}

function buildConfirmedBWFormula(r) {
  return `=IF(OR(A${r}="", B${r}=""), "-",
  IF(AND(LEN(AL${r})=0, N(AG${r})=0, N(R${r})=0), "-",
    IF(AJ${r}<>"Project", "NA",
      (N(AG${r}) + N(R${r})) - (N(AP${r}) + N(AW${r}) + N(BD${r})) - (SUMIFS(AP:AP, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(AW:AW, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(BD:BD, A:A, A${r}, B:B, B${r}, AL:AL, ""))
    )
  )
)`;
}

function buildConfCalcsEQFormula(r) {
  const prev = r - 1;
  return `=IF(AJ${r}="", 
  IF((AP${r}-N(AU${r}))>0, 
    IFERROR(
      LET(
        p_match, FILTER(HSTACK(ROW($A$1:A${prev}), $EQ$1:EQ${prev}, $AG$1:AG${prev}), $A$1:A${prev}=A${r}, $B$1:B${prev}=B${r}, $AJ$1:AJ${prev}="Retainer"),
        p_row, CHOOSEROWS(INDEX(p_match, , 1), -1),
        p_start, CHOOSEROWS(INDEX(p_match, , 2), -1),
        p_rev, CHOOSEROWS(INDEX(p_match, , 3), -1),
        prev_ap, SUM(IFERROR(FILTER($AP$1:AP${prev}, $A$1:A${prev}=A${r}, $B$1:B${prev}=B${r}, $AJ$1:AJ${prev}="", ROW($A$1:A${prev})>p_row), 0)) - SUM(IFERROR(FILTER($AU$1:AU${prev}, $A$1:A${prev}=A${r}, $B$1:B${prev}=B${r}, $AJ$1:AJ${prev}="", ROW($A$1:A${prev})>p_row), 0)),
        prev_m, IF(p_rev > 0, ROUND(prev_ap / p_rev), 0),
        IF(p_start > 0, EDATE(p_start, prev_m), "")
      ), 
      ""
    ), 
    ""
  ),
  IF(AL${r}="", "", 
    LET(
      curr_m_start, EOMONTH(AL${r}, -1) + 1,
      next_m_start, EOMONTH(AL${r}, 0) + 1,
      day_val, DAY(AL${r}),
      days_left, next_m_start - AL${r},
      IF(AJ${r}="Project",
        SWITCH(KeyInfo!$F$15,
          "Raw dates", curr_m_start,
          "5-day adjust", IF(day_val > (DAY(next_m_start-1)-5), next_m_start, curr_m_start),
          "10-day adjust", IF(day_val > (DAY(next_m_start-1)-10), next_m_start, curr_m_start),
          "15-day adjust", IF(day_val > (DAY(next_m_start-1)-15), next_m_start, curr_m_start),
          curr_m_start
        ),
        SWITCH(KeyInfo!$F$17,
          "Raw dates", curr_m_start,
          "10-day min", IF(days_left >= 10, curr_m_start, next_m_start),
          "15-day min", IF(days_left >= 15, curr_m_start, next_m_start),
          "20-day min", IF(days_left >= 20, curr_m_start, next_m_start),
          curr_m_start
        )
      )
    )
  )
)
`;
}

function buildConfCalcsESFormula(r) {
  return `=IF(AJ${r}="", 
  IFERROR(
    IF(AND((AP${r}-N(AU${r}))>0, EQ${r}<>""), 
      LET(
        p_rev, IFERROR(CHOOSEROWS(FILTER($AG$1:AG${r - 1}, $A$1:A${r - 1}=A${r}, $B$1:B${r - 1}=B${r}, $AJ$1:AJ${r - 1}="Retainer"), -1), 0),
        IF(p_rev > 0, MAX(1, ROUND((AP${r}-N(AU${r})) / p_rev)), 1)
      ), 
      0
    ),
    0
  ),
  IF(OR(EQ${r}="", ER${r}=""), 0,
    LET(
      s, IF(AJ${r}="Project", EQ${r}, AL${r}),
      e_raw, IF(AJ${r}="Project", ER${r}, AM${r}),
      e, IF(e_raw < s, EDATE(s, 1), e_raw),
      m, DATEDIF(s, e, "m"),
      d, DATEDIF(s, e, "md"),
      calc_val, IF(AJ${r}="Project",
        ROUND(m + (d/30.4167)),
        SWITCH(KeyInfo!$F$18,
          "Raw date rounding", ROUND(m + (d/30.4167)),
          "Any day down bias", m,
          "25-day down bias", m + (d > 25),
          "20-day down bias", m + (d > 20),
          "10-day up bias", m + (d >= 10),
          "5-day up bias", m + (d >= 5),
          "Any day up bias", m + (d > 0),
          m
        )
      ),
      MAX(1, calc_val)
    )
  )
)
`;
}

function buildConfCalcsETFormula(r) {
  return `=IFERROR(
  IF(AJ${r}="", 
    IF(AND((AP${r}-N(AU${r}))>0, EQ${r}<>""), (AP${r}-N(AU${r})) / MAX(1, ES${r}), 0),
    IF(AJ${r}="project", EO${r} / ES${r}, EO${r})
  ),
  0
)
`;
}

async function verifyFormulaHealth(sheetsClient, spreadsheetId, label, extra = {}) {
  const res = await sheetsClient.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [
      "KeyInfo!C21:D21",
      "KeyInfo!D6",
      "Outgoings!A225:N228",
      "Confirmed!R1:BJ2",
      "Confirmed!BW2:BW25",
      "ConfCalcs!EO2:EU15",
      "Dashboard!G4:L18",
      "Performance!G1:L20",
    ],
    ...extra,
  });
  const errors = [];
  for (const vr of res.data.valueRanges || []) {
    (vr.values || []).forEach((row, rIdx) =>
      row.forEach((cell, cIdx) => {
        if (typeof cell === "string" && FORMULA_ERR_RE.test(cell)) {
          errors.push(`${vr.range}[${rIdx},${cIdx}]=${cell}`);
        }
      })
    );
  }
  console.log(`  [${label}] Post-migration formula errors: ${errors.length ? JSON.stringify(errors) : "0"}`);
  return errors;
}

async function inspectClient(rawSheets, client) {
  console.log(`\n=== [DRY-RUN] ${client.clientName} ===`);
  const clientId = client.clientSheetId;
  const masterId = client.masterSheetId;

  const [cMeta, cRead, mRead] = await Promise.all([
    rawSheets.spreadsheets.get({
      spreadsheetId: clientId,
      fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
      _bypassSupabaseVirtualSheet: true,
    }),
    rawSheets.spreadsheets.values.batchGet({
      spreadsheetId: clientId,
      ranges: [
        "KeyInfo!C21:D21",
        "KeyInfo!D6",
        "KeyInfo!D11",
        "Confirmed!R1",
        "Confirmed!AU1:BJ1",
        "Confirmed!BW2",
        "Outgoings!A225:AX226",
        "ConfCalcs!EQ2:ET2",
      ],
      valueRenderOption: "FORMULA",
      _bypassSupabaseVirtualSheet: true,
    }),
    masterId
      ? rawSheets.spreadsheets.values.batchGet({
          spreadsheetId: masterId,
          ranges: ["KeyInfo!C21:D21", "KeyInfo!D6", "KeyInfo!D11"],
          valueRenderOption: "FORMULA",
          _bypassSupabaseVirtualSheet: true,
        })
      : Promise.resolve(null),
  ]);

  const tabTitles = new Set((cMeta.data.sheets || []).map((s) => s.properties.title));
  if (!tabTitles.has("Outgoings") || !tabTitles.has("Confirmed") || !tabTitles.has("ConfCalcs")) {
    console.log("  SKIP CANDIDATE: Missing required tab(s) (Outgoings / Confirmed / ConfCalcs).");
    return { status: "skipped_missing_tabs" };
  }

  const vr = cRead.data.valueRanges || [];
  const outA225Ax226 = vr[6]?.values || [];
  const guard = checkOutgoingsRowsSafe(outA225Ax226[0] || [], outA225Ax226[1] || []);
  const { a225, a226, occupied, details } = guard;

  const cKeyC21D21 = vr[0]?.values?.[0] || [];
  const cKeyD6 = String(vr[1]?.values?.[0]?.[0] ?? "");
  const cKeyD11 = String(vr[2]?.values?.[0]?.[0] ?? "").trim();
  const confR1 = String(vr[3]?.values?.[0]?.[0] ?? "");
  const confAuBj1 = vr[4]?.values?.[0] || [];
  const confBw2 = String(vr[5]?.values?.[0]?.[0] ?? "").replace(/\s+/g, " ").trim();
  const ccEqEt2 = vr[7]?.values?.[0] || [];

  const mVr = mRead?.data?.valueRanges || [];
  const mKeyC21D21 = mVr[0]?.values?.[0] || [];
  const mKeyD6 = String(mVr[1]?.values?.[0]?.[0] ?? "");
  const mKeyD11 = String(mVr[2]?.values?.[0]?.[0] ?? "").trim();

  console.log(`  Client ID: ${clientId} | Master ID: ${masterId || "(none)"}`);
  console.log(
    `  Outgoings!A225:A226 = ${JSON.stringify([a225, a226])}${
      occupied ? ` [OCCUPIED - WILL SKIP: ${details.slice(0, 6).join(", ")}]` : " [SAFE]"
    }`
  );
  console.log(`  Master KeyInfo!C21:D21 = ${JSON.stringify(mKeyC21D21)} | D11 = "${mKeyD11 || cKeyD11}"`);
  console.log(`  Client KeyInfo!C21:D21 = ${JSON.stringify(cKeyC21D21)} | D6 merge needed = ${mergeKeyInfoD6(cKeyD6).changed}`);
  console.log(`  Master KeyInfo!D6 merge needed = ${mRead ? mergeKeyInfoD6(mKeyD6).changed : "n/a"}`);
  console.log(`  Confirmed!R1 = ${JSON.stringify(confR1)} | BW2 = ${JSON.stringify(confBw2.slice(0, 90))}`);
  console.log(`  Confirmed!AU1:BJ1 = ${JSON.stringify(confAuBj1)}`);
  console.log(`  ConfCalcs!EQ2:ET2 populated = ${ccEqEt2.map((c) => Boolean(c)).join(", ")}`);

  return { status: occupied ? "skipped_occupied" : "ready", details };
}

const MONTH_COL_SET = new Set(
  MONTH_BLOCKS.flatMap((b) => Array.from({ length: b.end - b.start + 1 }, (_, i) => b.start + i))
);
const TOTAL_COL_SET = new Set(MONTH_BLOCKS.map((b) => b.totalCol));

export function checkOutgoingsRowsSafe(row225Cells = [], row226Cells = []) {
  const a225 = String(row225Cells[0] ?? "").trim();
  const a226 = String(row226Cells[0] ?? "").trim();
  const alreadyMigrated =
    a225 === "Recharged expenses (forecast)" && a226 === "Recharged expenses recovery";
  const details = [];

  if (!alreadyMigrated) {
    if (a225 !== "") details.push(`225:A=${a225}`);
    if (a226 !== "") details.push(`226:A=${a226}`);
  }

  for (const [rowNum, cells] of [
    [225, row225Cells],
    [226, row226Cells],
  ]) {
    for (let idx = 1; idx <= 49; idx++) {
      const raw = cells[idx];
      const s = String(raw ?? "").trim();
      if (s === "") continue;

      if (alreadyMigrated) {
        if (idx === 1 && ((rowNum === 225 && s === "Yes") || (rowNum === 226 && s === "No"))) continue;
        if ((idx === 2 || idx === 3) && rowNum === 225 && s === "Curr") continue;
        if (idx === 4 && rowNum === 225 && s.toUpperCase() === "=E226") continue;
        if (
          idx === 4 &&
          rowNum === 226 &&
          (/^=IF\(KeyInfo!\$D\$21/i.test(s) || isZeroPct(raw) || raw === 1 || s === "100%" || s === "1")
        ) {
          continue;
        }
        if (MONTH_COL_SET.has(idx)) {
          if (rowNum === 225 && /^=IF\(/i.test(s)) continue;
          if (rowNum === 226 && /^=-LET\(/i.test(s)) continue;
        }
        if (TOTAL_COL_SET.has(idx) && /^=SUM\(/i.test(s)) continue;
      } else {
        if (idx === 4 && isZeroPct(raw)) continue;
        if (TOTAL_COL_SET.has(idx) && /^=SUM\([A-Z]+22[56]:[A-Z]+22[56]\)$/i.test(s)) continue;
      }

      details.push(`${rowNum}:${colIdxToA1(idx)}=${s}`);
    }
  }

  return { occupied: details.length > 0, a225, a226, details };
}

function buildClientRechargedUpdates({
  a2Formula,
  d6Raw,
  preservedD21,
  jobTableStyle,
  existingAg,
  existingBw,
  eqRows,
  bwCheckEnd,
  capRow,
  confCalcsMaxRows,
}) {
  const updates = [
    { range: "Confirmed!R1", values: [["Recharged expenses (excl VAT)"]] },
    { range: "Confirmed!AU1:AV1", values: [["Inv 1 of which rechgd", "Inv 1 cost month"]] },
    { range: "Confirmed!BB1:BC1", values: [["Inv 2 of which rechgd", "Inv 2 cost month"]] },
    { range: "Confirmed!BI1:BJ1", values: [["Inv 3 of which rechgd", "Inv 3 cost month"]] },
  ];

  const d6 = mergeKeyInfoD6(d6Raw);
  if (!String(a2Formula || "").trim().toUpperCase().startsWith("=IMPORTRANGE")) {
    updates.push({ range: "KeyInfo!C21:D21", values: [[KEYINFO_C21_NOTE, preservedD21]] });
    if (d6.changed) updates.push({ range: "KeyInfo!D6", values: [[d6.merged]] });
  }

  // JobCosting Confirmed!AG rewrite only where formula references Col R
  if (jobTableStyle === "jobcosting") {
    let agChanged = false;
    const agUpdated = (existingAg || []).map((row, idx) => {
      const f = String(row?.[0] ?? "");
      if (f.startsWith("=") && /\bR\d+\b/i.test(f)) {
        agChanged = true;
        return [`=if(I${idx + 2}=0,"",I${idx + 2})`];
      }
      return [row?.[0] ?? ""];
    });
    if (agChanged && agUpdated.length > 0) {
      updates.push({
        range: `Confirmed!AG2:AG${1 + agUpdated.length}`,
        values: agUpdated,
      });
    }
  }

  // Confirmed!BW active formula rows (preserve static non-formula overrides)
  let lastActiveBwIdx = Math.min(bwCheckEnd - 2, 5000);
  for (let idx = (existingBw || []).length - 1; idx >= 0; idx--) {
    if (existingBw[idx]?.[0] !== undefined && existingBw[idx]?.[0] !== "") {
      lastActiveBwIdx = idx;
      break;
    }
  }
  const bwRowsOut = [];
  for (let idx = 0; idx <= lastActiveBwIdx; idx++) {
    const r = idx + 2;
    const cur = existingBw?.[idx]?.[0];
    if (cur !== undefined && cur !== "" && !String(cur).startsWith("=")) {
      bwRowsOut.push([cur]);
    } else {
      bwRowsOut.push([buildConfirmedBWFormula(r)]);
    }
  }
  updates.push({
    range: `Confirmed!BW2:BW${1 + bwRowsOut.length}`,
    values: bwRowsOut,
  });

  // Outgoings rows 225:226
  const row225 = new Array(50).fill("");
  const row226 = new Array(50).fill("");
  row225[0] = "Recharged expenses (forecast)";
  row225[1] = "Yes";
  row225[2] = "Curr";
  row225[3] = "Curr";
  row225[4] = "=E226";

  row226[0] = "Recharged expenses recovery";
  row226[1] = "No";
  row226[2] = "";
  row226[3] = "";
  row226[4] = '=IF(KeyInfo!$D$21="", 1, KeyInfo!$D$21)';

  for (const block of MONTH_BLOCKS) {
    for (let c = block.start; c <= block.end; c++) {
      const colLetter = colIdxToA1(c);
      row225[c] = buildOutgoingsRow225Formula(colLetter);
      row226[c] = buildOutgoingsRow226Formula(colLetter, capRow);
    }
    row225[block.totalCol] = `=SUM(${block.sumRange.replace(/\{r\}/g, "225")})`;
    row226[block.totalCol] = `=SUM(${block.sumRange.replace(/\{r\}/g, "226")})`;
  }
  updates.push({ range: "Outgoings!A225:AX226", values: [row225, row226] });

  // ConfCalcs EQ/ES/ET
  let lastFormulaRow = 2;
  for (let i = (eqRows || []).length - 1; i >= 0; i--) {
    if (eqRows[i]?.[0]) {
      lastFormulaRow = i + 2;
      break;
    }
  }
  const confCalcsEndRow =
    lastFormulaRow > 2
      ? Math.min(confCalcsMaxRows || 5010, lastFormulaRow)
      : Math.min(confCalcsMaxRows || 5010, 5002);
  const eqCol = [];
  const esEtCols = [];
  for (let r = 2; r <= confCalcsEndRow; r++) {
    eqCol.push([buildConfCalcsEQFormula(r)]);
    esEtCols.push([buildConfCalcsESFormula(r), buildConfCalcsETFormula(r)]);
  }
  updates.push(
    { range: `ConfCalcs!EQ2:EQ${confCalcsEndRow}`, values: eqCol },
    { range: `ConfCalcs!ES2:ET${confCalcsEndRow}`, values: esEtCols }
  );

  return { updates, confCalcsEndRow };
}

async function applyClientMigration(rawSheets, virtSheets, client) {
  console.log(`\n=== [APPLY] ${client.clientName} ===`);
  const clientId = client.clientSheetId;
  const masterId = client.masterSheetId;
  const ctx = await resolveSupabaseSheetContext({ clientName: client.clientName, masterSheetId: masterId }).catch(() => null);

  const [clientMeta, masterMeta] = await Promise.all([
    rawSheets.spreadsheets.get({
      spreadsheetId: clientId,
      fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
      _bypassSupabaseVirtualSheet: true,
    }),
    masterId
      ? rawSheets.spreadsheets.get({
          spreadsheetId: masterId,
          fields: "sheets(properties(sheetId,title))",
          _bypassSupabaseVirtualSheet: true,
        })
      : Promise.resolve({ data: { sheets: [] } }),
  ]);

  const cTabs = Object.fromEntries((clientMeta.data.sheets || []).map((s) => [s.properties.title, s.properties]));
  const mTabs = Object.fromEntries((masterMeta.data.sheets || []).map((s) => [s.properties.title, s.properties]));

  if (!cTabs.Outgoings || !cTabs.Confirmed || !cTabs.ConfCalcs) {
    console.log("  SKIP: Missing Outgoings, Confirmed, or ConfCalcs tab.");
    return { status: "skipped_missing_tabs", errors: [] };
  }

  const maxConfRow = Math.max(cTabs.Confirmed.gridProperties?.rowCount || 5002, 2);
  const bwCheckEnd = Math.min(maxConfRow, 5007);
  const capRow = Math.min(maxConfRow, 5002);
  const confCalcsMaxRows = cTabs.ConfCalcs.gridProperties?.rowCount || 5010;
  const clientInspectRanges = [
    "Outgoings!A225:AX226",
    "KeyInfo!A2",
    "KeyInfo!D6",
    "KeyInfo!D11",
    "KeyInfo!D21",
    `Confirmed!AG2:AG${maxConfRow}`,
    `Confirmed!BW2:BW${bwCheckEnd}`,
    `ConfCalcs!EQ2:EQ${confCalcsMaxRows}`,
  ];

  // Read existing raw & (when enabled) Supabase virtual state before mutating
  const [cBatchRes, mBatchRes, outValidationMeta, virtCBatchRes, virtMBatchRes] = await Promise.all([
    rawSheets.spreadsheets.values.batchGet({
      spreadsheetId: clientId,
      ranges: clientInspectRanges,
      valueRenderOption: "FORMULA",
      _bypassSupabaseVirtualSheet: true,
    }),
    masterId
      ? rawSheets.spreadsheets.values.batchGet({
          spreadsheetId: masterId,
          ranges: ["KeyInfo!D6", "KeyInfo!D11", "KeyInfo!D21"],
          valueRenderOption: "FORMULA",
          _bypassSupabaseVirtualSheet: true,
        })
      : Promise.resolve(null),
    rawSheets.spreadsheets.get({
      spreadsheetId: clientId,
      ranges: ["Outgoings!B225:E225"],
      includeGridData: true,
      fields: "sheets(data(rowData(values(dataValidation))))",
      _bypassSupabaseVirtualSheet: true,
    }),
    ctx?.clientMode === "supabase"
      ? virtSheets.spreadsheets.values.batchGet({
          spreadsheetId: clientId,
          ranges: clientInspectRanges,
          valueRenderOption: "FORMULA",
        })
      : Promise.resolve(null),
    ctx?.masterMode === "supabase" && masterId
      ? virtSheets.spreadsheets.values.batchGet({
          spreadsheetId: masterId,
          ranges: ["KeyInfo!D6", "KeyInfo!D11", "KeyInfo!D21"],
          valueRenderOption: "FORMULA",
        })
      : Promise.resolve(null),
  ]);

  const cVr = cBatchRes.data.valueRanges || [];
  const rawGuard = checkOutgoingsRowsSafe(cVr[0]?.values?.[0] || [], cVr[0]?.values?.[1] || []);
  if (rawGuard.occupied) {
    console.log(
      `  SKIP: Raw Outgoings row 225/226 occupied (${rawGuard.details.slice(0, 8).join(", ")}).`
    );
    return { status: "skipped_occupied", details: rawGuard.details, errors: [] };
  }

  const vVr = virtCBatchRes?.data?.valueRanges || [];
  if (virtCBatchRes) {
    const virtGuard = checkOutgoingsRowsSafe(vVr[0]?.values?.[0] || [], vVr[0]?.values?.[1] || []);
    if (virtGuard.occupied) {
      console.log(
        `  SKIP: Virtual Outgoings row 225/226 occupied (${virtGuard.details.slice(0, 8).join(", ")}).`
      );
      return { status: "skipped_occupied", details: virtGuard.details, errors: [] };
    }
  }

  const cA2Formula = String(cVr[1]?.values?.[0]?.[0] ?? "");
  const cD11 = String(cVr[3]?.values?.[0]?.[0] ?? "").trim();
  const cD21Raw = cVr[4]?.values?.[0]?.[0];

  const mVr = mBatchRes?.data?.valueRanges || [];
  const mD6 = mergeKeyInfoD6(mVr[0]?.values?.[0]?.[0]);
  const mD11 = String(mVr[1]?.values?.[0]?.[0] ?? "").trim();
  const mD21Raw = mVr[2]?.values?.[0]?.[0];

  const preservedD21 = isZeroPct(mD21Raw !== undefined && mD21Raw !== "" ? mD21Raw : cD21Raw) ? 0 : 1;
  const jobTableStyle = (mD11 || cD11).toLowerCase();

  // 1. Master KeyInfo values
  const masterValueUpdates = [];
  if (masterId) {
    masterValueUpdates.push({ range: "KeyInfo!C21:D21", values: [[KEYINFO_C21_NOTE, preservedD21]] });
    if (mD6.changed) masterValueUpdates.push({ range: "KeyInfo!D6", values: [[mD6.merged]] });
  }

  // 2. Client formatting requests (Confirmed + KeyInfo!D21 + Outgoings 225:226)
  const confSheetId = cTabs.Confirmed.sheetId;
  const outSheetId = cTabs.Outgoings.sheetId;
  const cKeySheetId = cTabs.KeyInfo?.sheetId;
  const mKeySheetId = mTabs.KeyInfo?.sheetId;

  const headerCellStyle = {
    backgroundColor: HEADER_BG,
    backgroundColorStyle: { rgbColor: HEADER_BG },
    verticalAlignment: "TOP",
    wrapStrategy: "WRAP",
    textFormat: {
      foregroundColor: WHITE,
      foregroundColorStyle: { rgbColor: WHITE },
      fontFamily: "Arial",
      fontSize: 9,
      bold: true,
      italic: false,
    },
  };

  const greyDataBaseStyle = {
    backgroundColor: GREY_BG,
    backgroundColorStyle: { rgbColor: GREY_BG },
    verticalAlignment: "BOTTOM",
    textFormat: {
      foregroundColor: BLACK,
      foregroundColorStyle: { rgbColor: BLACK },
      fontFamily: "Arial",
      fontSize: 9,
      bold: false,
      italic: false,
    },
  };

  const currencyFmt = { type: "CURRENCY", pattern: "[$£]#,##0.00" };
  const costMonthDateFmt = { type: "DATE", pattern: 'mmm"-"yy' };

  const clientFormatRequests = [
    // Confirmed Col R (17): unhide & 72px, format header & currency
    {
      updateDimensionProperties: {
        range: { sheetId: confSheetId, dimension: "COLUMNS", startIndex: 17, endIndex: 18 },
        properties: { hiddenByUser: false, pixelSize: 72 },
        fields: "hiddenByUser,pixelSize",
      },
    },
    {
      repeatCell: {
        range: { sheetId: confSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 17, endColumnIndex: 18 },
        cell: { userEnteredFormat: { ...headerCellStyle, numberFormat: currencyFmt } },
        fields: "userEnteredFormat(backgroundColor,backgroundColorStyle,verticalAlignment,wrapStrategy,textFormat,numberFormat)",
      },
    },
    {
      repeatCell: {
        range: { sheetId: confSheetId, startRowIndex: 1, endRowIndex: maxConfRow, startColumnIndex: 17, endColumnIndex: 18 },
        cell: { userEnteredFormat: { numberFormat: currencyFmt } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
  ];

  // AU (46), BB (53), BI (60) -> of which rechgd
  for (const cIdx of [46, 53, 60]) {
    clientFormatRequests.push(
      {
        updateDimensionProperties: {
          range: { sheetId: confSheetId, dimension: "COLUMNS", startIndex: cIdx, endIndex: cIdx + 1 },
          properties: { hiddenByUser: false, pixelSize: 72 },
          fields: "hiddenByUser,pixelSize",
        },
      },
      {
        repeatCell: {
          range: { sheetId: confSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: cIdx, endColumnIndex: cIdx + 1 },
          cell: { userEnteredFormat: { ...headerCellStyle, numberFormat: currencyFmt } },
          fields: "userEnteredFormat(backgroundColor,backgroundColorStyle,verticalAlignment,wrapStrategy,textFormat,numberFormat)",
        },
      },
      {
        repeatCell: {
          range: { sheetId: confSheetId, startRowIndex: 1, endRowIndex: maxConfRow, startColumnIndex: cIdx, endColumnIndex: cIdx + 1 },
          cell: { userEnteredFormat: { ...greyDataBaseStyle, numberFormat: currencyFmt } },
          fields: "userEnteredFormat(backgroundColor,backgroundColorStyle,verticalAlignment,textFormat,numberFormat)",
        },
      },
      {
        setDataValidation: {
          range: { sheetId: confSheetId, startRowIndex: 1, endRowIndex: maxConfRow, startColumnIndex: cIdx, endColumnIndex: cIdx + 1 },
          rule: null,
        },
      }
    );
  }

  // AV (47), BC (54), BJ (61) -> cost month (with CLIP wrap!)
  for (const cIdx of [47, 54, 61]) {
    clientFormatRequests.push(
      {
        updateDimensionProperties: {
          range: { sheetId: confSheetId, dimension: "COLUMNS", startIndex: cIdx, endIndex: cIdx + 1 },
          properties: { hiddenByUser: false, pixelSize: 70 },
          fields: "hiddenByUser,pixelSize",
        },
      },
      {
        repeatCell: {
          range: { sheetId: confSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: cIdx, endColumnIndex: cIdx + 1 },
          cell: { userEnteredFormat: { ...headerCellStyle } },
          fields: "userEnteredFormat(backgroundColor,backgroundColorStyle,verticalAlignment,wrapStrategy,textFormat)",
        },
      },
      {
        repeatCell: {
          range: { sheetId: confSheetId, startRowIndex: 1, endRowIndex: maxConfRow, startColumnIndex: cIdx, endColumnIndex: cIdx + 1 },
          cell: { userEnteredFormat: { ...greyDataBaseStyle, numberFormat: costMonthDateFmt, wrapStrategy: "CLIP" } },
          fields: "userEnteredFormat(backgroundColor,backgroundColorStyle,verticalAlignment,textFormat,numberFormat,wrapStrategy)",
        },
      },
      {
        setDataValidation: {
          range: { sheetId: confSheetId, startRowIndex: 1, endRowIndex: maxConfRow, startColumnIndex: cIdx, endColumnIndex: cIdx + 1 },
          rule: null,
        },
      }
    );
  }

  // Outgoings 225:226 formatting & KeyInfo!D21 format
  if (cKeySheetId !== undefined && !cA2Formula.startsWith("=IMPORTRANGE")) {
    clientFormatRequests.push({
      repeatCell: {
        range: { sheetId: cKeySheetId, startRowIndex: 20, endRowIndex: 21, startColumnIndex: 3, endColumnIndex: 4 },
        cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0%" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  }
  clientFormatRequests.push(
    {
      updateDimensionProperties: {
        range: { sheetId: outSheetId, dimension: "ROWS", startIndex: 224, endIndex: 226 },
        properties: { pixelSize: 20 },
        fields: "pixelSize",
      },
    },
    {
      repeatCell: {
        range: { sheetId: outSheetId, startRowIndex: 224, endRowIndex: 226, startColumnIndex: 0, endColumnIndex: 55 },
        cell: {
          userEnteredFormat: {
            backgroundColor: WHITE,
            backgroundColorStyle: { rgbColor: WHITE },
            textFormat: { fontFamily: "Arial", fontSize: 9, bold: false, italic: false },
          },
        },
        fields: "userEnteredFormat(backgroundColor,backgroundColorStyle,textFormat(fontFamily,fontSize,bold,italic))",
      },
    },
    {
      repeatCell: {
        range: { sheetId: outSheetId, startRowIndex: 224, endRowIndex: 226, startColumnIndex: 4, endColumnIndex: 5 },
        cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0%" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId: outSheetId, startRowIndex: 224, endRowIndex: 226, startColumnIndex: 6, endColumnIndex: 50 },
        cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "£#,##0" } } },
        fields: "userEnteredFormat.numberFormat",
      },
    }
  );

  // Copy Outgoings!B225:E225 validations to B226:E226 if present
  const srcValRow = outValidationMeta.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || [];
  if (srcValRow.some((v) => v?.dataValidation)) {
    clientFormatRequests.push({
      updateCells: {
        range: { sheetId: outSheetId, startRowIndex: 225, endRowIndex: 226, startColumnIndex: 1, endColumnIndex: 5 },
        rows: [
          {
            values: [0, 1, 2, 3].map((idx) => ({
              dataValidation: srcValRow[idx]?.dataValidation || null,
            })),
          },
        ],
        fields: "dataValidation",
      },
    });
  }

  // 3. Client values & formulas (raw Google Sheet)
  const { updates: clientValueUpdates, confCalcsEndRow } = buildClientRechargedUpdates({
    a2Formula: cA2Formula,
    d6Raw: cVr[2]?.values?.[0]?.[0],
    preservedD21,
    jobTableStyle,
    existingAg: cVr[5]?.values || [],
    existingBw: cVr[6]?.values || [],
    eqRows: cVr[7]?.values || [],
    bwCheckEnd,
    capRow,
    confCalcsMaxRows,
  });

  // Execute Google Sheets updates
  await rawSheets.spreadsheets.batchUpdate({
    spreadsheetId: clientId,
    requestBody: { requests: clientFormatRequests },
    _bypassSupabaseVirtualSheet: true,
  });
  await rawSheets.spreadsheets.values.batchUpdate({
    spreadsheetId: clientId,
    requestBody: { valueInputOption: "USER_ENTERED", data: clientValueUpdates },
    _bypassSupabaseVirtualSheet: true,
  });

  if (masterId && masterValueUpdates.length > 0) {
    if (mKeySheetId !== undefined) {
      await rawSheets.spreadsheets.batchUpdate({
        spreadsheetId: masterId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: { sheetId: mKeySheetId, startRowIndex: 20, endRowIndex: 21, startColumnIndex: 3, endColumnIndex: 4 },
                cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0%" } } },
                fields: "userEnteredFormat.numberFormat",
              },
            },
          ],
        },
        _bypassSupabaseVirtualSheet: true,
      });
    }
    await rawSheets.spreadsheets.values.batchUpdate({
      spreadsheetId: masterId,
      requestBody: { valueInputOption: "USER_ENTERED", data: masterValueUpdates },
      _bypassSupabaseVirtualSheet: true,
    });
  }

  console.log(`  Applied raw Google Sheet updates (Conf=${maxConfRow}r, ConfCalcs=2..${confCalcsEndRow}).`);

  // 4. Sync Supabase virtual grids in-place when enabled (never overwrite virtual edits from raw sheet)
  const virtMVr = virtMBatchRes?.data?.valueRanges || [];
  const virtMD21Raw = virtMVr[2]?.values?.[0]?.[0];
  const virtMD11 = String(virtMVr[1]?.values?.[0]?.[0] ?? "").trim();

  if (ctx?.masterMode === "supabase" && masterId) {
    const virtMasterD21 = isZeroPct(virtMD21Raw !== undefined && virtMD21Raw !== "" ? virtMD21Raw : preservedD21) ? 0 : 1;
    const virtMD6 = mergeKeyInfoD6(virtMVr[0]?.values?.[0]?.[0]);
    const virtMasterUpdates = [
      { range: "KeyInfo!C21:D21", values: [[KEYINFO_C21_NOTE, virtMasterD21]] },
      ...(virtMD6.changed ? [{ range: "KeyInfo!D6", values: [[virtMD6.merged]] }] : []),
    ];
    await virtSheets.spreadsheets.values.batchUpdate({
      spreadsheetId: masterId,
      requestBody: { valueInputOption: "USER_ENTERED", data: virtMasterUpdates },
    });
    console.log("  Updated Master Supabase virtual grid in-place.");
  }

  if (ctx?.clientMode === "supabase") {
    const vA2Formula = String(vVr[1]?.values?.[0]?.[0] ?? "");
    const vD11 = String(vVr[3]?.values?.[0]?.[0] ?? "").trim();
    const vD21Raw = vVr[4]?.values?.[0]?.[0];
    const vPreservedD21 = isZeroPct(
      virtMD21Raw !== undefined && virtMD21Raw !== ""
        ? virtMD21Raw
        : (vD21Raw !== undefined && vD21Raw !== "" ? vD21Raw : preservedD21)
    ) ? 0 : 1;
    const vJobTableStyle = (virtMD11 || vD11 || jobTableStyle).toLowerCase();

    const { updates: virtClientValueUpdates, confCalcsEndRow: virtConfCalcsEndRow } = buildClientRechargedUpdates({
      a2Formula: vA2Formula,
      d6Raw: vVr[2]?.values?.[0]?.[0],
      preservedD21: vPreservedD21,
      jobTableStyle: vJobTableStyle,
      existingAg: vVr[5]?.values || [],
      existingBw: vVr[6]?.values || [],
      eqRows: vVr[7]?.values || [],
      bwCheckEnd,
      capRow,
      confCalcsMaxRows,
    });

    await virtSheets.spreadsheets.values.batchUpdate({
      spreadsheetId: clientId,
      requestBody: { valueInputOption: "USER_ENTERED", data: virtClientValueUpdates },
    });
    invalidateMasterEngineCache(client.clientName);
    console.log(`  Updated Client Supabase virtual grid in-place (ConfCalcs=2..${virtConfCalcsEndRow}).`);
  }

  // 5. Post-migration formula verification
  const rawErrors = await verifyFormulaHealth(rawSheets, clientId, "Raw Google Sheet", {
    _bypassSupabaseVirtualSheet: true,
  });
  let virtErrors = [];
  if (ctx?.clientMode === "supabase") {
    virtErrors = await verifyFormulaHealth(virtSheets, clientId, "Supabase Virtual");
  }

  return {
    status: "migrated",
    errors: [...rawErrors, ...virtErrors],
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help || (!args.all && !args.client)) {
    printUsage();
    setTimeout(() => process.exit(0), 50);
    return;
  }

  const rawSheets = await getSheetsClient({ _bypassSupabaseVirtualSheet: true });
  const virtSheets = await getSheetsClient();
  const { clientsArray } = await getAllClients(rawSheets, { isAdmin: true }, true);

  let targets = clientsArray || [];
  if (!args.all) {
    const targetLower = args.client.toLowerCase();
    targets = targets.filter((c) => String(c.clientName || "").trim().toLowerCase() === targetLower);
  }

  if (targets.length === 0) {
    console.error(`No matching clients found for ${args.all ? "--all" : `--client="${args.client}"`}.`);
    setTimeout(() => process.exit(1), 50);
    return;
  }

  console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"} | Target clients: ${targets.map((c) => c.clientName).join(", ")}`);

  let hadErrors = false;
  for (const client of targets) {
    if (!client.clientSheetId) {
      console.log(`SKIP ${client.clientName}: Missing clientSheetId.`);
      continue;
    }
    if (args.apply) {
      const res = await applyClientMigration(rawSheets, virtSheets, client);
      if (res.errors?.length) hadErrors = true;
    } else {
      await inspectClient(rawSheets, client);
    }
  }

  setTimeout(() => process.exit(hadErrors ? 1 : 0), 150);
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error("Migration script failed:", err);
    setTimeout(() => process.exit(1), 150);
  });
}

