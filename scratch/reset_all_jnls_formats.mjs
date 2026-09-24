import fs from 'fs';
import { getSheetsClient } from '../services/sheetsClient.js';

const env = fs.readFileSync('.env.local', 'utf8');
for (const rawLine of env.split('\n')) {
  const line = rawLine.trim();
  const idx = line.indexOf('=');
  if (idx > 0 && !line.startsWith('#')) {
    let k = line.substring(0, idx).trim();
    let v = line.substring(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

const ALL_MASTERS = [
  { name: 'Template', masterId: '1Kt0dRbMCd0jgTxBU5uwVMlVN75CIc7YtVJQHnYMR61w' },
  { name: 'Eleven', masterId: '18Wc63tRTTmCCu4AmYUuPc3aG8bHTyzz6j4pFYnNqASU' },
  { name: 'Orinoco Communications', masterId: '1bof1JZWoDH2KLpw54YIf7ObWZWc3hponQBt4yUo7j9o' },
  { name: 'Rascal Ventures', masterId: '1qCMqPyydWNUkVSHAkhsV9CT23w9Y6QlK0AJEtkvvtZ0' },
  { name: 'Beyond the Blueprint', masterId: '1myVZVUCZ_0OxeZFPkbBQMA1RuE-r0NgqvzhPIgH8pS4' },
  { name: 'Get Better', masterId: '112IgaAdZk1RrfbaqLjzmX3vAuNM_0BF0Uq6iHqOlm3U' },
  { name: 'Thrive Recruitment Marketing', masterId: '1f-YUxOmS51j8B7JVlHJ1nf72QSneNklnMATROe1E94s' },
  { name: 'Advance Online', masterId: '1zg3r7OELvq-ItDDdqA9bVarcSB08n-OTRpmI0LdY88Q' },
  { name: 'Incredibble', masterId: '1DrFYTp5rt2bZ8VYs3e9inu58yJmeFQUeC6J9yaJSf_0' },
  { name: 'ANRPR', masterId: '1BQXEmKy1j6xMiRe-P5Hf7sInWySN8xM1hl7Uv78hS-M' },
  { name: 'The Anteroom', masterId: '12Gdo6TJ9IHsCvxVtbyr1t7ubnb5wIYx3A1IvDuCtnWY' },
  { name: 'Ayefour Design', masterId: '18PW0iPepcUqcvqGwhvXvoEgnIiWeAyUZhUdF722fO_U' },
  { name: 'APPTEST', masterId: '13Ayrpn_i0fgOV19IXYh9zUukUk-zj7r3cI3_FTrqy1g' },
  { name: 'GeoBrand', masterId: '1CRB3QA11-tjezTygXsATDahDoiPEMYnt-A-4Ucdu6bE' },
  { name: 'Hancock & Rowe', masterId: '1t9XTgCzU4sM-XRi1ocpMI-oyMISSxqjTnoOEuycmB0c' },
  { name: 'Base Three', masterId: '1eIITHKFR7_WhFcroswc13nguJoAzqZpWXoSTFdmz-ZA' }
];

async function resetJnlsFormatsForSheet(sheets, clientName, masterId) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: masterId });
    const jnlsSheet = meta.data.sheets.find(s => s.properties.title === 'JnlsFromApp');
    if (!jnlsSheet) {
      console.log(`[${clientName}] JnlsFromApp does not exist. Skipping.`);
      return;
    }
    const sheetId = jnlsSheet.properties.sheetId;
    const maxRows = jnlsSheet.properties.gridProperties?.rowCount || 500;

    // Requests to apply proper number formats:
    // Col 0 (A): Date -> yyyy-mm-dd
    // Col 1 (B): Description -> @
    // Cols 2..4 (C..E): Net, VAT, Gross -> 0.00
    // Cols 5..8 (F..I): Reference, Account, Status, Transaction ID -> @
    // Col 9 (J): Date Paid -> yyyy-mm-dd
    const requests = [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: maxRows, startColumnIndex: 0, endColumnIndex: 1 },
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: maxRows, startColumnIndex: 1, endColumnIndex: 2 },
          cell: { userEnteredFormat: { numberFormat: { type: 'TEXT', pattern: '@' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: maxRows, startColumnIndex: 2, endColumnIndex: 5 },
          cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.00' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: maxRows, startColumnIndex: 5, endColumnIndex: 9 },
          cell: { userEnteredFormat: { numberFormat: { type: 'TEXT', pattern: '@' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: maxRows, startColumnIndex: 9, endColumnIndex: 10 },
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      }
    ];

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: masterId,
      requestBody: { requests }
    });

    console.log(`[${clientName}] Successfully reset JnlsFromApp formatting on ${maxRows} rows.`);
  } catch (err) {
    console.error(`[${clientName}] Error resetting formatting: ${err.message}`);
  }
}

async function run() {
  const sheets = await getSheetsClient();
  for (const client of ALL_MASTERS) {
    await resetJnlsFormatsForSheet(sheets, client.name, client.masterId);
  }
  console.log('\nAll clients processed!');
}

run().catch(console.error);
