import fs from 'fs';
import { getSheetsClient } from '../services/sheetsClient.js';
import { fetchClientActivity } from '../services/activityService.js';

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

async function run() {
  const sheets = await getSheetsClient();
  const testClient = {
    clientName: "Eleven",
    clientSheetId: "14UO5eBNuV-F7pSiPokcIMT3y63EkppeHQgiTU7eqM1Y",
    masterSheetId: "18Wc63tRTTmCCu4AmYUuPc3aG8bHTyzz6j4pFYnNqASU"
  };

  console.log("Fetching activity for Eleven...");
  const res = await fetchClientActivity(sheets, testClient, false);
  console.log(`Retrieved ${res.events.length} events (routine filtered out):`);
  res.events.forEach((ev, idx) => {
    console.log(`[${idx+1}] ${ev.relativeTime} • [${ev.source.toUpperCase()}] • ${ev.summary}`);
    if (ev.structuredDetails?.invoices) {
      console.log("    Invoices detail:", ev.structuredDetails.invoices);
    }
    if (ev.structuredDetails?.opportunities) {
      console.log("    Opportunities detail:", ev.structuredDetails.opportunities);
    }
    if (ev.structuredDetails?.pagesVisited) {
      console.log("    Pages visited:", ev.structuredDetails.pagesVisited);
    }
  });

  console.log("\nTesting with includeRoutine=true...");
  const resRoutine = await fetchClientActivity(sheets, testClient, true);
  console.log(`Retrieved ${resRoutine.events.length} total events (including routine checks).`);
  process.exit(0);
}

run();
