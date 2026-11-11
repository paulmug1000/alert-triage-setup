import { google } from "googleapis";
import fs from "fs";
import path from "path";

const envPath = path.resolve("pulse-management-system", ".env.local");
const envContent = fs.readFileSync(envPath, "utf8");
let clientEmail = "";
let privateKey = "";
for (const line of envContent.split("\n")) {
  if (line.startsWith("SERVICE_ACCOUNT_EMAIL=")) {
    clientEmail = line.substring("SERVICE_ACCOUNT_EMAIL=".length).trim().replace(/^"|"$/g, "");
  }
  if (line.startsWith("SERVICE_ACCOUNT_PRIVATE_KEY=")) {
    privateKey = line.substring("SERVICE_ACCOUNT_PRIVATE_KEY=".length).trim().replace(/^"|"$/g, "");
  }
}
privateKey = privateKey.replace(/\\n/g, "\n");

const auth = new google.auth.GoogleAuth({
  credentials: { client_email: clientEmail, private_key: privateKey },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

function getRevFormula(r) {
  return `=IF(OR(A${r}="", B${r}=""), "-",
  IF(AND(LEN(AL${r})=0, N(AG${r})=0), "-",
    IF(AJ${r}<>"Project", "NA",
      AG${r} - (N(AP${r}) + N(AW${r}) + N(BD${r})) - (SUMIFS(AP:AP, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(AW:AW, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(BD:BD, A:A, A${r}, B:B, B${r}, AL:AL, ""))
    )
  )
)`;
}

function getDcFormula(r) {
  return `=IF(OR(A${r}="", B${r}=""), "-",
  IF(AND(LEN(AL${r})=0, N(AH${r})=0), "-",
    IF(AJ${r}<>"Project", "NA",
      AH${r} - (N(BY${r}) + N(CF${r}) + N(CM${r})) - (SUMIFS(BY:BY, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(CF:CF, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(CM:CM, A:A, A${r}, B:B, B${r}, AL:AL, ""))
    )
  )
)`;
}

async function testAppTest() {
  const appTestId = "1LZYoHrogDV828bVHFOWTjejuWspKdihbUMAqSihqArA";
  console.log("Fetching APPTEST metadata...");
  const meta = await sheets.spreadsheets.get({ spreadsheetId: appTestId });
  const confSheet = meta.data.sheets.find(s => s.properties.title === "Confirmed");
  const pipeSheet = meta.data.sheets.find(s => s.properties.title === "Pipeline");

  const confRows = confSheet.properties.gridProperties.rowCount;
  const pipeRows = pipeSheet.properties.gridProperties.rowCount;

  console.log(`Confirmed rows: ${confRows}, Pipeline rows: ${pipeRows}`);

  // Build batches:
  const confBwValues = [];
  const confDcValues = [];
  for (let r = 2; r <= confRows; r++) {
    confBwValues.push([getRevFormula(r)]);
    confDcValues.push([getDcFormula(r)]);
  }

  const pipeBwValues = [];
  const pipeDcValues = [];
  for (let r = 2; r <= pipeRows; r++) {
    pipeBwValues.push([getRevFormula(r)]);
    pipeDcValues.push([getDcFormula(r)]);
  }

  console.log("Writing to APPTEST via values.batchUpdate...");
  const t0 = Date.now();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: appTestId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `Confirmed!BW2:BW${confRows}`, values: confBwValues },
        { range: `Confirmed!DC2:DC${confRows}`, values: confDcValues },
        { range: `Pipeline!BW2:BW${pipeRows}`, values: pipeBwValues },
        { range: `Pipeline!DC2:DC${pipeRows}`, values: pipeDcValues },
      ]
    }
  });
  console.log(`Completed APPTEST update in ${Date.now() - t0} ms!`);

  // Verify row 2, row 100, row 5000 in Confirmed
  const checkRes = await sheets.spreadsheets.values.get({
    spreadsheetId: appTestId,
    range: `Confirmed!BW2:DC3`,
    valueRenderOption: "FORMULA"
  });
  console.log("Confirmed BW2 formula:", checkRes.data.values[0][0]);
  console.log("Confirmed DC2 formula:", checkRes.data.values[0][32]);
  console.log("Confirmed BW3 formula:", checkRes.data.values[1][0]);
  console.log("Confirmed DC3 formula:", checkRes.data.values[1][32]);

  // Check Pipeline row 2, 3
  const pipeCheck = await sheets.spreadsheets.values.get({
    spreadsheetId: appTestId,
    range: `Pipeline!BW2:DC3`,
    valueRenderOption: "FORMULA"
  });
  console.log("Pipeline BW2 formula:", pipeCheck.data.values[0][0]);
  console.log("Pipeline DC2 formula:", pipeCheck.data.values[0][32]);
}

testAppTest().catch(console.error);
