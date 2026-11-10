import fs from 'fs';
const envLines = fs.readFileSync('pulse-management-system/.env.local', 'utf8').split('\n');
envLines.forEach(l => {
  const idx = l.indexOf('=');
  if (idx !== -1) {
    const k = l.slice(0, idx).trim();
    let v = l.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    process.env[k] = v;
  }
});

async function run() {
  const { autoReconcileClientBankTransactions } = await import('../services/bankTransactionsService.js');

  console.log("Executing autoReconcileClientBankTransactions for Thrive Recruitment Marketing (monthKey: 2026-10)...");

  // Also test with clientName: "" to ensure defensive resolution from Master Sheet KeyInfo!B1 works!
  const result = await autoReconcileClientBankTransactions({
    clientName: "",
    masterSheetId: "1f-YUxOmS51j8B7JVlHJ1nf72QSneNklnMATROe1E94s",
    reconSheetId: "1nezKTYKn2_2rFWeXeFjATNWRYIGZ6YdzaBLOsVlOKN4",
    monthKey: "2026-10"
  });

  console.log("Result:", JSON.stringify(result, null, 2));
}

run().catch(err => {
  console.error("Error executing auto-reconcile:", err);
  process.exit(1);
});
