function parseInvoiceLine(line) {
  // Format 1: Inv #RV-1214 (Omnis Intelligence Limited | Phase 2 - September) - Amount: ...
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

    // Status
    let status = "Updated";
    let statusType = "updated";
    const statusMatch = rest.match(/Status:\s*'([^\']+)'\s*->\s*'([^\']+)'/i);
    if (statusMatch) {
      const from = statusMatch[1].toUpperCase();
      const to = statusMatch[2].toUpperCase();
      if (to === "PAID") {
        status = "Paid";
        statusType = "paid";
      } else if (to === "OVERDUE") {
        status = "Overdue (was Paid)";
        statusType = "overdue";
      } else {
        status = `${to} (was ${from})`;
        statusType = "transition";
      }
    } else if (rest.includes("Amount:")) {
      status = "New Invoice";
      statusType = "new";
    }

    return {
      invoiceNumber: invNum,
      clientName: cName,
      jobName: jName,
      amount: amount || "",
      dates,
      status,
      statusType,
      rawChanges: rest
    };
  }

  // Format 2: [Confirmed|Pipeline] Updated Invoice 2181-1: Row 362, BW&P Ltd | RMO Outsource, Slot 1 - Status: 'Paid' -> 'Sent'
  const updatedInvMatch = line.match(/^\[(Pipeline|Confirmed)\]\s*Updated\s*Invoice\s*([^:]+):\s*Row\s*(\d+),\s*([^,|]+)(?:\|\s*([^,]+))?,\s*Slot\s*(\d+)(?:\s*-\s*(.+))?/i);
  if (updatedInvMatch) {
    const sheet = updatedInvMatch[1];
    const invNum = updatedInvMatch[2].trim();
    const row = updatedInvMatch[3];
    const cName = updatedInvMatch[4].trim();
    const jName = updatedInvMatch[5] ? updatedInvMatch[5].trim() : "";
    const slot = `Slot ${updatedInvMatch[6]}`;
    const rest = updatedInvMatch[7] ? updatedInvMatch[7].trim() : "";

    let status = "Updated";
    let statusType = "updated";
    const statusMatch = rest.match(/Status:\s*'([^\']+)'\s*->\s*'([^\']+)'/i);
    if (statusMatch) {
      const from = statusMatch[1].toUpperCase();
      const to = statusMatch[2].toUpperCase();
      if (to === "PAID") {
        status = "Paid";
        statusType = "paid";
      } else if (to === "SENT") {
        status = `Sent (was ${from})`;
        statusType = from === "PAID" ? "overdue" : "transition";
      } else {
        status = `${to} (was ${from})`;
        statusType = "transition";
      }
    } else if (rest.includes("Client (Block Update)")) {
      status = "Client Name Updated";
      statusType = "updated";
    }

    let amount = "";
    const amtM = rest.match(/£([\d,]+(?:\.\d{2})?)/);
    if (amtM) amount = `£${amtM[1]}`;

    return {
      sheet,
      row,
      slot,
      invoiceNumber: invNum,
      clientName: cName,
      jobName: jName,
      amount,
      dates: [],
      status,
      statusType,
      rawChanges: rest
    };
  }

  // Format 3: Stale Invoice
  const staleMatch = line.match(/^\[(Pipeline|Confirmed)\]\s*Stale\s*Invoice\s*-\s*Row\s*(\d+),\s*([^|]+)\|\s*([^,]+),\s*Slot\s*(\d+):\s*(.+)/i);
  if (staleMatch) {
    return {
      sheet: staleMatch[1],
      row: staleMatch[2],
      slot: `Slot ${staleMatch[5]}`,
      invoiceNumber: "Stale",
      clientName: staleMatch[3].trim(),
      jobName: staleMatch[4].trim(),
      amount: "",
      dates: [staleMatch[6].trim()],
      status: "Date Moved",
      statusType: "updated",
      rawChanges: staleMatch[6].trim()
    };
  }

  return null;
}

function parseExpenseLine(line) {
  // Format 1: [ID: ...] Supplier - Job - Changes
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
    let statusType = "updated";
    const dates = [];

    // VAT change
    const vatMatch = rawRest.match(/VAT:\s*(?:'([^']+)'|([^\s->]+))\s*->\s*(?:'([^']+)'|([^\s,]+))/i);
    if (vatMatch) {
      status = "VAT Adjusted";
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
        statusType = "transition";
      } else {
        status = statusMatch[1];
        statusType = status.toUpperCase() === "PAID" ? "paid" : "updated";
      }
    } else if (rawRest.includes("Amount:") && !statusMatch) {
      status = "New Expense";
      statusType = "new";
    }

    return {
      supplier: supplier.trim(),
      jobOrRef: jobOrRef.trim(),
      amount,
      dates,
      status,
      statusType,
      rawChanges: changes.trim() || rawRest
    };
  }

  // Format 2: [Outgoings] Adjusted Manual Entry - Oct 2026 row 111, Making up CoS to 55.%: £4015.46 -> £4627.33
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

    return {
      sheet,
      row,
      supplier: desc,
      jobOrRef: `${dateStr}`,
      amount,
      dates: [dateStr],
      status: "Manual Adjusted",
      statusType: "manual",
      rawChanges: rest
    };
  }

  // Format 3: Stale / Overdue expense updates
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

    return {
      sheet,
      row,
      slot,
      supplier: cName,
      jobOrRef: jName,
      amount: "",
      dates,
      status: "Date Moved",
      statusType: "updated",
      rawChanges: changes
    };
  }

  // Format 4: [Confirmed|Outgoings] Matched/Updated/Created entries
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

    const cleanDesc = rest.replace(/\(£[\d,]+(?:\.\d{2})?\)/, "").trim();

    return {
      sheet,
      row,
      supplier: cleanDesc,
      jobOrRef: "",
      amount: amt,
      dates: [],
      status: `${actionType}`,
      statusType: actionType.toLowerCase().includes("created") ? "new" : "updated",
      rawChanges: rest
    };
  }

  return null;
}

// TEST CASES
const testInvoices = [
  "Inv #RV-1214 (Omnis Intelligence Limited | Phase 2 - September) - Amount: £13,550.00 +VAT | Sent: 24-Sep-26 | Due: 24-Oct-26",
  "Inv #INV-1846 (SWANKY GROUP LIMITED | GB_Swanky_August) - Due Date: 'Blank' -> '23-Oct-26', Status: 'DRAFT' -> 'AUTHORISED', Amount Due: '369.60' -> '235.20', Total: '369.60' -> '235.20'",
  "Inv #INV-1817 (Outside In (Cambridge) Ltd | Klaviyo support) - Status: 'AUTHORISED' -> 'PAID', Amount Due: '1,320.00' -> '0.00', Amount Paid: '0.00' -> '1,320.00', Fully Paid Date: 'Blank' -> '24-Sep-26'",
  "[Confirmed] Updated Invoice 2181-1: Row 362, BW&P Ltd | RMO Outsource, Slot 1 - Status: 'Paid' -> 'Sent'",
  "[Confirmed] Stale Invoice - Row 382, Northoaks Capital Ltd | Brand identity, Slot 1: Date moved 05-Sep-26 -> 28-Sep-26"
];

console.log("=== INVOICES ===");
for (const line of testInvoices) {
  console.log(parseInvoiceLine(line));
}

const testExpenses = [
  "[ID: 4eff7590-ff7a-4c15-a874-fc386df6f3cd] ALM Translations - 2025/776 (2025/776) - VAT: '1,819,000,000,000,000.00' -> '78.00'",
  "[ID: 7352] Light Ink Creative (Bill) - Amount: £10,400.00 +VAT | Date: 21-Sep-26 | Ref: 1007 | Acct: Subcontractors | Status: UNPAID",
  "[Outgoings] Adjusted Manual Entry - Oct 2026 row 111, Making up CoS to 55.%: £4015.46 -> £4627.33",
  "[Confirmed] Row 382, Northoaks Capital Ltd | Brand identity, Slot 1: Rec Date updated 05-Sep-26 -> 28-Sep-26",
  "[Confirmed] Matched Row 138: Contractor A - Retainer Fee (£1,200.00) - Slot 1 updated."
];

console.log("\n=== EXPENSES ===");
for (const line of testExpenses) {
  console.log(parseExpenseLine(line));
}
