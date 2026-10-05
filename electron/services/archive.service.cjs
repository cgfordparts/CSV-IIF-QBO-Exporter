const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const defaultDataDirectory = () => path.join(app.getPath('userData'), 'payout-archive');
const settingsPath = () => path.join(app.getPath('userData'), 'app-settings.json');

function getOutputRoot() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (typeof parsed.dataDirectory === 'string' && parsed.dataDirectory.trim()) {
      return parsed.dataDirectory.trim();
    }
  } catch {
    // Fall through to the application default.
  }
  return defaultDataDirectory();
}

function hasCustomDataDirectory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return typeof parsed.dataDirectory === 'string' && Boolean(parsed.dataDirectory.trim());
  } catch {
    return false;
  }
}

function monthFolderName(yearMonth) {
  const [year, month] = yearMonth.split('-');
  const monthName = MONTH_NAMES[parseInt(month, 10) - 1] || month;
  return `${yearMonth} (${monthName} ${year})`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sourceLabel(source) {
  return String(source || '').toUpperCase() === 'PAYPAL' ? 'PayPal' : 'Shopify';
}

/** 2026-06-03 → "June 03" */
function formatDayLabel(isoDate) {
  const [year, month, day] = isoDate.split('-');
  const monthName = MONTH_NAMES[parseInt(month, 10) - 1] || month;
  return `${monthName} ${day}`;
}

/** Sorted ISO dates → "June 03" or "June 03-06" or "May 31-June 01" */
function formatDateSpanLabel(isoDates) {
  const dates = [...new Set(isoDates.filter(Boolean))].sort();
  if (dates.length === 0) return 'Unknown';
  if (dates.length === 1) return formatDayLabel(dates[0]);

  const first = dates[0];
  const last = dates[dates.length - 1];
  const [, m1, d1] = first.split('-');
  const [, m2, d2] = last.split('-');
  const n1 = MONTH_NAMES[parseInt(m1, 10) - 1] || m1;
  const n2 = MONTH_NAMES[parseInt(m2, 10) - 1] || m2;

  if (m1 === m2) {
    return `${n1} ${d1}-${d2}`;
  }
  return `${n1} ${d1}-${n2} ${d2}`;
}

function yearMonthsFromIsoDates(isoDates) {
  const months = new Set();
  isoDates.forEach((d) => {
    if (d && d.length >= 7) months.add(d.substring(0, 7));
  });
  return Array.from(months).sort();
}

function calendarDayFromPaypalDate(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const s = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (s) return `${s[1]}-${s[2]}-${s[3]}`;
  return null;
}

function calendarDayFromShopifyDateTime(dateTime) {
  if (!dateTime) return null;
  const s = String(dateTime).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (s) return `${s[1]}-${s[2]}-${s[3]}`;
  return calendarDayFromPaypalDate(dateTime);
}

function isPaypalSkippedType(type) {
  const t = String(type || '').trim();
  return (
    t === 'General Withdrawal' ||
    t === 'User Initiated Withdrawal' ||
    t === 'Bank Deposit to PP Account'
  );
}

function uniqueShopifyPath(dir, baseName) {
  let candidate = path.join(dir, `${baseName}.csv`);
  if (!fs.existsSync(candidate)) return candidate;
  let n = 1;
  while (fs.existsSync(path.join(dir, `${baseName} (${n}).csv`))) {
    n += 1;
  }
  return path.join(dir, `${baseName} (${n}).csv`);
}

function rawDir(yearMonth, source) {
  const root = getOutputRoot();
  return ensureDir(path.join(root, monthFolderName(yearMonth), 'RAW', sourceLabel(source)));
}

function dayEndDir(yearMonth, source) {
  const root = getOutputRoot();
  return ensureDir(path.join(root, monthFolderName(yearMonth), 'Day End', sourceLabel(source)));
}

function archiveShopifyRawCsv(fileContent, transactions, originalFilename) {
  const days = [];
  (transactions || []).forEach((tx) => {
    const day = calendarDayFromShopifyDateTime(tx.dateTime);
    if (day) days.push(day);
  });
  const uniqueDays = [...new Set(days)].sort();
  if (uniqueDays.length === 0) {
    return { success: false, error: 'No calendar days found in Shopify CSV', saved: [] };
  }

  const originalBase = path.basename(String(originalFilename || ''), '.csv');
  const spanLabel = formatDateSpanLabel(uniqueDays);
  const baseName = originalBase || `${spanLabel} - Shopify`;
  const months = yearMonthsFromIsoDates(uniqueDays);
  const saved = [];

  for (const ym of months) {
    const dir = rawDir(ym, 'SHOPIFY');
    const fullPath = uniqueShopifyPath(dir, baseName);
    fs.writeFileSync(fullPath, fileContent, 'utf-8');
    saved.push(fullPath);
  }

  return { success: true, saved };
}

function parseCsvRows(text) {
  const normalized = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = normalized.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return { header: null, rows: [] };

  const parseLine = (line) => {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur);
    return result;
  };

  const header = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return {
    header,
    rows,
    serializeLine: (cols) =>
      cols
        .map((c) => {
          const s = String(c ?? '');
          if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        })
        .join(','),
  };
}

function archivePaypalRawCsv(fileContent) {
  const { header, rows, serializeLine } = parseCsvRows(fileContent);
  if (!header || header.length === 0) {
    return { success: false, error: 'Invalid PayPal CSV header', saved: [], skipped: [] };
  }

  const dateIdx = header.findIndex((h) => String(h).replace(/^"|"$/g, '') === 'Date');
  const typeIdx = header.findIndex((h) => String(h).replace(/^"|"$/g, '') === 'Type');
  if (dateIdx < 0) {
    return { success: false, error: 'PayPal CSV missing Date column', saved: [], skipped: [] };
  }

  const byDay = new Map();
  for (const row of rows) {
    if (!row || row.length === 0) continue;
    const type = typeIdx >= 0 ? String(row[typeIdx] || '').trim() : '';
    if (isPaypalSkippedType(type)) continue;
    const day = calendarDayFromPaypalDate(row[dateIdx]);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }

  const saved = [];
  const skipped = [];

  for (const [day, dayRows] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (dayRows.length === 0) continue;
    const ym = day.substring(0, 7);
    const dir = rawDir(ym, 'PAYPAL');
    const baseName = `${formatDayLabel(day)} - PayPal`;
    const fullPath = path.join(dir, `${baseName}.csv`);

    if (fs.existsSync(fullPath)) {
      skipped.push(fullPath);
      continue;
    }

    const out = [serializeLine(header), ...dayRows.map(serializeLine)].join('\n') + '\n';
    fs.writeFileSync(fullPath, out, 'utf-8');
    saved.push(fullPath);
  }

  return { success: true, saved, skipped };
}

function archiveRawCsv({ source, fileContent, transactions, filename }) {
  try {
    if (!hasCustomDataDirectory()) {
      return { success: false, error: 'Choose a data folder in Settings first.', saved: [] };
    }
    if (String(source).toUpperCase() === 'PAYPAL') {
      return archivePaypalRawCsv(fileContent);
    }
    return archiveShopifyRawCsv(fileContent, transactions, filename);
  } catch (err) {
    return { success: false, error: err.message, saved: [] };
  }
}

function archiveDayEndPdf({ source, isoDate, base64Data }) {
  try {
    if (!hasCustomDataDirectory()) {
      return { success: false, error: 'Choose a data folder in Settings first.' };
    }
    if (!isoDate) throw new Error('isoDate required');
    const ym = isoDate.substring(0, 7);
    const dir = dayEndDir(ym, source);
    const label = sourceLabel(source);
    const fullPath = path.join(dir, `${formatDayLabel(isoDate)} - ${label}.pdf`);

    let base64Content = base64Data || '';
    if (base64Content.includes('base64,')) {
      base64Content = base64Content.split('base64,')[1];
    }
    const buffer = Buffer.from(base64Content, 'base64');
    fs.writeFileSync(fullPath, buffer);
    return { success: true, path: fullPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function saveRollingPdf({ yearMonth, monthName, source, base64Data }) {
  try {
    if (!hasCustomDataDirectory()) {
      throw new Error('Choose a data folder in Settings first.');
    }
    if (!yearMonth) throw new Error('yearMonth required');

    const targetDir = path.join(getOutputRoot(), `${yearMonth} (${monthName})`);
    ensureDir(targetDir);

    const filename = `${source === 'SHOPIFY' ? 'Shopify' : 'PayPal'}-Rolling-${yearMonth}.pdf`;
    const fullPath = path.join(targetDir, filename);

    let base64Content = base64Data || '';
    if (base64Content.includes('base64,')) {
      base64Content = base64Content.split('base64,')[1];
    }

    fs.writeFileSync(fullPath, Buffer.from(base64Content, 'base64'));
    return { success: true, path: fullPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  archiveRawCsv,
  archiveDayEndPdf,
  saveRollingPdf,
  hasCustomDataDirectory,
  getOutputRoot,
  formatDayLabel,
  formatDateSpanLabel,
  monthFolderName,
};
