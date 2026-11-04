import { google } from "googleapis";
import fs from "fs";
import jszip from "jszip";

const envContent = fs.readFileSync(".env.local", "utf8");
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
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/presentations"
  ],
});
const drive = google.drive({ version: "v3", auth });
const slidesApi = google.slides({ version: "v1", auth });

async function run() {
  console.log("Searching for Google Slides presentations in Drive...");
  const list = await drive.files.list({
    q: "mimeType = 'application/vnd.google-apps.presentation' and trashed = false",
    fields: "files(id, name, modifiedTime, webViewLink)",
    pageSize: 10,
    orderBy: "modifiedTime desc"
  });

  const files = list.data.files || [];
  console.log(`Found ${files.length} presentations:`);
  for (const f of files) {
    console.log(`- ${f.name} (${f.id})`);
  }

  if (files.length === 0) return;

  const target = files[0];
  console.log(`\nInspecting presentation: "${target.name}" (${target.id}) via Google Slides API:`);
  try {
    const pres = await slidesApi.presentations.get({
      presentationId: target.id
    });
    console.log(`Presentation title: ${pres.data.title}`);
    console.log(`Total slides from Slides API: ${pres.data.slides?.length}`);
    for (let i = 0; i < Math.min(5, pres.data.slides?.length || 0); i++) {
      const s = pres.data.slides[i];
      console.log(`  Slide index ${i}: objectId = ${s.objectId}`);
    }

    // Now test export PNG with pageid
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    const token = tokenRes?.token || tokenRes;

    const firstSlideId = pres.data.slides[0]?.objectId;
    console.log(`\nTesting PNG export for pageid=${firstSlideId}...`);
    const exportUrl = `https://docs.google.com/presentation/d/${target.id}/export/png?id=${target.id}&pageid=${firstSlideId}`;
    const resp = await fetch(exportUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`Export PNG HTTP status: ${resp.status}, content-type: ${resp.headers.get("content-type")}`);
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      console.log(`Successfully received PNG buffer of length ${buf.byteLength} bytes!`);
    } else {
      const text = await resp.text();
      console.log(`Export PNG response text:`, text.slice(0, 300));
    }

    // Also test Slides API thumbnails endpoint
    console.log(`\nTesting Slides API pages.getThumbnail for ${firstSlideId}...`);
    try {
      const thumb = await slidesApi.presentations.pages.getThumbnail({
        presentationId: target.id,
        pageObjectId: firstSlideId,
        "thumbnailProperties.thumbnailSize": "LARGE"
      });
      console.log(`Slides API thumbnail response:`, thumb.data);
      if (thumb.data?.contentUrl) {
        const thumbResp = await fetch(thumb.data.contentUrl);
        console.log(`Thumbnail fetch HTTP ${thumbResp.status}, type: ${thumbResp.headers.get("content-type")}, size: ${(await thumbResp.arrayBuffer()).byteLength}`);
      }
    } catch (tErr) {
      console.log(`Slides API getThumbnail error:`, tErr.message);
    }

    // Now test PPTX export and what pageId gets extracted!
    console.log(`\nTesting PPTX export to inspect pageId extraction...`);
    const pptxResp = await drive.files.export({
      fileId: target.id,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    }, { responseType: "arraybuffer" });
    const zip = await jszip.loadAsync(pptxResp.data);
    for (const key of Object.keys(zip.files)) {
      if (key.includes("notesSlide")) {
        const content = await zip.files[key].async("text");
        const pageIdMatch = content.match(/name="Google Shape;\d+;([^":]+):notes"/);
        console.log(`Found notes slide ${key}: pageIdMatch =`, pageIdMatch ? pageIdMatch[1] : "NONE");
      }
    }
  } catch (err) {
    console.error("Slides API error:", err);
  }
}

run();
