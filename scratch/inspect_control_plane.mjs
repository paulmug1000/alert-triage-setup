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
  'Client version tracker (bulk-updater)': '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co',
  'reporting-control': '1uAJS6ZWn0o-GPU9Ea3DIVU9nzQoRnXrMfmBcQYHNJ_s',
  'agent-automater': '12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M',
  'deployment-manager': '1v1N5ymNkcUCSPfzEGJxE43ylgGN95iyZmhKgnz62OQQ'
};

async function inspect(sheets, name, id) {
  console.log(`\n======================================================`);
  console.log(`ANALYZING: ${name} (${id})`);
  console.log(`======================================================`);

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: id,
    fields: 'properties.title,namedRanges,sheets(properties(sheetId,title,gridProperties,hidden))'
  });

  console.log(`Title: "${meta.data.properties.title}"`);
  if (meta.data.namedRanges && meta.data.namedRanges.length > 0) {
    console.log(`Named Ranges (${meta.data.namedRanges.length}):`);
    meta.data.namedRanges.forEach(nr => {
      console.log(`  - ${nr.name}: sheet ${nr.range.sheetId} [R${nr.range.startRowIndex || 0}:R${nr.range.endRowIndex || 'end'}, C${nr.range.startColumnIndex || 0}:C${nr.range.endColumnIndex || 'end'}]`);
    });
  }

  for (const s of meta.data.sheets) {
    const title = s.properties.title;
    const isHidden = s.properties.hidden ? ' (HIDDEN)' : '';
    const rowCount = s.properties.gridProperties?.rowCount || 0;
    const colCount = s.properties.gridProperties?.columnCount || 0;

    let sampleData = [];
    try {
      const dataRes = await sheets.spreadsheets.values.get({
        spreadsheetId: id,
        range: `'${title}'!A1:AZ6`,
        valueRenderOption: 'FORMULA'
      });
      sampleData = dataRes.data.values || [];
    } catch (e) {
      sampleData = [[`Error fetching rows: ${e.message}`]];
    }

    await new Promise(r => setTimeout(r, 600)); // Respect quota

    const formulasFound = [];
    sampleData.forEach((row, rIdx) => {
      row.forEach((cell, cIdx) => {
        if (typeof cell === 'string' && cell.startsWith('=')) {
          formulasFound.push(`R${rIdx + 1}C${cIdx + 1}: ${cell}`);
        }
      });
    });

    console.log(`\n--- Tab: "${title}"${isHidden} (${rowCount}r x ${colCount}c) ---`);
    for (let r = 0; r < Math.min(sampleData.length, 4); r++) {
      const rowVals = (sampleData[r] || []).map((c, i) => c ? `[C${i+1}] ${c}` : '').filter(Boolean);
      if (rowVals.length > 0) {
        console.log(`  Row ${r+1}: ${rowVals.slice(0, 10).join(' | ')}`);
      }
    }
    if (formulasFound.length > 0) {
      console.log(`  Formulas (${formulasFound.length} found in top rows):`);
      formulasFound.slice(0, 6).forEach(f => console.log(`     ${f}`));
    }
  }
}

async function run() {
  const sheets = await getSheetsClient();
  for (const [name, id] of Object.entries(targetSheets)) {
    try {
      await inspect(sheets, name, id);
    } catch (err) {
      console.error(`Error inspecting ${name}:`, err.message);
    }
  }
}

run();
