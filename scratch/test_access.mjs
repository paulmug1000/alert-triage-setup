import fs from 'fs';
import { getSheetsClient } from '../services/sheetsClient.js';

// Load .env.local manually
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

const sheetIds = {
  'Master sheet template': '1Kt0dRbMCd0jgTxBU5uwVMlVN75CIc7YtVJQHnYMR61w',
  'Client sheet template': '1KE0CRs8a92WMzyxy6rMZtr6d9D7cGMpUB3YLV89xjno',
  'agent-automater': '12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M',
  'Client version tracker (bulk-updater)': '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co',
  'deployment-manager': '1v1N5ymNkcUCSPfzEGJxE43ylgGN95iyZmhKgnz62OQQ',
  'reporting-control': '1uAJS6ZWn0o-GPU9Ea3DIVU9nzQoRnXrMfmBcQYHNJ_s'
};

async function test() {
  const sheets = await getSheetsClient();
  for (const [name, id] of Object.entries(sheetIds)) {
    try {
      const res = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'properties.title' });
      console.log(`[ACCESSIBLE] ${name}: "${res.data.properties.title}"`);
    } catch (err) {
      console.log(`[NO ACCESS] ${name} (${id}): ${err.message || err}`);
    }
  }
}

test();
