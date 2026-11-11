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

const { getSupabaseAdmin } = require('../services/supabaseClient.js');

async function test() {
  const supabase = getSupabaseAdmin();
  
  const { data: recs } = await supabase
    .from('master_sheet_grids')
    .select('client_id, client_name, tab_name, grid_data')
    .ilike('client_name', '%Beyond%')
    .in('tab_name', ['CRMComp', 'CRMList', 'DataFromCRM']);

  for (const r of recs || []) {
    console.log(`Tab: ${r.tab_name} (client: ${r.client_name}, id: ${r.client_id}) -> rows: ${r.grid_data?.length}`);
    if (r.tab_name === 'CRMComp') {
      const g = r.grid_data || [];
      console.log('CRMComp A2:C2:', g[1]?.slice(0, 3));
      console.log('CRMComp X5:X10:', g.slice(4, 10).map(row => row ? row[23] : ''));
    }
  }

  process.exit(0);
}
test().catch(e => { console.error(e); process.exit(1); });

