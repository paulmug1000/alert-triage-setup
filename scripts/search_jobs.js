const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '../.env.local');
const lines = fs.readFileSync(envPath, 'utf8').split('\n');
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx !== -1) {
    const k = trimmed.slice(0, eqIdx).trim();
    const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    process.env[k] = v;
  }
}
process.env.REDIS_URL = '';

const { getSheetsClient } = require('../services/sheetsClient.js');

async function test() {
  const masterSheetId = '1myVZVUCZ_0OxeZFPkbBQMA1RuE-r0NgqvzhPIgH8pS4';
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: masterSheetId });
  const tabs = meta.data.sheets.map(s => s.properties.title);

  console.log('Searching for 105a91a8 and Gairdner across tabs in 1myVZVUCZ_0OxeZFPkbBQMA1RuE-r0NgqvzhPIgH8pS4...');
  for (const t of tabs) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: `'${t}'!A1:AZ50`
      });
      const str = JSON.stringify(res.data.values || []);
      if (str.includes('105a91a8') || str.includes('Gairdner') || str.includes('Jagrit') || str.includes('121 personal')) {
        console.log('FOUND IN TAB:', t);
      }
    } catch (e) {
      console.error(`Error on ${t}:`, e.message);
    }
  }

  // Also search the client sheet 1MNsDQzTSuVylNCL2MUTqLjmQfd1NtkLhWsmrebyyqhE!
  const clientSheetId = '1MNsDQzTSuVylNCL2MUTqLjmQfd1NtkLhWsmrebyyqhE';
  const clientMeta = await sheets.spreadsheets.get({ spreadsheetId: clientSheetId });
  const cTabs = clientMeta.data.sheets.map(s => s.properties.title);
  console.log('\nSearching across tabs in Client sheet 1MNsDQzTSuVylNCL2MUTqLjmQfd1NtkLhWsmrebyyqhE...');
  for (const t of cTabs) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `'${t}'!A1:AZ50`
      });
      const str = JSON.stringify(res.data.values || []);
      if (str.includes('105a91a8') || str.includes('Gairdner') || str.includes('Jagrit') || str.includes('121 personal')) {
        console.log('FOUND IN CLIENT TAB:', t);
      }
    } catch (e) {}
  }

  // Also search the Recon sheet 1kxpNeQqLlM2H5czNHppqOoHzgCUUwb3w4vcTuGHxhlY!
  const reconSheetId = '1kxpNeQqLlM2H5czNHppqOoHzgCUUwb3w4vcTuGHxhlY';
  const reconMeta = await sheets.spreadsheets.get({ spreadsheetId: reconSheetId });
  const rTabs = reconMeta.data.sheets.map(s => s.properties.title);
  console.log('\nSearching across tabs in Recon sheet 1kxpNeQqLlM2H5czNHppqOoHzgCUUwb3w4vcTuGHxhlY...');
  for (const t of rTabs) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: reconSheetId,
        range: `'${t}'!A1:AZ50`
      });
      const str = JSON.stringify(res.data.values || []);
      if (str.includes('105a91a8') || str.includes('Gairdner') || str.includes('Jagrit') || str.includes('121 personal')) {
        console.log('FOUND IN RECON TAB:', t);
      }
    } catch (e) {}
  }

  process.exit(0);
}
test().catch(e => { console.error(e); process.exit(1); });

