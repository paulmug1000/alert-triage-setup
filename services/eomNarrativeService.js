import zlib from "zlib";
import { getDriveClient, getGoogleAuth, withRetry, extractSheetIdFromUrl } from "./sheetsClient";
import { anthropic } from "./claudeClient";
import { logClaudeUsage_ } from "./systemConfig";
import { logPmaActivity } from "./pmaLogger";
import { getSessionUser } from "./authService";
import { getAllClients, DEFAULT_AC_SHEET_ID } from "./workspaces";
import {
  REPORTING_CONTROL_SHEET_ID,
  CLIENT_VERSION_TRACKER_SHEET_ID,
  DEFAULT_REPORTING_WEBAPP_URL,
  ensureEomReportingTabs_,
  isValidGoogleScriptUrl
} from "./eomTools";

// ============================================================================
// 1. PURE NODE.JS IN-MEMORY .PPTX (ZIP + XML) PARSER
// ============================================================================

/**
 * Extracts files from a ZIP buffer (such as a .pptx export) in memory using Node's built-in zlib.
 * Returns a Map<string, Buffer> mapping internal zip paths to uncompressed Buffers.
 */
function unzipBufferToMap_(zipBuf) {
  const buf = Buffer.isBuffer(zipBuf) ? zipBuf : Buffer.from(zipBuf);
  const files = new Map();

  // Find End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  const minEocdOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minEocdOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Invalid PPTX archive: End of Central Directory not found.");
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let ptr = cdOffset;
  const cdEnd = Math.min(buf.length, cdOffset + cdSize);

  for (let idx = 0; idx < totalEntries && ptr + 46 <= cdEnd; idx++) {
    const sig = buf.readUInt32LE(ptr);
    if (sig !== 0x02014b50) break;

    const compressionMethod = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const fileNameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);

    const fileName = buf.slice(ptr + 46, ptr + 46 + fileNameLen).toString("utf8");
    ptr += 46 + fileNameLen + extraLen + commentLen;

    if (fileName.endsWith("/")) continue;
    if (localHeaderOffset + 30 > buf.length) continue;

    const localSig = buf.readUInt32LE(localHeaderOffset);
    if (localSig !== 0x04034b50) continue;

    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) continue;

    const compressedSlice = buf.slice(dataStart, dataEnd);
    try {
      if (compressionMethod === 0) {
        files.set(fileName, compressedSlice);
      } else if (compressionMethod === 8) {
        files.set(fileName, zlib.inflateRawSync(compressedSlice));
      }
    } catch (zlibErr) {
      console.warn(`[unzipBufferToMap_] Could not inflate ${fileName}:`, zlibErr.message);
    }
  }

  return files;
}

function decodeXmlEntities_(str) {
  if (!str) return "";
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractTextFromParagraphXml_(pXml) {
  const runs = [];
  const regex = /<a:t>([\s\S]*?)<\/a:t>|<a:br\s*\/?>/g;
  let m;
  while ((m = regex.exec(pXml)) !== null) {
    if (m[0].startsWith("<a:br")) {
      runs.push("\n");
    } else {
      runs.push(decodeXmlEntities_(m[1]));
    }
  }
  return runs.join("");
}

/**
 * Parses a shape's paragraphs preserving bullet vs heading structure
 */
function parseShapeParagraphs_(spXml) {
  const paragraphs = [];
  const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let m;
  while ((m = pRegex.exec(spXml)) !== null) {
    const pInner = m[1];
    const text = extractTextFromParagraphXml_(pInner).trim();
    const hasBuNone = /<a:buNone\s*\/?>/.test(pInner);
    const hasBullet = !hasBuNone && (/<a:buChar\b/.test(pInner) || /<a:buAutoNum\b/.test(pInner));

    // Check if the runs in this paragraph are bold
    const rPrMatches = [...pInner.matchAll(/<a:rPr\b([^>]*)\/?>/g)];
    const isBold = rPrMatches.length > 0 && rPrMatches.every(rm => /\bb="1"/.test(rm[1]));

    // Extract first font size if present
    let fontSizePt = null;
    for (const rm of rPrMatches) {
      const szMatch = rm[1].match(/\bsz="(\d+)"/);
      if (szMatch) {
        fontSizePt = parseInt(szMatch[1], 10) / 100;
        break;
      }
    }

    paragraphs.push({
      text,
      hasBullet,
      hasBuNone,
      isBold,
      fontSizePt
    });
  }
  return paragraphs;
}

/**
 * Formats parsed shape paragraphs into clean human-editable text with `• ` bullets
 * and unbulleted section headers (like `Month in review` and `Key takeaways from this report`).
 */
function formatParagraphsForEditor_(paragraphs) {
  const lines = [];
  for (const p of paragraphs) {
    if (!p.text) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      continue;
    }
    const cleanText = p.text.replace(/^[•■▪●\-–]\s*/, "").trim();
    const isSectionHeader =
      /^month in review$/i.test(cleanText) ||
      /^key takeaways/i.test(cleanText) ||
      (p.isBold && !p.hasBullet && cleanText.length < 60 && !cleanText.includes(":"));

    if (isSectionHeader) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(cleanText);
    } else if (p.hasBullet) {
      lines.push(`• ${cleanText}`);
    } else {
      lines.push(cleanText);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function resolveRelTargetPath_(baseDir, target) {
  if (!target) return "";
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${baseDir}/${target}`.split("/");
  const resolved = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

/**
 * Parses a full .pptx Buffer into structured slide objects
 */
export function parsePptxBuffer(pptxBuffer, options = { includeImages: true }) {
  const zipMap = unzipBufferToMap_(pptxBuffer);

  // Discover all slideX.xml files
  const slidePaths = [];
  for (const key of zipMap.keys()) {
    const m = key.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (m) {
      slidePaths.push({ path: key, slideNumber: parseInt(m[1], 10) });
    }
  }
  slidePaths.sort((a, b) => a.slideNumber - b.slideNumber);

  const slides = [];

  for (const { path: slidePath, slideNumber } of slidePaths) {
    const slideXml = zipMap.get(slidePath)?.toString("utf8") || "";
    const relsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
    const relsXml = zipMap.get(relsPath)?.toString("utf8") || "";

    // 1. Parse relationships for notesSlide and embedded images
    let notesTargetPath = "";
    const imageRelMap = new Map(); // rId -> zip path
    const relRegex = /<Relationship\b([^>]*)\/?>/g;
    let relMatch;
    while ((relMatch = relRegex.exec(relsXml)) !== null) {
      const attrs = relMatch[1];
      const idMatch = attrs.match(/\bId="([^"]+)"/);
      const typeMatch = attrs.match(/\bType="([^"]+)"/);
      const targetMatch = attrs.match(/\bTarget="([^"]+)"/);
      if (!idMatch || !typeMatch || !targetMatch) continue;
      const rId = idMatch[1];
      const relType = typeMatch[1];
      const target = targetMatch[1];

      if (relType.endsWith("/notesSlide")) {
        notesTargetPath = resolveRelTargetPath_("ppt/slides", target);
      } else if (relType.endsWith("/image")) {
        imageRelMap.set(rId, resolveRelTargetPath_("ppt/slides", target));
      }
    }

    // 2. Extract speaker notes, [ChartRef] code, and real Google Slides pageId (g...)
    let speakerNotes = "";
    let chartCode = "";
    let pageId = "";
    if (notesTargetPath && zipMap.has(notesTargetPath)) {
      const notesXml = zipMap.get(notesTargetPath).toString("utf8");
      const pageIdMatch = notesXml.match(/name="Google Shape;\d+;([^":]+):notes"/);
      if (pageIdMatch) {
        pageId = pageIdMatch[1];
      }
      const notesSpRegex = /<p:sp\b[\s\S]*?<\/p:sp>/g;
      const noteParts = [];
      let nsm;
      while ((nsm = notesSpRegex.exec(notesXml)) !== null) {
        const spBlock = nsm[0];
        if (/<p:ph\b[^>]*type="sldNum"/.test(spBlock) || /<p:ph\b[^>]*type="sldImg"/.test(spBlock)) {
          continue;
        }
        const pMatches = [...spBlock.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)];
        const text = pMatches.map(pm => extractTextFromParagraphXml_(pm[1]).trim()).filter(Boolean).join("\n");
        if (text) noteParts.push(text);
      }
      speakerNotes = noteParts.join("\n").trim();
      const codeMatch = speakerNotes.match(/\[[A-Za-z0-9_]+\]/);
      if (codeMatch) {
        chartCode = codeMatch[0];
      }
    }

    // 3. Extract tables (<a:tbl>)
    const tables = [];
    const tblRegex = /<a:tbl\b[\s\S]*?<\/a:tbl>/g;
    let tblMatch;
    while ((tblMatch = tblRegex.exec(slideXml)) !== null) {
      const tblXml = tblMatch[0];
      const rows = [];
      const trRegex = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g;
      let trMatch;
      while ((trMatch = trRegex.exec(tblXml)) !== null) {
        const trXml = trMatch[1];
        const rowCells = [];
        const tcRegex = /<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>/g;
        let tcMatch;
        while ((tcMatch = tcRegex.exec(trXml)) !== null) {
          const tcAttrs = tcMatch[1] || "";
          const tcInner = tcMatch[2] || "";
          const isHMerge = /\bhMerge="1"/.test(tcAttrs);
          const isVMerge = /\bvMerge="1"/.test(tcAttrs);
          if (isHMerge || isVMerge) {
            rowCells.push("");
            continue;
          }
          const cellParagraphs = [...tcInner.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
            .map(pm => extractTextFromParagraphXml_(pm[1]).trim())
            .filter(Boolean);
          rowCells.push(cellParagraphs.join(" "));
        }
        // Keep rows that have at least one non-empty cell
        if (rowCells.some(c => c !== "")) {
          rows.push(rowCells);
        }
      }
      if (rows.length > 0) {
        tables.push(rows);
      }
    }

    // 4. Extract embedded chart images (<p:pic>)
    const chartImages = [];
    let hasCharts = false;
    const picRegex = /<p:pic\b[\s\S]*?<\/p:pic>/g;
    let picMatch;
    while ((picMatch = picRegex.exec(slideXml)) !== null) {
      const picXml = picMatch[0];
      const cNvPrMatch = picXml.match(/<p:cNvPr\b([^>]*)\/?>/);
      const cNvAttrs = cNvPrMatch ? cNvPrMatch[1] : "";
      const isTitledChart = /\btitle="Chart"/i.test(cNvAttrs) || /\bdescr="Chart"/i.test(cNvAttrs);

      const offMatch = picXml.match(/<a:off\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/);
      const extMatch = picXml.match(/<a:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
      const x = offMatch ? parseInt(offMatch[1], 10) : 0;
      const y = offMatch ? parseInt(offMatch[2], 10) : 0;
      const cx = extMatch ? parseInt(extMatch[1], 10) : 0;
      const cy = extMatch ? parseInt(extMatch[2], 10) : 0;

      // Filter out small top-corner client logo (typically y < 300000, cx < 1300000, cy < 600000, without title="Chart")
      const isLargeChartGraphic = cx > 1500000 && cy > 700000 && y > 250000;
      if (!isTitledChart && !isLargeChartGraphic) {
        continue;
      }

      hasCharts = true;
      if (options.includeImages) {
        const blipMatch = picXml.match(/<a:blip\b[^>]*r:embed="([^"]+)"/);
        if (blipMatch) {
          const rId = blipMatch[1];
          const mediaPath = imageRelMap.get(rId);
          if (mediaPath && zipMap.has(mediaPath)) {
            const imgBuf = zipMap.get(mediaPath);
            const ext = mediaPath.endsWith(".jpg") || mediaPath.endsWith(".jpeg") ? "image/jpeg" : "image/png";
            chartImages.push({
              rId,
              mediaPath,
              mimeType: ext,
              base64: imgBuf.toString("base64"),
              x,
              y,
              cx,
              cy
            });
          }
        }
      }
    }

    // 5. Extract text shapes (<p:sp>) -> identify title, flag, slide number, and narrative commentary
    const textShapes = [];
    let hasFlag = false;
    const spRegex = /<p:sp\b[\s\S]*?<\/p:sp>/g;
    let spMatch;
    while ((spMatch = spRegex.exec(slideXml)) !== null) {
      const spXml = spMatch[0];
      const cNvPrMatch = spXml.match(/<p:cNvPr\b([^>]*)\/?>/);
      const cNvAttrs = cNvPrMatch ? cNvPrMatch[1] : "";
      const idMatch = cNvAttrs.match(/\bid="([^"]+)"/);
      const nameMatch = cNvAttrs.match(/\bname="([^"]+)"/);
      const shapeId = idMatch ? idMatch[1] : "";
      const shapeName = nameMatch ? decodeXmlEntities_(nameMatch[1]) : "";

      const phMatch = spXml.match(/<p:ph\b([^>]*)\/?>/);
      const phType = phMatch ? (phMatch[1].match(/\btype="([^"]+)"/)?.[1] || "body") : "";

      const offMatch = spXml.match(/<a:off\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/);
      const extMatch = spXml.match(/<a:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
      const x = offMatch ? parseInt(offMatch[1], 10) : 0;
      const y = offMatch ? parseInt(offMatch[2], 10) : 0;
      const cx = extMatch ? parseInt(extMatch[1], 10) : 0;
      const cy = extMatch ? parseInt(extMatch[2], 10) : 0;

      const paragraphs = parseShapeParagraphs_(spXml);
      const rawText = paragraphs.map(p => p.text).filter(Boolean).join("\n").trim();
      if (!rawText) continue;

      if (phType === "sldNum" || rawText === "‹#›" || /^\d{1,2}$/.test(rawText)) {
        continue;
      }

      // Skip bottom-right slide number box (y > 360pt / 4572000 EMU, x > 600pt / 7620000 EMU, cx < 85pt / 1079500 EMU)
      if (y > 4572000 && x > 7620000 && cx < 1079500) {
        continue;
      }

      if (rawText.includes("🚩")) {
        hasFlag = true;
        if (rawText.replace(/🚩/g, "").trim() === "") {
          continue;
        }
      }

      // Skip tiny badges or shapes narrower than 95pt (1206500 EMU) or shorter than 35pt (444500 EMU) unless it's a title
      if (y >= 700000 && (cx < 1206500 || cy < 444500)) {
        continue;
      }

      const maxFontSize = paragraphs.reduce((max, p) => Math.max(max, p.fontSizePt || 0), 0);
      const formattedText = formatParagraphsForEditor_(paragraphs);

      textShapes.push({
        shapeId,
        shapeName,
        phType,
        x,
        y,
        cx,
        cy,
        maxFontSize,
        rawText,
        formattedText,
        paragraphs
      });
    }

    // Identify slide title vs narrative shape
    let slideTitle = "";
    let titleShapeId = null;
    if (textShapes.length > 0) {
      // Sort candidates for title: top-most shape with y < 700000 or largest font size >= 20pt
      const titleCandidates = textShapes
        .filter(s => (s.y < 700000 && s.rawText.length < 90) || s.maxFontSize >= 20)
        .sort((a, b) => a.y - b.y || b.maxFontSize - a.maxFontSize);

      if (titleCandidates.length > 0) {
        slideTitle = titleCandidates[0].rawText.replace(/\s+/g, " ").trim();
        titleShapeId = titleCandidates[0].shapeId;
      } else {
        const sortedByY = [...textShapes].sort((a, b) => a.y - b.y);
        if (sortedByY[0].rawText.length < 90) {
          slideTitle = sortedByY[0].rawText.replace(/\s+/g, " ").trim();
          titleShapeId = sortedByY[0].shapeId;
        }
      }
    }

    const remainingShapes = textShapes.filter(s => s.shapeId !== titleShapeId);
    let narrativeShape = null;
    if (remainingShapes.length > 0) {
      // Pick the shape with the most text content (or right-most / bottom-most commentary box)
      const sortedNarrative = [...remainingShapes].sort((a, b) => b.formattedText.length - a.formattedText.length);
      const picked = sortedNarrative[0];
      const isTakeawaysSlide =
        chartCode === "[BusinessPerformance]" ||
        /month in review/i.test(picked.formattedText) ||
        /key takeaways/i.test(picked.formattedText) ||
        /^business performance$/i.test(slideTitle);

      narrativeShape = {
        shapeId: picked.shapeId,
        shapeName: picked.shapeName,
        text: picked.formattedText,
        rawText: picked.rawText,
        isTakeawaysSlide,
        x: picked.x,
        y: picked.y,
        cx: picked.cx,
        cy: picked.cy
      };
    }

    // Determine if this slide belongs in the Narrative Workbench:
    // Only slides that actually carry a narrative commentary shape (excluding cover Slide 1, MonthSnapshot/QuarterSnapshot, and Thank You)
    const isSnapshotSlide = chartCode === "[MonthSnapshot]" || chartCode === "[QuarterSnapshot]";
    const isCoverOrDivider =
      slideNumber === 1 ||
      (!chartCode && tables.length === 0 && !hasCharts && (!narrativeShape || narrativeShape.text.length < 20)) ||
      /^thank you/i.test(slideTitle);

    const isNarrativeSlide = !isSnapshotSlide && !isCoverOrDivider && Boolean(narrativeShape);

    const isTakeawaysSlide =
      chartCode === "[BusinessPerformance]" ||
      /^business performance$/i.test(slideTitle) ||
      /performance and key takeaways/i.test(slideTitle) ||
      Boolean(narrativeShape?.isTakeawaysSlide);

    slides.push({
      slideNumber,
      pageId,
      slideTitle: slideTitle || (chartCode ? chartCode.replace(/^\[|\]$/g, "") : `Slide ${slideNumber}`),
      speakerNotes,
      chartCode,
      hasFlag,
      tables,
      chartImages,
      hasCharts,
      narrativeShape,
      currentText: narrativeShape ? narrativeShape.text : "",
      isTakeawaysSlide,
      isSnapshotSlide,
      isNarrativeSlide
    });
  }

  return slides;
}

// ============================================================================
// 2. PRESENTATION DISCOVERY & HISTORICAL DECK MATCHING
// ============================================================================

export function extractDriveIdFromUrl_(urlOrId) {
  if (!urlOrId) return "";
  const s = String(urlOrId).trim();
  const folderMatch = s.match(/\/folders\/([a-zA-Z0-9-_]+)/);
  if (folderMatch) return folderMatch[1];
  const fileMatch = s.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (fileMatch) return fileMatch[1];
  const idMatch = s.match(/([a-zA-Z0-9-_]{25,})/);
  return idMatch ? idMatch[1] : "";
}

function monthKeyToYyMm_(monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return "";
  const [y, m] = monthKey.split("-");
  return `${y.slice(-2)}${m}`;
}

function yyMmToMonthKey_(yyMm) {
  if (!yyMm || !/^\d{4}$/.test(yyMm)) return "";
  return `20${yyMm.slice(0, 2)}-${yyMm.slice(2, 4)}`;
}

function parseHeaderToMonthKeyLocal_(headerStr) {
  if (!headerStr) return "";
  const s = String(headerStr).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const match = s.match(/^([a-zA-Z]+)[\s-]*(\d{2,4})$/);
  if (match) {
    const m = months[match[1].toLowerCase().slice(0, 3)];
    let y = match[2];
    if (y.length === 2) y = "20" + y;
    if (m && y) return `${y}-${m}`;
  }
  return "";
}

function normalizeChartFamily_(chartCode) {
  if (!chartCode) return "";
  const clean = chartCode.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean.startsWith("overheads")) return "overheads";
  if (clean.startsWith("bookings")) return "bookings";
  if (clean.startsWith("pipeline")) return "pipeline";
  if (clean.startsWith("util")) return "util";
  return clean;
}

/**
 * Normalizes slide text for clone comparison, stripping bullets and month/year tokens
 * so that decks where `replaceAllText("September", "October")` ran during deck creation
 * are still accurately identified as unedited clones of the prior month.
 */
function normalizeTextForComparison_(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .replace(/[•■▪●\-–]/g, " ")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi, "")
    .replace(/\b202\d\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolves the target month's presentation ID and up to 4 prior monthly presentations
 * using ReportsLog on Reporting Control sheet + the client's Mgmt Reports Drive folder.
 */
async function resolveClientPresentations_(sheets, drive, clientName, reportMonthKey, providedFolderUrl) {
  const deckMap = new Map(); // monthKey ("YYYY-MM") -> { monthKey, presentationId, reportUrl, title }
  let folderUrl = providedFolderUrl || "";
  let reconSheetId = "";
  let clientSheetId = "";
  let masterSheetId = "";

  // 1. Read ReportsLog, EomReportingConfig, and RepControl on Reporting Control sheet
  try {
    const batchResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: REPORTING_CONTROL_SHEET_ID,
      ranges: [
        "ReportsLog!A1:Z100",
        "EomReportingConfig!A2:I500",
        "RepControl!A5:BZ100"
      ],
      valueRenderOption: "FORMATTED_VALUE"
    }));

    const logRows = batchResp.data.valueRanges?.[0]?.values || [];
    const cfgRows = batchResp.data.valueRanges?.[1]?.values || [];
    const repRows = batchResp.data.valueRanges?.[2]?.values || [];

    const headerRow = logRows[0] || [];
    const colMonthKeys = headerRow.map((h, i) => (i === 0 ? "" : parseHeaderToMonthKeyLocal_(h)));

    for (let r = 1; r < logRows.length; r++) {
      const row = logRows[r] || [];
      if (String(row[0] || "").trim().toLowerCase() === clientName.trim().toLowerCase()) {
        for (let c = 1; c < row.length; c++) {
          const url = String(row[c] || "").trim();
          const mKey = colMonthKeys[c];
          const presId = extractDriveIdFromUrl_(url);
          if (mKey && presId) {
            deckMap.set(mKey, {
              monthKey: mKey,
              presentationId: presId,
              reportUrl: url,
              title: `${clientName} (${headerRow[c] || mKey})`
            });
          }
        }
        break;
      }
    }

    if (!folderUrl) {
      const cfgMatch = cfgRows.find(r => String(r[0] || "").trim().toLowerCase() === clientName.trim().toLowerCase());
      if (cfgMatch && cfgMatch[4]) folderUrl = String(cfgMatch[4]).trim();
    }

    // RepControl columns: 0=Client, 16=Client sheet, 17=Master sheet, 32=Mgmt Reports folder, 34=Recon sheet
    const repMatch = repRows.find(r => String(r[0] || "").trim().toLowerCase() === clientName.trim().toLowerCase());
    if (repMatch) {
      if (!clientSheetId && repMatch[16]) clientSheetId = extractSheetIdFromUrl(repMatch[16]) || "";
      if (!masterSheetId && repMatch[17]) masterSheetId = extractSheetIdFromUrl(repMatch[17]) || "";
      if (!folderUrl && repMatch[32]) folderUrl = String(repMatch[32]).trim();
      if (!reconSheetId && repMatch[34]) reconSheetId = extractSheetIdFromUrl(repMatch[34]) || "";
    }
  } catch (err) {
    console.warn(`[resolveClientPresentations_] Reporting Control lookup note for ${clientName}:`, err.message);
  }

  // 2. Fallback to Client Version Tracker if folderUrl is still missing
  if (!folderUrl) {
    try {
      const trackerResp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: CLIENT_VERSION_TRACKER_SHEET_ID,
        range: "Clients!A2:BA100",
        valueRenderOption: "FORMATTED_VALUE"
      }));
      const matchRow = (trackerResp.data.values || []).find(
        r => String(r[0] || "").trim().toLowerCase() === clientName.trim().toLowerCase()
      );
      if (matchRow && matchRow[52]) {
        folderUrl = String(matchRow[52]).trim();
      }
    } catch (_) {}
  }

  // 3. Also scan the client's Mgmt Reports Drive folder for presentations containing a 4-digit yyMM code (e.g. "Eleven 2609 Management Report Sep26")
  const folderId = extractDriveIdFromUrl_(folderUrl);
  if (folderId) {
    try {
      const listResp = await withRetry(() => drive.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.presentation' and trashed = false`,
        fields: "files(id, name, webViewLink, modifiedTime)",
        orderBy: "name desc, modifiedTime desc",
        pageSize: 40,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      }));
      for (const file of listResp.data.files || []) {
        const nameMatch = String(file.name || "").trim().match(/\b(2\d(?:0[1-9]|1[0-2]))\b/);
        if (nameMatch) {
          const mKey = yyMmToMonthKey_(nameMatch[1]);
          if (mKey && !deckMap.has(mKey)) {
            deckMap.set(mKey, {
              monthKey: mKey,
              presentationId: file.id,
              reportUrl: file.webViewLink || `https://docs.google.com/presentation/d/${file.id}/edit`,
              title: file.name
            });
          }
        }
      }
    } catch (driveErr) {
      console.warn(`[resolveClientPresentations_] Folder scan note for ${clientName}:`, driveErr.message);
    }
  }

  const allDecksSorted = [...deckMap.values()].sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  const targetDeck = (reportMonthKey && deckMap.get(reportMonthKey)) || allDecksSorted[0] || null;
  const effectiveMonthKey = targetDeck?.monthKey || reportMonthKey || "";

  // Load up to 4 prior monthly presentations so the user can scroll through earlier months
  const priorDecks = allDecksSorted
    .filter(d => d.monthKey < effectiveMonthKey && d.presentationId !== targetDeck?.presentationId)
    .slice(0, 4);

  return {
    targetDeck,
    priorDecks,
    effectiveMonthKey,
    folderUrl,
    reconSheetId,
    clientSheetId,
    masterSheetId
  };
}

async function exportPresentationAsPptxBuffer_(drive, presentationId) {
  const resp = await withRetry(() =>
    drive.files.export(
      {
        fileId: presentationId,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      },
      { responseType: "arraybuffer" }
    )
  );
  return Buffer.from(resp.data);
}

// ============================================================================
// 3. SUPPLIER & OVERHEAD TRANSACTION CONTEXT (CLIENT OUTGOINGS ROW 300 + RECON)
// ============================================================================

function parseAmountNum_(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s || s === "-" || s === "—") return null;
  const isNegParen = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[£$,%\s()]/g, "");
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return isNegParen ? -Math.abs(num) : num;
}

function formatGbpShort_(num) {
  if (num === null || num === undefined || !Number.isFinite(num)) return "£0";
  const sign = num < 0 ? "-" : "";
  const abs = Math.round(Math.abs(num));
  return `${sign}£${abs.toLocaleString("en-GB")}`;
}

/**
 * Pulls overhead supplier transaction details from:
 * 1. Client Sheet `Outgoings!A300:AZ300` ("Transactions Breakdown (JSON)" synced by 7_Cost_Sync.gs,
 *    containing all reconciled Xero/QBO bills, bank spend, journals, and unreconciled items by category)
 * 2. Recon Sheet `'yyMM'!CD1:CR160` (unreconciled expenses: CF=Date, CG=Payee, CH=Desc, CI=Gross, CM=Category, CP=Net)
 *    and `'yyMM'!A3:Q200` (bank statement Outgoings lines).
 */
async function fetchOverheadTransactionContext_(sheets, {
  reconSheetId,
  clientSheetId,
  masterSheetId,
  reportMonthKey
}) {
  const yyMm = monthKeyToYyMm_(reportMonthKey);
  const result = {
    yyMm,
    reconAvailable: false,
    categoriesMap: {}, // categoryName -> [{ date, payee, description, netAmount, netFormatted, grossFormatted, isUnreconciled }]
    categorisedTransactions: [],
    outgoingsBankLines: []
  };

  if (!yyMm) return result;

  let resolvedReconId = reconSheetId;
  let resolvedClientSheetId = clientSheetId;
  if (!resolvedReconId || !resolvedClientSheetId) {
    try {
      const allClientsData = await getAllClients(sheets, { isAdmin: true }, false);
      const found = (allClientsData.clientsArray || []).find(
        c => (masterSheetId && c.masterSheetId === masterSheetId) || (clientSheetId && c.clientSheetId === clientSheetId)
      );
      if (found) {
        if (!resolvedReconId && found.reconSheetId) resolvedReconId = found.reconSheetId;
        if (!resolvedClientSheetId && found.clientSheetId) resolvedClientSheetId = found.clientSheetId;
      }
    } catch (_) {}
  }

  const seenTxKeys = new Set();
  const addCategorisedTx = (item) => {
    const dedupeKey = `${String(item.category).toLowerCase()}|${String(item.payee).toLowerCase()}|${Math.round(Math.abs(item.netAmount))}|${item.date}`;
    if (seenTxKeys.has(dedupeKey)) return;
    seenTxKeys.add(dedupeKey);

    result.categorisedTransactions.push(item);
    const catKey = item.category || "Uncategorised";
    if (!result.categoriesMap[catKey]) {
      result.categoriesMap[catKey] = [];
    }
    result.categoriesMap[catKey].push(item);
  };

  // 1. Read Client Sheet Outgoings Row 300 JSON breakdown for the target month
  if (resolvedClientSheetId) {
    try {
      const outResp = await withRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId: resolvedClientSheetId,
        ranges: ["Outgoings!A1:AZ1", "Outgoings!A300:AZ300"],
        valueRenderOption: "FORMATTED_VALUE"
      }));
      const headerRow = outResp.data.valueRanges?.[0]?.values?.[0] || [];
      const jsonRow = outResp.data.valueRanges?.[1]?.values?.[0] || [];

      let targetColIdx = -1;
      for (let c = 1; c < headerRow.length; c++) {
        if (parseHeaderToMonthKeyLocal_(headerRow[c]) === reportMonthKey) {
          targetColIdx = c;
          break;
        }
      }

      if (targetColIdx !== -1 && jsonRow[targetColIdx]) {
        const rawJson = String(jsonRow[targetColIdx]).trim();
        if (rawJson.startsWith("[")) {
          const parsedTx = JSON.parse(rawJson);
          if (Array.isArray(parsedTx)) {
            result.reconAvailable = true;
            for (const tx of parsedTx) {
              const netAmount = Number(tx.n ?? tx.g ?? 0);
              if (!Number.isFinite(netAmount) || Math.abs(netAmount) < 1) continue;
              const rawSupplier = String(tx.s || "").trim();
              // Split "Supplier Name (Description)" if formatted that way
              let payee = rawSupplier;
              let description = "";
              const parenIdx = rawSupplier.indexOf(" (");
              if (parenIdx > 0 && rawSupplier.endsWith(")")) {
                payee = rawSupplier.slice(0, parenIdx).trim();
                description = rawSupplier.slice(parenIdx + 2, -1).trim();
                if (/^no desc$/i.test(description)) description = "";
              }
              addCategorisedTx({
                date: String(tx.d || "").trim(),
                payee: payee || "Supplier",
                description,
                category: String(tx.c || "Uncategorised").trim(),
                netAmount,
                netFormatted: formatGbpShort_(netAmount),
                grossFormatted: formatGbpShort_(Number(tx.g ?? netAmount)),
                isUnreconciled: Boolean(tx.u)
              });
            }
          }
        }
      }
    } catch (clientErr) {
      console.warn(`[fetchOverheadTransactionContext_] Client Outgoings row 300 note:`, clientErr.message);
    }
  }

  // 2. Read Recon Sheet tab `yyMM` (CD1:CR160 unreconciled expenses + A3:Q200 bank lines)
  if (resolvedReconId) {
    try {
      const reconBatch = await withRetry(() => sheets.spreadsheets.values.batchGet({
        spreadsheetId: resolvedReconId,
        ranges: [
          `'${yyMm}'!CD1:CR160`,
          `'${yyMm}'!A3:Q200`
        ],
        valueRenderOption: "FORMATTED_VALUE"
      }));

      result.reconAvailable = true;
      const expRows = reconBatch.data.valueRanges?.[0]?.values || [];
      const bankRows = reconBatch.data.valueRanges?.[1]?.values || [];

      // In CD1:CR160 (CD=0, CE=1, CF=2 Date, CG=3 Payee, CH=4 Description, CI=5 Gross Amount, CM=9 Category, CP=12 Amt excl VAT)
      for (let i = 2; i < expRows.length; i++) {
        const r = expRows[i] || [];
        const date = String(r[2] ?? r[0] ?? "").trim();
        const payee = String(r[3] ?? r[1] ?? "").trim();
        const description = String(r[4] ?? r[2] ?? "").trim();
        const grossStr = String(r[5] ?? r[3] ?? "").trim();
        const category = String(r[9] ?? r[7] ?? "").trim();
        const netStr = String(r[12] ?? r[10] ?? grossStr).trim();
        const netAmount = parseAmountNum_(netStr) ?? parseAmountNum_(grossStr) ?? 0;

        if (!payee && !description && !category) continue;
        if (Math.abs(netAmount) < 1) continue;

        addCategorisedTx({
          date,
          payee: payee || description || "Supplier",
          description: description !== payee ? description : "",
          category: category || "Uncategorised",
          netAmount: Math.abs(netAmount),
          netFormatted: formatGbpShort_(Math.abs(netAmount)),
          grossFormatted: grossStr,
          isUnreconciled: true
        });
      }

      // Parse A3:Q200 bank statement Outgoings lines (Col 1=Date, Col 3=Payee, Col 4=Desc, Col 8=Out, Col 16=Type)
      for (let i = 0; i < bankRows.length; i++) {
        const r = bankRows[i] || [];
        const lineType = String(r[16] || "").trim();
        if (!/outgoings|overhead/i.test(lineType)) continue;
        const date = String(r[1] || "").trim();
        const payee = String(r[3] || "").trim();
        const description = String(r[4] || "").trim();
        const outAmt = parseAmountNum_(r[8]);
        if (!outAmt || Math.abs(outAmt) < 25) continue;

        result.outgoingsBankLines.push({
          date,
          payee: payee || description || "Payment",
          description: description !== payee ? description : "",
          amount: outAmt,
          amountFormatted: formatGbpShort_(outAmt)
        });
      }
      result.outgoingsBankLines.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    } catch (reconErr) {
      // Tab yyMM might not exist on Recon sheet for older months; ignore quietly
    }
  }

  // Sort each category's transactions by absolute amount descending
  for (const catKey of Object.keys(result.categoriesMap)) {
    result.categoriesMap[catKey].sort((a, b) => Math.abs(b.netAmount) - Math.abs(a.netAmount));
  }
  result.categorisedTransactions.sort((a, b) => Math.abs(b.netAmount) - Math.abs(a.netAmount));

  return result;
}

/**
 * Checks whether the Overhead expenses slide total matches Slide 3 (`[BusinessPerformance]`)
 * `Other expenses - non-delivery` row, returning a warning if they diverge.
 */
function checkOverheadConsistency_(slides) {
  const perfSlide = slides.find(s => s.chartCode === "[BusinessPerformance]" || /^business performance$/i.test(s.slideTitle));
  const ovhSlide = slides.find(s => /^\[Overheads/i.test(s.chartCode || "") || /^overhead expenses$/i.test(s.slideTitle));
  if (!perfSlide || !ovhSlide) return null;

  const perfTable = perfSlide.tables?.[0] || [];
  const ovhTable = ovhSlide.tables?.[0] || [];

  const nonDelRow = perfTable.find(r => /other expenses\s*-\s*non-delivery/i.test(String(r[0] || "")));
  const ovhTotalRow = ovhTable.find(r => /^total other expenses/i.test(String(r[0] || "")));

  if (!nonDelRow || !ovhTotalRow) return null;

  const perfActual = parseAmountNum_(nonDelRow[1]);
  const ovhActual = parseAmountNum_(ovhTotalRow[1]);

  if (perfActual !== null && ovhActual !== null && Math.abs(perfActual - ovhActual) > 5) {
    return {
      perfSlideNumber: perfSlide.slideNumber,
      ovhSlideNumber: ovhSlide.slideNumber,
      perfActualFormatted: nonDelRow[1],
      ovhActualFormatted: ovhTotalRow[1],
      diffFormatted: formatGbpShort_(Math.abs(perfActual - ovhActual)),
      message: `Overhead total on slide ${ovhSlide.slideNumber} (${ovhTotalRow[1]}) differs from 'Other expenses - non-delivery' on slide ${perfSlide.slideNumber} (${nonDelRow[1]}) by ${formatGbpShort_(Math.abs(perfActual - ovhActual))}. Check that overhead expense categories are finalised and synced.`
    };
  }
  return null;
}

// ============================================================================
// 4. DRAFT PERSISTENCE IN REPORTING CONTROL SHEET (`EomNarrativeDrafts`)
// ============================================================================

async function ensureNarrativeDraftsTab_(sheets) {
  await ensureEomReportingTabs_(sheets, REPORTING_CONTROL_SHEET_ID);
  try {
    const meta = await withRetry(() => sheets.spreadsheets.get({
      spreadsheetId: REPORTING_CONTROL_SHEET_ID,
      fields: "sheets.properties.title"
    }));
    const existing = new Set((meta.data.sheets || []).map(s => s.properties?.title));
    if (!existing.has("EomNarrativeDrafts")) {
      await withRetry(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId: REPORTING_CONTROL_SHEET_ID,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: "EomNarrativeDrafts",
                gridProperties: { rowCount: 500, columnCount: 8, frozenRowCount: 1 }
              }
            }
          }]
        }
      }));
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: REPORTING_CONTROL_SHEET_ID,
        range: "EomNarrativeDrafts!A1:F1",
        valueInputOption: "RAW",
        requestBody: {
          values: [["ClientName", "ReportMonthKey", "PresentationId", "Status", "DraftsJson", "UpdatedAt"]]
        }
      }));
    }
  } catch (err) {
    console.warn("[ensureNarrativeDraftsTab_] Note:", err.message);
  }
}

async function readSavedNarrativeDrafts_(sheets, clientName, reportMonthKey) {
  try {
    await ensureNarrativeDraftsTab_(sheets);
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: REPORTING_CONTROL_SHEET_ID,
      range: "EomNarrativeDrafts!A2:F500",
      valueRenderOption: "FORMATTED_VALUE"
    }));
    const rows = resp.data.values || [];
    const match = rows.find(
      r =>
        String(r[0] || "").trim().toLowerCase() === clientName.trim().toLowerCase() &&
        String(r[1] || "").trim() === reportMonthKey
    );
    if (!match) return { status: null, draftsBySlide: {}, updatedAt: null };
    let draftsBySlide = {};
    if (match[4]) {
      try {
        draftsBySlide = JSON.parse(match[4]) || {};
      } catch (_) {}
    }
    return {
      status: match[3] || "drafted",
      draftsBySlide,
      updatedAt: match[5] || null
    };
  } catch (err) {
    console.warn("[readSavedNarrativeDrafts_] Note:", err.message);
    return { status: null, draftsBySlide: {}, updatedAt: null };
  }
}

async function saveNarrativeDraftsRecord_(sheets, {
  clientName,
  reportMonthKey,
  presentationId,
  status,
  draftsBySlide,
  totalNarrativeSlides
}) {
  await ensureNarrativeDraftsTab_(sheets);
  const now = new Date().toISOString();
  const draftsJson = JSON.stringify(draftsBySlide || {});

  const resp = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: REPORTING_CONTROL_SHEET_ID,
    range: "EomNarrativeDrafts!A2:F500"
  }));
  const rows = resp.data.values || [];
  const existingIdx = rows.findIndex(
    r =>
      String(r[0] || "").trim().toLowerCase() === clientName.trim().toLowerCase() &&
      String(r[1] || "").trim() === reportMonthKey
  );

  const rowValues = [clientName, reportMonthKey, presentationId || "", status || "drafted", draftsJson, now];

  if (existingIdx === -1) {
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: REPORTING_CONTROL_SHEET_ID,
      range: "EomNarrativeDrafts!A:F",
      valueInputOption: "RAW",
      requestBody: { values: [rowValues] }
    }));
  } else {
    const sheetRow = existingIdx + 2;
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: REPORTING_CONTROL_SHEET_ID,
      range: `EomNarrativeDrafts!A${sheetRow}:F${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [rowValues] }
    }));
  }

  // Also update NarrativeStatusByMonth in EomReportingConfig!I so ReportingTab shows the status badge immediately
  try {
    const cfgResp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: REPORTING_CONTROL_SHEET_ID,
      range: "EomReportingConfig!A2:I500"
    }));
    const cfgRows = cfgResp.data.values || [];
    const cfgIdx = cfgRows.findIndex(r => String(r[0] || "").trim().toLowerCase() === clientName.trim().toLowerCase());
    let statusByMonth = {};
    if (cfgIdx !== -1 && cfgRows[cfgIdx]?.[8]) {
      try {
        const parsed = JSON.parse(String(cfgRows[cfgIdx][8]));
        if (parsed && typeof parsed === "object") statusByMonth = parsed;
      } catch (_) {}
    }

    const draftedCount = Object.values(draftsBySlide || {}).filter(d => d && d.text && String(d.text).trim()).length;
    statusByMonth[reportMonthKey] = {
      status: status || "drafted",
      draftedCount,
      totalSlides: totalNarrativeSlides || draftedCount,
      updatedAt: now
    };
    const statusJson = JSON.stringify(statusByMonth);

    if (cfgIdx === -1) {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId: REPORTING_CONTROL_SHEET_ID,
        range: "EomReportingConfig!A:I",
        valueInputOption: "RAW",
        requestBody: {
          values: [[clientName, "", "", "", "", "", now, "", statusJson]]
        }
      }));
    } else {
      const cfgSheetRow = cfgIdx + 2;
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: REPORTING_CONTROL_SHEET_ID,
        range: `EomReportingConfig!I${cfgSheetRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [[statusJson]] }
      }));
    }
  } catch (cfgErr) {
    console.warn("[saveNarrativeDraftsRecord_] Config badge update note:", cfgErr.message);
  }

  return { updatedAt: now };
}

// ============================================================================
// 5. WORKBENCH LOADER ENDPOINT (`handleEomGetNarrativeWorkbench`)
// ============================================================================

/**
 * Replaces any em dashes (—) or spaced en dashes (–) with normal hyphens (" - ")
 * so narratives strictly follow the user's punctuation standard.
 */
function sanitizeNarrativePunctuation_(text) {
  if (!text) return "";
  return String(text)
    .replace(/\s*—\s*/g, " - ")
    .replace(/\s+–\s+/g, " - ");
}

/**
 * Fetches full-slide high-resolution PNG previews directly from Google Slides
 * using each slide's real Google Slides pageId (`g...`) and the Service Account OAuth token.
 */
async function fetchSlidePreviewsMap_(presentationId, slidesList) {
  const previewMap = new Map();
  if (!presentationId || !Array.isArray(slidesList) || slidesList.length === 0) {
    return previewMap;
  }

  try {
    const auth = getGoogleAuth();
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    const token = tokenRes?.token || tokenRes;
    if (!token) return previewMap;

    const validSlides = slidesList.filter(s => s && s.pageId && s.slideNumber);
    const concurrency = 5;
    for (let i = 0; i < validSlides.length; i += concurrency) {
      const batch = validSlides.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async s => {
          try {
            const url = `https://docs.google.com/presentation/d/${encodeURIComponent(presentationId)}/export/png?id=${encodeURIComponent(presentationId)}&pageid=${encodeURIComponent(s.pageId)}`;
            const resp = await fetch(url, {
              headers: { Authorization: `Bearer ${token}` }
            });
            if (resp.ok && (resp.headers.get("content-type") || "").startsWith("image/")) {
              const ab = await resp.arrayBuffer();
              previewMap.set(Number(s.slideNumber), Buffer.from(ab).toString("base64"));
            }
          } catch (err) {
            console.warn(`[fetchSlidePreviewsMap_] Could not fetch preview for slide ${s.slideNumber}:`, err.message);
          }
        })
      );
    }
  } catch (err) {
    console.warn("[fetchSlidePreviewsMap_] Auth/fetch warning:", err.message);
  }

  return previewMap;
}

/**
 * POST /api/triage { action: "eom_get_narrative_workbench", clientName, reportMonthKey, folderUrl }
 * Exports the current month's presentation and up to 4 prior monthly presentations,
 * extracts tables, embedded chart PNGs, full-slide PNG previews, speaker notes, flags, and saved drafts,
 * and pulls supplier transaction details from the client's Outgoings & Recon sheets.
 */
export async function handleEomGetNarrativeWorkbench(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const { clientName, reportMonthKey, folderUrl: incomingFolderUrl, masterSheetId: incomingMasterId } = req.body || {};
  if (!clientName) {
    return res.status(400).json({ success: false, error: "Client name is required." });
  }

  try {
    const drive = await getDriveClient();
    const resolved = await resolveClientPresentations_(sheets, drive, clientName, reportMonthKey, incomingFolderUrl);

    if (!resolved.targetDeck?.presentationId) {
      return res.status(404).json({
        success: false,
        error: `No Google Slides management report found for ${clientName} (${reportMonthKey || "latest"}). Generate the report deck first or verify the client's management reports folder.`
      });
    }

    const effectiveMonthKey = resolved.effectiveMonthKey;
    const masterSheetId = incomingMasterId || resolved.masterSheetId;

    // Download current deck + prior decks + saved drafts + Recon overhead transactions in parallel
    const [targetPptxBuf, priorBuffers, savedRecord, overheadTxContext] = await Promise.all([
      exportPresentationAsPptxBuffer_(drive, resolved.targetDeck.presentationId),
      Promise.all(
        resolved.priorDecks.map(async d => {
          try {
            const buf = await exportPresentationAsPptxBuffer_(drive, d.presentationId);
            return { ...d, slides: parsePptxBuffer(buf, { includeImages: false }) };
          } catch (e) {
            console.warn(`Could not export prior deck ${d.monthKey} for ${clientName}:`, e.message);
            return null;
          }
        })
      ),
      readSavedNarrativeDrafts_(sheets, clientName, effectiveMonthKey),
      fetchOverheadTransactionContext_(sheets, {
        reconSheetId: resolved.reconSheetId,
        clientSheetId: resolved.clientSheetId,
        masterSheetId,
        reportMonthKey: effectiveMonthKey
      })
    ]);

    const validPriorDecks = priorBuffers.filter(Boolean);
    const parsedSlides = parsePptxBuffer(targetPptxBuf, { includeImages: true });
    const overheadMismatchWarning = checkOverheadConsistency_(parsedSlides);

    // Extract MonthSnapshot table/KPIs from Slide 2 for global context
    const snapshotSlide = parsedSlides.find(s => s.chartCode === "[MonthSnapshot]" || s.slideNumber === 2);
    const snapshotContext = snapshotSlide
      ? {
          slideNumber: snapshotSlide.slideNumber,
          slideTitle: snapshotSlide.slideTitle,
          tables: snapshotSlide.tables
        }
      : null;

    const candidateNarrativeSlides = parsedSlides.filter(s => {
      if (s.isNarrativeSlide) return true;
      if (savedRecord.draftsBySlide?.[s.slideNumber]?.text && String(savedRecord.draftsBySlide[s.slideNumber].text).trim()) {
        return true;
      }
      const normT = s.slideTitle.toLowerCase().trim();
      return validPriorDecks.some(pd =>
        pd.slides.some(ps => ps.slideTitle.toLowerCase().trim() === normT && Boolean(ps.currentText))
      );
    });

    // Fetch full-slide PNG previews in parallel for all candidate narrative slides
    const slidePreviewMap = await fetchSlidePreviewsMap_(
      resolved.targetDeck.presentationId,
      candidateNarrativeSlides
    );

    // Match each narrative slide with its T-1..T-4 historical narratives and saved drafts
    const narrativeSlides = candidateNarrativeSlides
      .map(slide => {
        const family = normalizeChartFamily_(slide.chartCode);
        const normTitle = slide.slideTitle.toLowerCase().trim();

        const previousNarratives = [];
        for (const pDeck of validPriorDecks) {
          // Match exact slide title first (since slides like Bookings per month vs Bookings by source share [Bookings12])
          let matchedPriorSlide = pDeck.slides.find(
            ps => ps.slideTitle.toLowerCase().trim() === normTitle && Boolean(ps.currentText)
          );
          if (!matchedPriorSlide && slide.chartCode) {
            matchedPriorSlide = pDeck.slides.find(
              ps => ps.chartCode === slide.chartCode && Boolean(ps.currentText)
            );
          }
          if (!matchedPriorSlide && family) {
            matchedPriorSlide = pDeck.slides.find(
              ps => normalizeChartFamily_(ps.chartCode) === family && Boolean(ps.currentText)
            );
          }
          if (matchedPriorSlide && matchedPriorSlide.currentText) {
            previousNarratives.push({
              monthKey: pDeck.monthKey,
              slideNumber: matchedPriorSlide.slideNumber,
              slideTitle: matchedPriorSlide.slideTitle,
              chartCode: matchedPriorSlide.chartCode,
              text: matchedPriorSlide.currentText,
              hasFlag: matchedPriorSlide.hasFlag,
              tables: matchedPriorSlide.tables
            });
          }
        }

        const tMinus1Text = previousNarratives[0]?.text || "";
        const deckIsUneditedClone =
          Boolean(slide.currentText && tMinus1Text) &&
          normalizeTextForComparison_(slide.currentText) === normalizeTextForComparison_(tMinus1Text);

        const savedDraft = savedRecord.draftsBySlide?.[slide.slideNumber] || null;
        const hasSavedDraftText = Boolean(savedDraft?.text && String(savedDraft.text).trim());
        const savedDraftIsClone =
          hasSavedDraftText &&
          Boolean(tMinus1Text) &&
          normalizeTextForComparison_(savedDraft.text) === normalizeTextForComparison_(tMinus1Text);

        const isUneditedClone = hasSavedDraftText ? savedDraftIsClone : deckIsUneditedClone;

        const effectiveDraftText = hasSavedDraftText
          ? sanitizeNarrativePunctuation_(savedDraft.text)
          : (deckIsUneditedClone ? "" : sanitizeNarrativePunctuation_(slide.currentText));

        const slideStatus = hasSavedDraftText
          ? (savedDraft?.status || "drafted")
          : (deckIsUneditedClone ? "cloned" : (slide.currentText ? "existing" : "empty"));

        const effectiveHasFlag =
          typeof savedDraft?.hasFlag === "boolean" ? savedDraft.hasFlag : Boolean(slide.hasFlag);

        // Attach relevant overhead supplier transactions if this is the Overheads slide
        const isOverheadsSlide = family === "overheads" || /overhead/i.test(slide.slideTitle);
        let slideTransactions = null;
        if (isOverheadsSlide) {
          const tableCategories = (slide.tables?.[0] || [])
            .slice(1)
            .map(r => String(r[0] || "").trim())
            .filter(c => c && !/^total/i.test(c));

          const matchedByCategory = {};
          const allCatsMap = overheadTxContext.categoriesMap || {};
          for (const cat of tableCategories) {
            const exactOrPartial = Object.keys(allCatsMap).find(
              k =>
                k.toLowerCase() === cat.toLowerCase() ||
                k.toLowerCase().includes(cat.toLowerCase()) ||
                cat.toLowerCase().includes(k.toLowerCase())
            );
            if (exactOrPartial && allCatsMap[exactOrPartial]?.length > 0) {
              matchedByCategory[cat] = allCatsMap[exactOrPartial].slice(0, 12);
            }
          }
          // Also include any remaining categories in allCatsMap that weren't matched by exact table row name
          for (const [rawCat, txList] of Object.entries(allCatsMap)) {
            const alreadyIncluded = Object.keys(matchedByCategory).some(
              mc => mc.toLowerCase() === rawCat.toLowerCase()
            );
            if (!alreadyIncluded && txList?.length > 0) {
              matchedByCategory[rawCat] = txList.slice(0, 12);
            }
          }

          slideTransactions = {
            yyMm: overheadTxContext.yyMm,
            reconAvailable: Boolean(overheadTxContext.reconAvailable),
            matchedByCategory,
            topTransactions: (overheadTxContext.categorisedTransactions || []).slice(0, 30),
            outgoingsBankLines: (overheadTxContext.outgoingsBankLines || []).slice(0, 15)
          };
        }

        return {
          slideNumber: slide.slideNumber,
          pageId: slide.pageId || "",
          slideTitle: slide.slideTitle,
          chartCode: slide.chartCode,
          speakerNotes: slide.speakerNotes,
          hasFlag: effectiveHasFlag,
          deckHasFlag: Boolean(slide.hasFlag),
          isTakeawaysSlide: slide.isTakeawaysSlide,
          isOverheadsSlide,
          slidePreviewBase64: slidePreviewMap.get(slide.slideNumber) || "",
          tables: slide.tables,
          chartImages: slide.chartImages.map(img => ({
            mimeType: img.mimeType,
            base64: img.base64
          })),
          shapeName: slide.narrativeShape?.shapeName || "",
          shapeId: slide.narrativeShape?.shapeId || "",
          deckText: slide.currentText,
          draftText: effectiveDraftText,
          steerText: savedDraft?.steerText || "",
          status: slideStatus,
          isUneditedClone,
          previousNarratives,
          slideTransactions
        };
      });

    return res.status(200).json({
      success: true,
      clientName,
      reportMonthKey: effectiveMonthKey,
      presentationId: resolved.targetDeck.presentationId,
      reportUrl: resolved.targetDeck.reportUrl,
      presentationTitle: resolved.targetDeck.title,
      folderUrl: resolved.folderUrl,
      priorMonthsLoaded: validPriorDecks.map(d => d.monthKey),
      overallStatus: savedRecord.status || "pending",
      updatedAt: savedRecord.updatedAt,
      overheadMismatchWarning,
      snapshotContext,
      slides: narrativeSlides
    });
  } catch (err) {
    console.error("❌ handleEomGetNarrativeWorkbench error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ============================================================================
// 6. CLAUDE MULTIMODAL NARRATIVE GENERATOR (`handleEomGenerateNarrative`)
// ============================================================================

function formatTableAsMarkdown_(tableRows) {
  if (!Array.isArray(tableRows) || tableRows.length === 0) return "(No table on this slide)";
  return tableRows
    .map((row, idx) => {
      const cells = row.map(c => String(c ?? "").replace(/\s+/g, " ").trim());
      const line = `| ${cells.join(" | ")} |`;
      if (idx === 0) {
        const sep = `| ${cells.map(() => "---").join(" | ")} |`;
        return `${line}\n${sep}`;
      }
      return line;
    })
    .join("\n");
}

function countWords_(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function countBullets_(text) {
  const lines = String(text || "")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);
  const bulletLines = lines.filter(l => /^[•\-\*]/.test(l));
  return bulletLines.length || lines.length;
}

function computeTargetLengthMetrics_(slide) {
  const prevText = slide.previousNarratives?.[0]?.text || "";
  const prevWords = countWords_(prevText);
  const prevBullets = countBullets_(prevText);

  if (slide.isTakeawaysSlide) {
    const targetWords = prevWords > 40 ? prevWords : 165;
    const maxAllowedWords = Math.round(targetWords * 1.15);
    return {
      hasPriorGuide: prevWords > 0,
      prevWords,
      prevBullets: prevBullets || 8,
      targetBullets: prevBullets || 8,
      targetWords,
      maxAllowedWords
    };
  }

  if (prevWords > 0) {
    // Allow at most +20% or +6 words over last month's word count (e.g. 12 words -> max 18 words; 24 words -> max 30 words; 51 words -> max 61 words)
    const maxAllowedWords = Math.max(prevWords + 6, Math.round(prevWords * 1.2));
    return {
      hasPriorGuide: true,
      prevWords,
      prevBullets,
      targetBullets: prevBullets,
      targetWords: prevWords,
      maxAllowedWords
    };
  }

  return {
    hasPriorGuide: false,
    prevWords: 0,
    prevBullets: 0,
    targetBullets: 3,
    targetWords: 45,
    maxAllowedWords: 60
  };
}

const FRACTIONAL_FD_SYSTEM_PROMPT = `You are a seasoned UK fractional Finance Director writing the monthly management report commentary for an agency/professional services client.

Your task is to write the slide narrative that accompanies the financial tables and charts on a specific slide of the client's Google Slides management report.

### Essential style, brevity & tone rules (strictly enforced)
1. **EXTREME BREVITY & WORD-COUNT DISCIPLINE (CRITICAL)**:
   - These slide text boxes are compact. You MUST strictly match the word count and bullet count of the previous month's narrative on that specific slide (specified in \`<length_constraint>\`).
   - If the previous month had 1 short bullet of 12 words (e.g. \`• Strong month in October; the rolling 12-month trend is now moving upwards\`), you MUST write 1 short bullet of ~12-18 words - NEVER 3 or 4 long paragraphs!
   - Write telegraphic, high-density commercial notes: drop unnecessary articles, conjunctions, and explanatory padding. Let the numbers and \`->\` arrows do the work.
2. **NO EM DASHES (STRICT RULE)**:
   - NEVER use em dashes (\`—\`) or en dashes (\`–\`) anywhere in the narrative text.
   - Always use a normal hyphen with spaces (\` - \`), a semicolon, or a comma instead.
3. **UK English**: Always use UK spelling and formatting (e.g. utilisation, normalised, realised, programme, £, %).
4. **Concise, commercial, direct voice**:
   - Never use filler phrases ("Overall, this chart illustrates...", "Looking at the table...", "It is pleasing to see..."), marketing fluff, or exclamation marks.
   - Use shorthand arrows (\`->\`) naturally when showing run-rate math or multi-step commercial consequences (e.g. \`£292k for the remaining 6 months -> £49k per month; current pipeline shows £179k across Oct-Dec -> £113k still to find\`).
   - Quote accurate figures (e.g. \`£92k vs £105k budget\`, \`55.1% vs 61.5% target\`, \`+£1,535 / +22.4%\`).
5. **Red flag (\`🚩\`) handling**:
   - If the slide is marked as having a red flag (\`🚩\` = true), your final bullet MUST begin with \`• The flag: \` followed by a concise, direct explanation of the risk, pinch point, or shortfall.
   - If the slide does NOT have a red flag (\`🚩\` = false), do NOT include \`The flag:\`.
6. **Continuity without cloning**:
   - Study the client's prior months' narratives ($T-1$, $T-2$, etc.) for this exact slide to match sentence rhythm, exact bullet count, level of detail, and client-specific terminology.
   - NEVER copy last month's numbers or text verbatim. Tell this month's financial story clearly.
7. **Formatting output**:
   - Output ONLY the narrative text to go into the commentary box - no markdown code fences, no introductory preamble, and no trailing commentary.
   - For standard slides: format every point as a bullet starting with \`• \` (one bullet per line).
   - For the **Business performance (\`[BusinessPerformance]\` / Slide 3)** overview slide ONLY:
     Format with two exact section headings (without bullets on the headings) separated by a blank line, and end every bullet in the second section with \`(see slide X)\` referencing the exact slide number in the deck:
     Month in review
     • [1 to 3 concise headline bullets covering revenue, gross profit/margin, overheads, and net profit for the month]

     Key takeaways from this report
     • [4 to 6 concise bullets synthesising key insights across YTD, full-year forecast, targets, cashflow, bookings/pipeline, and utilisation, each ending with (see slide X)]`;

function buildSlidePromptText_(slide, {
  clientName,
  reportMonthKey,
  snapshotContext,
  allSlidesSummaryForTakeaways,
  overheadMismatchWarning,
  steerText,
  lengthMetrics
}) {
  const parts = [];
  parts.push(`Client: ${clientName}`);
  parts.push(`Reporting month: ${reportMonthKey}`);
  parts.push(`Slide number: Slide ${slide.slideNumber}`);
  parts.push(`Slide title: ${slide.slideTitle}`);
  if (slide.chartCode) parts.push(`Slide chart/table code: ${slide.chartCode}`);
  parts.push(`Red flag (🚩) on slide: ${slide.hasFlag ? "YES - include a concise '• The flag: ...' bullet explaining the risk/issue" : "NO - do NOT include 'The flag:'"}`);
  parts.push(`Punctuation rule: NEVER use em dashes (—). Use normal hyphens (" - ") instead.`);

  if (lengthMetrics) {
    parts.push(`\n<length_constraint>`);
    if (lengthMetrics.hasPriorGuide) {
      parts.push(`Previous month's commentary on this slide was **${lengthMetrics.prevWords} words** across **${lengthMetrics.prevBullets} bullet(s)**.`);
      if (!slide.isTakeawaysSlide) {
        const effectiveBullets = slide.hasFlag && !slide.previousNarratives?.[0]?.hasFlag
          ? lengthMetrics.targetBullets + 1
          : lengthMetrics.targetBullets;
        parts.push(`STRICT REQUIREMENT: Write **${effectiveBullets} bullet(s)** and keep your total response around **${lengthMetrics.targetWords} words** (HARD MAXIMUM: **${lengthMetrics.maxAllowedWords} words**). Do NOT write more bullets or longer sentences than last month.`);
      } else {
        parts.push(`STRICT REQUIREMENT: Keep your total response around **${lengthMetrics.targetWords} words** (HARD MAXIMUM: **${lengthMetrics.maxAllowedWords} words**).`);
      }
    } else {
      parts.push(`STRICT REQUIREMENT: Write at most **${lengthMetrics.targetBullets} concise bullets** and keep your total response under **${lengthMetrics.maxAllowedWords} words**.`);
    }
    parts.push(`</length_constraint>`);
  }

  if (snapshotContext?.tables?.length > 0) {
    parts.push(`\n--- HEADLINE KPI SNAPSHOT (Slide ${snapshotContext.slideNumber}: ${snapshotContext.slideTitle}) ---`);
    for (const tbl of snapshotContext.tables) {
      parts.push(formatTableAsMarkdown_(tbl));
    }
  }

  parts.push(`\n--- CURRENT MONTH SLIDE TABLE(S) (Slide ${slide.slideNumber}) ---`);
  if (slide.tables?.length > 0) {
    slide.tables.forEach((tbl, idx) => {
      if (slide.tables.length > 1) parts.push(`Table ${idx + 1}:`);
      parts.push(formatTableAsMarkdown_(tbl));
    });
  } else {
    parts.push("(No table on this slide - rely on the attached slide/chart image(s) and deck context)");
  }

  if (slide.isOverheadsSlide && overheadMismatchWarning) {
    parts.push(`\n--- DATA CONSISTENCY NOTE ---`);
    parts.push(overheadMismatchWarning.message);
  }

  if (slide.slideTransactions) {
    parts.push(`\n--- SUPPLIER & TRANSACTION DETAILS FROM RECONCILIATION (${slide.slideTransactions.yyMm}) ---`);
    parts.push(`Use these actual supplier/payee details to briefly explain significant overhead variances in brackets where helpful (do not list every micro-transaction; only cite the main drivers of notable budget variances or unbudgeted spend):`);
    const byCat = slide.slideTransactions.matchedByCategory || {};
    const catKeys = Object.keys(byCat);
    if (catKeys.length > 0) {
      for (const cat of catKeys) {
        const itemsStr = byCat[cat]
          .slice(0, 6)
          .map(t => `${t.payee}${t.description ? ` - ${t.description}` : ""} (${t.netFormatted})`)
          .join("; ");
        parts.push(`- ${cat}: ${itemsStr}`);
      }
    } else if (slide.slideTransactions.topTransactions?.length > 0) {
      for (const t of slide.slideTransactions.topTransactions.slice(0, 12)) {
        parts.push(`- [${t.category}] ${t.payee}${t.description ? ` - ${t.description}` : ""}: ${t.netFormatted}`);
      }
    }
  }

  if (slide.previousNarratives?.length > 0) {
    parts.push(`\n--- PREVIOUS MONTHS' NARRATIVE FOR THIS SLIDE (match this exact analytical style, brevity, bullet count, and tone) ---`);
    for (const prev of slide.previousNarratives) {
      const wCount = countWords_(prev.text);
      const bCount = countBullets_(prev.text);
      parts.push(`[${prev.monthKey} - Slide ${prev.slideNumber} (${prev.slideTitle})${prev.hasFlag ? " 🚩" : ""} - ${wCount} words, ${bCount} bullet(s)]:`);
      parts.push(sanitizeNarrativePunctuation_(prev.text));
      if (prev.tables?.length > 0) {
        parts.push(`(${prev.monthKey} table for comparison:)`);
        parts.push(formatTableAsMarkdown_(prev.tables[0]));
      }
      parts.push("");
    }
  } else if (slide.deckText && !slide.isUneditedClone) {
    parts.push(`\n--- EXISTING TEXT ON THIS SLIDE ---`);
    parts.push(sanitizeNarrativePunctuation_(slide.deckText));
  }

  if (slide.isTakeawaysSlide && allSlidesSummaryForTakeaways) {
    parts.push(`\n--- FULL DECK SUMMARY & DETAIL SLIDE NARRATIVES (use these exact slide numbers for '(see slide X)' references in 'Key takeaways from this report') ---`);
    parts.push(allSlidesSummaryForTakeaways);
  }

  if (steerText && String(steerText).trim()) {
    parts.push(`\n--- SPECIFIC USER STEER / CONTEXT FOR THIS SLIDE (incorporate this instruction) ---`);
    parts.push(String(steerText).trim());
  }

  parts.push(`\nNow write the narrative for Slide ${slide.slideNumber} (${slide.slideTitle}) for ${reportMonthKey}. Stay strictly within ${lengthMetrics?.maxAllowedWords || 60} words and NEVER use em dashes (—). Output only the narrative text.`);
  return parts.join("\n");
}

async function generateSingleSlideWithClaude_({
  sheets,
  acId,
  clientName,
  reportMonthKey,
  slide,
  snapshotContext,
  allSlidesSummaryForTakeaways,
  overheadMismatchWarning,
  steerText,
  shortenOnly = false
}) {
  const lengthMetrics = computeTargetLengthMetrics_(slide);

  // If the user clicked "Shorten" on an existing draft, run a fast tightening pass
  if (shortenOnly && slide.draftText && String(slide.draftText).trim()) {
    const currentWords = countWords_(slide.draftText);
    const desiredMax = Math.min(lengthMetrics.maxAllowedWords, Math.max(12, Math.round(currentWords * 0.6)));
    const prevSample = sanitizeNarrativePunctuation_(slide.previousNarratives?.[0]?.text || "");
    const tightenMsg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      temperature: 0.15,
      system: FRACTIONAL_FD_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Tighten and shorten this draft narrative for Slide ${slide.slideNumber} (${slide.slideTitle}) so it is **at most ${desiredMax} words** (target ~${lengthMetrics.targetWords} words across ${lengthMetrics.targetBullets} bullet(s)).
Keep the exact commercial numbers, \`->\` shorthand arrows, UK spelling, normal hyphens (" - ", never em dashes "—"), and ${slide.hasFlag ? "keep a concise '• The flag: ...' final bullet" : "do not include 'The flag:'"}.
${prevSample ? `\nReference for exact length and rhythm from last month (${lengthMetrics.prevWords} words):\n${prevSample}\n` : ""}
Current draft to shorten (${currentWords} words):
${slide.draftText}

Output ONLY the shortened narrative text.`
        }
      ]
    });
    const shortened = sanitizeNarrativePunctuation_(
      (tightenMsg.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim()
    );
    return shortened || sanitizeNarrativePunctuation_(slide.draftText);
  }

  const userContentBlocks = [];

  // Attach the full actual slide preview PNG if available so Claude sees the complete formatted slide
  if (slide.slidePreviewBase64) {
    userContentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: slide.slidePreviewBase64
      }
    });
  } else {
    // Fallback: attach up to 3 chart PNG images from the slide
    const imagesToAttach = (slide.chartImages || []).slice(0, 3);
    for (const img of imagesToAttach) {
      if (img.base64) {
        userContentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mimeType || "image/png",
            data: img.base64
          }
        });
      }
    }
  }

  const promptText = buildSlidePromptText_(slide, {
    clientName,
    reportMonthKey,
    snapshotContext,
    allSlidesSummaryForTakeaways,
    overheadMismatchWarning,
    steerText,
    lengthMetrics
  });

  userContentBlocks.push({
    type: "text",
    text: promptText
  });

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 900,
    temperature: 0.2,
    system: FRACTIONAL_FD_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContentBlocks }]
  });

  let generatedText = sanitizeNarrativePunctuation_(
    (msg.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim()
  );

  let totalInputTokens = msg.usage?.input_tokens || 0;
  let totalOutputTokens = msg.usage?.output_tokens || 0;

  // Deterministic post-generation word-count enforcement:
  // If Claude exceeded maxAllowedWords (and user didn't explicitly ask for extra detail in steerText),
  // automatically run a fast text-only tightening pass so the output genuinely respects the guide word count.
  const generatedWords = countWords_(generatedText);
  const effectiveMaxWords =
    slide.hasFlag && !slide.previousNarratives?.[0]?.hasFlag
      ? lengthMetrics.maxAllowedWords + 18
      : lengthMetrics.maxAllowedWords;

  if (generatedWords > effectiveMaxWords && (!steerText || !/detail|expand|longer/i.test(steerText))) {
    const prevSample = sanitizeNarrativePunctuation_(slide.previousNarratives?.[0]?.text || "");
    const targetBullets =
      slide.hasFlag && !slide.previousNarratives?.[0]?.hasFlag
        ? lengthMetrics.targetBullets + 1
        : lengthMetrics.targetBullets;

    const tightenMsg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      temperature: 0.1,
      system: FRACTIONAL_FD_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Your draft for Slide ${slide.slideNumber} (${slide.slideTitle}) is **${generatedWords} words**, which exceeds the strict maximum of **${effectiveMaxWords} words** (last month's narrative was **${lengthMetrics.prevWords} words** across **${lengthMetrics.prevBullets} bullet(s)**).

Rewrite and condense the draft below so that it is **at most ${effectiveMaxWords} words** (ideally ~${lengthMetrics.targetWords} words) and has **${targetBullets} bullet(s)**.
- Preserve the key commercial figures, variances, and \`->\` shorthand arrows.
- NEVER use em dashes (—); use normal hyphens (" - ") instead.
- Cut secondary commentary, repetitive phrasing, and wordy explanations.
- ${slide.hasFlag ? "Keep a concise '• The flag: ...' bullet at the end." : "Do NOT include 'The flag:'."}
${slide.isTakeawaysSlide ? "- Keep the two section headings ('Month in review' and 'Key takeaways from this report') and the '(see slide X)' references at the end of each takeaway bullet." : ""}
${prevSample ? `\nLast month's actual narrative on this slide (${lengthMetrics.prevWords} words - match this exact brevity and density):\n${prevSample}\n` : ""}
Draft to condense (${generatedWords} words):
${generatedText}

Output ONLY the condensed narrative text.`
        }
      ]
    });

    const tightenedText = sanitizeNarrativePunctuation_(
      (tightenMsg.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim()
    );

    if (tightenedText) {
      generatedText = tightenedText;
    }
    totalInputTokens += tightenMsg.usage?.input_tokens || 0;
    totalOutputTokens += tightenMsg.usage?.output_tokens || 0;
  }

  if (acId) {
    logClaudeUsage_(
      sheets,
      acId,
      clientName,
      `eom_narrative_slide_${slide.slideNumber}`,
      totalInputTokens,
      totalOutputTokens,
      "reporting_narrative"
    ).catch(() => {});
  }

  return sanitizeNarrativePunctuation_(generatedText);
}

/**
 * POST /api/triage {
 *   action: "eom_generate_narrative",
 *   mode: "single" | "all" | "shorten",
 *   clientName,
 *   reportMonthKey,
 *   presentationId,
 *   slideNumber,
 *   steerText,
 *   slides, // optional pre-loaded workbench slides or minimal slide descriptors
 *   snapshotContext,
 *   overheadMismatchWarning,
 *   automationCommanderSheetId
 * }
 */
export async function handleEomGenerateNarrative(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const {
    mode = "single",
    clientName,
    reportMonthKey,
    presentationId,
    slideNumber,
    steerText = "",
    slides: incomingSlides,
    snapshotContext,
    overheadMismatchWarning,
    automationCommanderSheetId
  } = req.body || {};

  if (!clientName || !reportMonthKey) {
    return res.status(400).json({ success: false, error: "clientName and reportMonthKey are required." });
  }

  const acId = automationCommanderSheetId || process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_SHEET_ID;

  try {
    const slidesList = Array.isArray(incomingSlides) ? incomingSlides : [];
    if (slidesList.length === 0) {
      return res.status(400).json({ success: false, error: "Slide data is required to generate narrative." });
    }

    const savedRecord = await readSavedNarrativeDrafts_(sheets, clientName, reportMonthKey);
    const draftsBySlide = { ...(savedRecord.draftsBySlide || {}) };
    const now = new Date().toISOString();

    if (mode === "single" || mode === "shorten") {
      const targetSlide = slidesList.find(s => Number(s.slideNumber) === Number(slideNumber));
      if (!targetSlide) {
        return res.status(404).json({ success: false, error: `Slide ${slideNumber} not found.` });
      }

      let allSlidesSummaryForTakeaways = "";
      if (targetSlide.isTakeawaysSlide && mode !== "shorten") {
        allSlidesSummaryForTakeaways = slidesList
          .filter(s => !s.isTakeawaysSlide)
          .map(s => {
            const currentDraft = draftsBySlide[s.slideNumber]?.text || s.draftText || s.deckText || "";
            const tblSummary = s.tables?.[0] ? formatTableAsMarkdown_(s.tables[0].slice(0, 12)) : "";
            return `Slide ${s.slideNumber} - ${s.slideTitle} (${s.chartCode || ""})${s.hasFlag ? " [🚩 FLAGGED]" : ""}:\nDrafted narrative:\n${currentDraft || "(none)"}\nKey table rows:\n${tblSummary}`;
          })
          .join("\n\n");
      }

      const generatedText = await generateSingleSlideWithClaude_({
        sheets,
        acId,
        clientName,
        reportMonthKey,
        slide: targetSlide,
        snapshotContext,
        allSlidesSummaryForTakeaways,
        overheadMismatchWarning,
        steerText,
        shortenOnly: mode === "shorten"
      });

      draftsBySlide[targetSlide.slideNumber] = {
        slideNumber: targetSlide.slideNumber,
        slideTitle: targetSlide.slideTitle,
        chartCode: targetSlide.chartCode || "",
        text: generatedText,
        steerText: steerText || "",
        hasFlag: Boolean(targetSlide.hasFlag),
        status: "drafted",
        updatedAt: now
      };

      await saveNarrativeDraftsRecord_(sheets, {
        clientName,
        reportMonthKey,
        presentationId,
        status: "drafted",
        draftsBySlide,
        totalNarrativeSlides: slidesList.length
      });

      return res.status(200).json({
        success: true,
        mode,
        slideNumber: targetSlide.slideNumber,
        generatedText,
        draftsBySlide,
        updatedAt: now
      });
    }

    // mode === "all":
    // 1. Draft all detail slides first (with concurrency = 3)
    const detailSlides = slidesList.filter(s => !s.isTakeawaysSlide);
    const takeawaysSlides = slidesList.filter(s => s.isTakeawaysSlide);

    const concurrency = 3;
    for (let i = 0; i < detailSlides.length; i += concurrency) {
      const batch = detailSlides.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async slide => {
          const slideSteer = slide.steerText || draftsBySlide[slide.slideNumber]?.steerText || "";
          const text = await generateSingleSlideWithClaude_({
            sheets,
            acId,
            clientName,
            reportMonthKey,
            slide,
            snapshotContext,
            allSlidesSummaryForTakeaways: "",
            overheadMismatchWarning,
            steerText: slideSteer
          });
          return { slide, text, slideSteer };
        })
      );

      for (const { slide, text, slideSteer } of batchResults) {
        draftsBySlide[slide.slideNumber] = {
          slideNumber: slide.slideNumber,
          slideTitle: slide.slideTitle,
          chartCode: slide.chartCode || "",
          text,
          steerText: slideSteer,
          hasFlag: Boolean(slide.hasFlag),
          status: "drafted",
          updatedAt: now
        };
      }
    }

    // 2. Synthesise Slide 3 ([BusinessPerformance] / takeaways slide) using all newly drafted detail slides
    if (takeawaysSlides.length > 0) {
      const allSlidesSummaryForTakeaways = detailSlides
        .map(s => {
          const draftedText = draftsBySlide[s.slideNumber]?.text || "";
          const tblSummary = s.tables?.[0] ? formatTableAsMarkdown_(s.tables[0].slice(0, 12)) : "";
          return `Slide ${s.slideNumber} - ${s.slideTitle} (${s.chartCode || ""})${s.hasFlag ? " [🚩 FLAGGED]" : ""}:\nDrafted narrative:\n${draftedText}\nKey table rows:\n${tblSummary}`;
        })
        .join("\n\n");

      for (const tSlide of takeawaysSlides) {
        const slideSteer = tSlide.steerText || draftsBySlide[tSlide.slideNumber]?.steerText || "";
        const text = await generateSingleSlideWithClaude_({
          sheets,
          acId,
          clientName,
          reportMonthKey,
          slide: tSlide,
          snapshotContext,
          allSlidesSummaryForTakeaways,
          overheadMismatchWarning,
          steerText: slideSteer
        });
        draftsBySlide[tSlide.slideNumber] = {
          slideNumber: tSlide.slideNumber,
          slideTitle: tSlide.slideTitle,
          chartCode: tSlide.chartCode || "",
          text,
          steerText: slideSteer,
          hasFlag: Boolean(tSlide.hasFlag),
          status: "drafted",
          updatedAt: now
        };
      }
    }

    await saveNarrativeDraftsRecord_(sheets, {
      clientName,
      reportMonthKey,
      presentationId,
      status: "drafted",
      draftsBySlide,
      totalNarrativeSlides: slidesList.length
    });

    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      category: "REPORTING",
      action: "Drafted Management Report Narrative",
      summary: `Generated AI narrative drafts across ${slidesList.length} slides for ${clientName} (${reportMonthKey})`,
      details: { clientName, reportMonthKey, presentationId, slideCount: slidesList.length }
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      mode: "all",
      draftsBySlide,
      updatedAt: now
    });
  } catch (err) {
    console.error("❌ handleEomGenerateNarrative error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ============================================================================
// 7. SAVE NARRATIVE DRAFT & APPLY TO GOOGLE SLIDES DECK
// ============================================================================

/**
 * POST /api/triage {
 *   action: "eom_save_narrative_draft",
 *   clientName,
 *   reportMonthKey,
 *   presentationId,
 *   draftsMap, // { [slideNumber]: { text, steerText, hasFlag, slideTitle, chartCode } }
 *   totalNarrativeSlides
 * }
 */
export async function handleEomSaveNarrativeDraft(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const { clientName, reportMonthKey, presentationId, draftsMap, totalNarrativeSlides } = req.body || {};
  if (!clientName || !reportMonthKey || !draftsMap || typeof draftsMap !== "object") {
    return res.status(400).json({ success: false, error: "clientName, reportMonthKey, and draftsMap are required." });
  }

  try {
    const existing = await readSavedNarrativeDrafts_(sheets, clientName, reportMonthKey);
    const mergedDrafts = { ...(existing.draftsBySlide || {}) };
    const now = new Date().toISOString();

    for (const [sNum, item] of Object.entries(draftsMap)) {
      if (!item || typeof item !== "object") continue;
      const rawText = item.text !== undefined ? String(item.text) : (mergedDrafts[sNum]?.text || "");
      const newText = sanitizeNarrativePunctuation_(rawText);
      mergedDrafts[sNum] = {
        ...(mergedDrafts[sNum] || {}),
        slideNumber: Number(sNum),
        slideTitle: item.slideTitle || mergedDrafts[sNum]?.slideTitle || `Slide ${sNum}`,
        chartCode: item.chartCode || mergedDrafts[sNum]?.chartCode || "",
        text: newText,
        steerText: item.steerText !== undefined ? String(item.steerText) : (mergedDrafts[sNum]?.steerText || ""),
        hasFlag: typeof item.hasFlag === "boolean" ? item.hasFlag : mergedDrafts[sNum]?.hasFlag,
        status: newText.trim() ? (item.status || "drafted") : "empty",
        updatedAt: now
      };
    }

    const nextStatus = existing.status === "applied" ? "drafted" : "drafted";
    await saveNarrativeDraftsRecord_(sheets, {
      clientName,
      reportMonthKey,
      presentationId,
      status: nextStatus,
      draftsBySlide: mergedDrafts,
      totalNarrativeSlides: totalNarrativeSlides || Object.keys(mergedDrafts).length
    });

    return res.status(200).json({
      success: true,
      draftsBySlide: mergedDrafts,
      status: nextStatus,
      updatedAt: now
    });
  } catch (err) {
    console.error("❌ handleEomSaveNarrativeDraft error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/triage {
 *   action: "eom_apply_narrative_to_deck",
 *   clientName,
 *   reportMonthKey,
 *   presentationId,
 *   folderUrl,
 *   webAppUrl,
 *   slideUpdates, // [{ slideNumber, pageId, shapeName, newText, hasFlag, isTakeawaysSlide, slideTitle, chartCode }]
 *   totalNarrativeSlides,
 *   automationCommanderSheetId
 * }
 * Calls the Reporting Control GAS Web App (`action: "APPLY_NARRATIVE"`) to write the approved
 * narrative commentary into each slide's text box while preserving font, size, and bullet styling,
 * as well as adding or removing the red flag (🚩) shape on each slide.
 */
export async function handleEomApplyNarrativeToDeck(req, res, sheets) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser?.isAdmin) {
    return res.status(403).json({ success: false, error: "Admin access required." });
  }

  const {
    clientName,
    reportMonthKey,
    presentationId,
    folderUrl,
    webAppUrl,
    slideUpdates = [],
    totalNarrativeSlides,
    automationCommanderSheetId
  } = req.body || {};

  if (!clientName || !presentationId || !Array.isArray(slideUpdates) || slideUpdates.length === 0) {
    return res.status(400).json({
      success: false,
      error: "clientName, presentationId, and non-empty slideUpdates array are required."
    });
  }

  const targetWebAppUrl = String(webAppUrl || process.env.REPORTING_WEBAPP_URL || DEFAULT_REPORTING_WEBAPP_URL).trim();
  if (!isValidGoogleScriptUrl(targetWebAppUrl)) {
    return res.status(400).json({
      success: false,
      error: "Invalid Reporting Web App URL configured."
    });
  }

  const candidateSecrets = Array.from(new Set([
    (process.env.CRON_SECRET || "").trim(),
    (process.env.AGENT_TRIGGER_SECRET || "").trim(),
    (process.env.REPORTING_WEBAPP_SECRET || "").trim(),
    "triage-cron-2026-AY4K2LDMXBV8DS7"
  ].filter(Boolean)));

  try {
    let gasResp = null;
    let gasText = "";
    let gasData = null;

    for (const secret of candidateSecrets) {
      gasResp = await fetch(targetWebAppUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "APPLY_NARRATIVE",
          secret,
          clientName,
          presentationId,
          folderUrl: folderUrl || "",
          slideUpdates: slideUpdates.map(u => ({
            slideNumber: Number(u.slideNumber),
            shapeName: u.shapeName || "",
            newText: sanitizeNarrativePunctuation_(String(u.newText || "")),
            hasFlag: typeof u.hasFlag === "boolean" ? u.hasFlag : undefined,
            isTakeawaysSlide: Boolean(u.isTakeawaysSlide)
          }))
        })
      });
      gasText = await gasResp.text();
      gasData = null;
      try {
        gasData = JSON.parse(gasText);
      } catch (_) {}
      if (!gasData || gasData.success || !String(gasData.error || "").includes("Invalid secret token")) {
        break;
      }
    }

    if (!gasData) {
      return res.status(502).json({
        success: false,
        error: `Reporting Web App returned HTTP ${gasResp?.status} (${gasText.slice(0, 120).replace(/<[^>]*>/g, "").trim() || "non-JSON"}). Ensure the updated Reporting Control script is deployed.`
      });
    }

    if (!gasData.success) {
      return res.status(200).json({
        success: false,
        error: gasData.error || "Failed to apply narrative to Google Slides presentation."
      });
    }

    // Persist applied status in EomNarrativeDrafts and EomReportingConfig!I
    const existing = await readSavedNarrativeDrafts_(sheets, clientName, reportMonthKey);
    const mergedDrafts = { ...(existing.draftsBySlide || {}) };
    const now = new Date().toISOString();

    for (const u of slideUpdates) {
      const sNum = Number(u.slideNumber);
      const cleanedText = u.newText !== undefined && String(u.newText).trim()
        ? sanitizeNarrativePunctuation_(String(u.newText))
        : (mergedDrafts[sNum]?.text || "");
      mergedDrafts[sNum] = {
        ...(mergedDrafts[sNum] || {}),
        slideNumber: sNum,
        slideTitle: u.slideTitle || mergedDrafts[sNum]?.slideTitle || `Slide ${sNum}`,
        chartCode: u.chartCode || mergedDrafts[sNum]?.chartCode || "",
        text: cleanedText,
        hasFlag: typeof u.hasFlag === "boolean" ? u.hasFlag : mergedDrafts[sNum]?.hasFlag,
        status: "applied",
        appliedAt: now,
        updatedAt: now
      };
    }

    // Re-fetch updated full-slide PNG previews for any slides that provided a pageId
    const refreshedPreviewMap = await fetchSlidePreviewsMap_(presentationId, slideUpdates);
    const updatedPreviewsBySlide = {};
    for (const [sNum, b64] of refreshedPreviewMap.entries()) {
      updatedPreviewsBySlide[sNum] = b64;
    }

    await saveNarrativeDraftsRecord_(sheets, {
      clientName,
      reportMonthKey,
      presentationId,
      status: "applied",
      draftsBySlide: mergedDrafts,
      totalNarrativeSlides: totalNarrativeSlides || Object.keys(mergedDrafts).length
    });

    const acId = automationCommanderSheetId || process.env.AUTOMATION_COMMANDER_SHEET_ID || DEFAULT_AC_SHEET_ID;
    logPmaActivity(sheets, {
      automationCommanderSheetId: acId,
      category: "REPORTING",
      action: "Applied Management Report Narrative",
      summary: `Applied narrative commentary to ${slideUpdates.length} slides in Google Slides deck for ${clientName} (${reportMonthKey})`,
      details: { clientName, reportMonthKey, presentationId, updatedCount: gasData.updatedCount || slideUpdates.length }
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      updatedCount: gasData.updatedCount || slideUpdates.length,
      slideResults: gasData.slideResults || [],
      draftsBySlide: mergedDrafts,
      updatedPreviewsBySlide,
      status: "applied",
      updatedAt: now
    });
  } catch (err) {
    console.error("❌ handleEomApplyNarrativeToDeck error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

