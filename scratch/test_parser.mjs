const lines = [
  "[Confirmed] Updated Invoice 1544: Row 286, Alive Publishing Group Inc | Development, Ecommerce, Web Deisgn, Slot 1 - Days to Pay: 15 -> 7",
  "[Confirmed] Overdue Update - Row 286, Alive Publishing Group Inc | Development, Ecommerce, Web Deisgn, Slot 1: Extended days 7 -> 15",
  "  - Inv #INV-1544 (Alive Publishing Group Inc | Alive-004) - Fully Paid Date: '28-Aug-26' -> 'Blank'",
  "[Confirmed] Updated Invoice 1200: Row 105, Alive Publishing Group Inc | Brand Identity - Client: 'Alive Publishing Group Inc' -> 'Alive Publishing'",
  "Updated Pipeline: Row 42, Client | Job - Copied Status: 'Yes' -> 'No'",
  "[Confirmed] Stale Invoice - Row 21, ACME | Project, Slot 1: Date moved 01-Jan-26 -> 08-Jan-26",
];

function cleanVal(v) {
  if (!v) return "";
  let s = String(v).trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function parseLineTransitions(line) {
  if (!line || !line.includes("->")) return [];
  const results = [];

  // Match: ... [Field]: [FromVal] -> [ToVal]
  // Note: Values may contain hyphens (e.g. dates like 28-Aug-26) or spaces
  const p1 = /(?:[-–•,\n:]|^)\s*([A-Za-z\s]+?)\s*:\s*('?[^':\r\n]+?'?)\s*->\s*('?[^':\r\n;]+?'?)(?:[\r\n,;]|$)/g;
  let m;
  while ((m = p1.exec(line)) !== null) {
    const rawField = m[1].trim();
    const fromVal = cleanVal(m[2]);
    const toVal = cleanVal(m[3]);
    if (rawField.length <= 35 && fromVal && toVal && fromVal.toLowerCase() !== toVal.toLowerCase()) {
      results.push({ rawField, fromVal, toVal });
    }
  }

  // Match: ... (Extended days|Date moved) [FromVal] -> [ToVal]
  const p2 = /(?:[-–•,:\n]|^)\s*(Extended days|Date moved)\s+('?[^':\r\n]+?'?)\s*->\s*('?[^':\r\n;]+?'?)(?:[\r\n,;]|$)/gi;
  while ((m = p2.exec(line)) !== null) {
    const rawField = m[1].trim();
    const fromVal = cleanVal(m[2]);
    const toVal = cleanVal(m[3]);
    if (fromVal && toVal && fromVal.toLowerCase() !== toVal.toLowerCase()) {
      results.push({ rawField, fromVal, toVal });
    }
  }

  return results;
}

lines.forEach((l, idx) => {
  console.log(`Line ${idx + 1}:`, parseLineTransitions(l));
});

