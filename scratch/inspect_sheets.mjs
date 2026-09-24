import fs from 'fs';
import { getSheetsClient } from '../services/sheetsClient.js';

// Load .env.local
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

const targetSheets = {
  'master-sheet-template': '1Kt0dRbMCd0jgTxBU5uwVMlVN75CIc7YtVJQHnYMR61w',
  'client-sheet-template': '1KE0CRs8a92WMzyxy6rMZtr6d9D7cGMpUB3YLV89xjno',
  'agent-automater': '12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M',
  'deployment-manager': '1v1N5ymNkcUCSPfzEGJxE43ylgGN95iyZmhKgnz62OQQ'
};

async function inspectSpreadsheet(sheets, name, id) {
  console.log(`\n======================================================`);
  console.log(`ANALYZING: ${name} (${id})`);
  console.log(`======================================================`);
  
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: id,
    fields: 'properties.title,namedRanges,sheets(properties(sheetId,title,gridProperties,hidden))'
  });

  console.log(`Title: ${meta.data.properties.title}`);
  if (meta.data.namedRanges && meta.data.namedRanges.length > 0) {
    console.log(`Named Ranges (${meta.data.namedRanges.length}):`);
    meta.data.namedRanges.slice(0, 10).forEach(nr => {
      console.log(`  - ${nr.name}: sheet ${nr.range.sheetId} [${nr.range.startRowIndex}:${nr.range.endRowIndex}, ${nr.range.startColumnIndex}:${nr.range.endColumnIndex}]`);
    });
  }

  const sheetSummaries = [];
  for (const s of meta.data.sheets) {
    const title = s.properties.title;
    const isHidden = s.properties.hidden ? ' (HIDDEN)' : '';
    const rowCount = s.properties.gridProperties?.rowCount || 0;
    const colCount = s.properties.gridProperties?.columnCount || 0;
    
    // Read the top 5 rows with formulas
    let sampleData = [];
    try {
      const dataRes = await sheets.spreadsheets.values.get({
        spreadsheetId: id,
        range: `'${title}'!A1:Z5`,
        valueRenderOption: 'FORMULA'
      });
      sampleData = dataRes.data.values || [];
    } catch (e) {
      sampleData = [[`Error fetching rows: ${e.message}`]];
    }

    const headers = sampleData[0] || [];
    const formulasFound = [];
    sampleData.forEach((row, rIdx) => {
      row.forEach((cell, cIdx) => {
        if (typeof cell === 'string' && cell.startsWith('=')) {
          formulasFound.push(`R${rIdx + 1}C${cIdx + 1}: ${cell}`);
        }
      });
    });

    // Add a short delay to stay well under Google Sheets API 60 req/min rate limit
    await new Promise(r => setTimeout(r, 1100));

    console.log(`\n--- Tab: "${title}"${isHidden} (${rowCount}r x ${colCount}c) ---`);
    console.log(`Headers (${headers.length}):`, headers.slice(0, 15).map(h => String(h).trim()).filter(Boolean).join(' | '));
    if (formulasFound.length > 0) {
      console.log(`Sample Formulas in top 5 rows:`);
      formulasFound.slice(0, 5).forEach(f => console.log(`   ${f}`));
    }
  }
}

async function run() {
  const sheets = await getSheetsClient();
  for (const [name, id] of Object.entries(targetSheets)) {
    try {
      await inspectSpreadsheet(sheets, name, id);
    } catch (err) {
      console.error(`Error inspecting ${name}:`, err.message);
    }
  }
}

run();
