// Bank statement import for the budget: parse DBS/POSB and UOB statements (CSV, Excel .xlsx and
// PDF e-statements, password-protected ones too), mask account-like numbers, guess categories
// (learned per family, then built-in Singapore merchant rules) and spot monthly bills.
//
// Parsing runs in a worker thread (this same file, see the bottom) with a memory cap, a time limit,
// no environment and its console output thrown away, so a hostile or huge file can only fail its
// own request. The file is handed over in memory and never written anywhere; nothing in it is
// executed (PDF text is read with pdf.js, scripting/eval/fonts off; .xlsx is unzipped with zlib
// under an output cap and read as plain XML text).
//
// Layouts (see docs/MODULE_SPECS.md "budget" for the sources):
//   DBS/POSB CSV   "Account Details For:,POSB Savings Account 123-45678-9" … then
//                  "Transaction Date,Reference,Debit Amount,Credit Amount,Transaction Ref1,Ref2,Ref3"
//   UOB export     "Account Number" / "Statement Period" preamble, then
//                  "Transaction Date | Transaction Description | Withdrawal | Deposit | Available Balance"
//   PDF            "Date  Description  Withdrawal(s)  Deposit(s)  Balance" table (DBS/POSB consolidated
//                  statement with "Balance Brought/Carried Forward", UOB with "BALANCE B/F"), dates
//                  "01 Nov" (year from "Period: … to …" / "as at …") or "01/11/2026".
import { fork } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 5000;
const MAX_PAGES = 60;
const MAX_UNZIPPED = 40 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_WORKERS = 2;

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => { throw new ImportError(code, message); };

export const MESSAGES = {
  UNSUPPORTED: "That doesn't look like a DBS, POSB or UOB account statement. Upload the PDF e-statement, or a CSV or Excel (.xlsx) export of your account history.",
  XLS: 'Older Excel (.xls) files can’t be read safely. Download the CSV export from your bank instead, or open the file in Excel or Numbers and save it as .xlsx or CSV.',
  PASSWORD_REQUIRED: 'This PDF is password-protected. Enter its password to open it.',
  BAD_PASSWORD: 'That password didn’t open the PDF. Check it and try again.',
  EMPTY: 'No transactions were found in this statement.',
  TOO_LARGE: 'That file is too large (max 10 MB).',
  TOO_COMPLEX: 'That file is too large or complex to read.',
  BUSY: 'Another statement is still being read — try again in a moment.',
  PDF: 'That PDF couldn’t be read. Upload the original e-statement from your bank, or a CSV export.',
};

// ---- text helpers (shared by the worker and the server) ----------------------------------------

/** Any Unicode decimal digit → its ASCII digit (Nd digits come in runs of whole 0–9 blocks). */
const asciiDigit = (c) => {
  let cp = c.codePointAt(0);
  const end = cp;
  while (/\p{Nd}/u.test(String.fromCodePoint(cp - 1))) cp--;
  return String((end - cp) % 10);
};
/** NFKC (full-width → ASCII), every decimal digit as 0–9, whitespace collapsed; private-use characters dropped. */
export const normText = (s) => String(s ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '') // zero-width space, soft hyphen, …
  .replace(/(?![0-9])\p{Nd}/gu, asciiDigit).replace(/\s+/g, ' ').trim();

// ≥ 8 digits with up to 3 separator characters (space . , ; - / _ * dashes) between any two of them.
const LONG_NUMBER = /\d(?:[\s.,;\-/_*‐-―−]{0,3}\d){7,}/g;
// Singapore NRIC/FIN, spaces and check letter optional ("S1234567A", "s 1234567 a", "S1234567").
const NRIC = /\b[STFGM]\s?\d{7}(?:\s?[A-Z])?\b/gi;
// Pieces of such a run kept as they are: amounts ("1,234.56", "12.30") and dates.
const AMOUNT_PIECE = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;
const DATE_PIECE = /^(?:\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})$/;

/**
 * One long digit run: its space-separated pieces that are amounts or dates stay, the rest is
 * grouped and every group with ≥ 8 digits becomes "••" + its last 4 (a trailing ".00" is not part
 * of the number). An amount right after a group of ≥ 4 digits joins it ("4111 1111 1111 1111.00"
 * is a card number, not $1111.00), so the guard never reveals the tail of a number.
 */
function maskRun(run) {
  const out = [];
  let group = [];
  let ws = '';
  const digits = (t) => t.replace(/\D/g, '').length;
  const flush = () => {
    if (!group.length) return;
    const text = group.join('');
    const cents = /\.\d{2}$/.test(text) && !text.slice(0, -3).includes('.'); // "….00" after a number without dots
    const d = (cents ? text.slice(0, -3) : text).replace(/\D/g, '');
    out.push(d.length >= 8 ? `••${d.slice(-4)}` : text);
    group = [];
  };
  for (const tok of run.split(/(\s+)/)) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) { ws += tok; continue; }
    const piece = tok.replace(/[,;]$/, '');
    if ((AMOUNT_PIECE.test(piece) || DATE_PIECE.test(piece)) && !(group.length && digits(group.join('')) >= 4)) {
      flush();
      out.push(ws, tok);
    } else if (group.length) group.push(ws, tok);
    else { out.push(ws); group.push(tok); }
    ws = '';
  }
  flush();
  out.push(ws);
  return out.join('');
}

/**
 * Text as stored: normalised (normText), Singapore NRIC/FIN numbers fully masked, and every run of
 * ≥ 8 digits (account, card and phone numbers, separators allowed) → "••" + its last 4 digits.
 */
export function maskDigits(s) {
  return normText(s).replace(NRIC, '•••••••••').replace(LONG_NUMBER, maskRun);
}

const clean = (s) => maskDigits(s).slice(0, 140);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
function ymd(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1990 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * 'YYYY-MM-DD' from "01 Nov 2026", "01-Nov-26", "01/11/2026" (day first, as in Singapore),
 * "2026-11-01", an Excel serial number, or "01 Nov" (year from `end`, the statement's last day).
 */
export function parseDate(v, end = null, order = 'dmy') {
  if (typeof v === 'number') {
    if (v < 30000 || v > 80000) return null; // Excel serial (1900 system)
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5).toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  let m = /^(\d{1,2})[\s\-/.]*([A-Za-z]{3})[a-z]*\.?(?:[\s\-/.,]+(\d{4}|\d{2}))?$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return null;
    if (m[3]) return ymd(Number(m[3]), mon, Number(m[1]));
    if (!end) return null;
    const [ey, em] = end.split('-').map(Number);
    return ymd(mon > em ? ey - 1 : ey, mon, Number(m[1]));
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(s))) {
    return order === 'mdy' ? ymd(Number(m[3]), Number(m[1]), Number(m[2])) : ymd(Number(m[3]), Number(m[2]), Number(m[1]));
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s))) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/**
 * Day/month order of a file's "a/b/yyyy" dates: day first if any first part is > 12, month first
 * if any second part is > 12, else day first (Singapore banks) — `ambiguous` then.
 */
export function dateOrder(values) {
  const parts = values.map((v) => /^(\d{1,2})\/(\d{1,2})\/(?:\d{4}|\d{2})$/.exec(String(v ?? '').trim())).filter(Boolean);
  if (parts.some((m) => Number(m[1]) > 12)) return { order: 'dmy', ambiguous: false };
  if (parts.some((m) => Number(m[2]) > 12)) return { order: 'mdy', ambiguous: false };
  return { order: 'dmy', ambiguous: parts.some((m) => m[1] !== m[2]) };
}

/** Signed cents from "1,234.56", "-12.30", "12.30 CR" / "DR", "(12.30)", "S$12.30", or a number; null if not money. */
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) < 1e10 ? Math.round(v * 100) : null;
  let s = String(v ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  const m = /^(?:S?\$|SGD)?\s*([+-])?\s*(?:S?\$|SGD)?\s*(\d{1,3}(?:,\d{3})+|\d{1,10})(?:\.(\d{1,2}))?\s*(CR|DR)?$/i.exec(s);
  if (!m) return null;
  const cents = Number(m[2].replace(/,/g, '')) * 100 + Number((m[3] ?? '0').padEnd(2, '0'));
  if (m[1] === '-' || /DR/i.test(m[4] ?? '')) neg = true;
  return neg ? -cents : cents;
}

const NOISE = new Set(`POS NETS EPS VISA MASTERCARD MC DEBIT CREDIT CARD PURCHASE POINT OF SALE TRANSACTION TRANSFER FAST PAYMENT PAYMENTS
  PAYNOW GIRO IBG ICT MST UMC BILL TO FROM OTHR OTHER INWARD OUTWARD SI STANDING INSTRUCTION REF REFERENCE SGP SG SINGAPORE SGD PTE LTD
  CO COM WWW THE AND NO ADVICE RECURRING VIA FUND FUNDS NETS QR CONTACTLESS BIZ AT ACCT ACCOUNT AC RECEIPT FOREIGN AMT AMOUNT
  EXCHANGE RATE FX USD EUR GBP MYR JPY AUD CNY RMB HKD IDR THB INR KRW TWD CAD CHF NZD PHP VND`.split(/\s+/));

/** Short merchant key ("NETFLIX", "NTUC FAIRPRICE") used for learning, recurring detection and insights. */
export function merchantKey(desc) {
  return String(desc ?? '').toUpperCase().replace(/••\d{4}/g, ' ').replace(/[^A-Z&]+/g, ' ')
    .split(' ').filter((w) => w.length > 1 && !NOISE.has(w)).slice(0, 3).join(' ');
}
export const prettyMerchant = (key) => key.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Description normalised for duplicate detection. */
export const normDesc = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9•]+/g, '');

// ---- categorising --------------------------------------------------------------------------------

// [pattern, category names to try (first that exists in the family wins), kind]. Order matters:
// NTUC Income before NTUC FairPrice, GrabFood before Grab.
const RULES = [
  [/\b(AIA|PRUDENTIAL|GREAT EASTERN|NTUC INCOME|INCOME INSURANCE|MANULIFE|AVIVA|SINGLIFE|FWD|HSBC LIFE|TOKIO MARINE|CHUBB|ETIQA|AXA)\b/, ['Insurance', 'Health'], 'expense'],
  [/\b(GRABFOOD|GRAB ?FOOD|FOODPANDA|DELIVEROO|MCDONALD'?S?|KFC|STARBUCKS|TOAST BOX|YA KUN|KOPITIAM|FOOD REPUBLIC|KOUFU|BREADTALK|SUBWAY|JOLLIBEE|DIN TAI FUNG|HAWKER|RESTAURANT|CAFE)\b/, ['Dining'], 'expense'],
  [/\b(NTUC|FAIRPRICE|FAIR ?PRICE|FP ?XTRA|COLD STORAGE|SHENG SIONG|GIANT|DON DON DONKI|DONKI|PRIME SUPERMARKET|REDMART|CS FRESH|SUPERMARKET)\b/, ['Groceries'], 'expense'],
  [/\b(GRAB|GOJEK|COMFORTDELGRO|CDG ?TAXI|TADA|RYDE|SIMPLYGO|TRANSITLINK|EZ-?LINK|BUS ?\/ ?MRT|SMRT|SBS TRANSIT|MRT|SHELL|ESSO|CALTEX|SPC|SINOPEC|CARPARK|PARKING|ERP)\b/, ['Transport'], 'expense'],
  [/\b(SINGTEL|STARHUB|M1|SIMBA|CIRCLES ?LIFE|GOMO|MYREPUBLIC|VIEWQWEST|SP GROUP|SP SERVICES|SP DIGITAL|SENOKO|GENECO|TUAS POWER|KEPPEL ELECTRIC|CITY GAS)\b/, ['Utilities'], 'expense'],
  [/\b(SHOPEE|LAZADA|AMAZON|AMZN|TAOBAO|QOO10|IKEA|UNIQLO|COURTS|HARVEY NORMAN|BEST DENKI|CHALLENGER|DECATHLON|TEMU|ZALORA)\b/, ['Shopping'], 'expense'],
  [/\b(NETFLIX|SPOTIFY|DISNEY|YOUTUBE|APPLE\.COM|STEAM|PLAYSTATION|NINTENDO|GOLDEN VILLAGE|SHAW THEATRES|CATHAY CINEPLEXES|KLOOK)\b/, ['Entertainment'], 'expense'],
  [/\b(GUARDIAN|WATSONS|POLYCLINIC|CLINIC|HOSPITAL|DENTAL|PHARMACY|RAFFLES MEDICAL|PARKWAY)\b/, ['Health'], 'expense'],
  [/\b(HDB|TOWN COUNCIL|MCST|RENTAL|MORTGAGE|HOME LOAN)\b/, ['Housing'], 'expense'],
  [/\b(IRAS|TAX)\b/, ['Taxes', 'Other'], 'expense'],
  [/\b(CPF|SRS)\b/, ['Savings'], 'expense'],
  [/\b(SCHOOL|MOE|KINDERGARTEN|PRESCHOOL|STUDENT CARE|TUITION|SPARKLETOTS)\b/, ['Kids'], 'expense'],
  [/\b(SALARY|PAYROLL)\b/, ['Salary'], 'income'],
  [/\b(INTEREST|DIVIDEND|CASHBACK)\b/, ['Side income'], 'income'],
  [/\b(REFUND|REVERSAL)\b/, ['Gifts & refunds'], 'income'],
];

/** Built-in category id for a description, mapped onto the family's categories by name; null if none. */
export function ruleCategory(desc, kind, cats) {
  const up = String(desc ?? '').toUpperCase();
  for (const [re, names, k] of RULES) {
    if (k !== kind || !re.test(up)) continue;
    for (const n of names) {
      const c = cats.find((x) => x.kind === kind && x.name.toLowerCase() === n.toLowerCase());
      if (c) return c.id;
    }
  }
  return null;
}

// ---- recurring detection -------------------------------------------------------------------------

const monthIndex = (date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/**
 * Monthly payments: same kind + merchant key, then grouped by amount (within 10%); a series needs
 * one payment a month in ≥ 2 consecutive months (a one-month gap is allowed) on roughly the same
 * day (± 7). When a merchant has the same number (2–3) of such payments every month — two Singtel
 * plans — they're split by size into fixed-amount series (± 2%, ± 3 days). A merchant paid a
 * different number of times from month to month is everyday spending, not a bill. `items`: { key, kind, amount_cents, date, ref, statement }.
 * Returns [{ key, kind, amount_cents, day_of_month, months_seen, latest, refs }].
 */
export function detectRecurring(items) {
  const groups = new Map();
  for (const it of items) {
    if (!it.key) continue;
    const g = `${it.kind}|${it.key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  const out = [];
  const series = (list, tol, dayTol) => {
    const anchor = list.filter((i) => i.statement).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!anchor) return;
    const near = list.filter((i) => Math.abs(i.amount_cents - anchor.amount_cents) <= anchor.amount_cents * tol);
    const byMonth = new Map(near.map((i) => [monthIndex(i.date), i]));
    const months = [...byMonth.keys()].sort((a, b) => b - a);
    let seen = 1;
    for (let k = 1; k < months.length && months[k - 1] - months[k] <= 2; k++) seen++;
    if (seen < 2) return;
    const members = months.slice(0, seen).map((m) => byMonth.get(m));
    const days = members.map((i) => Number(i.date.slice(8, 10)));
    if (Math.max(...days) - Math.min(...days) > dayTol && !days.every((d) => d >= 25 || d <= 3)) return;
    out.push({
      key: anchor.key, kind: anchor.kind, amount_cents: anchor.amount_cents, day_of_month: Number(anchor.date.slice(8, 10)),
      months_seen: seen, latest: members[0], refs: members.map((i) => i.ref),
    });
  };
  for (const list of groups.values()) {
    // A merchant paid a different number of times from month to month (over the statement's months)
    // is everyday spending.
    const stmt = list.filter((i) => i.statement).map((i) => monthIndex(i.date));
    const perMonth = new Map();
    for (const i of list) {
      const m = monthIndex(i.date);
      if (m >= Math.min(...stmt) && m <= Math.max(...stmt)) perMonth.set(m, (perMonth.get(m) ?? 0) + 1);
    }
    if (new Set(perMonth.values()).size > 1) continue;
    // Amount clusters: sorted, a new cluster starts more than 10% above the previous amount.
    const sorted = [...list].sort((a, b) => a.amount_cents - b.amount_cents);
    const clusters = [];
    for (const it of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && it.amount_cents <= last[last.length - 1].amount_cents * 1.1) last.push(it);
      else clusters.push([it]);
    }
    for (const cluster of clusters) {
      const byMonth = new Map();
      for (const i of cluster) byMonth.set(monthIndex(i.date), [...(byMonth.get(monthIndex(i.date)) ?? []), i]);
      const counts = new Set([...byMonth.values()].map((v) => v.length));
      if (counts.size === 1 && counts.has(1)) series(cluster, 0.1, 7);
      else if (counts.size === 1 && [...counts][0] <= 3) {
        const k = [...counts][0];
        const ranked = [...byMonth.values()].map((v) => [...v].sort((a, b) => a.amount_cents - b.amount_cents));
        for (let r = 0; r < k; r++) series(ranked.map((v) => v[r]), 0.02, 3);
      }
    }
  }
  return out;
}

// ---- file readers (run inside the worker) -----------------------------------------------------------

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  return utf8.replace(/^﻿/, '');
}

function parseCsv(text) {
  const head = text.slice(0, 4096);
  const delim = ['\t', ';', ','].reduce((a, d) => ((head.split(d).length > head.split(a).length) ? d : a), ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const push = () => { row.push(cell.length > 500 ? cell.slice(0, 500) : cell); cell = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (c === '"' && cell.trim() === '') { quoted = true; cell = ''; } else if (c === delim) push();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      push();
      rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 200) fail('TOO_LARGE', MESSAGES.TOO_COMPLEX);
    } else if (cell.length < 2000) cell += c;
  }
  push();
  rows.push(row);
  return rows;
}

/** Entries of a .zip (only the ones `want(name)` accepts), inflated under a total output cap. */
function unzip(buf, want) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > 5000 || p >= buf.length) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED); // zip64 / damaged
  const files = new Map();
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (!want(name)) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + size > buf.length) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
    const data = buf.subarray(start, start + size);
    let out;
    if (method === 0) out = data;
    else if (method === 8) {
      try {
        out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, MAX_UNZIPPED - total) });
      } catch (err) {
        fail(err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError ? 'TOO_LARGE' : 'UNSUPPORTED', err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError ? MESSAGES.TOO_COMPLEX : MESSAGES.UNSUPPORTED);
      }
    } else fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
    total += out.length;
    if (total > MAX_UNZIPPED) fail('TOO_LARGE', MESSAGES.TOO_COMPLEX);
    files.set(name, out.toString('utf8'));
  }
  return files;
}

const xmlText = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  }
  return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
});

/**
 * <tag …>inner</tag> and <tag …/> elements, found with indexOf (linear: no regex backtracking on
 * broken XML). Stops at the first unclosed element. ponytail: no nested same-name tags (xlsx has none).
 */
function elements(xml, tag, max = Infinity) {
  const out = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  for (let i = xml.indexOf(open); i >= 0 && out.length < max; i = xml.indexOf(open, i)) {
    if (!/[\s/>]/.test(xml[i + open.length] ?? '')) { i += open.length; continue; } // <tagname…> of another tag
    const gt = xml.indexOf('>', i);
    if (gt < 0 || gt - i > 4096) break;
    if (xml[gt - 1] === '/') { out.push({ attrs: xml.slice(i + open.length, gt - 1), inner: '' }); i = gt + 1; continue; }
    const end = xml.indexOf(close, gt);
    if (end < 0) break;
    out.push({ attrs: xml.slice(i + open.length, gt), inner: xml.slice(gt + 1, end) });
    i = end + close.length;
  }
  return out;
}
const runs = (xml) => elements(xml, 't').map((e) => xmlText(e.inner)).join('');

/** First worksheet of an .xlsx as rows of cells (strings, or numbers for numeric cells). */
function readXlsx(buf) {
  const meta = unzip(buf, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml');
  const wb = meta.get('xl/workbook.xml');
  if (!wb) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
  const rid = /\br:id="([^"]+)"/.exec(elements(wb, 'sheet', 1)[0]?.attrs ?? '')?.[1];
  const rel = rid && elements(meta.get('xl/_rels/workbook.xml.rels') ?? '', 'Relationship', 1000).map((e) => e.attrs).find((t) => t.includes(`Id="${rid}"`));
  let target = (rel && /Target="([^"]+)"/.exec(rel)?.[1]) || 'worksheets/sheet1.xml';
  target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheet = unzip(buf, (n) => n === target).get(target);
  if (!sheet) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
  const shared = elements(meta.get('xl/sharedStrings.xml') ?? '', 'si', 500_001).map((e) => runs(e.inner));
  if (shared.length > 500_000) fail('TOO_LARGE', MESSAGES.TOO_COMPLEX);
  const sheetRows = elements(sheet, 'row', MAX_ROWS + 201);
  if (sheetRows.length > MAX_ROWS + 200) fail('TOO_LARGE', MESSAGES.TOO_COMPLEX);
  const rows = [];
  for (const rm of sheetRows) {
    const row = [];
    for (const cm of elements(rm.inner, 'c', 200)) {
      const ref = /\br="([A-Z]{1,3})\d+"/.exec(cm.attrs)?.[1];
      const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : row.length;
      if (col > 60) continue;
      const t = /\bt="(\w+)"/.exec(cm.attrs)?.[1];
      const inner = cm.inner;
      const v = elements(inner, 'v', 1)[0]?.inner;
      if (t === 'inlineStr') row[col] = runs(inner);
      else if (t === 's') row[col] = shared[Number(v)] ?? '';
      else if (t === 'str' || t === 'b' || t === 'e') row[col] = xmlText(v ?? '');
      else row[col] = v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v);
    }
    rows.push(Array.from(row, (c) => c ?? ''));
  }
  return rows;
}

// ---- table (CSV / XLSX) statements ---------------------------------------------------------------

const lc = (c) => String(c ?? '').trim().toLowerCase();

const TITLES = /^(?:MR|MRS|MS|MDM|MISS|DR|MADAM)\.?\s+/i;
const NOT_A_NAME = /\b(?:BANK|DBS|POSB|UOB|STATEMENT|ACCOUNT|CONSOLIDATED|PERIOD|PAGE|DETAILS|SINGAPORE|LTD|LIMITED|SAMPLE STATEMENT|CONTACT|EMAIL|WWW|TOTAL|BALANCE)\b/i;
/**
 * The holder's name in a PDF header without a "Name:" label: DBS and UOB print it as the first line
 * of the address block — an all-capitals line of 2–6 words (optionally "MR"/"MS"…) followed by an
 * address line with a number in it ("88 SENGKANG SQUARE", "BLK 123 …", "#12-31 …").
 */
function unlabelledHolder(lines) {
  for (let i = 0; i < lines.length - 1; i++) {
    const t = (lines[i].cells[0]?.s ?? '').trim(); // the left column only ("Contact Us" sits on the right)
    if (!/^[A-Z][A-Z'.-]*(?:\s+[A-Z][A-Z'.-]*){1,5}$/.test(t) || NOT_A_NAME.test(t)) continue;
    if (/\d/.test(lines[i + 1].cells[0]?.s ?? '')) return t.replace(TITLES, '');
  }
  return null;
}
const BALANCE_LINE = /balance b\/f|balance c\/f|brought forward|carried forward|opening balance|closing balance|previous balance/i;
const HOLDER_LABEL = /^(?:account holder|customer name|account name|name)\s*:?$/i;
const isHeaderRow = (r) => {
  const h = r.map(lc);
  return h.some((c) => /\bdate\b/.test(c)) && (h.some((c) => /debit|withdraw/.test(c)) && h.some((c) => /credit|deposit/.test(c)) || h.some((c) => /amount/.test(c)));
};

function detectBank(text, header = '') {
  if (/\bUOB\b|United Overseas Bank|uobgroup/i.test(text)) return 'uob';
  if (/\bPOSB\b/i.test(text)) return 'posb';
  if (/\bDBS\b|dbs\.com/i.test(text)) return 'dbs';
  // Headers alone, when the preamble was trimmed: DBS's "Transaction Ref1" and UOB's "Transaction Description … Available Balance".
  if (/transaction ref1/i.test(header)) return 'dbs';
  if (/transaction description/i.test(header) && /available balance/i.test(header)) return 'uob';
  return null;
}

function accountLast4(text) {
  for (const line of text.split('\n')) {
    if (!/account|a\/c/i.test(line)) continue;
    const m = /(\d[\d -]{5,24}\d)/.exec(line.replace(/\b\d{1,2} [A-Za-z]{3} \d{4}\b/g, ''));
    if (m && m[1].replace(/\D/g, '').length >= 6) return m[1].replace(/\D/g, '').slice(-4);
  }
  return null;
}

const DATE_RE = '\\d{1,2}[ -][A-Za-z]{3}[ -]\\d{4}';
function periodOf(text) {
  const m = new RegExp(`(${DATE_RE})\\s*(?:to|-|–)\\s*(${DATE_RE})`, 'i').exec(text);
  if (m) return { from: parseDate(m[1]), to: parseDate(m[2]) };
  const end = new RegExp(`(?:as at|statement date|as of)[:\\s,]*(${DATE_RE})`, 'i').exec(text);
  return { from: null, to: end ? parseDate(end[1]) : null };
}

function parseTable(rows, format) {
  const hi = rows.findIndex((r, i) => i < 80 && isHeaderRow(r));
  if (hi < 0) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
  const header = rows[hi].map(lc);
  const preamble = rows.slice(0, hi).map((r) => r.join(' ')).join('\n');
  const bank = detectBank(preamble, header.join(','));
  if (!bank) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
  const find = (re, not = /$^/) => header.findIndex((c) => re.test(c) && !not.test(c));
  let dateCol = find(/^(transaction )?date$/);
  if (dateCol < 0) dateCol = find(/date/, /value|posting/);
  const debit = find(/debit|withdraw/);
  const credit = find(/credit|deposit/);
  const amountCol = debit < 0 || credit < 0 ? find(/amount/) : -1;
  const balanceCol = find(/balance/);
  const descCols = header.map((c, i) => (/desc|ref|detail|particular|narrat|payee|merchant|remark/.test(c) && i !== dateCol ? i : -1)).filter((i) => i >= 0);
  const period = periodOf(preamble);
  const { order, ambiguous } = dateOrder(rows.slice(hi + 1).map((r) => r[dateCol]));
  const out = [];
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    if (!r.some((c) => String(c ?? '').trim())) continue;
    const date = parseDate(r[dateCol], null, order);
    let cents = null;
    if (amountCol >= 0) cents = parseAmount(r[amountCol]);
    else {
      const d = parseAmount(r[debit]);
      const c = parseAmount(r[credit]);
      if (d) cents = -Math.abs(d);
      else if (c) cents = Math.abs(c);
    }
    if (!date || !cents) {
      // Balance-only lines ("BALANCE B/F", opening/closing balance) carry no transaction: skip quietly.
      const balanceOnly = date && !cents && (BALANCE_LINE.test(r.join(' ')) || (balanceCol >= 0 && parseAmount(r[balanceCol]) != null));
      if ((date || cents) && !balanceOnly) skipped++;
      continue;
    }
    out.push({
      date,
      description: clean(descCols.map((i) => String(r[i] ?? '').trim()).filter(Boolean).join(' ')),
      amount_cents: Math.abs(cents),
      kind: cents > 0 ? 'income' : 'expense',
      balance_cents: balanceCol >= 0 ? parseAmount(r[balanceCol]) : null,
    });
  }
  if (out.length > 1 && out[0].date > out[out.length - 1].date) out.reverse(); // newest-first exports
  let closing = out.length ? out[out.length - 1].balance_cents : null;
  if (closing == null) {
    const row = rows.slice(0, hi).find((r) => /ledger balance|closing balance/i.test(String(r[0] ?? '')));
    closing = row ? parseAmount(row.slice(1).find((c) => String(c).trim()) ?? '') : null;
  }
  const first = out[0];
  const opening = first?.balance_cents != null ? first.balance_cents + (first.kind === 'income' ? -first.amount_cents : first.amount_cents) : null;
  const warnings = skipped ? [`${skipped} line${skipped === 1 ? '' : 's'} couldn't be read and ${skipped === 1 ? 'was' : 'were'} skipped.`] : [];
  // Dates like 03/04/2026 read day first; say so when some then fall outside the statement's dates
  // (or, with only an end date, over two months before it).
  const early = period.to && new Date(Date.parse(`${period.to}T12:00:00Z`) - 62 * 864e5).toISOString().slice(0, 10);
  if (ambiguous && out.some((x) => (period.to && x.date > period.to) || (period.from ? x.date < period.from : early && x.date < early))) {
    warnings.push('Some dates could be day/month or month/day; they were read day first (DD/MM/YYYY). Check the dates before importing.');
  }
  const nameRow = rows.slice(0, hi).find((r) => HOLDER_LABEL.test(String(r[0] ?? '').trim()));
  const holder = nameRow ? String(nameRow.slice(1).find((c) => String(c).trim()) ?? '') : null;
  return { bank, format, last4: accountLast4(preamble), period, opening, closing, rows: out, warnings, holder };
}

// ---- PDF statements -------------------------------------------------------------------------------

const PDF_DATE = /^(\d{2}\/\d{2}\/\d{4}|\d{1,2} [A-Za-z]{3}(?: \d{4})?)$/;
const AMOUNT = /^(?:S?\$)?\d{1,3}(?:,\d{3})*\.\d{2}(?:\s?(?:CR|DR))?$/;

async function pdfLines(buf, password) {
  // pdf.js would load the native @napi-rs/canvas module for rendering; text extraction doesn't need it.
  const Module = createRequire(import.meta.url)('node:module');
  const load = Module._load;
  Module._load = function guarded(request, ...rest) {
    if (/^@napi-rs\//.test(request)) throw new Error('native modules are disabled in the statement parser');
    return load.call(this, request, ...rest);
  };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf), password: password || undefined, isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    enableXfa: false, verbosity: 0, disableAutoFetch: true, disableStream: true, isOffscreenCanvasSupported: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (err?.name === 'PasswordException') fail(password ? 'BAD_PASSWORD' : 'PASSWORD_REQUIRED', password ? MESSAGES.BAD_PASSWORD : MESSAGES.PASSWORD_REQUIRED);
    fail('UNSUPPORTED', MESSAGES.PDF);
  }
  try {
    if (doc.numPages > MAX_PAGES) fail('TOO_LARGE', MESSAGES.TOO_COMPLEX);
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      if (items.length > 20_000) fail('TOO_LARGE', MESSAGES.TOO_COMPLEX);
      const pageLines = [];
      const byY = new Map(); // y rounded to 2pt → line (the neighbours are checked too: ± 2pt)
      for (const it of items) {
        if (!it.str?.trim()) continue;
        const x = it.transform[4];
        const y = it.transform[5];
        const k = Math.round(y / 2);
        let line = [byY.get(k), byY.get(k - 1), byY.get(k + 1)].find((l) => l && Math.abs(l.y - y) <= 2);
        if (!line) {
          pageLines.push((line = { page: p, y, items: [] }));
          byY.set(k, line);
        }
        line.items.push({ x, r: x + (it.width || it.str.length * 4), s: it.str });
      }
      pageLines.sort((a, b) => b.y - a.y);
      for (const l of pageLines) {
        l.items.sort((a, b) => a.x - b.x);
        // Merge pieces of the same phrase (gap < 6pt) into cells; amounts always stand alone.
        const cells = [];
        for (const it of l.items) {
          const last = cells[cells.length - 1];
          if (last && it.x - last.r < 6 && !AMOUNT.test(it.s.trim()) && !AMOUNT.test(last.s)) { last.s += (it.x - last.r > 1 ? ' ' : '') + it.s; last.r = it.r; } else cells.push({ ...it });
        }
        cells.forEach((c) => { c.s = c.s.replace(/\s+/g, ' ').trim(); });
        lines.push({ page: l.page, y: l.y, cells, text: cells.map((c) => c.s).join(' ') });
      }
      if (lines.length > MAX_ROWS * 4) fail('TOO_LARGE', MESSAGES.TOO_COMPLEX);
    }
    return lines;
  } finally {
    await task.destroy();
  }
}

async function parsePdf(buf, password) {
  const lines = await pdfLines(buf, password);
  const hi = lines.findIndex((l) => /withdraw/i.test(l.text) && /deposit/i.test(l.text) && /balance/i.test(l.text) && /date/i.test(l.text));
  const preamble = lines.slice(0, hi < 0 ? 40 : hi).map((l) => l.text).join('\n');
  const bank = detectBank(preamble);
  if (!bank || hi < 0) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
  const all = lines.map((l) => l.text).join('\n');
  const period = periodOf(all);
  const end = period.to;
  let cols = null;
  const center = (c) => (c.x + c.r) / 2;
  const setCols = (l) => {
    const at = (re) => l.cells.find((c) => re.test(c.s));
    const w = at(/withdraw/i);
    const d = at(/deposit/i);
    const b = at(/balance/i);
    cols = { w: center(w), d: center(d), b: center(b), desc: at(/description|details|particulars/i)?.x ?? w.x / 2 };
  };
  const rows = [];
  const warnings = [];
  let opening = null;
  let closing = null;
  let current = null;
  let continuations = 0;
  let prevY = null;
  let undated = 0;
  const last4 = accountLast4(preamble);
  for (let i = hi; i < lines.length; i++) {
    const l = lines[i];
    const t = l.text;
    if (/withdraw/i.test(t) && /deposit/i.test(t) && /balance/i.test(t)) {
      // A table for another account (consolidated statements): stop at the first account.
      // ponytail: one account per import; the others can be imported from their own exports.
      const other = i > hi ? accountLast4(lines.slice(Math.max(hi + 1, i - 6), i).map((x) => x.text).join('\n')) : null;
      if (other && last4 && other !== last4) {
        warnings.push('This statement covers more than one account; only the first one was imported.');
        break;
      }
      setCols(l);
      current = null;
      prevY = l.y;
      continue;
    }
    const nums = l.cells.filter((c) => AMOUNT.test(c.s) && c.x > cols.desc + 40);
    const nearest = (c) => ['w', 'd', 'b'].reduce((a, k) => (Math.abs(center(c) - cols[k]) < Math.abs(center(c) - cols[a]) ? k : a), 'w');
    const pick = (k) => { const c = nums.find((n) => nearest(n) === k); return c ? Math.abs(parseAmount(c.s)) : null; };
    if (/balance brought forward|balance b\/f|opening balance|previous balance/i.test(t)) {
      // DBS repeats "Balance Brought Forward" at the top of every page: only the first one opens.
      if (opening == null && !rows.length) opening = pick('b') ?? (nums.length ? Math.abs(parseAmount(nums[nums.length - 1].s)) : null);
      current = null;
      continue;
    }
    if (/balance carried forward|balance c\/f|closing balance|total balance/i.test(t)) {
      closing = pick('b') ?? (nums.length ? Math.abs(parseAmount(nums[nums.length - 1].s)) : closing);
      current = null;
      continue;
    }
    const first = l.cells[0];
    const date = first && PDF_DATE.test(first.s) ? parseDate(first.s, end) : null;
    if (first && PDF_DATE.test(first.s) && !date) undated++;
    const w = pick('w');
    const d = pick('d');
    if (date && (w || d)) {
      const prev = rows.length ? rows[rows.length - 1].balance_cents : opening;
      const bal = pick('b');
      const amount = w || d;
      let kind = w ? 'expense' : 'income';
      // The running balance decides when it agrees with the amount (columns can drift on later pages).
      if (prev != null && bal != null && Math.abs(Math.abs(bal - prev) - amount) <= 1) kind = bal > prev ? 'income' : 'expense';
      const words = l.cells.slice(1).filter((c) => !nums.includes(c)).map((c) => c.s);
      current = { date, description: words.join(' '), amount_cents: amount, kind, balance_cents: bal };
      rows.push(current);
      continuations = 0;
      prevY = l.y;
      if (rows.length > MAX_ROWS) fail('TOO_LARGE', MESSAGES.TOO_COMPLEX);
      continue;
    }
    // Continuation of the previous row's description (PayNow / card details on the next line).
    if (current && !nums.length && !date && continuations < 3 && first && first.x >= cols.desc - 5 && first.x < cols.w - 20
      && prevY != null && prevY - l.y < 16 && l.page === lines[i - 1]?.page) {
      current.description += ` ${t}`;
      continuations++;
      prevY = l.y;
      continue;
    }
    current = null;
  }
  if (!rows.length && undated) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED);
  for (const r of rows) r.description = clean(r.description);
  const holder = preamble.split('\n').map((t) => /^(?:account holder|customer name|account name|name)\s*:\s*(.+)$/i.exec(t)?.[1]).find(Boolean)
    ?? unlabelledHolder(lines.slice(0, hi));
  return { bank, format: 'pdf', last4, period, opening, closing: closing ?? rows[rows.length - 1]?.balance_cents ?? null, rows, warnings, holder };
}

/** Parse a statement file (Buffer). Throws ImportError with a contract code. */
export async function parseStatement(buf, { password = null, filename = '' } = {}) {
  if (buf.length > MAX_FILE_BYTES) fail('TOO_LARGE', MESSAGES.TOO_LARGE);
  if (buf.length < 4) fail('EMPTY', MESSAGES.EMPTY);
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(filename)?.[1] ?? '').toLowerCase();
  let res;
  if (buf.subarray(0, 1024).includes('%PDF-')) res = await parsePdf(buf, password);
  else if (buf.readUInt32LE(0) === 0x04034b50) res = parseTable(readXlsx(buf), 'xlsx');
  else if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0) fail('UNSUPPORTED', MESSAGES.XLS); // legacy BIFF .xls
  else if (buf.subarray(0, 4096).includes(0) && !(buf[0] === 0xff || buf[0] === 0xfe)) fail('UNSUPPORTED', MESSAGES.UNSUPPORTED); // binary
  else res = parseTable(parseCsv(decodeText(buf)), ext === 'xls' ? 'xls' : 'csv');
  if (!res.rows.length) fail('EMPTY', MESSAGES.EMPTY);
  if (res.rows.length > MAX_ROWS) fail('TOO_LARGE', MESSAGES.TOO_COMPLEX);
  // The statement holder's own name (self-transfers: "FROM ALEX RIVERA", "RIVERA ALEX") becomes
  // "(you)", its words in any order; the name itself is never kept.
  const names = [...new Set(normText(res.holder ?? '').replace(TITLES, '').toUpperCase().split(/[\s,]+/).filter((w) => /\p{L}/u.test(w)))].slice(0, 6);
  if (names.join('').length >= 3) {
    const alt = names.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?:[\\s,]+(?:${alt})){${names.length - 1}}(?![\\p{L}\\p{N}])`, 'giu');
    const all = (m) => names.every((w) => m.toUpperCase().split(/[\s,]+/).includes(w));
    for (const r of res.rows) r.description = r.description.replace(re, (m) => (all(m) ? '(you)' : m));
  }
  delete res.holder;
  const dates = res.rows.map((r) => r.date).sort();
  return {
    ...res,
    period: { from: res.period.from && res.period.from <= dates[0] ? res.period.from : dates[0], to: res.period.to && res.period.to >= dates[dates.length - 1] ? res.period.to : dates[dates.length - 1] },
  };
}

// ---- worker plumbing ----------------------------------------------------------------------------------

let running = 0;
const waiting = [];
const busy = new Set(); // owners with a parse queued or running
const MAX_QUEUE = 4;
const CHILD_FLAG = 'HEARTH_STATEMENT_PARSER';
// pdf.js inflates streams into typed arrays outside V8's heap limit, so the parser process's
// resident memory is capped too; past it the process exits and the OS takes everything back.
const CHILD_RSS_LIMIT = 320 * 1024 * 1024;
/**
 * Node's permission model for the parser process: it may read only its own code (this folder, the
 * server's package.json) and pdf.js — not the database, the key file or uploads — and may not
 * write files, start processes or load native addons. It may start the one worker thread it parses
 * on (--allow-worker; workers inherit these limits).
 */
export function parserFlags() {
  const require = createRequire(import.meta.url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // pdf.js as Node finds it (node_modules may be a symlink: both that path and its target are needed).
  let linked = null;
  for (let dir = here; !linked && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'node_modules', 'pdfjs-dist', 'package.json'))) linked = path.join(dir, 'node_modules', 'pdfjs-dist');
  }
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  // Node resolves modules with realpath, which looks at each symlink on the way: those need read access too.
  // ponytail: a symlinked node_modules is then readable as a whole (it holds no secrets).
  const links = [];
  for (const p of [here, linked].filter(Boolean)) {
    for (let q = p; q !== path.dirname(q); q = path.dirname(q)) {
      try { if (fs.lstatSync(q).isSymbolicLink()) links.push(q); } catch { /* gone */ }
    }
  }
  const paths = [here, path.resolve(here, '../../../package.json'), path.dirname(require.resolve('pdfjs-dist/package.json')), linked, ...links].filter(Boolean);
  // Shorter paths first: Node 22 ignores an allowed folder listed after a path inside it.
  const reads = [...new Set(paths.flatMap((p) => [p, real(p)]))].sort((a, b) => a.length - b.length);
  return ['--permission', ...reads.map((p) => `--allow-fs-read=${p}`), '--allow-worker', '--disable-warning=SecurityWarning'];
}

// The smallest PDF pdf.js will open (one empty page; it rebuilds the missing cross-reference table).
const MINI_PDF = '%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n'
  + '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 10 10]>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n';
let selfTest = null;
/**
 * Can this server read PDF statements? Opens a tiny built-in PDF through the real parser process
 * (permission flags, worker thread, pdf.js) once per process; resolves true/false, never throws.
 */
export function pdfImportSelfTest() {
  selfTest ??= parseInWorker(Buffer.from(MINI_PDF), { selfTest: true }).then((r) => r === 'ok', () => false);
  return selfTest;
}

/**
 * Parse in a separate, short-lived process (this file, run with HEARTH_STATEMENT_PARSER=1): it has
 * no environment (no encryption key, …), no output (pdf.js chatter is dropped, never logged), at most
 * 320 MB resident memory, a 256 MB heap and 20 s; inside it the parsing runs on a worker thread so
 * the memory watch keeps ticking. At most 2 parses at a time, 4 waiting, and one per `owner` —
 * anything more is refused right away with code BUSY. The caller's buffer is zeroed.
 */
export async function parseInWorker(buffer, { password = null, filename = '', owner = null, selfTest: test = false } = {}) {
  if ((owner != null && busy.has(owner)) || (running >= MAX_WORKERS && waiting.length >= MAX_QUEUE)) {
    buffer.fill(0);
    throw new ImportError('BUSY', MESSAGES.BUSY);
  }
  if (owner != null) busy.add(owner);
  const data = new Uint8Array(buffer.length);
  data.set(buffer);
  buffer.fill(0);
  let started = false;
  try {
    if (running >= MAX_WORKERS) await new Promise((r) => waiting.push(r));
    running++;
    started = true;
    return await new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), [], {
        env: { [CHILD_FLAG]: '1' },
        execArgv: ['--max-old-space-size=256', '--disable-warning=ExperimentalWarning', ...parserFlags()],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
      });
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        fn(v);
      };
      const tooBig = () => new ImportError('TOO_LARGE', MESSAGES.TOO_COMPLEX);
      const timer = setTimeout(() => finish(reject, tooBig()), TIMEOUT_MS);
      child.on('message', (m) => (m?.ok ? finish(resolve, m.result) : finish(reject, new ImportError(m?.code ?? 'UNSUPPORTED', m?.message ?? MESSAGES.UNSUPPORTED))));
      child.on('error', () => finish(reject, new ImportError('UNSUPPORTED', MESSAGES.UNSUPPORTED)));
      child.on('exit', (code) => finish(reject, code === 3 ? tooBig() : new ImportError('UNSUPPORTED', MESSAGES.UNSUPPORTED)));
      child.send({ data, password, filename, selfTest: test }, () => data.fill(0));
    });
  } finally {
    if (owner != null) busy.delete(owner);
    if (started) {
      running--;
      waiting.shift()?.();
    }
  }
}

// The parser process: watch our own memory, parse on a worker thread, answer once, exit.
if (isMainThread && process.env[CHILD_FLAG] && process.send) {
  process.once('message', ({ data, password, filename, selfTest: test }) => {
    setInterval(() => { if (process.memoryUsage.rss() > CHILD_RSS_LIMIT) process.exit(3); }, 10);
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { hearthStatement: true, data, password, filename, selfTest: test },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    worker.on('message', (m) => process.send(m, () => process.exit(0)));
    worker.on('error', (err) => process.exit(err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 3 : 1));
    worker.on('exit', () => process.exit(1));
  });
}

if (!isMainThread && workerData?.hearthStatement && workerData.selfTest) {
  pdfLines(Buffer.from(workerData.data.buffer, workerData.data.byteOffset, workerData.data.byteLength), null)
    .then(() => parentPort.postMessage({ ok: true, result: 'ok' }), () => parentPort.postMessage({ ok: false, code: 'UNSUPPORTED', message: MESSAGES.PDF }));
} else if (!isMainThread && workerData?.hearthStatement) {
  const { data, password, filename } = workerData;
  parseStatement(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { password, filename }).then(
    (result) => parentPort.postMessage({ ok: true, result }),
    // Only our own codes/messages cross back: library errors could quote the file.
    (err) => parentPort.postMessage({ ok: false, code: err instanceof ImportError ? err.code : 'UNSUPPORTED', message: err instanceof ImportError ? err.message : MESSAGES.UNSUPPORTED }),
  );
}
