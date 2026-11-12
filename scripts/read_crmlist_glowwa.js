const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const envContent = fs.readFileSync(path.resolve(__dirname, '../.env.local'), 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let val = (match[2] || '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[match[1]] = val;
  }
});

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: env.SERVICE_ACCOUNT_EMAIL,
    private_key: env.SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    project_id: env.SERVICE_ACCOUNT_PROJECT_ID
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function main() {
  const sheets = google.sheets({ version: 'v4', auth });
  const masterId = '18Wc63tRTTmCCu4AmYUuPc3aG8bHTyzz6j4pFYnNqASU';
  
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: masterId,
    range: 'CRMList!C1:C1000'
  });
  const rows = res.data.values || [];
  console.log(`CRMList has ${rows.length} rows.`);
  rows.forEach((r, idx) => {
    if (r[0] && (r[0].toLowerCase().includes('glowwa') || r[0].toLowerCase().includes('869f6dpa0'))) {
      console.log(`Found in Col C at row ${idx + 1}: ${r[0]}`);
    }
  });
}

main().catch(console.error);
