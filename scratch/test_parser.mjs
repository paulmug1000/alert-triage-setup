// Test parsing logic for AutoLog and AppLog

function parseLogDate(rawStr) {
  if (!rawStr) return null;
  const str = String(rawStr).trim();
  
  // Format: dd-MMM-yy HH:mm (e.g. "24-Sep-26 12:21")
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

  // Format: YYYY-MM-DD HH:MM:SS (e.g. "2026-09-15 00:54:25")
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

function formatRelativeTime(date, baseDate = new Date()) {
  if (!date) return "";
  const d = new Date(date);
  const now = new Date(baseDate);
  
  const isSameDay = (d1, d2) =>
    d1.getUTCFullYear() === d2.getUTCFullYear() &&
    d1.getUTCMonth() === d2.getUTCMonth() &&
    d1.getUTCDate() === d2.getUTCDate();

  const timeStr = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "UTC" }).toLowerCase();
  
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

// Test dates
const d1 = parseLogDate("24-Sep-26 12:21");
const d2 = parseLogDate("2026-09-15 00:54:25");
console.log("Parsed d1:", d1?.toISOString(), "Relative:", formatRelativeTime(d1, new Date("2026-09-24T16:00:00Z")));
console.log("Parsed d2:", d2?.toISOString(), "Relative:", formatRelativeTime(d2, new Date("2026-09-24T16:00:00Z")));
