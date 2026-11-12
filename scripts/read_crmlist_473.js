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
  
  const hRes = await sheets.spreadsheets.values.get({
    spreadsheetId: masterId,
    range: 'CRMList!1:1'
  });
  const headers = hRes.data.values[0];
  
  const vRes = await sheets.spreadsheets.values.get({
    spreadsheetId: masterId,
    range: 'CRMList!A473:AZ473'
  });
  const fRes = await sheets.spreadsheets.values.get({
    spreadsheetId: masterId,
    range: 'CRMList!A473:AZ473',
    valueRenderOption: 'FORMULA'
  });
  
  const vals = vRes.data.values?.[0] || [];
  const forms = fRes.data.values?.[0] || [];
  
  vals.forEach((v, idx) => {
    if (v !== '' && v !== undefined && v !== null) {
      console.log(`Col ${idx+1} (${headers[idx]}): Value="${v}" | Formula="${forms[idx]}"`);
    }
  });
}

main().catch(console.error);
