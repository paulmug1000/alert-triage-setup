import { getSheetsClient } from '../services/sheetsClient.js';

function extractSheetId(url) {
  if (!url) return null;
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

async function main() {
  const sheets = await getSheetsClient();
  const trackerSheetId = '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co';

  // Read clients from Clients tab
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: trackerSheetId,
    range: 'Clients!A3:N30'
  });

  const rows = res.data.values || [];
  const targets = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row[0];
    const version = row[1];
    const clientUrl = row[11]; // Col L
    const sheetId = extractSheetId(clientUrl);

    if (name && sheetId) {
      targets.push({
        row: i + 3,
        name,
        version,
        sheetId,
        isTemplate: name.toLowerCase().includes('template')
      });
    }
  }

  console.log(`Starting OutgNotes rows 1000-1005 sweep across ${targets.length} targets...\n`);

  const results = {
    cleared: [],
    alreadyClean: [],
    noTab: [],
    errors: []
  };

  for (const target of targets) {
    process.stdout.write(`Checking [${target.name}] (${target.sheetId})... `);
    try {
      // 1. Check if OutgNotes tab exists
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: target.sheetId,
        fields: 'sheets(properties(sheetId,title))'
      });

      const hasOutgNotes = meta.data.sheets.some(s => s.properties?.title === 'OutgNotes');
      if (!hasOutgNotes) {
        console.log('⏩ No OutgNotes tab.');
        results.noTab.push(target.name);
        continue;
      }

      // 2. Read rows 1000-1005
      const checkRes = await sheets.spreadsheets.values.get({
        spreadsheetId: target.sheetId,
        range: "'OutgNotes'!A1000:ZZ1005"
      });

      const values = checkRes.data.values || [];
      const hasData = values.some(r => r.some(cell => cell !== '' && cell !== undefined && cell !== null));

      if (!hasData) {
        console.log('✅ Clean (rows 1000-1005 are empty).');
        results.alreadyClean.push(target.name);
        continue;
      }

      // Sample data
      const sampleRow = values.find(r => r.length > 0);
      const sampleText = sampleRow ? sampleRow.filter(Boolean).slice(0, 3).join(', ') : '';
      console.log(`⚠️ Stray data found (Sample: "${sampleText}"). Clearing...`);

      // 3. Clear A1000:ZZ1005
      await sheets.spreadsheets.values.clear({
        spreadsheetId: target.sheetId,
        range: "'OutgNotes'!A1000:ZZ1005"
      });

      // 4. Verify cleared
      const verifyRes = await sheets.spreadsheets.values.get({
        spreadsheetId: target.sheetId,
        range: "'OutgNotes'!A1000:ZZ1005"
      });
      const verifyValues = verifyRes.data.values || [];
      const stillHasData = verifyValues.some(r => r.some(cell => cell !== '' && cell !== undefined && cell !== null));

      if (stillHasData) {
        console.log(`❌ Failed to clear rows on [${target.name}].`);
        results.errors.push({ name: target.name, error: 'Data persisted after clear' });
      } else {
        console.log(`🧹 Successfully cleared and verified on [${target.name}].`);
        results.cleared.push(target.name);
      }
    } catch (err) {
      console.log(`❌ Error: ${err.message}`);
      results.errors.push({ name: target.name, error: err.message });
    }
  }

  console.log('\n=======================================');
  console.log('SWEEP COMPLETE SUMMARY');
  console.log('=======================================');
  console.log(`Total Targets Checked: ${targets.length}`);
  console.log(`Cleared: ${results.cleared.length} (${results.cleared.join(', ') || 'none'})`);
  console.log(`Already Clean: ${results.alreadyClean.length} (${results.alreadyClean.join(', ') || 'none'})`);
  console.log(`No OutgNotes Tab: ${results.noTab.length} (${results.noTab.join(', ') || 'none'})`);
  console.log(`Errors / Permissions: ${results.errors.length}`);
  results.errors.forEach(e => console.log(`  - ${e.name}: ${e.error}`));
}

main().catch(console.error);
