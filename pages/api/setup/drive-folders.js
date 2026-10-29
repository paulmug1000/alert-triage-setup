/**
 * ============================================================================
 * SETUP DRIVE FOLDERS API: /api/setup/drive-folders
 * ============================================================================
 *
 * GET: Lists Google Drive folders inside the primary Clients folder (or a
 * specified parent folder) so administrators can pick an existing client folder
 * when onboarding a client.
 */

import { getSessionUser } from "../../../services/authService.js";
import { getDriveClient, withRetry } from "../../../services/sheetsClient.js";
import { DEFAULT_CLIENTS_FOLDER_ID } from "../../../services/setupService.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const sessionUser = getSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  if (sessionUser.isReadOnly || (!sessionUser.isAdmin && sessionUser.role !== "Admin")) {
    return res.status(403).json({ success: false, error: "Only administrators can browse client Drive folders." });
  }

  const rawParentId = String(req.query.parentId || DEFAULT_CLIENTS_FOLDER_ID).trim();
  const parentId = rawParentId.replace(/[^a-zA-Z0-9_-]/g, "") || DEFAULT_CLIENTS_FOLDER_ID;
  const search = String(req.query.search || "").trim().toLowerCase();

  try {
    const drive = await getDriveClient();

    let currentFolder = {
      id: parentId,
      name: parentId === DEFAULT_CLIENTS_FOLDER_ID ? "Clients" : "Folder",
      webViewLink: `https://drive.google.com/drive/folders/${parentId}`
    };

    try {
      const folderMeta = await withRetry(() =>
        drive.files.get({
          fileId: parentId,
          fields: "id, name, webViewLink, parents",
          supportsAllDrives: true
        })
      );
      if (folderMeta?.data) {
        currentFolder = {
          id: folderMeta.data.id,
          name: folderMeta.data.name || currentFolder.name,
          webViewLink: folderMeta.data.webViewLink || currentFolder.webViewLink,
          parents: folderMeta.data.parents || []
        };
      }
    } catch (metaErr) {
      console.warn("Could not read parent folder metadata:", metaErr.message);
    }

    const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const listRes = await withRetry(() =>
      drive.files.list({
        q,
        fields: "files(id, name, webViewLink, modifiedTime)",
        orderBy: "name",
        pageSize: 250,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      })
    );

    let folders = (listRes.data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      webViewLink: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`,
      modifiedTime: f.modifiedTime || ""
    }));

    if (search) {
      folders = folders.filter((f) => f.name.toLowerCase().includes(search));
    }

    return res.status(200).json({
      success: true,
      rootFolderId: DEFAULT_CLIENTS_FOLDER_ID,
      currentFolder,
      folders
    });
  } catch (err) {
    console.error("GET /api/setup/drive-folders error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
