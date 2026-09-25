/**
 * ACTIVITY SERVICE
 * 
 * Aggregates, parses, synthesizes plain-English timelines, and caches
 * activity from:
 * 1) Master Sheet `AutoLog` (automated syncs: Invoices, CRM, Expenses, Integrations)
 * 2) Client Sheet `AppLog` (user actions: Job creation/edits, Salaries, Outgoings, Logins & Page Views)
 * 
 * Strict Quota Defense:
 * - Reads only bounded ranges (AutoLog!A2:D40, AppLog!A2:E50)
 * - 100% of Sheets API calls wrapped in withRetry with exponential backoff
 * - Redis caching (30-minute TTL)
 * - Paced batch processing across clients
 */

import { withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { redisClient } from "./redisClient.js";

const REDIS_ACTIVITY_PREFIX = "pulse:activity:";
const CACHE_TTL_SECONDS = 7 * 24 * 3600; // 7 days permanent cache

/**
 * Robust date parser for both AutoLog (dd-MMM-yy HH:mm) and AppLog (YYYY-MM-DD HH:MM:SS / ISO)
 */
export function parseLogDate(rawStr) {
  if (!rawStr) return null;
  const str = String(rawStr).trim();

  // Format 1: dd-MMM-yy HH:mm (e.g., "24-Sep-26 12:21")
  const m1 = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\s+(\d{1,2}):(\d{2})/);
  if (m1) {
    const day = parseInt(m1[1], 10);
    const monthNames = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const month = monthNames.indexOf(m1[2].toLowerCase());
    let year = parseInt(m1[3], 10);
    if (year < 100) year += 2000;
    const hours = parseInt(m1[4], 10);
    const minutes = parseInt(m1[5], 10);
    if (month !== -1) {
      return new Date(Date.UTC(year, month, day, hours, minutes));
    }
  }

  // Format 2: YYYY-MM-DD HH:MM:SS or ISO (e.g., "2026-09-15 00:54:25")
  const m2 = str.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):?(\d{2})?/);
  if (m2) {
    const year = parseInt(m2[1], 10);
    const month = parseInt(m2[2], 10) - 1;
    const day = parseInt(m2[3], 10);
    const hours = parseInt(m2[4], 10);
    const minutes = parseInt(m2[5], 10);
    const seconds = m2[6] ? parseInt(m2[6], 10) : 0;
    return new Date(Date.UTC(year, month, day, hours, minutes, seconds));
  }

  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Human-friendly relative date formatting (e.g. "Today 10:15 am", "Yesterday 8:20 pm")
 */
export function formatRelativeTime(date, baseDate = new Date()) {
  if (!date) return "";
  const d = new Date(date);
  const now = new Date(baseDate);

  const isSameDay = (d1, d2) =>
    d1.getUTCFullYear() === d2.getUTCFullYear() &&
    d1.getUTCMonth() === d2.getUTCMonth() &&
    d1.getUTCDate() === d2.getUTCDate();

  const timeStr = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC"
  }).toLowerCase();

  const yesterday = new Date(now);
  yesterday.setUTCDate(now.getUTCDate() - 1);

  if (isSameDay(d, now)) {
    return `Today ${timeStr}`;
  } else if (isSameDay(d, yesterday)) {
    return `Yesterday ${timeStr}`;
  } else {
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 7) {
      const weekday = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
      return `${weekday} ${timeStr}`;
    } else {
      const dayMonth = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
      return `${dayMonth}, ${timeStr}`;
    }
  }
}

/**
 * Check if a date falls within the last 30 days
 */
export function isWithin30Days(date) {
  if (!date) return false;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return date.getTime() >= cutoff;
}

/**
 * Parse an AutoLog row into a normalized event
 */
export function parseAutoLogRow(row, clientName, rowIndex) {
  if (!row || !row[0]) return null;
  const rawTimestamp = row[0];
  const category = String(row[1] || "").trim().toUpperCase();
  const rawSummary = String(row[2] || "").trim();
  const rawDetails = String(row[3] || "").trim();

  const date = parseLogDate(rawTimestamp);
  if (!date || !isWithin30Days(date)) return null;

  // Detect routine zero-change runs
  let isRoutine =
    rawSummary.toLowerCase().includes("no change") ||
    rawSummary.toLowerCase().includes("no updates") ||
    rawDetails.toLowerCase().includes("no new or updated") &&
    (rawDetails.toLowerCase().includes("no updates found") || rawDetails.toLowerCase().includes("no invoices matched") || rawDetails.toLowerCase().includes("no new expenses matched"));

  // Synthesize plain-English summary and extract structured data
  let summary = rawSummary || "Automated sync completed";
  let structuredDetails = { type: category, raw: rawDetails };

  if (category === "INVOICES") {
    // Check for invoice counts
    const newMatch = rawDetails.match(/New Invoices \((\d+)\)/i);
    const updatedMatch = rawDetails.match(/Updated Invoices \((\d+)\)/i);
    const matchedMatch = rawDetails.match(/Matched\/Updated\s*(\d+)\s*Invoices/i) || rawDetails.match(/Matched:?\s*#?([0-9a-zA-Z_-]+)/gi);
    const gapsMatch = rawDetails.match(/Created\/Adjusted (\d+) Invoice Gaps/i) || rawDetails.match(/Invoice Gaps:\s*\(?(\d+)\)?/i);

    const newCount = newMatch ? parseInt(newMatch[1], 10) : 0;
    const updatedCount = updatedMatch ? parseInt(updatedMatch[1], 10) : 0;
    const matchedCount = matchedMatch ? (Array.isArray(matchedMatch) ? matchedMatch.length : parseInt(matchedMatch[1], 10)) : 0;
    const gapsCount = gapsMatch ? parseInt(gapsMatch[1], 10) : 0;

    // Parse individual invoice items and gaps from lines
    const accountingInvoices = [];
    const matchedInvoices = [];
    const invoiceGaps = [];
    const lines = rawDetails.split("\n");

    for (const rawLine of lines) {
      const line = rawLine.trim().replace(/^[•\-*]\s*/, "");
      if (!line) continue;
      if (/^(?:Updated|New)\s*Invoices\s*\(\d+\):?$/i.test(line)) continue;
      if (/^Matched\/Updated\s*\d+\s*Invoices/i.test(line)) continue;
      if (/^No new or updated invoices/i.test(line)) continue;
      if (/^No invoices matched/i.test(line)) continue;
      if (/^\[Accounting Download\]/i.test(line)) continue;

      // 1. Inv #RV-1214 (Omnis Intelligence Limited | Phase 2 - September) - Amount: ...
      // Handles nested parens like Inv #INV-1817 (Outside In (Cambridge) Ltd | Klaviyo support) - ...
      const invMatch = line.match(/^Inv\s*#([^\s(]+)\s*\((.+)\)\s*-\s*(.+)/i);
      if (invMatch) {
        const invNum = invMatch[1].trim();
        const inside = invMatch[2].trim();
        const rest = invMatch[3].trim();
        const pipeIdx = inside.indexOf("|");
        const cName = pipeIdx !== -1 ? inside.substring(0, pipeIdx).trim() : inside;
        const jName = pipeIdx !== -1 ? inside.substring(pipeIdx + 1).trim() : "";

        // Amount extraction
        let amount = "";
        const totalChangeMatch = rest.match(/Total:\s*(?:'([^']+)'|([^\s,]+))\s*->\s*(?:'([^']+)'|([^\s,]+))/i);
        const amtPaidMatch = rest.match(/Amount\s*Paid:\s*(?:'[^']+'\s*->\s*)?'?([1-9][\d,]+(?:\.\d{2})?)'?/i);
        const amtDueChangeMatch = rest.match(/Amount\s*Due:\s*(?:'([^']+)'|([^\s,]+))\s*->\s*(?:'([^']+)'|([^\s,]+))/i);

        if (totalChangeMatch) {
          const fromVal = totalChangeMatch[1] || totalChangeMatch[2];
          const toVal = totalChangeMatch[3] || totalChangeMatch[4];
          amount = `£${toVal} (was £${fromVal})`;
        } else if (amtPaidMatch) {
          amount = `£${amtPaidMatch[1]}`;
        } else if (amtDueChangeMatch) {
          const fromVal = amtDueChangeMatch[1] || amtDueChangeMatch[2];
          const toVal = amtDueChangeMatch[3] || amtDueChangeMatch[4];
          if (toVal !== "0.00" && toVal !== "0") {
            amount = `£${toVal} (was £${fromVal})`;
          } else {
            amount = `£${fromVal}`;
          }
        } else {
          const amtMatch = rest.match(/Amount:\s*(£[\d,]+(?:\.\d{2})?(?:\s*\+VAT)?)/i) ||
                           rest.match(/£([1-9][\d,]+(?:\.\d{2})?(?:\s*\+VAT)?)/) ||
                           rest.match(/Amount:\s*£([\d,]+(?:\.\d{2})?)/i);
          if (amtMatch) {
            const raw = amtMatch[1].trim();
            amount = raw.startsWith("£") ? raw : `£${raw}`;
          }
        }

        // Dates (strictly matching calendar dates dd-mmm-yy)
        const dates = [];
        const sentM = rest.match(/(?:^|[|\s])Sent(?:\s*Date)?:\s*'?(\d{1,2}-[A-Za-z]{3}-\d{2,4})'?/i);
        if (sentM) dates.push(`Sent: ${sentM[1]}`);
        const dueM = rest.match(/(?:^|[|\s])Due(?:\s*Date)?:\s*(?:'[^']+'\s*->\s*)?'?(\d{1,2}-[A-Za-z]{3}-\d{2,4})'?/i);
        if (dueM) dates.push(`Due: ${dueM[1]}`);
        const paidDateM = rest.match(/Fully\s*Paid\s*Date:\s*(?:'[^']+'\s*->\s*)?'?(\d{1,2}-[A-Za-z]{3}-\d{2,4})'?/i);
        if (paidDateM) dates.push(`Paid: ${paidDateM[1]}`);

        // Status & Action
        let status = "Updated";
        let action = "Invoice Updated";
        let statusType = "updated";
        const statusMatch = rest.match(/Status:\s*'([^\']+)'\s*->\s*'([^\']+)'/i);
        if (statusMatch) {
          const from = statusMatch[1].toUpperCase();
          const to = statusMatch[2].toUpperCase();
          if (to === "PAID") {
            status = "Paid";
            action = `Paid (was ${from === "AUTHORISED" ? "Authorised" : from})`;
            statusType = "paid";
          } else if (to === "OVERDUE") {
            status = "Overdue";
            action = `Overdue (was ${from})`;
            statusType = "overdue";
          } else {
            status = `${to} (was ${from})`;
            action = `${to} (was ${from})`;
            statusType = "transition";
          }
        } else if (rest.includes("Amount:")) {
          status = "New Invoice";
          action = "New Invoice";
          statusType = "new";
        } else if (totalChangeMatch || amtDueChangeMatch) {
          action = "Amount Updated";
        }

        accountingInvoices.push({
          invoiceNumber: invNum,
          clientName: cName,
          jobName: jName,
          amount,
          dates,
          action,
          status,
          statusType,
          rawChanges: rest
        });
        continue;
      }

      // 2. [Confirmed|Pipeline] Updated Invoice 2181-1: Row 362, BW&P Ltd | RMO Outsource, Slot 1 - Status: 'Paid' -> 'Sent'
      const updatedInvMatch = line.match(/^\[(Pipeline|Confirmed)\]\s*Updated\s*Invoice\s*([^:]+):\s*Row\s*(\d+),\s*([^,|]+)(?:\|\s*([^,]+))?(?:,\s*Slot\s*(\d+))?(?:\s*-\s*(.+))?/i);
      if (updatedInvMatch) {
        const rest = updatedInvMatch[7] ? updatedInvMatch[7].trim() : "";
        let status = "Updated";
        let action = "Updated in Pulse";
        let statusType = "updated";
        const statusMatch = rest.match(/Status:\s*'([^\']+)'\s*->\s*'([^\']+)'/i);
        if (statusMatch) {
          const from = statusMatch[1];
          const to = statusMatch[2];
          const toUpper = to.toUpperCase();
          const fromUpper = from.toUpperCase();
          if (toUpper === "PAID") {
            status = "Paid";
            action = `Paid (was ${from})`;
            statusType = "paid";
          } else if (toUpper === "SENT") {
            status = `Sent (was ${from})`;
            action = `Sent (was ${from})`;
            statusType = fromUpper === "PAID" ? "overdue" : "transition";
          } else {
            status = `${to} (was ${from})`;
            action = `${to} (was ${from})`;
            statusType = "transition";
          }
        } else if (rest.includes("Client (Block Update)")) {
          status = "Client Name Updated";
          action = "Client Name Updated";
          statusType = "updated";
        } else if (rest.includes("Days to Pay")) {
          const dtpMatch = rest.match(/Days to Pay:\s*(\d+\s*->\s*\d+)/i);
          action = dtpMatch ? `Days to Pay: ${dtpMatch[1]}` : "Days to Pay Updated";
          status = rest;
          statusType = "updated";
        }

        let amount = "";
        const amtM = rest.match(/£([\d,]+(?:\.\d{2})?)/);
        if (amtM) amount = `£${amtM[1]}`;

        const dates = [];
        const movedM = rest.match(/Date\s*moved\s*([0-9a-zA-Z-]+)\s*->\s*([0-9a-zA-Z-]+)/i);
        if (movedM) dates.push(`Date Moved: ${movedM[1]} -> ${movedM[2]}`);

        matchedInvoices.push({
          sheet: updatedInvMatch[1],
          invoiceNumber: updatedInvMatch[2].trim(),
          row: updatedInvMatch[3],
          clientName: updatedInvMatch[4].trim(),
          jobName: updatedInvMatch[5] ? updatedInvMatch[5].trim() : "",
          slot: updatedInvMatch[6] ? `Slot ${updatedInvMatch[6]}` : "",
          amount,
          dates,
          action,
          status,
          statusType,
          rawChanges: rest
        });
        continue;
      }

      // 3. Invoice gaps (Created or Adjusted): [Pipeline|Confirmed] (Created|Adjusted) (Manual|Retainer)? Invoice: Row ...
      const gapMatch = line.match(/^\[(Pipeline|Confirmed)\]\s*(?:Created|Adjusted)\s*(Manual|Retainer)?\s*Invoice:\s*Row\s*(\d+),\s*([^,-]+)(?:,\s*([^,]+))?(?:,\s*(£[\d,]+(?:\.\d{2})?))?(?:,\s*Slot\s*(\d+))?(?:\s*-\s*(.+))?/i);
      if (gapMatch) {
        invoiceGaps.push({
          sheet: gapMatch[1],
          invoiceType: gapMatch[2] ? `${gapMatch[2]} Invoice` : "Invoice",
          action: "Gap Created/Adjusted",
          row: gapMatch[3],
          client: gapMatch[4].trim(),
          jobName: gapMatch[5] ? gapMatch[5].trim() : "",
          amount: gapMatch[6] ? gapMatch[6].trim() : "",
          slot: gapMatch[7] ? `Slot ${gapMatch[7]}` : "",
          rawChanges: gapMatch[8] ? gapMatch[8].trim() : ""
        });
        continue;
      }

      // 4. Stale invoices: [Confirmed] Stale Invoice - Row 382, Northoaks Capital Ltd | Brand identity and sales enablement, Slot 1: Date moved 05-Sep-26 -> 28-Sep-26
      const staleMatch = line.match(/^\[(Pipeline|Confirmed)\]\s*Stale\s*Invoice\s*-\s*Row\s*(\d+),\s*([^|]+)\|\s*([^,]+),\s*Slot\s*(\d+):\s*(.+)/i);
      if (staleMatch) {
        matchedInvoices.push({
          sheet: staleMatch[1],
          invoiceNumber: "Stale",
          row: staleMatch[2],
          clientName: staleMatch[3].trim(),
          jobName: staleMatch[4].trim(),
          slot: `Slot ${staleMatch[5]}`,
          amount: "—",
          action: "Stale Date Moved",
          status: "Stale Date Moved",
          statusType: "updated",
          rawChanges: staleMatch[6].trim()
        });
        continue;
      }

      // 5. Fallback for bullet line
      if (line.startsWith("•") || line.startsWith("-")) {
        const desc = line.replace(/^[•\-]\s*/, "");
        if (desc.includes("Inv #")) {
          accountingInvoices.push({ description: desc, invoiceNumber: "—", action: "Updated" });
        } else {
          matchedInvoices.push({ description: desc, invoiceNumber: "—", action: "Updated" });
        }
      }
    }

    const totalAccounting = accountingInvoices.length;
    const totalMatched = matchedInvoices.length;
    const totalGaps = invoiceGaps.length;

    if (totalAccounting > 0 && totalMatched > 0) {
      summary = `${totalAccounting} invoice${totalAccounting > 1 ? "s" : ""} updated from accounting, ${totalMatched} matched in Pulse`;
    } else if (totalAccounting > 0) {
      summary = `${totalAccounting} invoice${totalAccounting > 1 ? "s" : ""} adjusted / imported from accounting tool`;
    } else if (totalMatched > 0 && totalGaps > 0) {
      summary = `${totalMatched} invoice${totalMatched > 1 ? "s" : ""} matched in Pulse, ${totalGaps} gap${totalGaps > 1 ? "s" : ""} created/adjusted`;
    } else if (totalMatched > 0) {
      summary = `${totalMatched} invoice${totalMatched > 1 ? "s" : ""} matched & updated in Pulse`;
    } else if (totalGaps > 0) {
      summary = `${totalGaps} invoice gap${totalGaps > 1 ? "s" : ""} created / adjusted`;
    } else if (isRoutine) {
      summary = "Routine invoice sync (no changes)";
    } else {
      summary = rawSummary || "Invoice sync completed";
    }

    if (accountingInvoices.length > 0) structuredDetails.accountingInvoices = accountingInvoices;
    if (matchedInvoices.length > 0) structuredDetails.matchedInvoices = matchedInvoices;
    if (invoiceGaps.length > 0) structuredDetails.invoiceGaps = invoiceGaps;
    structuredDetails.invoices = [...accountingInvoices, ...matchedInvoices];
  } else if (category === "CRM") {
    const updatedMatch = rawDetails.match(/Updated Opportunities \((\d+)\)/i);
    const newMatch = rawDetails.match(/New Opportunities \((\d+)\)/i);
    const updatedCount = updatedMatch ? parseInt(updatedMatch[1], 10) : 0;
    const newCount = newMatch ? parseInt(newMatch[1], 10) : 0;

    const skippedJobs = [];
    const createdJobs = [];
    const oppItems = [];

    const oppLines = rawDetails.split("\n");
    for (const rawLine of oppLines) {
      const line = rawLine.trim().replace(/^[•\-*]\s*/, "");
      if (!line) continue;
      if (/^\[CRM Download\]/i.test(line)) continue;
      if (/^No new or updated opportunities/i.test(line)) continue;
      if (/^No updates found in Pipeline/i.test(line)) continue;

      // Created New Confirmed Job: Row 138, Nevine El-Warraky (Accenture) | Transition 121 coaching (self funding)
      const createdJobMatch = line.match(/^Created New Confirmed Job:\s*Row\s*(\d+),\s*([^|]+)\|\s*(.+)/i);
      if (createdJobMatch) {
        createdJobs.push({
          row: createdJobMatch[1],
          client: createdJobMatch[2].trim(),
          jobName: createdJobMatch[3].trim()
        });
        continue;
      }

      // Skipped Copy: Job with Project Code "..." already exists in Confirmed.
      const skippedMatch = line.match(/^Skipped Copy:\s*Job with Project Code\s*"([^"]+)"\s*(.+)/i);
      if (skippedMatch) {
        skippedJobs.push({
          projectCode: skippedMatch[1],
          reason: skippedMatch[2].trim()
        });
        continue;
      }

      // [ID: ...] Name - Details
      const opMatch = line.match(/^\[ID:\s*([^\]]+)\]\s*([^-]+)-\s*(.+)/i);
      if (opMatch) {
        oppItems.push({
          id: opMatch[1].trim(),
          name: opMatch[2].trim(),
          details: opMatch[3].trim()
        });
        continue;
      }

      if (line.startsWith("Updated Pipeline:") || line.startsWith("•")) {
        oppItems.push({ note: line });
      }
    }

    const hasRealChanges = newCount > 0 || updatedCount > 0 || createdJobs.length > 0;

    if (!hasRealChanges && skippedJobs.length > 0) {
      // ONLY skipped jobs existed — this was a routine check where nothing was added or updated
      isRoutine = true;
      summary = `Routine CRM sync (${skippedJobs.length} existing job${skippedJobs.length > 1 ? "s" : ""} verified)`;
    } else if (newCount > 0 && createdJobs.length > 0) {
      summary = `${newCount} new opportunit${newCount > 1 ? "ies" : "y"} imported, ${createdJobs.length} job${createdJobs.length > 1 ? "s" : ""} created in Confirmed`;
    } else if (newCount > 0 && updatedCount > 0) {
      summary = `${newCount} new opportunit${newCount > 1 ? "ies" : "y"}, ${updatedCount} updated`;
    } else if (newCount > 0) {
      summary = `${newCount} new opportunit${newCount > 1 ? "ies" : "y"} imported`;
    } else if (createdJobs.length > 0) {
      summary = `${createdJobs.length} new job${createdJobs.length > 1 ? "s" : ""} created in Confirmed from CRM`;
    } else if (updatedCount > 0) {
      if (rawDetails.toLowerCase().includes("project start")) {
        summary = `${updatedCount} opportunit${updatedCount > 1 ? "ies" : "y"} updated (project start date changed)`;
      } else {
        summary = `${updatedCount} opportunit${updatedCount > 1 ? "ies" : "y"} updated`;
      }
    } else if (isRoutine) {
      summary = "Routine CRM sync (no changes)";
    } else {
      summary = rawSummary || "CRM sync completed";
    }

    if (oppItems.length > 0) structuredDetails.opportunities = oppItems;
    if (createdJobs.length > 0) structuredDetails.createdJobs = createdJobs;
    if (skippedJobs.length > 0) structuredDetails.skippedJobs = skippedJobs;
  } else if (category === "EXPENSES") {
    const newMatch = rawDetails.match(/New Expenses \((\d+)\)/i);
    const updatedExpMatch = rawDetails.match(/Updated Expenses \((\d+)\)/i);
    const adjMatch = rawDetails.match(/Adjusted\/Refreshed (\d+) Manual Entries/i);
    const pushedMatch = rawDetails.match(/Pushed (\d+) Expense Updates/i);
    const overdueMatch = rawDetails.match(/Fixed (\d+) overdue expenses/i);
    const gapsMatch = rawDetails.match(/Created (\d+) Unreconciled Gaps/i);

    const newCount = newMatch ? parseInt(newMatch[1], 10) : 0;
    const updatedCount = updatedExpMatch ? parseInt(updatedExpMatch[1], 10) : 0;
    const adjCount = adjMatch ? parseInt(adjMatch[1], 10) : 0;
    const pushedCount = pushedMatch ? parseInt(pushedMatch[1], 10) : 0;
    const overdueCount = overdueMatch ? parseInt(overdueMatch[1], 10) : 0;
    const gapsCount = gapsMatch ? parseInt(gapsMatch[1], 10) : 0;

    const accountingExpenses = [];
    const matchedExpenses = [];
    const manualAdjustments = [];
    const lines = rawDetails.split("\n");

    for (const rawLine of lines) {
      const line = rawLine.trim().replace(/^[•\-*]\s*/, "");
      if (!line) continue;
      if (/^(?:Updated|New)\s*Expenses\s*\(\d+\):?$/i.test(line)) continue;
      if (/^No new or updated expenses/i.test(line)) continue;
      if (/^No new expenses matched/i.test(line)) continue;
      if (/^\[Expenses Download\]/i.test(line)) continue;

      // 0a. [Confirmed|Pipeline|Outgoings] (Created|Changed|Adjusted|Removed) Manual Gap: Row 45, Client | Job (Slot X) - Changes
      // e.g.: [Confirmed] Changed Manual Gap: Row 45, Acme Corp | Website Refresh (Slot 2) - Amt: £500.00 -> £750.00
      // e.g.: [Confirmed] Created Manual Gap: Row 45, Acme Corp | Website Refresh (Slot 2) - Amt: £750.00
      // e.g.: [Confirmed] Removed Manual Gap: Row 45, Acme Corp | Website Refresh (Slot 2) - Balanced
      const gapMatch = line.match(/^\[(Confirmed|Pipeline|Outgoings)\]\s*(Created|Changed|Adjusted|Removed)\s*Manual\s*Gap:\s*Row\s*(\d+),\s*([^|:]+)(?:\|\s*([^(\n]+))?(?:\((Slot\s*\d+)\))?\s*-\s*(.+)/i);
      if (gapMatch) {
        const sheet = gapMatch[1];
        const actionVerb = gapMatch[2].trim();
        const row = gapMatch[3].trim();
        const cName = gapMatch[4].trim();
        const jName = gapMatch[5] ? gapMatch[5].trim() : "";
        const slot = gapMatch[6] ? gapMatch[6].trim() : "";
        const changes = gapMatch[7].trim();

        let amount = "";
        const amtChange = changes.match(/Amt:\s*[£Â]?([\d,]+(?:\.\d{2})?)\s*(?:->\s*[£Â]?([\d,]+(?:\.\d{2})?))?/i);
        if (amtChange) {
          amount = amtChange[2] ? `£${amtChange[2]} (was £${amtChange[1]})` : `£${amtChange[1]}`;
        }

        const dates = [];
        const dateMatch = changes.match(/Date:\s*([0-9a-zA-Z-]+)\s*(?:->\s*([0-9a-zA-Z-]+))?/i);
        if (dateMatch) {
          dates.push(dateMatch[2] ? `${dateMatch[1]} -> ${dateMatch[2]}` : dateMatch[1]);
        }

        const actionText = actionVerb.toLowerCase() === "created" 
          ? "Manual Gap Created" 
          : actionVerb.toLowerCase() === "removed" 
            ? "Manual Gap Removed" 
            : "Manual Gap Changed";

        const actionType = actionVerb.toLowerCase() === "created"
          ? "new"
          : actionVerb.toLowerCase() === "removed"
            ? "removed"
            : "updated";

        manualAdjustments.push({
          sheet,
          row,
          slot,
          entry: cName,
          supplier: cName,
          jobOrRef: jName,
          description: `${cName}${jName ? ` • ${jName}` : ""}${slot ? ` (${slot})` : ""}`,
          action: actionText,
          actionType,
          amount,
          dates,
          status: actionText,
          statusType: actionType,
          rawChanges: changes
        });
        continue;
      }

      // 0b. [Outgoings] (Created|Adjusted|Removed) Gap - Nov 2026 Row 12, John Doe: £200.00 -> £250.00
      const outGapMatch = line.match(/^\[Outgoings\]\s*(Created|Adjusted|Removed)\s*Gap\s*-\s*([A-Za-z]{3}\s*\d{4})\s*(?:Row\s*(\d+))?,\s*([^:]+):\s*(.+)/i);
      if (outGapMatch) {
        const actionVerb = outGapMatch[1].trim();
        const dateStr = outGapMatch[2].trim();
        const row = outGapMatch[3] ? outGapMatch[3].trim() : "";
        const contractor = outGapMatch[4].trim();
        const rest = outGapMatch[5].trim();

        let amount = "";
        const amtChange = rest.match(/[£Â]?([\d,]+(?:\.\d{2})?)\s*->\s*[£Â]?([\d,]+(?:\.\d{2})?)/);
        if (amtChange) {
          amount = `£${amtChange[2]} (was £${amtChange[1]})`;
        } else {
          const singleAmt = rest.match(/[£Â]?([\d,]+(?:\.\d{2})?)/);
          if (singleAmt) amount = `£${singleAmt[1]}`;
        }

        const actionText = `Gap ${actionVerb}`;
        manualAdjustments.push({
          sheet: "Outgoings",
          row,
          entry: contractor,
          supplier: contractor,
          jobOrRef: dateStr,
          description: `${contractor} (${dateStr})`,
          action: actionText,
          actionType: actionVerb.toLowerCase() === "created" ? "new" : "updated",
          amount,
          dates: [dateStr],
          status: actionText,
          statusType: actionVerb.toLowerCase() === "created" ? "new" : "updated",
          rawChanges: rest
        });
        continue;
      }

      // 1. [Outgoings|Confirmed] Adjusted Manual Entry - Oct 2026 row 111, Making up CoS to 55.%: £4015.46 -> £4627.33
      const manualMatch = line.match(/^\[(Confirmed|Outgoings)\]\s*Adjusted\s*Manual\s*Entry\s*-\s*([A-Za-z]{3}\s*\d{4})\s*row\s*(\d+),\s*([^:]+):\s*(.+)/i);
      if (manualMatch) {
        const sheet = manualMatch[1];
        const dateStr = manualMatch[2];
        const row = manualMatch[3];
        const desc = manualMatch[4].trim();
        const rest = manualMatch[5].trim();

        let amount = "";
        const amtChange = rest.match(/[£Â]?([\d,]+(?:\.\d{2})?)\s*->\s*[£Â]?([\d,]+(?:\.\d{2})?)/);
        if (amtChange) {
          amount = `£${amtChange[2]} (was £${amtChange[1]})`;
        }

        manualAdjustments.push({
          sheet,
          row,
          entry: desc,
          supplier: desc,
          jobOrRef: dateStr,
          description: desc,
          action: "Manual Adjusted",
          actionType: "manual",
          amount,
          dates: [dateStr],
          status: "Manual Adjusted",
          statusType: "manual",
          rawChanges: rest
        });
        continue;
      }

      // 2. Stale / Overdue expense updates
      // [Confirmed] Row 382, Northoaks Capital Ltd | Brand identity, Slot 1: Rec Date updated 05-Sep-26 -> 28-Sep-26
      // [Outgoings] Row 45, Studio Design: Updated stale Manual/Gap date (Rec: UNK->01-Oct-26, Pay: UNK->05-Oct-26)
      const staleExpMatch = line.match(/^\[(Confirmed|Outgoings)\]\s*Row\s*(\d+),\s*([^,|:]+)(?:\|\s*([^,:]+))?(?:,\s*Slot\s*(\d+))?:\s*(.+)/i);
      if (staleExpMatch) {
        const sheet = staleExpMatch[1];
        const row = staleExpMatch[2];
        const cName = staleExpMatch[3].trim();
        const jName = staleExpMatch[4] ? staleExpMatch[4].trim() : "";
        const slot = staleExpMatch[5] ? `Slot ${staleExpMatch[5]}` : "";
        const changes = staleExpMatch[6].trim();

        const dates = [];
        const dateMoved = changes.match(/([0-9a-zA-Z-]+)\s*->\s*([0-9a-zA-Z-]+)/);
        if (dateMoved) dates.push(`${dateMoved[1]} -> ${dateMoved[2]}`);

        manualAdjustments.push({
          sheet,
          row,
          slot,
          entry: cName,
          supplier: cName,
          jobOrRef: jName,
          description: `${cName}${jName ? ` • ${jName}` : ""}${slot ? ` (${slot})` : ""}`,
          action: "Date Moved",
          actionType: "updated",
          amount: "",
          dates,
          status: "Date Moved",
          statusType: "updated",
          rawChanges: changes
        });
        continue;
      }

      // 3. [Confirmed|Outgoings] Matched/Updated/Created entries
      // [Confirmed] Matched Row 138: Contractor A - Retainer Fee (£1,200.00) - Slot 1 updated.
      // [Outgoings] Updated existing entry for Cloud Hosting (£450.00)
      // [Outgoings] Created New Row: Software Subscription (£99.00)
      const expMatch = line.match(/^\[(Confirmed|Outgoings)\]\s*(Matched|Updated|Created(?:\s*New\s*Row)?:?)\s*(?:(?:existing entry for|Row:?)\s*(\d+)?:?)?\s*(.+)/i);
      if (expMatch) {
        const sheet = expMatch[1];
        const actionType = expMatch[2].replace(/:$/, "").trim();
        const row = expMatch[3] || "";
        const rest = expMatch[4].trim();

        let amt = "";
        const amtM = rest.match(/£([\d,]+(?:\.\d{2})?)/);
        if (amtM) amt = `£${amtM[1]}`;

        let cleanDesc = rest.replace(/\(£[\d,]+(?:\.\d{2})?\)/, "").trim();
        let slot = "";
        const slotMatch = cleanDesc.match(/-\s*(Slot\s*\d+(?:\s*updated)?)/i);
        if (slotMatch) {
          slot = slotMatch[1];
          cleanDesc = cleanDesc.replace(/-\s*Slot\s*\d+(?:\s*updated)?/i, "").trim().replace(/\s+-\s*$/, "");
        }

        const action = actionType.toLowerCase().includes("matched")
          ? `Matched in ${sheet}`
          : `${actionType} in ${sheet}`;

        matchedExpenses.push({
          sheet,
          row,
          slot,
          supplier: cleanDesc || rest,
          jobOrRef: "",
          description: cleanDesc || rest,
          action,
          actionType: actionType.toLowerCase().includes("created") ? "new" : "updated",
          amount: amt,
          dates: [],
          status: actionType,
          statusType: actionType.toLowerCase().includes("created") ? "new" : "updated",
          rawChanges: rest
        });
        continue;
      }

      // 4. [ID: 123] Supplier - Job/Ref - Changes
      const idMatch = line.match(/^\[ID:\s*([^\]]+)\]\s*(.+)/i);
      if (idMatch) {
        const rawRest = idMatch[2].trim();
        const parts = rawRest.split(/\s+-\s+(?!>)/);
        let supplier = parts[0] || "Expense";
        let jobOrRef = "";
        let changes = "";

        if (parts.length >= 3) {
          supplier = parts[0];
          jobOrRef = parts[1];
          changes = parts.slice(2).join(" - ");
        } else if (parts.length === 2) {
          if (parts[1].includes(":") || parts[1].includes("->")) {
            supplier = parts[0];
            changes = parts[1];
          } else {
            supplier = parts[0];
            jobOrRef = parts[1];
          }
        }

        let amount = "";
        let status = "Updated";
        let action = "Expense Updated";
        let statusType = "updated";
        const dates = [];

        // VAT change
        const vatMatch = rawRest.match(/VAT:\s*(?:'([^']+)'|([^\s->]+))\s*->\s*(?:'([^']+)'|([^\s,]+))/i);
        if (vatMatch) {
          status = "VAT Adjusted";
          action = "VAT Adjusted";
          statusType = "transition";
          const toVal = vatMatch[3] || vatMatch[4] || "";
          amount = `VAT: £${toVal}`;
        }

        // Amount change
        const amtChangeMatch = rawRest.match(/(?:Total|Amount|Amount Due|SubTotal):\s*'?([^'->]+)'?\s*->\s*'?([^']+)'?/i);
        if (amtChangeMatch) {
          const fromVal = amtChangeMatch[1].trim();
          const toVal = amtChangeMatch[2].trim();
          amount = `£${toVal} (was £${fromVal})`;
          status = "Amount Adjusted";
          action = "Amount Adjusted";
        } else if (!amount) {
          const standaloneAmt = rawRest.match(/Amount:\s*(£[\d,]+(?:\.\d{2})?(?:\s*\+VAT)?)/i) || rawRest.match(/£([\d,]+(?:\.\d{2})?)/);
          if (standaloneAmt) {
            amount = standaloneAmt[1].startsWith("£") ? standaloneAmt[1] : `£${standaloneAmt[1]}`;
          }
        }

        // Dates
        const dateMatch = rawRest.match(/Date:\s*([0-9a-zA-Z-]+)/i);
        if (dateMatch) dates.push(`Date: ${dateMatch[1]}`);

        // Status
        const statusMatch = rawRest.match(/Status:\s*'?([^'->]+)'?\s*->\s*'?([^']+)'?/i) || rawRest.match(/Status:\s*([A-Z_]+)/i);
        if (statusMatch) {
          if (statusMatch[2]) {
            status = `${statusMatch[2]} (was ${statusMatch[1]})`;
            action = `${statusMatch[2]} (was ${statusMatch[1]})`;
            statusType = "transition";
          } else {
            status = statusMatch[1];
            action = statusMatch[1];
            statusType = status.toUpperCase() === "PAID" ? "paid" : "updated";
          }
        } else if (rawRest.includes("Amount:") && !statusMatch) {
          status = "New Expense";
          action = "New Expense";
          statusType = "new";
        }

        accountingExpenses.push({
          ref: `ID: ${idMatch[1].trim()}`,
          supplier: supplier.trim(),
          jobOrRef: jobOrRef.trim(),
          description: supplier.trim(),
          amount,
          dates,
          action,
          status,
          statusType,
          rawChanges: changes.trim() || rawRest
        });
        continue;
      }

      // 5. Pre-Match / Post-Match adjustments (fallback only if no individual entries found)
      if (line.includes("Adjusted/Refreshed") || line.includes("Unreconciled Gaps") || line.includes("overdue expenses")) {
        if (/\[(Confirmed|Pipeline|Outgoings)\]/i.test(rawDetails)) {
          continue;
        }
        manualAdjustments.push({
          sheet: "Outgoings",
          entry: line,
          supplier: line,
          description: line,
          action: "Adjustment",
          actionType: "updated",
          amount: "",
          dates: []
        });
        continue;
      }

      // 6. Fallback bullet line
      if (line.startsWith("•") || line.startsWith("-")) {
        const desc = line.replace(/^[•\-]\s*/, "");
        if (desc.includes("[ID:") || desc.toLowerCase().includes("vat:") || desc.toLowerCase().includes("status:")) {
          accountingExpenses.push({ description: desc, supplier: desc, action: "Updated" });
        } else {
          matchedExpenses.push({ sheet: "Outgoings", description: desc, supplier: desc, action: "Updated" });
        }
      }
    }

    const totalAccounting = accountingExpenses.length;
    const totalMatched = matchedExpenses.length;
    const totalManual = manualAdjustments.length;

    if (totalAccounting > 0 && totalMatched > 0) {
      summary = `${totalAccounting} expense${totalAccounting > 1 ? "s" : ""} adjusted from accounting, ${totalMatched} matched in Pulse`;
    } else if (totalAccounting > 0) {
      summary = `${totalAccounting} expense${totalAccounting > 1 ? "s" : ""} adjusted / imported from accounting tool`;
    } else if (totalMatched > 0 && totalManual > 0) {
      summary = `${totalMatched} expense${totalMatched > 1 ? "s" : ""} matched in Pulse, ${totalManual} manual entr${totalManual > 1 ? "ies" : "y"} adjusted`;
    } else if (totalMatched > 0) {
      summary = `${totalMatched} expense${totalMatched > 1 ? "s" : ""} matched & updated in Pulse`;
    } else if (totalManual > 0) {
      summary = `${totalManual} manual expense entr${totalManual > 1 ? "ies" : "y"} / gap${totalManual > 1 ? "s" : ""} adjusted in Pulse`;
    } else if (isRoutine) {
      summary = "Routine expense sync (no changes)";
    } else {
      summary = rawSummary || "Expenses sync completed";
    }

    if (accountingExpenses.length > 0) structuredDetails.accountingExpenses = accountingExpenses;
    if (matchedExpenses.length > 0) structuredDetails.matchedExpenses = matchedExpenses;
    if (manualAdjustments.length > 0) structuredDetails.manualAdjustments = manualAdjustments;
    structuredDetails.expenses = [...accountingExpenses, ...matchedExpenses, ...manualAdjustments];
  } else if (category === "CLIENT_AUTH") {
    summary = rawSummary || "Third-party integration authorized";
    structuredDetails.portalNote = rawDetails;
  }

  return {
    id: `auto_${clientName}_${date.getTime()}_${rowIndex}`,
    clientName,
    source: "auto",
    category,
    timestamp: date.toISOString(),
    timestampMs: date.getTime(),
    relativeTime: formatRelativeTime(date),
    userEmail: null,
    summary,
    isRoutine,
    rawDetails,
    structuredDetails
  };
}

/**
 * Parse AppLog rows and group contiguous sessions/page views (within 1-hour window per user)
 */
export function parseAppLogRows(rows, clientName) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const rawEvents = [];
  rows.forEach((row, idx) => {
    if (!row || !row[0]) return;
    const date = parseLogDate(row[0]);
    if (!date || !isWithin30Days(date)) return;

    const action = String(row[1] || "").trim().toUpperCase();
    const userEmail = String(row[2] || "").trim().toLowerCase();
    let detailsObj = {};
    try {
      if (row[3]) detailsObj = JSON.parse(row[3]);
    } catch {
      detailsObj = { raw: row[3] };
    }
    const sessionId = String(row[4] || "").trim();

    rawEvents.push({
      date,
      timestampMs: date.getTime(),
      action,
      userEmail: userEmail === "unknown" || userEmail === "user" || userEmail === "anonymous" ? "" : userEmail,
      details: detailsObj,
      sessionId,
      rowIndex: idx
    });
  });

  const processedEvents = [];
  const userBuckets = new Map(); // userEmail -> array of session-related events
  const ONE_HOUR_MS = 60 * 60 * 1000;

  for (const ev of rawEvents) {
    const { date, action, userEmail, details, rowIndex } = ev;

    // Session-related events
    const isSessionAction = [
      "LOGIN_SUCCESS",
      "PAGE_VIEW_BATCH",
      "SESSION_RETURN",
      "HOME_PAGE_ACCESS",
      "DASHBOARD_LOADED"
    ].includes(action);

    if (isSessionAction) {
      const uKey = userEmail || "anonymous";
      if (!userBuckets.has(uKey)) userBuckets.set(uKey, []);
      userBuckets.get(uKey).push(ev);
      continue;
    }

    // Skip low-value background noise
    if (["AUTH_CODE_SENT", "LOGIN_SCREEN_SHOWN", "SESSION_EXPIRED_ON_ACCESS", "LOG_CLEANUP"].includes(action)) {
      continue;
    }

    // Discrete User Actions: Job Created, Job Modified, Salaries, Expenses, etc.
    let summary = `Performed ${action}`;
    let category = "USER_ACTION";
    let structuredDetails = { action, ...details };

    if (action === "JOB_CREATED") {
      category = "JOB";
      const jobName = details.jobName || "Untitled Job";
      const cName = details.clientName || clientName;
      summary = `Created new job: "${jobName}" (${cName})`;
    } else if (action === "JOB_MODIFIED") {
      category = "JOB";
      const jobName = details.jobName || "Job";
      const count = details.fieldsChangedCount || (details.changeDetails ? Object.keys(details.changeDetails).length : 1);
      summary = `Updated job: "${jobName}" (${count} field${count > 1 ? "s" : ""} changed)`;
      structuredDetails.changes = details.changeDetails;
    } else if (action === "SALARIES_MODIFIED") {
      category = "OUTGOINGS";
      const count = details.cellsChanged || 0;
      summary = `Updated salary figures (${count} cell${count > 1 ? "s" : ""} updated)`;
    } else if (action === "EXPENSES_MODIFIED") {
      category = "OUTGOINGS";
      const count = details.cellsChanged || 0;
      summary = `Updated expense figures (${count} cell${count > 1 ? "s" : ""} updated)`;
    } else if (action === "CONTRACTORS_MODIFIED") {
      category = "OUTGOINGS";
      const count = details.cellsChanged || 0;
      summary = `Updated contractor figures (${count} cell${count > 1 ? "s" : ""} updated)`;
    } else if (action === "DIVIDENDS_MODIFIED") {
      category = "OUTGOINGS";
      const count = details.cellsChanged || 0;
      summary = `Updated dividend figures (${count} cell${count > 1 ? "s" : ""} updated)`;
    }

    processedEvents.push({
      id: `user_${clientName}_${date.getTime()}_${rowIndex}`,
      clientName,
      source: "user",
      category,
      timestamp: date.toISOString(),
      timestampMs: date.getTime(),
      relativeTime: formatRelativeTime(date),
      userEmail: userEmail || "User",
      summary,
      isRoutine: false,
      rawDetails: JSON.stringify(details, null, 2),
      structuredDetails
    });
  }

  // 1-Hour Window Session Clustering per User
  for (const [userEmail, events] of userBuckets.entries()) {
    // Sort chronological (oldest to newest) to bundle sessions forward
    events.sort((a, b) => a.timestampMs - b.timestampMs);

    let curSession = null;
    for (const ev of events) {
      if (curSession && (ev.timestampMs - curSession.firstTimestampMs) <= ONE_HOUR_MS) {
        // Extend current session
        curSession.lastTimestampMs = ev.timestampMs;
        curSession.lastDate = ev.date;
        if (ev.action === "LOGIN_SUCCESS") curSession.hasLogin = true;
        if (ev.action === "SESSION_RETURN") curSession.hasReturn = true;
        if (ev.action === "PAGE_VIEW_BATCH" && Array.isArray(ev.details.views)) {
          curSession.views.push(...ev.details.views);
        } else if (ev.action === "HOME_PAGE_ACCESS" || ev.action === "DASHBOARD_LOADED") {
          curSession.views.push({ page: ev.action.toLowerCase().replace(/_/g, " "), time: ev.date.toISOString() });
        }
      } else {
        if (curSession) finalizeSession(curSession, processedEvents, clientName);
        curSession = {
          userEmail: userEmail === "anonymous" ? "User" : userEmail,
          firstDate: ev.date,
          lastDate: ev.date,
          firstTimestampMs: ev.timestampMs,
          lastTimestampMs: ev.timestampMs,
          hasLogin: ev.action === "LOGIN_SUCCESS",
          hasReturn: ev.action === "SESSION_RETURN",
          views: ev.action === "PAGE_VIEW_BATCH" && Array.isArray(ev.details.views)
            ? [...ev.details.views]
            : (ev.action === "HOME_PAGE_ACCESS" || ev.action === "DASHBOARD_LOADED")
              ? [{ page: ev.action.toLowerCase().replace(/_/g, " "), time: ev.date.toISOString() }]
              : [],
          rowIndex: ev.rowIndex
        };
      }
    }
    if (curSession) finalizeSession(curSession, processedEvents, clientName);
  }

  return processedEvents;
}

function finalizeSession(sess, targetArray, clientName) {
  const viewCount = sess.views.length;
  const uniquePages = Array.from(new Set(sess.views.map(v => v.page || "view"))).filter(Boolean);

  const pageFrequencies = {};
  for (const v of sess.views) {
    const pageName = v.page || "view";
    pageFrequencies[pageName] = (pageFrequencies[pageName] || 0) + 1;
  }

  let summaryText = "";
  let isRoutine = false;

  if (sess.hasLogin) {
    if (viewCount > 0) {
      summaryText = `Logged in and viewed ${viewCount} page${viewCount > 1 ? "s" : ""}`;
    } else {
      summaryText = "Logged in";
    }
  } else if (sess.hasReturn) {
    if (viewCount > 0) {
      summaryText = `Active in WebApp (${viewCount} page${viewCount > 1 ? "s" : ""} viewed)`;
    } else {
      summaryText = "Session ping (idle return)";
      isRoutine = true;
    }
  } else if (viewCount > 0) {
    summaryText = `Viewed ${viewCount} page${viewCount > 1 ? "s" : ""}`;
  } else {
    summaryText = "Active in WebApp";
    isRoutine = true;
  }

  const durationMins = Math.round((sess.lastTimestampMs - sess.firstTimestampMs) / 60000);
  const timeSpanText = durationMins >= 1 ? `${durationMins} min${durationMins > 1 ? "s" : ""}` : "< 1 min";

  const structuredDetails = {
    userEmail: sess.userEmail,
    pagesVisited: uniquePages,
    pageFrequencies,
    totalViews: viewCount,
    firstSeen: sess.firstDate.toISOString(),
    lastSeen: sess.lastDate.toISOString(),
    durationMins,
    timeSpanText,
    viewsLog: sess.views
  };

  targetArray.push({
    id: `user_sess_${clientName}_${sess.lastTimestampMs}_${sess.rowIndex}`,
    clientName,
    source: "user",
    category: "SESSION",
    timestamp: sess.lastDate.toISOString(),
    timestampMs: sess.lastTimestampMs,
    relativeTime: formatRelativeTime(sess.lastDate),
    userEmail: sess.userEmail,
    summary: summaryText,
    isRoutine,
    rawDetails: JSON.stringify(structuredDetails, null, 2),
    structuredDetails
  });
}

/**
 * Deduplicate adjacent identical events
 */
function deduplicateEvents(events) {
  if (!Array.isArray(events) || events.length < 2) return events;
  const deduped = [];
  for (let i = 0; i < events.length; i++) {
    const cur = events[i];
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.clientName === cur.clientName &&
      prev.summary === cur.summary &&
      Math.abs(prev.timestampMs - cur.timestampMs) < 60000 // within 1 minute
    ) {
      continue;
    }
    deduped.push(cur);
  }
  return deduped;
}

/**
 * Fetch and parse activity for a single client with Redis caching
 */
export async function fetchClientActivity(sheets, client, includeRoutine = false, forceRefresh = false) {
  const { clientName, clientSheetId, masterSheetId } = client;
  if (!clientSheetId && !masterSheetId) {
    return { clientName, events: [], totalEvents: 0 };
  }

  const cacheKey = `${REDIS_ACTIVITY_PREFIX}client:${clientName}:${includeRoutine ? "with_routine" : "normal"}`;

  if (!forceRefresh) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      // Redis fallback
    }
  }

  const events = [];

  // 1. Read Master Sheet AutoLog (Expanded bounded range A2:D250 to capture full 30 days)
  if (masterSheetId) {
    try {
      const resp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: masterSheetId,
          range: "AutoLog!A2:D250",
          valueRenderOption: "FORMATTED_VALUE"
        })
      );
      const rows = resp.data.values || [];
      rows.forEach((row, idx) => {
        const ev = parseAutoLogRow(row, clientName, idx);
        if (ev) {
          if (includeRoutine || !ev.isRoutine) {
            events.push(ev);
          }
        }
      });
    } catch (err) {
      console.warn(`⚠️ Could not read AutoLog for ${clientName}:`, err.message);
    }
  }

  // 2. Read Client Sheet AppLog (Expanded bounded range A2:E200)
  if (clientSheetId) {
    try {
      const resp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: "AppLog!A2:E200",
          valueRenderOption: "FORMATTED_VALUE"
        })
      );
      const rows = resp.data.values || [];
      const userEvents = parseAppLogRows(rows, clientName);
      userEvents.forEach(ev => {
        if (includeRoutine || !ev.isRoutine) {
          events.push(ev);
        }
      });
    } catch (err) {
      console.warn(`⚠️ Could not read AppLog for ${clientName}:`, err.message);
    }
  }

  // Sort newest first
  events.sort((a, b) => b.timestampMs - a.timestampMs);

  const cleanEvents = deduplicateEvents(events);

  const result = {
    clientName,
    events: cleanEvents,
    totalEvents: cleanEvents.length,
    cachedAt: new Date().toISOString()
  };

  try {
    await redisClient.set(cacheKey, JSON.stringify(result), { EX: CACHE_TTL_SECONDS });
  } catch (e) {
    // Ignore cache write errors
  }

  return result;
}

/**
 * Fetch activity across all clients with strict quota defense:
 * - Checks Redis cache first (TTL 30m)
 * - Paced batch execution (batch size: 2, 400ms delay) to avoid quota spikes
 */
export async function fetchAllClientsActivity(sheets, clientsList, forceRefresh = false, includeRoutine = false) {
  if (!Array.isArray(clientsList) || clientsList.length === 0) {
    return { clients: {}, allEvents: [], cachedAt: null };
  }

  const cacheKey = `${REDIS_ACTIVITY_PREFIX}all:${includeRoutine ? "with_routine" : "normal"}`;

  // 1. Try Redis cache if not forced refresh
  if (!forceRefresh) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        console.log(`⚡ Returned cached activity for ${Object.keys(parsed.clients || {}).length} clients`);
        return parsed;
      }
    } catch (cacheErr) {
      console.warn("⚠️ Redis read error in fetchAllClientsActivity:", cacheErr.message);
    }
  }

  console.log(`🔄 Fetching fresh activity for ${clientsList.length} clients from Google Sheets...`);

  const clientsData = {};
  const allEvents = [];
  const BATCH_SIZE = 2;
  const DELAY_MS = 400;

  for (let i = 0; i < clientsList.length; i += BATCH_SIZE) {
    const batch = clientsList.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(client => fetchClientActivity(sheets, client, includeRoutine, forceRefresh))
    );

    for (const res of batchResults) {
      clientsData[res.clientName] = {
        events: res.events,
        totalEvents: res.totalEvents
      };
      allEvents.push(...res.events);
    }

    // Delay between batches to respect rate limits
    if (i + BATCH_SIZE < clientsList.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // Sort overall allEvents newest first
  allEvents.sort((a, b) => b.timestampMs - a.timestampMs);

  const payload = {
    clients: clientsData,
    allEvents,
    cachedAt: new Date().toISOString()
  };

  // Cache in Redis
  try {
    await redisClient.set(cacheKey, JSON.stringify(payload), { EX: CACHE_TTL_SECONDS });
    console.log(`✅ Cached activity for ${clientsList.length} clients (TTL: ${CACHE_TTL_SECONDS}s)`);
  } catch (cacheErr) {
    console.warn("⚠️ Redis write error in fetchAllClientsActivity:", cacheErr.message);
  }

  return payload;
}

/**
 * API Route Handler for Activity feed
 */
export async function handleGetActivity(req, res, sheets) {
  const { automationCommanderSheetId, clientName, forceRefresh, includeRoutine, clients } = req.body;

  try {
    let clientsList = Array.isArray(clients) ? clients : [];

    // If client list was not supplied by caller, load it from AutoUpdates
    if (clientsList.length === 0 && automationCommanderSheetId) {
      const resp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: automationCommanderSheetId,
          range: "AutoUpdates!A2:N500",
        })
      );
      const rows = resp.data.values || [];
      for (const row of rows) {
        const cName = String(row[0] || "").trim();
        const clientSheetUrl = row[11];
        const masterSheetUrl = row[12];
        if (!cName || !clientSheetUrl) continue;
        if (cName.toLowerCase() === "client" || cName.toLowerCase() === "client name") continue;
        const clientSheetId = extractSheetIdFromUrl(clientSheetUrl) || String(clientSheetUrl).trim();
        const masterSheetId = extractSheetIdFromUrl(masterSheetUrl) || String(masterSheetUrl || "").trim();
        clientsList.push({ clientName: cName, clientSheetId, masterSheetId });
      }
    }

    // 1. Single Client View
    if (clientName && clientName !== "ALL") {
      let targetClient = clientsList.find(c => c.clientName.toLowerCase() === clientName.toLowerCase());
      if (!targetClient) {
        // Fallback: search row directly
        targetClient = { clientName };
      }
      const data = await fetchClientActivity(sheets, targetClient, !!includeRoutine, !!forceRefresh);
      return res.status(200).json({ success: true, clientName, data });
    }

    // 2. All Clients View
    const data = await fetchAllClientsActivity(sheets, clientsList, !!forceRefresh, !!includeRoutine);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("❌ handleGetActivity error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
