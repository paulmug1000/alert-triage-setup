import fs from 'fs';
import path from 'path';
import os from 'os';

const clasprc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.clasprc.json'), 'utf8'));
const creds = clasprc.tokens?.default || clasprc.token;
const token = creds.access_token;

const orinocoMasterScriptId = '1bcAW0Ys5Xmd1t1moxi9r20hd308dmxZoikNlVJIxH0mxnDsU1KPDDIm3';

async function run() {
  const url = `https://script.googleapis.com/v1/projects/${orinocoMasterScriptId}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  const file1 = data.files.find(f => f.name === '1_Core_and_Xero');
  const file7 = data.files.find(f => f.name === '7_Cost_Sync');

  console.log('--- Orinoco Master Live Script Verification ---');
  console.log('1_Core_and_Xero.gs header line:');
  console.log(file1?.source.split('\n').slice(0, 7).join('\n'));
  console.log('\n7_Cost_Sync.gs header line:');
  console.log(file7?.source.split('\n').slice(0, 8).join('\n'));
}

run().catch(console.error);
