// app/api/blob-upload-token/route.js
//
// Replaces the earlier pages/api/blob-upload-token.js. That version bridged
// Node's req/res into a Request-shaped object for handleUpload() — every
// official Vercel example uses the App Router's native Request/NextResponse
// instead, and I flagged that bridging as the one unverified part of the
// original implementation. A hang at exactly the "Uploading" step (never an
// error, never resolving) is consistent with that bridge being the problem.
// This version needs no bridging at all — request IS already the right
// shape — which removes that whole class of uncertainty rather than trying
// to patch it further. See conversation 18 Aug 2026.
//
// DEPLOYMENT NOTE: delete pages/api/blob-upload-token.js — Next.js won't
// allow the same route to exist in both pages/ and app/ at once.
import { handleUpload } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export async function POST(request) {
  const body = await request.json();

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        console.log("  📎 blob-upload-token: issuing client token");
        return {
          allowedContentTypes: [
            "application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif",
            "text/csv", "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/json", // the converted {data, type} payload is uploaded as JSON
          ],
          addRandomSuffix: true,
          maximumSizeInBytes: 50 * 1024 * 1024, // generous — comfortably covers a large merged multi-page payroll image
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log(`  📎 Payroll document uploaded to blob: ${blob.url}`);
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    console.error("❌ blob-upload-token error:", error);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}