// pages/api/blob-upload-token.js
//
// Issues short-lived tokens that let the browser upload a payroll document
// straight to Vercel Blob storage, bypassing the 4.5MB request body limit
// on /api/triage entirely (see conversation 18 Aug 2026 — a hung "Processing"
// stage with zero backend logs was a request being rejected before the
// function ever ran, not a bug in the extraction code itself).
//
// This is a Pages Router file, matching the rest of this project — but
// @vercel/blob's handleUpload() is documented against the App Router's
// Request/NextResponse objects, not Node's req/res. The synthetic Request
// below bridges that gap. This is the one part of this file I haven't been
// able to verify with full certainty (every official example uses App
// Router) — if the upload step fails specifically at the token-generation
// call, this bridging is the first thing to check.
import { handleUpload } from "@vercel/blob/client";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Next.js's default Pages Router bodyParser has already parsed this —
    // no need to call .json() ourselves the way the App Router examples do.
    const body = req.body;

    // handleUpload also reads from `request` directly (e.g. headers) for
    // parts of its own flow — reconstruct a minimal but compatible Request
    // object from the Node req, since Pages Router doesn't give us one.
    const request = new Request(`https://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
    });

    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        // Matches the file types the Tools screen already accepts.
        allowedContentTypes: [
          "application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif",
          "text/csv", "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/json", // the converted {data, type} payload is uploaded as JSON
        ],
        addRandomSuffix: true,
        maximumSizeInBytes: 50 * 1024 * 1024, // generous — comfortably covers a large merged multi-page payroll image
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log(`  📎 Payroll document uploaded to blob: ${blob.url}`);
      },
    });

    return res.status(200).json(jsonResponse);
  } catch (error) {
    console.error("❌ blob-upload-token error:", error);
    return res.status(400).json({ error: error.message });
  }
}