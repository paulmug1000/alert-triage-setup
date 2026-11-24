import nodemailer from "nodemailer";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabaseClient.js";
import {
  getAllUsers,
  isUserAuthorizedForClient,
  canViewSalariesAndDividends,
  matchesClientName,
  DEFAULT_AC_SHEET_ID,
} from "./userPermissions.js";
import { logPulseActivity } from "./pulseLogger.js";
import { logPmaActivity } from "./pmaLogger.js";
import { escapeIlikeExact, sanitizeSpreadsheetTerms } from "../utils/helpers.js";
import {
  ALL_NOTE_ENTITY_TYPES,
  SCREEN_ENTITY_TYPES,
  isRestrictedNoteEntityType,
  getPortalViewForNote,
  getEntityTypeDisplayLabel,
  normalizeNoteSegment,
  normalizeAmountFingerprint,
  normalizeDateFingerprint,
  buildJobNoteKey,
} from "../utils/pulseNotesKeys.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NOTE_BODY_LEN = 4000;
const MAX_REPLY_BODY_LEN = 2500;
const MAX_LABEL_LEN = 300;

function isMissingTableError(err) {
  if (!err) return false;
  const code = String(err.code || "").toUpperCase();
  const msg = String(err.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (msg.includes("pulse_note") && (msg.includes("does not exist") || msg.includes("schema cache")))
  );
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatUkDateTime(iso) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

function sanitizeNoteText(val, maxLen = MAX_NOTE_BODY_LEN) {
  return String(val ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, maxLen);
}

function sanitizeContextMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  try {
    const serialized = JSON.stringify(meta);
    if (serialized.length > 24000) {
      return { truncated: true };
    }
    return JSON.parse(serialized);
  } catch {
    return {};
  }
}

function isStaffUser(user) {
  if (!user || user.isReadOnly) return false;
  return Boolean(user.isAdmin || user.role === "Admin" || user.role === "ClientManager");
}

function mapReplyRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    noteId: r.note_id,
    body: r.body || "",
    authorEmail: r.author_email || "",
    authorName: r.author_name || r.author_email || "",
    authorRole: r.author_role || "ClientUser",
    isStaffReply: Boolean(r.is_staff_reply),
    createdAt: r.created_at || "",
    updatedAt: r.updated_at || "",
  };
}

function mapNoteRow(r, replies = []) {
  if (!r) return null;
  return {
    id: r.id,
    clientId: r.client_id || null,
    jobId: r.job_id || null,
    clientName: r.client_name || "",
    scopeType: r.scope_type || "entity",
    entityType: r.entity_type || "job",
    entityKey: r.entity_key || "",
    parentEntityKey: r.parent_entity_key || "",
    entityLabel: r.entity_label || "",
    contextMeta: r.context_meta && typeof r.context_meta === "object" ? r.context_meta : {},
    visibilityScope: r.visibility_scope || "standard",
    body: r.body || "",
    notifyManager: Boolean(r.notify_manager),
    status: r.status || "note",
    authorEmail: r.author_email || "",
    authorName: r.author_name || r.author_email || "",
    authorRole: r.author_role || "ClientUser",
    notifiedEmails: Array.isArray(r.notified_emails) ? r.notified_emails : [],
    notifiedAt: r.notified_at || null,
    resolvedByEmail: r.resolved_by_email || "",
    resolvedByName: r.resolved_by_name || "",
    resolvedAt: r.resolved_at || null,
    clientUnreadReply: Boolean(r.client_unread_reply),
    createdAt: r.created_at || "",
    updatedAt: r.updated_at || "",
    replies: Array.isArray(replies) ? replies : [],
  };
}

function isEmbeddedRelationError(err) {
  if (!err) return false;
  const code = String(err.code || "").toUpperCase();
  const msg = String(err.message || "").toLowerCase();
  return code === "PGRST200" || msg.includes("relationship");
}

function mapNoteRowWithEmbeddedReplies(r) {
  if (!r) return null;
  const rawReplies = Array.isArray(r.pulse_note_replies) ? [...r.pulse_note_replies] : [];
  rawReplies.sort((a, b) => String(a?.created_at || "").localeCompare(String(b?.created_at || "")));
  return mapNoteRow(r, rawReplies.map(mapReplyRow).filter(Boolean));
}

function createEmailTransporter() {
  const emailUser = process.env.PMA_EMAIL_USER || "pulse@pulsedashboard.co.uk";
  const emailPass = process.env.PMA_EMAIL_APP_PASSWORD;
  const appUrl = process.env.APP_BASE_URL || "https://app.pulsedashboard.co.uk";
  if (!emailPass) {
    return { transporter: null, emailUser, appUrl };
  }
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: emailUser, pass: emailPass },
  });
  return { transporter, emailUser, appUrl };
}

async function resolveManagerRecipientsForClient(clientName) {
  let allUsers = [];
  try {
    allUsers = await getAllUsers(null, DEFAULT_AC_SHEET_ID, false);
  } catch (err) {
    console.warn("[pulseNotes] Failed to load users for manager lookup:", err?.message);
  }

  const activeManagers = (allUsers || []).filter((u) => {
    if (u.status !== "Active" || u.role !== "ClientManager" || !u.email || !u.email.includes("@")) {
      return false;
    }
    if (u.assignedClients === "*") return true;
    if (Array.isArray(u.assignedClients)) {
      return u.assignedClients.some((assigned) => matchesClientName(assigned, clientName));
    }
    return false;
  });

  // Fallback to active Admins if no ClientManager is assigned to this client
  const recipients = activeManagers.length > 0
    ? activeManagers
    : (allUsers || []).filter((u) => u.status === "Active" && Boolean(u.isAdmin) && u.email && u.email.includes("@"));

  const seen = new Set();
  const deduped = [];
  for (const r of recipients) {
    const email = String(r.email || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    deduped.push({ email: r.email.trim(), name: r.name || email.split("@")[0] });
  }
  return deduped;
}

function renderScenarioSummaryHtml(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.hasChanges) return "";
  const lines = [];
  if (Array.isArray(snapshot.confirmedPipelineJobs) && snapshot.confirmedPipelineJobs.length > 0) {
    lines.push(
      `<li><strong>Pipeline treated as confirmed:</strong> ${escapeHtml(snapshot.confirmedPipelineJobs.join(", "))}</li>`
    );
  }
  if (Array.isArray(snapshot.excludedPipelineJobs) && snapshot.excludedPipelineJobs.length > 0) {
    lines.push(
      `<li><strong>Pipeline excluded:</strong> ${escapeHtml(snapshot.excludedPipelineJobs.join(", "))}</li>`
    );
  }
  if (Array.isArray(snapshot.disabledNBMonths) && snapshot.disabledNBMonths.length > 0) {
    lines.push(
      `<li><strong>New business to find excluded:</strong> ${escapeHtml(snapshot.disabledNBMonths.join(", "))}</li>`
    );
  }
  if (Array.isArray(snapshot.adjustments) && snapshot.adjustments.length > 0) {
    const adjSummary = snapshot.adjustments
      .slice(0, 12)
      .map((a) => `${a.category} (${a.month}): ${a.currencySymbol || "£"}${Number(a.amount).toLocaleString("en-GB")}`)
      .join("; ");
    const more = snapshot.adjustments.length > 12 ? ` (+${snapshot.adjustments.length - 12} more)` : "";
    lines.push(`<li><strong>Scenario adjustments:</strong> ${escapeHtml(adjSummary + more)}</li>`);
  }
  if (lines.length === 0) return "";
  return `
    <div style="margin-top:16px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#334155;">
      <div style="font-weight:700;color:#0f172a;margin-bottom:6px;">Scenario snapshot (${escapeHtml(snapshot.fyLabel || "Current year")})</div>
      <ul style="margin:0;padding-left:18px;line-height:1.5;">${lines.join("")}</ul>
    </div>
  `;
}

async function sendManagerNoteNotificationEmail({
  note,
  recipients,
  replyBody = "",
  replyAuthorName = "",
  isFollowUpReply = false,
}) {
  if (!recipients || recipients.length === 0) return;
  const { transporter, emailUser, appUrl } = createEmailTransporter();
  const clientName = note.clientName || "Client";
  const typeLabel = getEntityTypeDisplayLabel(note.entityType);
  const targetLabel = sanitizeSpreadsheetTerms(note.entityLabel || typeLabel);
  const cleanNoteBody = sanitizeSpreadsheetTerms(note.body || "");
  const cleanReplyBody = sanitizeSpreadsheetTerms(replyBody || "");
  const actorName = isFollowUpReply ? (replyAuthorName || note.authorName) : note.authorName;
  const pmaLink = `${appUrl}/pma?nav=notes&client=${encodeURIComponent(clientName)}&noteId=${encodeURIComponent(note.id)}`;

  const subject = isFollowUpReply
    ? `[Pulse] Client reply from ${clientName}: ${targetLabel}`
    : `[Pulse] Note from ${clientName}: ${targetLabel}`;

  const scenarioHtml = renderScenarioSummaryHtml(note.contextMeta?.scenarioSnapshot);

  const html = `
    <div style="font-family:'Kumbh Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:24px;color:#1e293b;">
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
        <div style="background:#0047AB;padding:20px 28px;color:#ffffff;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;opacity:0.85;margin-bottom:4px;">
            Pulse client note
          </div>
          <h1 style="margin:0;font-size:20px;font-weight:700;">
            ${isFollowUpReply ? "New reply from client" : "Client requested your attention"}
          </h1>
        </div>
        <div style="padding:26px 28px;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;">
            <div style="margin-bottom:4px;"><span style="color:#64748b;">Client:</span> <strong>${escapeHtml(clientName)}</strong></div>
            <div style="margin-bottom:4px;"><span style="color:#64748b;">Area:</span> <strong>${escapeHtml(typeLabel)}</strong> &mdash; ${escapeHtml(targetLabel)}</div>
            <div><span style="color:#64748b;">From:</span> <strong>${escapeHtml(actorName || "Client user")}</strong> &middot; ${escapeHtml(formatUkDateTime(new Date().toISOString()))}</div>
          </div>

          <div style="background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #f59e0b;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.55;color:#1e293b;white-space:pre-wrap;">${escapeHtml(isFollowUpReply ? cleanReplyBody : cleanNoteBody)}</div>

          ${isFollowUpReply && cleanNoteBody ? `<div style="margin-top:12px;font-size:12px;color:#64748b;"><strong>Original note:</strong> ${escapeHtml(cleanNoteBody.slice(0, 280))}${cleanNoteBody.length > 280 ? "..." : ""}</div>` : ""}

          ${scenarioHtml}

          <div style="text-align:center;margin-top:24px;">
            <a href="${pmaLink}" style="display:inline-block;background:#0047AB;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 24px;border-radius:8px;">
              View and reply in PMA &rarr;
            </a>
          </div>
        </div>
        <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center;">
          Pulse Management Area &middot; Client notes notification
        </div>
      </div>
    </div>
  `;

  const text = `${isFollowUpReply ? "Client reply" : "Client note"} for ${clientName}\nArea: ${typeLabel} — ${targetLabel}\nFrom: ${actorName}\n\n${isFollowUpReply ? cleanReplyBody : cleanNoteBody}\n\nView and reply in PMA: ${pmaLink}`;

  const toAddresses = recipients.map((r) => r.email).filter(Boolean);
  if (!transporter) {
    console.log(`[pulseNotes] Simulated manager email to ${toAddresses.join(", ")}: ${subject}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: `"Pulse" <${emailUser}>`,
      to: toAddresses.join(", "),
      subject,
      text,
      html,
    });
  } catch (err) {
    console.error("[pulseNotes] Failed sending manager email:", err?.message);
  }
}

async function sendClientReplyNotificationEmail({
  note,
  recipientEmail,
  recipientName,
  staffName,
  replyBody = "",
  isResolvedNotice = false,
}) {
  if (!recipientEmail || !recipientEmail.includes("@")) return;
  const { transporter, emailUser, appUrl } = createEmailTransporter();
  const clientName = note.clientName || "Client";
  const typeLabel = getEntityTypeDisplayLabel(note.entityType);
  const targetLabel = sanitizeSpreadsheetTerms(note.entityLabel || typeLabel);
  const cleanNoteBody = sanitizeSpreadsheetTerms(note.body || "");
  const cleanReplyBody = sanitizeSpreadsheetTerms(replyBody || "");
  const view = getPortalViewForNote(note);
  const pulseLink = `${appUrl}/pulse?client=${encodeURIComponent(clientName)}&view=${encodeURIComponent(view)}&noteId=${encodeURIComponent(note.id)}`;

  const subject = isResolvedNotice
    ? `[Pulse] Your note was marked as resolved (${clientName})`
    : `[Pulse] ${staffName || "Your client manager"} replied to your note (${clientName})`;

  const heading = isResolvedNotice
    ? "Your note has been marked as resolved"
    : "New reply on your note";

  const bodyBlock = isResolvedNotice
    ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-left:4px solid #16a34a;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.55;color:#14532d;"><strong>${escapeHtml(staffName || "Your client manager")}</strong> marked your note as resolved.</div>`
    : `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-left:4px solid #0047AB;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.55;color:#1e293b;white-space:pre-wrap;">${escapeHtml(cleanReplyBody)}</div>`;

  const html = `
    <div style="font-family:'Kumbh Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:24px;color:#1e293b;">
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
        <div style="background:#0047AB;padding:20px 28px;color:#ffffff;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;opacity:0.85;margin-bottom:4px;">
            Pulse update
          </div>
          <h1 style="margin:0;font-size:20px;font-weight:700;">${heading}</h1>
        </div>
        <div style="padding:26px 28px;">
          <p style="margin:0 0 14px 0;font-size:14px;color:#334155;">
            Hello ${escapeHtml(recipientName || "there")},
          </p>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;">
            <div style="margin-bottom:4px;"><span style="color:#64748b;">Company:</span> <strong>${escapeHtml(clientName)}</strong></div>
            <div style="margin-bottom:4px;"><span style="color:#64748b;">Item:</span> <strong>${escapeHtml(typeLabel)}</strong> &mdash; ${escapeHtml(targetLabel)}</div>
            <div><span style="color:#64748b;">Updated by:</span> <strong>${escapeHtml(staffName || "Client manager")}</strong></div>
          </div>

          ${bodyBlock}

          ${cleanNoteBody ? `<div style="margin-top:14px;font-size:12px;color:#64748b;"><strong>Your original note:</strong> ${escapeHtml(cleanNoteBody.slice(0, 280))}${cleanNoteBody.length > 280 ? "..." : ""}</div>` : ""}

          <div style="text-align:center;margin-top:24px;">
            <a href="${pulseLink}" style="display:inline-block;background:#0047AB;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 24px;border-radius:8px;">
              Open in Pulse &rarr;
            </a>
          </div>
        </div>
        <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center;">
          Pulse &middot; Client notes update
        </div>
      </div>
    </div>
  `;

  const text = `${heading}\nCompany: ${clientName}\nItem: ${typeLabel} — ${targetLabel}\n\n${isResolvedNotice ? `Marked as resolved by ${staffName || "your client manager"}.` : cleanReplyBody}\n\nOpen in Pulse: ${pulseLink}`;

  if (!transporter) {
    console.log(`[pulseNotes] Simulated client reply email to ${recipientEmail}: ${subject}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: `"Pulse" <${emailUser}>`,
      to: recipientEmail,
      subject,
      text,
      html,
    });
  } catch (err) {
    console.error("[pulseNotes] Failed sending client reply email:", err?.message);
  }
}

async function resolveClientRecord(sb, clientName) {
  if (!sb || !clientName) return null;
  try {
    const { data } = await sb
      .from("clients")
      .select("id, client_name")
      .ilike("client_name", escapeIlikeExact(clientName))
      .limit(1);
    return data?.[0] || null;
  } catch {
    return null;
  }
}

function buildSummaryBucket() {
  return {
    count: 0,
    openNotifyCount: 0,
    unreadReplyCount: 0,
    hasNotified: false,
    latestSnippet: "",
    latestAuthor: "",
    latestAt: "",
  };
}

function addNoteToBucket(bucket, row) {
  bucket.count += 1;
  if (row.notify_manager && row.status === "open") {
    bucket.openNotifyCount += 1;
  }
  if (row.notify_manager) {
    bucket.hasNotified = true;
  }
  if (row.client_unread_reply) {
    bucket.unreadReplyCount += 1;
  }
  if (!bucket.latestAt || String(row.created_at || "") > bucket.latestAt) {
    bucket.latestAt = row.created_at || "";
    bucket.latestAuthor = row.author_name || row.author_email || "";
    const text = String(row.body || "").trim();
    bucket.latestSnippet = text.length > 90 ? `${text.slice(0, 87)}...` : text;
  }
}

export async function getClientNoteSummaries({ clientName, includeRestricted = true }) {
  const empty = {
    byEntityKey: {},
    byParentKey: {},
    jobChildNotesByParent: {},
    totalCount: 0,
    openNotifyCount: 0,
    unreadReplyCount: 0,
  };
  if (!isSupabaseConfigured() || !clientName) return empty;
  const sb = getSupabaseAdmin();
  if (!sb) return empty;

  let query = sb
    .from("pulse_notes")
    .select(
      "id, entity_type, entity_key, parent_entity_key, entity_label, context_meta, visibility_scope, body, notify_manager, status, author_name, author_email, client_unread_reply, created_at"
    )
    .ilike("client_name", escapeIlikeExact(clientName))
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (!includeRestricted) {
    query = query.eq("visibility_scope", "standard");
  }

  const { data: rows, error } = await query;
  if (error) {
    if (isMissingTableError(error)) {
      return { ...empty, migrationRequired: true };
    }
    throw error;
  }

  const byEntityKey = Object.create(null);
  const byParentKey = Object.create(null);
  const jobChildNotesByParent = Object.create(null);
  let totalCount = 0;
  let openNotifyCount = 0;
  let unreadReplyCount = 0;

  for (const r of rows || []) {
    totalCount += 1;
    if (r.notify_manager && r.status === "open") openNotifyCount += 1;
    if (r.client_unread_reply) unreadReplyCount += 1;

    const ek = String(r.entity_key || "");
    if (ek && ek !== "__proto__" && ek !== "constructor" && ek !== "prototype") {
      if (!byEntityKey[ek]) byEntityKey[ek] = buildSummaryBucket();
      addNoteToBucket(byEntityKey[ek], r);
    }

    const pk = String(r.parent_entity_key || "");
    if (pk && pk !== "__proto__" && pk !== "constructor" && pk !== "prototype") {
      if (!byParentKey[pk]) byParentKey[pk] = buildSummaryBucket();
      addNoteToBucket(byParentKey[pk], r);

      if (r.entity_type === "invoice" || r.entity_type === "job_expense") {
        if (!jobChildNotesByParent[pk]) jobChildNotesByParent[pk] = [];
        jobChildNotesByParent[pk].push({
          id: r.id,
          entityType: r.entity_type,
          entityKey: r.entity_key,
          parentEntityKey: r.parent_entity_key,
          entityLabel: r.entity_label || "",
          contextMeta: r.context_meta && typeof r.context_meta === "object" ? r.context_meta : {},
          status: r.status || "note",
          notifyManager: Boolean(r.notify_manager),
          clientUnreadReply: Boolean(r.client_unread_reply),
          body: String(r.body || "").slice(0, 120),
          createdAt: r.created_at || "",
        });
      }
    }
  }

  return {
    byEntityKey: { ...byEntityKey },
    byParentKey: { ...byParentKey },
    jobChildNotesByParent: { ...jobChildNotesByParent },
    totalCount,
    openNotifyCount,
    unreadReplyCount,
  };
}

async function attachRepliesToNotes(sb, noteRows) {
  if (!Array.isArray(noteRows) || noteRows.length === 0) return [];
  const ids = noteRows.map((r) => r.id).filter(Boolean);
  const { data: replyRows, error: replyErr } = await sb
    .from("pulse_note_replies")
    .select("*")
    .in("note_id", ids)
    .order("created_at", { ascending: true });

  if (replyErr) {
    console.warn("[pulseNotes] Reply fetch warning:", replyErr.message);
    return noteRows.map((r) => mapNoteRow(r, []));
  }

  const repliesByNote = new Map();
  for (const rr of replyRows || []) {
    if (!repliesByNote.has(rr.note_id)) repliesByNote.set(rr.note_id, []);
    repliesByNote.get(rr.note_id).push(mapReplyRow(rr));
  }

  return noteRows.map((r) => mapNoteRow(r, repliesByNote.get(r.id) || []));
}

export async function listClientNotes({
  clientName,
  entityKey = "",
  entityKeys = null,
  parentEntityKey = "",
  includeChildren = false,
  entityType = "",
  noteId = "",
  filter = "all",
  includeRestricted = true,
  limit = 150,
}) {
  if (!isSupabaseConfigured() || !clientName) {
    return { notes: [] };
  }
  const sb = getSupabaseAdmin();
  if (!sb) return { notes: [] };

  const selectWithReplies = "*, pulse_note_replies(*)";
  const applyBaseFilters = (q) => {
    let next = q
      .ilike("client_name", escapeIlikeExact(clientName))
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (!includeRestricted) {
      next = next.eq("visibility_scope", "standard");
    }
    return next;
  };

  if (!noteId && !(Array.isArray(entityKeys) && entityKeys.length > 0) && includeChildren && parentEntityKey) {
    // Fetch direct parent entity notes AND child notes under parentEntityKey in parallel (with embedded replies)
    const cleanKey = String(parentEntityKey).trim();
    const runChildPair = (selectCols) =>
      Promise.all([
        applyBaseFilters(sb.from("pulse_notes").select(selectCols)).eq("entity_key", cleanKey).limit(100),
        applyBaseFilters(sb.from("pulse_notes").select(selectCols)).eq("parent_entity_key", cleanKey).limit(150),
      ]);

    let [{ data: directRows, error: e1 }, { data: childRows, error: e2 }] = await runChildPair(selectWithReplies);
    let usedFallback = false;
    if ((e1 && isEmbeddedRelationError(e1)) || (e2 && isEmbeddedRelationError(e2))) {
      usedFallback = true;
      [{ data: directRows, error: e1 }, { data: childRows, error: e2 }] = await runChildPair("*");
    }

    if (e1) {
      if (isMissingTableError(e1)) return { notes: [], migrationRequired: true };
      throw e1;
    }
    if (e2) {
      if (isMissingTableError(e2)) return { notes: [], migrationRequired: true };
      throw e2;
    }

    const seen = new Set();
    const merged = [];
    for (const r of [...(directRows || []), ...(childRows || [])]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push(r);
      }
    }
    merged.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const notes = usedFallback
      ? await attachRepliesToNotes(sb, merged)
      : merged.map(mapNoteRowWithEmbeddedReplies);
    return { notes };
  }

  const buildStandardQuery = (selectCols) => {
    let q = applyBaseFilters(sb.from("pulse_notes").select(selectCols)).limit(
      Math.min(Math.max(Number(limit) || 100, 1), 300)
    );

    if (noteId) {
      q = q.eq("id", String(noteId).trim());
    } else if (Array.isArray(entityKeys) && entityKeys.length > 0) {
      q = q.in("entity_key", entityKeys.slice(0, 40));
    } else if (entityKey) {
      q = q.eq("entity_key", String(entityKey).trim());
    } else if (parentEntityKey) {
      q = q.eq("parent_entity_key", String(parentEntityKey).trim());
    }

    if (entityType && ALL_NOTE_ENTITY_TYPES.has(entityType)) {
      q = q.eq("entity_type", entityType);
    }

    if (filter === "notified") {
      q = q.eq("notify_manager", true);
    } else if (filter === "open") {
      q = q.eq("notify_manager", true).eq("status", "open");
    } else if (filter === "unread") {
      q = q.eq("client_unread_reply", true);
    } else if (filter === "resolved") {
      q = q.eq("status", "resolved");
    }

    return q;
  };

  let usedFallback = false;
  let { data: rows, error } = await buildStandardQuery(selectWithReplies);
  if (error && isEmbeddedRelationError(error)) {
    usedFallback = true;
    ({ data: rows, error } = await buildStandardQuery("*"));
  }
  if (error) {
    if (isMissingTableError(error)) {
      return { notes: [], migrationRequired: true };
    }
    throw error;
  }

  const notes = usedFallback
    ? await attachRepliesToNotes(sb, rows || [])
    : (rows || []).map(mapNoteRowWithEmbeddedReplies);
  return { notes };
}

export async function listPmaNotes({
  sessionUser,
  clientName = "",
  statusFilter = "open",
  search = "",
  noteId = "",
  limit = 200,
}) {
  if (!isSupabaseConfigured()) {
    return {
      notes: [],
      counts: { open: 0, replied: 0, resolved: 0, all: 0 },
    };
  }
  const sb = getSupabaseAdmin();
  if (!sb) {
    return {
      notes: [],
      counts: { open: 0, replied: 0, resolved: 0, all: 0 },
    };
  }

  const allowSalaries = canViewSalariesAndDividends(sessionUser);

  const buildPmaQuery = (selectCols) => {
    let q = sb
      .from("pulse_notes")
      .select(selectCols)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 200, 1), 500));

    if (clientName) {
      q = q.ilike("client_name", escapeIlikeExact(clientName));
    }
    if (!allowSalaries) {
      q = q.eq("visibility_scope", "standard");
    }
    return q;
  };

  let usedFallback = false;
  let { data: rawRows, error } = await buildPmaQuery("*, pulse_note_replies(*)");
  if (error && isEmbeddedRelationError(error)) {
    usedFallback = true;
    ({ data: rawRows, error } = await buildPmaQuery("*"));
  }
  if (error) {
    if (isMissingTableError(error)) {
      return {
        notes: [],
        counts: { open: 0, replied: 0, resolved: 0, all: 0 },
        migrationRequired: true,
      };
    }
    throw error;
  }

  // Enforce strict user-to-client authorization
  const authorizedRows = (rawRows || []).filter((r) =>
    isUserAuthorizedForClient(sessionUser, r.client_name)
  );

  const counts = { open: 0, replied: 0, resolved: 0, notified: 0, all: authorizedRows.length };
  for (const r of authorizedRows) {
    if (r.notify_manager) counts.notified += 1;
    if (r.notify_manager && r.status === "open") counts.open += 1;
    else if (r.status === "replied") counts.replied += 1;
    else if (r.status === "resolved") counts.resolved += 1;
  }

  let filtered = authorizedRows;
  if (noteId) {
    filtered = authorizedRows.filter((r) => r.id === noteId);
  } else if (statusFilter === "open") {
    filtered = authorizedRows.filter((r) => r.notify_manager && r.status === "open");
  } else if (statusFilter === "replied") {
    filtered = authorizedRows.filter((r) => r.status === "replied");
  } else if (statusFilter === "resolved") {
    filtered = authorizedRows.filter((r) => r.status === "resolved");
  } else if (statusFilter === "notified") {
    filtered = authorizedRows.filter((r) => r.notify_manager);
  }

  const q = String(search || "").trim().toLowerCase();
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = `${r.client_name || ""} ${r.entity_label || ""} ${r.entity_type || ""} ${r.body || ""} ${r.author_name || ""} ${r.author_email || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const notes = usedFallback
    ? await attachRepliesToNotes(sb, filtered)
    : filtered.map(mapNoteRowWithEmbeddedReplies);
  return { notes, counts };
}

export async function getPmaOpenNotesCount({ sessionUser, clientName = "" }) {
  if (!isSupabaseConfigured()) return 0;
  const sb = getSupabaseAdmin();
  if (!sb) return 0;

  const allowSalaries = canViewSalariesAndDividends(sessionUser);
  let query = sb
    .from("pulse_notes")
    .select("id, client_name, visibility_scope")
    .is("deleted_at", null)
    .eq("notify_manager", true)
    .eq("status", "open")
    .limit(1000);

  if (clientName) {
    query = query.ilike("client_name", escapeIlikeExact(clientName));
  }
  if (!allowSalaries) {
    query = query.eq("visibility_scope", "standard");
  }

  const { data: rows, error } = await query;
  if (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }

  return (rows || []).filter((r) => isUserAuthorizedForClient(sessionUser, r.client_name)).length;
}

export async function createPulseNote({
  sessionUser,
  clientName,
  scopeType,
  entityType,
  entityKey,
  parentEntityKey = "",
  entityLabel = "",
  contextMeta = {},
  body,
  notifyManager = false,
  scheduleBg = null,
}) {
  if (!isSupabaseConfigured()) {
    throw new Error("Database storage is not configured.");
  }
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Database client unavailable.");

  const cleanType = String(entityType || "").trim().toLowerCase();
  if (!ALL_NOTE_ENTITY_TYPES.has(cleanType)) {
    throw new Error("Invalid note target type.");
  }

  const resolvedScopeType =
    scopeType === "screen" || SCREEN_ENTITY_TYPES.has(cleanType) ? "screen" : "entity";
  const cleanKey = String(entityKey || "").trim().slice(0, 300);
  if (!cleanKey) {
    throw new Error("Missing target identifier.");
  }

  const cleanBody = sanitizeNoteText(body, MAX_NOTE_BODY_LEN);
  if (!cleanBody) {
    throw new Error("Please enter a note before saving.");
  }

  const visibilityScope = isRestrictedNoteEntityType(cleanType)
    ? "restricted_salary"
    : "standard";
  if (visibilityScope === "restricted_salary" && !canViewSalariesAndDividends(sessionUser)) {
    const err = new Error("Access denied to restricted payroll/dividend notes.");
    err.statusCode = 403;
    throw err;
  }

  const cleanClientName = String(clientName || "").trim();
  const clientRow = await resolveClientRecord(sb, cleanClientName);
  const canonicalClientName = clientRow?.client_name || cleanClientName;

  const shouldNotify = Boolean(notifyManager);
  let recipients = [];
  if (shouldNotify) {
    recipients = await resolveManagerRecipientsForClient(canonicalClientName);
  }

  const nowIso = new Date().toISOString();
  const cleanLabel = sanitizeSpreadsheetTerms(String(entityLabel || "").trim()).slice(0, MAX_LABEL_LEN);
  const cleanParentKey = String(parentEntityKey || "").trim().slice(0, 300);

  let resolvedJobId = null;
  if (clientRow?.id && (cleanType === "job" || cleanParentKey.startsWith("job:"))) {
    try {
      const candidateUuid = String(contextMeta?.jobUuid || "").trim();
      if (UUID_REGEX.test(candidateUuid)) {
        const { data: verifiedJob } = await sb
          .from("pulse_jobs")
          .select("id")
          .eq("client_id", clientRow.id)
          .eq("id", candidateUuid)
          .maybeSingle();
        if (verifiedJob?.id) resolvedJobId = verifiedJob.id;
      }
      if (!resolvedJobId) {
        const targetJobKey = cleanType === "job" ? cleanKey : cleanParentKey;
        const { data: jobCandidates } = await sb
          .from("pulse_jobs")
          .select("id, tab_type, sheet_row_num, customer_name, job_name, project_code")
          .eq("client_id", clientRow.id)
          .limit(2000);
        const ordered = [...(jobCandidates || [])].sort((a, b) =>
          a.tab_type === b.tab_type ? (a.sheet_row_num || 0) - (b.sheet_row_num || 0) : a.tab_type === "confirmed" ? -1 : 1
        );
        for (const jc of ordered) {
          const k1 = buildJobNoteKey({
            client: jc.customer_name,
            jobName: jc.job_name,
            projectCode: jc.project_code,
            rowNumber: jc.sheet_row_num,
          });
          const k2 = !jc.project_code && jc.customer_name && jc.job_name
            ? buildJobNoteKey({ client: jc.customer_name, jobName: jc.job_name })
            : "";
          if (k1 === targetJobKey || (k2 && k2 === targetJobKey)) {
            resolvedJobId = jc.id;
            break;
          }
        }
      }
    } catch (_) { }
  }

  const insertRow = {
    client_id: clientRow?.id || null,
    client_name: canonicalClientName,
    ...(resolvedJobId ? { job_id: resolvedJobId } : {}),
    scope_type: resolvedScopeType,
    entity_type: cleanType,
    entity_key: cleanKey,
    parent_entity_key: cleanParentKey,
    entity_label: cleanLabel || getEntityTypeDisplayLabel(cleanType),
    context_meta: sanitizeContextMeta(contextMeta),
    visibility_scope: visibilityScope,
    body: cleanBody,
    notify_manager: shouldNotify,
    status: shouldNotify ? "open" : "note",
    author_email: String(sessionUser.email || "").trim().toLowerCase(),
    author_name: String(sessionUser.name || sessionUser.email || "").trim(),
    author_role: String(sessionUser.role || "ClientUser"),
    notified_emails: recipients.map((r) => r.email),
    notified_at: shouldNotify ? nowIso : null,
    client_unread_reply: false,
  };

  let { data: created, error } = await sb
    .from("pulse_notes")
    .insert(insertRow)
    .select("*")
    .single();
  if (error && resolvedJobId && String(error.message || "").includes("job_id")) {
    delete insertRow.job_id;
    ({ data: created, error } = await sb.from("pulse_notes").insert(insertRow).select("*").single());
  }

  if (error) {
    if (isMissingTableError(error)) {
      const migErr = new Error("Notes storage table has not been migrated yet (0011_pulse_client_notes.sql).");
      migErr.statusCode = 503;
      throw migErr;
    }
    throw error;
  }

  const mappedNote = mapNoteRow(created, []);

  // Activity logging (redacted if restricted)
  const staffActor = isStaffUser(sessionUser);
  const activitySummary =
    visibilityScope === "restricted_salary"
      ? `${shouldNotify ? "Notified manager with a note" : "Added a note"} on restricted item`
      : `${shouldNotify ? "Notified manager with a note" : "Added a note"} on ${mappedNote.entityLabel}`;

  const logTask = (staffActor ? logPmaActivity : logPulseActivity)(null, {
    clientName: canonicalClientName,
    category: "NOTES",
    action: shouldNotify ? "NOTE_AND_NOTIFY" : "NOTE_ADDED",
    summary: activitySummary,
    details: {
      noteId: mappedNote.id,
      entityType: mappedNote.entityType,
      visibilityScope,
      notifyManager: shouldNotify,
    },
    user: mappedNote.authorName || mappedNote.authorEmail,
  }).catch(() => {});

  const emailTask = shouldNotify
    ? sendManagerNoteNotificationEmail({ note: mappedNote, recipients })
    : Promise.resolve();

  const bgPromise = Promise.all([logTask, emailTask]);
  if (typeof scheduleBg === "function") {
    scheduleBg(bgPromise);
  } else {
    void bgPromise;
  }

  return {
    note: mappedNote,
    notifiedNames: recipients.map((r) => r.name || r.email),
  };
}

async function fetchAuthorizedNote(sb, sessionUser, noteId) {
  if (!noteId) {
    const err = new Error("noteId is required");
    err.statusCode = 400;
    throw err;
  }
  const { data: row, error } = await sb
    .from("pulse_notes")
    .select("*")
    .eq("id", String(noteId).trim())
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      const migErr = new Error("Notes storage table has not been migrated yet.");
      migErr.statusCode = 503;
      throw migErr;
    }
    throw error;
  }
  if (!row) {
    const err = new Error("Note not found.");
    err.statusCode = 404;
    throw err;
  }
  if (!isUserAuthorizedForClient(sessionUser, row.client_name)) {
    const err = new Error("Access denied to this client note.");
    err.statusCode = 403;
    throw err;
  }
  if (row.visibility_scope === "restricted_salary" && !canViewSalariesAndDividends(sessionUser)) {
    const err = new Error("Access denied to restricted note.");
    err.statusCode = 403;
    throw err;
  }
  return row;
}

export async function addPulseNoteReply({ sessionUser, noteId, body, scheduleBg = null }) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Database client unavailable.");

  const existing = await fetchAuthorizedNote(sb, sessionUser, noteId);
  const cleanBody = sanitizeNoteText(body, MAX_REPLY_BODY_LEN);
  if (!cleanBody) {
    throw new Error("Please enter a reply.");
  }

  const staffReply = isStaffUser(sessionUser);
  const actorEmail = String(sessionUser.email || "").trim().toLowerCase();
  const actorName = String(sessionUser.name || sessionUser.email || "").trim();

  const { data: replyRow, error: insErr } = await sb
    .from("pulse_note_replies")
    .insert({
      note_id: existing.id,
      body: cleanBody,
      author_email: actorEmail,
      author_name: actorName,
      author_role: String(sessionUser.role || "ClientUser"),
      is_staff_reply: staffReply,
    })
    .select("*")
    .single();

  if (insErr) throw insErr;

  const parentPatch = {};
  if (staffReply) {
    if (existing.notify_manager && existing.status === "open") {
      parentPatch.status = "replied";
    }
    if (existing.author_email && existing.author_email.toLowerCase() !== actorEmail) {
      parentPatch.client_unread_reply = true;
    }
  } else {
    if (existing.notify_manager) {
      parentPatch.status = "open";
    }
    parentPatch.client_unread_reply = false;
  }

  let updatedRow = existing;
  if (Object.keys(parentPatch).length > 0) {
    const { data: upd, error: updErr } = await sb
      .from("pulse_notes")
      .update(parentPatch)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (!updErr && upd) updatedRow = upd;
  }

  const mappedNote = mapNoteRow(updatedRow, []);
  const mappedReply = mapReplyRow(replyRow);

  const tasks = [];
  if (staffReply && existing.author_email && existing.author_email.toLowerCase() !== actorEmail) {
    tasks.push(
      sendClientReplyNotificationEmail({
        note: mappedNote,
        recipientEmail: existing.author_email,
        recipientName: existing.author_name,
        staffName: actorName,
        replyBody: cleanBody,
        isResolvedNotice: false,
      })
    );
  } else if (!staffReply && existing.notify_manager) {
    tasks.push(
      resolveManagerRecipientsForClient(existing.client_name).then((recipients) =>
        sendManagerNoteNotificationEmail({
          note: mappedNote,
          recipients,
          replyBody: cleanBody,
          replyAuthorName: actorName,
          isFollowUpReply: true,
        })
      )
    );
  }

  const loggerFn = staffReply ? logPmaActivity : logPulseActivity;
  tasks.push(
    loggerFn(null, {
      clientName: existing.client_name,
      category: "NOTES",
      action: "NOTE_REPLY",
      summary:
        existing.visibility_scope === "restricted_salary"
          ? "Replied to restricted note"
          : `Replied to note on ${mappedNote.entityLabel}`,
      details: { noteId: existing.id, isStaffReply: staffReply },
      user: actorName || actorEmail,
    }).catch(() => {})
  );

  const bgPromise = Promise.all(tasks);
  if (typeof scheduleBg === "function") {
    scheduleBg(bgPromise);
  } else {
    void bgPromise;
  }

  return { reply: mappedReply, note: mappedNote };
}

export async function setPulseNoteStatus({ sessionUser, noteId, status, scheduleBg = null }) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Database client unavailable.");

  const targetStatus = status === "resolved" ? "resolved" : "open";
  const existing = await fetchAuthorizedNote(sb, sessionUser, noteId);
  const staffActor = isStaffUser(sessionUser);
  const actorEmail = String(sessionUser.email || "").trim().toLowerCase();
  const actorName = String(sessionUser.name || sessionUser.email || "").trim();

  const patch =
    targetStatus === "resolved"
      ? {
          status: "resolved",
          resolved_by_email: actorEmail,
          resolved_by_name: actorName,
          resolved_at: new Date().toISOString(),
          ...(staffActor && existing.author_email && existing.author_email.toLowerCase() !== actorEmail
            ? { client_unread_reply: true }
            : {}),
        }
      : {
          status: existing.notify_manager ? "open" : "note",
          resolved_by_email: "",
          resolved_by_name: "",
          resolved_at: null,
        };

  const { data: updated, error } = await sb
    .from("pulse_notes")
    .update(patch)
    .eq("id", existing.id)
    .select("*")
    .single();

  if (error) throw error;
  const mappedNote = mapNoteRow(updated, []);

  const tasks = [];
  if (
    targetStatus === "resolved" &&
    staffActor &&
    existing.notify_manager &&
    existing.author_email &&
    existing.author_email.toLowerCase() !== actorEmail
  ) {
    tasks.push(
      sendClientReplyNotificationEmail({
        note: mappedNote,
        recipientEmail: existing.author_email,
        recipientName: existing.author_name,
        staffName: actorName,
        isResolvedNotice: true,
      })
    );
  }

  const loggerFn = staffActor ? logPmaActivity : logPulseActivity;
  tasks.push(
    loggerFn(null, {
      clientName: existing.client_name,
      category: "NOTES",
      action: targetStatus === "resolved" ? "NOTE_RESOLVED" : "NOTE_REOPENED",
      summary:
        existing.visibility_scope === "restricted_salary"
          ? `${targetStatus === "resolved" ? "Resolved" : "Reopened"} restricted note`
          : `${targetStatus === "resolved" ? "Resolved" : "Reopened"} note on ${mappedNote.entityLabel}`,
      details: { noteId: existing.id },
      user: actorName || actorEmail,
    }).catch(() => {})
  );

  const bgPromise = Promise.all(tasks);
  if (typeof scheduleBg === "function") scheduleBg(bgPromise);
  else void bgPromise;

  return { note: mappedNote };
}

export async function editPulseNote({ sessionUser, noteId, body }) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Database client unavailable.");

  const existing = await fetchAuthorizedNote(sb, sessionUser, noteId);
  const actorEmail = String(sessionUser.email || "").trim().toLowerCase();
  const isOwner = Boolean(actorEmail && existing.author_email?.toLowerCase() === actorEmail);
  if (!isOwner && !isStaffUser(sessionUser)) {
    const err = new Error("You can only edit your own notes.");
    err.statusCode = 403;
    throw err;
  }

  const cleanBody = sanitizeNoteText(body, MAX_NOTE_BODY_LEN);
  if (!cleanBody) throw new Error("Note cannot be empty.");

  let usedFallback = false;
  let { data: updated, error } = await sb
    .from("pulse_notes")
    .update({ body: cleanBody })
    .eq("id", existing.id)
    .select("*, pulse_note_replies(*)")
    .single();
  if (error && isEmbeddedRelationError(error)) {
    usedFallback = true;
    ({ data: updated, error } = await sb
      .from("pulse_notes")
      .update({ body: cleanBody })
      .eq("id", existing.id)
      .select("*")
      .single());
  }
  if (error) throw error;

  const notes = usedFallback
    ? await attachRepliesToNotes(sb, [updated])
    : [mapNoteRowWithEmbeddedReplies(updated)];
  return { note: notes[0] };
}

export async function deletePulseNote({ sessionUser, noteId }) {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error("Database client unavailable.");

  const existing = await fetchAuthorizedNote(sb, sessionUser, noteId);
  const actorEmail = String(sessionUser.email || "").trim().toLowerCase();
  const isOwner = Boolean(actorEmail && existing.author_email?.toLowerCase() === actorEmail);
  if (!isOwner && !isStaffUser(sessionUser)) {
    const err = new Error("You can only delete your own notes.");
    err.statusCode = 403;
    throw err;
  }

  const { error } = await sb
    .from("pulse_notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", existing.id);
  if (error) throw error;

  return { deletedId: existing.id };
}

export async function markNoteRepliesRead({ sessionUser, clientName, noteIds = [] }) {
  if (!isSupabaseConfigured() || !clientName || !Array.isArray(noteIds) || noteIds.length === 0) {
    return { updated: 0 };
  }
  // Only clear client_unread_reply for non-staff client viewers (so staff viewing in Portal don't dismiss the client's unread indicator)
  if (isStaffUser(sessionUser)) {
    return { updated: 0 };
  }
  const sb = getSupabaseAdmin();
  if (!sb) return { updated: 0 };

  const cleanIds = noteIds.map((id) => String(id || "").trim()).filter(Boolean).slice(0, 100);
  if (cleanIds.length === 0) return { updated: 0 };

  const { data, error } = await sb
    .from("pulse_notes")
    .update({ client_unread_reply: false })
    .ilike("client_name", escapeIlikeExact(clientName))
    .in("id", cleanIds)
    .eq("client_unread_reply", true)
    .select("id");

  if (error) {
    if (!isMissingTableError(error)) {
      console.warn("[pulseNotes] markNoteRepliesRead warning:", error.message);
    }
    return { updated: 0 };
  }
  return { updated: Array.isArray(data) ? data.length : 0 };
}

/**
 * Non-blocking relinker called after save-job / confirm-job / unconfirm-job.
 * 1) Migrates job & child note keys if projectCode or jobName changed.
 * 2) Upgrades slot-based manual invoice/expense notes when a ref/appId is later assigned,
 *    or refreshes their fingerprint & slotNum when reordered in Pulse.
 */
export async function relinkNotesForJobChange({
  clientName,
  oldJobKey = "",
  newJobKey = "",
  newJobLabel = "",
  invoices = [],
  directExpenses = [],
}) {
  if (!isSupabaseConfigured() || !clientName) return;
  const sb = getSupabaseAdmin();
  if (!sb) return;

  try {
    const activeJobKey = newJobKey || oldJobKey;
    if (!activeJobKey) return;

    // 1. Relink job notes & child parent_entity_key if job key changed
    if (oldJobKey && newJobKey && oldJobKey !== newJobKey) {
      await sb
        .from("pulse_notes")
        .update({
          entity_key: newJobKey,
          ...(newJobLabel ? { entity_label: String(newJobLabel).slice(0, MAX_LABEL_LEN) } : {}),
        })
        .ilike("client_name", escapeIlikeExact(clientName))
        .eq("entity_type", "job")
        .eq("entity_key", oldJobKey)
        .is("deleted_at", null);

      const { data: oldChildren } = await sb
        .from("pulse_notes")
        .select("id, entity_type, entity_key, context_meta")
        .ilike("client_name", escapeIlikeExact(clientName))
        .eq("parent_entity_key", oldJobKey)
        .is("deleted_at", null);

      for (const ch of oldChildren || []) {
        let nextKey = ch.entity_key;
        if (String(nextKey).startsWith(`invoice:job:${oldJobKey}:slot:`)) {
          nextKey = nextKey.replace(`invoice:job:${oldJobKey}:slot:`, `invoice:job:${newJobKey}:slot:`);
        } else if (String(nextKey).startsWith(`job_expense:job:${oldJobKey}:slot:`)) {
          nextKey = nextKey.replace(`job_expense:job:${oldJobKey}:slot:`, `job_expense:job:${newJobKey}:slot:`);
        }
        await sb
          .from("pulse_notes")
          .update({
            parent_entity_key: newJobKey,
            entity_key: nextKey,
          })
          .eq("id", ch.id);
      }
    }

    // 2. Re-sync slot & fingerprint metadata for child invoice / expense notes under activeJobKey
    const { data: children } = await sb
      .from("pulse_notes")
      .select("id, entity_type, entity_key, context_meta")
      .ilike("client_name", escapeIlikeExact(clientName))
      .eq("parent_entity_key", activeJobKey)
      .in("entity_type", ["invoice", "job_expense"])
      .is("deleted_at", null);

    if (!Array.isArray(children) || children.length === 0) return;

    for (const note of children) {
      const meta = note.context_meta && typeof note.context_meta === "object" ? { ...note.context_meta } : {};
      if (note.entity_type === "invoice" && Array.isArray(invoices) && invoices.length > 0) {
        const noteRef = normalizeNoteSegment(meta.ref || "");
        const nAmt = normalizeAmountFingerprint(meta.amount);
        const nDate = normalizeDateFingerprint(meta.sendDate);
        const nSlot = Number(meta.slotNum) || null;

        let matchIdx = -1;
        if (noteRef) {
          matchIdx = invoices.findIndex((inv) => normalizeNoteSegment(inv?.ref) === noteRef);
        }
        if (matchIdx === -1 && nAmt && nDate) {
          matchIdx = invoices.findIndex(
            (inv) =>
              normalizeAmountFingerprint(inv?.amount) === nAmt &&
              normalizeDateFingerprint(inv?.sendDate) === nDate
          );
        }
        if (matchIdx === -1 && nSlot && invoices[nSlot - 1]) {
          matchIdx = nSlot - 1;
        }
        if (matchIdx !== -1) {
          const inv = invoices[matchIdx];
          const nextSlot = matchIdx + 1;
          const newRef = normalizeNoteSegment(inv?.ref || "");
          const nextEntityKey = newRef
            ? `invoice:ref:${newRef}`
            : `invoice:job:${activeJobKey}:slot:${nextSlot}`;
          const nextMeta = {
            ...meta,
            slotNum: nextSlot,
            ref: String(inv?.ref || "").trim(),
            amount: normalizeAmountFingerprint(inv?.amount),
            sendDate: normalizeDateFingerprint(inv?.sendDate),
          };
          if (nextEntityKey !== note.entity_key || nextMeta.slotNum !== meta.slotNum || nextMeta.ref !== meta.ref) {
            await sb
              .from("pulse_notes")
              .update({ entity_key: nextEntityKey, context_meta: nextMeta })
              .eq("id", note.id);
          }
        }
      } else if (note.entity_type === "job_expense" && Array.isArray(directExpenses) && directExpenses.length > 0) {
        const noteAppId = normalizeNoteSegment(meta.appId || "");
        const nAmt = normalizeAmountFingerprint(meta.amount);
        const nDate = normalizeDateFingerprint(meta.recDate || meta.sendDate);
        const nDesc = normalizeNoteSegment(meta.desc || "");
        const nSlot = Number(meta.slotNum) || null;

        let matchIdx = -1;
        if (noteAppId) {
          matchIdx = directExpenses.findIndex((exp) => normalizeNoteSegment(exp?.appId) === noteAppId);
        }
        if (matchIdx === -1 && nDesc && nAmt) {
          matchIdx = directExpenses.findIndex(
            (exp) =>
              normalizeNoteSegment(exp?.desc || exp?.description) === nDesc &&
              normalizeAmountFingerprint(exp?.amount) === nAmt
          );
        }
        if (matchIdx === -1 && nAmt && nDate) {
          matchIdx = directExpenses.findIndex(
            (exp) =>
              normalizeAmountFingerprint(exp?.amount) === nAmt &&
              normalizeDateFingerprint(exp?.recDate || exp?.sendDate) === nDate
          );
        }
        if (matchIdx === -1 && nSlot && directExpenses[nSlot - 1]) {
          matchIdx = nSlot - 1;
        }
        if (matchIdx !== -1) {
          const exp = directExpenses[matchIdx];
          const nextSlot = matchIdx + 1;
          const newAppId = normalizeNoteSegment(exp?.appId || "");
          const nextEntityKey = newAppId
            ? `job_expense:id:${newAppId}`
            : `job_expense:job:${activeJobKey}:slot:${nextSlot}`;
          const nextMeta = {
            ...meta,
            slotNum: nextSlot,
            appId: String(exp?.appId || "").trim(),
            desc: String(exp?.desc || exp?.description || "").trim(),
            amount: normalizeAmountFingerprint(exp?.amount),
            recDate: normalizeDateFingerprint(exp?.recDate || exp?.sendDate),
          };
          if (nextEntityKey !== note.entity_key || nextMeta.slotNum !== meta.slotNum || nextMeta.appId !== meta.appId) {
            await sb
              .from("pulse_notes")
              .update({ entity_key: nextEntityKey, context_meta: nextMeta })
              .eq("id", note.id);
          }
        }
      }
    }
  } catch (err) {
    if (!isMissingTableError(err)) {
      console.warn("[pulseNotes] relinkNotesForJobChange warning:", err?.message);
    }
  }
}

export async function getOpenClientNotesForDigest() {
  if (!isSupabaseConfigured()) return [];
  const sb = getSupabaseAdmin();
  if (!sb) return [];

  try {
    const { data, error } = await sb
      .from("pulse_notes")
      .select("id, client_name, entity_type, entity_label, visibility_scope, body, author_name, created_at")
      .is("deleted_at", null)
      .eq("notify_manager", true)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      if (!isMissingTableError(error)) {
        console.warn("[pulseNotes] Digest fetch warning:", error.message);
      }
      return [];
    }
    return data || [];
  } catch {
    return [];
  }
}
