import fs from 'fs';
import { getSheetsClient } from '../services/sheetsClient.js';

const env = fs.readFileSync('.env.local', 'utf8');
for (const rawLine of env.split('\n')) {
  const line = rawLine.trim();
  const idx = line.indexOf('=');
  if (idx > 0 && !line.startsWith('#')) {
    const k = line.substring(0, idx).trim();
    let v = line.substring(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}

async function run() {
  const sheets = await getSheetsClient();
  const cId = '14UO5eBNuV-F7pSiPokcIMT3y63EkppeHQgiTU7eqM1Y';
  const mId = '18Wc63tRTTmCCu4AmYUuPc3aG8bHTyzz6j4pFYnNqASU';

  const appRes = await sheets.spreadsheets.values.get({
    spreadsheetId: cId,
    range: 'AppLog!A2:E50',
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const actions = new Set();
  (appRes.data.values || []).forEach(r => {
    actions.add(r[1]);
  });
  console.log("Distinct AppLog actions in top 50:", Array.from(actions));
  
  // Look for any PAGE_VIEW_BATCH or JOB actions
  const pageViews = (appRes.data.values || []).filter(r => r[1] === 'PAGE_VIEW_BATCH');
  if (pageViews.length > 0) {
    console.log("Sample PAGE_VIEW_BATCH details:", pageViews[0][3]);
  }
  
  const jobActions = (appRes.data.values || []).filter(r => r[1]?.includes('JOB'));
  if (jobActions.length > 0) {
    console.log("Sample JOB action:", jobActions[0]);
  }

  // Also check AutoLog non "No changes"
  const autoRes = await sheets.spreadsheets.values.get({
    spreadsheetId: mId,
    range: 'AutoLog!A2:D50',
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const changes = (autoRes.data.values || []).filter(r => !r[2]?.toLowerCase().includes("no change"));
  console.log("AutoLog with changes (top 50):", changes.map(r => ({ ts: r[0], cat: r[1], sum: r[2], det: r[3]?.substring(0, 100) })));
}

run();
