// Synthetic bank statements for tests — every name, number and amount here is made up.
//   statement('dbs')                         -> { meta, rows } (rows oldest first, with running balances)
//   csv('uob'), xlsx('posb'), pdf('dbs', { password })  -> Buffer in that bank's export layout
//   node server/test/fixtures/statements/index.js       -> (re)writes the sample files next to this one
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { makePdf } from './pdf.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PDF_PASSWORD = 'sample-pass-123';

// [date, description lines, signed amount]
const COMMON = [
  ['2026-09-01', ['GIRO SALARY', 'SAMPLE EMPLOYER PTE LTD'], 5200],
  ['2026-09-03', ['POS NTUC FP-SAMPLE BRANCH'], -85.4],
  ['2026-09-07', ['NETFLIX.COM', 'SINGAPORE SG'], -19.98],
  ['2026-09-12', ['GRAB*TRIP CARD 4111 1111 1111 1111'], -32.1],
  ['2026-09-15', ['PAYNOW TRANSFER TO SAMPLE FRIEND', 'MOBILE +65 9123 4567'], -250],
  ['2026-09-18', ['GIRO SINGTEL MOBILE', 'ACCT 1234567890'], -96.3],
  ['2026-09-21', ['POS SAMPLE HARDWARE TRADING'], -42],
  ['2026-09-25', ['SHOPEE SINGAPORE MP'], -64.9],
  ['2026-10-01', ['GIRO SALARY', 'SAMPLE EMPLOYER PTE LTD'], 5200],
  ['2026-10-04', ['POS NTUC FP-SAMPLE BRANCH'], -91.25],
  ['2026-10-07', ['NETFLIX.COM', 'SINGAPORE SG'], -19.98],
  ['2026-10-10', ['FAST PAYMENT TO 000-111222-333 SAMPLE LANDLORD'], -1800],
  ['2026-10-18', ['GIRO SINGTEL MOBILE', 'ACCT 1234567890'], -98.1],
  ['2026-10-20', ['AIA SAMPLE POLICY PREMIUM'], -150],
  ['2026-10-22', ['BUS/MRT 987654321'], -3.5],
  ['2026-10-24', ['POS NTUC FP-SAMPLE BRANCH'], -64.1],
  ['2026-10-29', ['INTEREST EARNED'], 1.23],
];

const BANKS = {
  dbs: { name: 'DBS Multiplier Account', number: '123-45678-4821', opening: 3000 },
  posb: { name: 'POSB Savings Account', number: '987-65432-1357', opening: 1500 },
  uob: { name: 'One Account', number: '123-456-789-0', opening: 4200 },
};

export function statement(bank) {
  const meta = BANKS[bank];
  let bal = Math.round(meta.opening * 100);
  const rows = COMMON.map(([date, lines, amount]) => {
    bal += Math.round(amount * 100);
    return { date, lines, amount, balance: bal / 100 };
  });
  return { meta: { ...meta, closing: bal / 100, from: '2026-09-01', to: '2026-10-31' }, rows };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (d) => `${d.slice(8)} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const dm = (d) => `${d.slice(8)} ${MON[Number(d.slice(5, 7)) - 1]}`;
const fmt = (n) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Table layout (header rows + data rows) shared by the CSV and XLSX exports. */
function table(bank, { numeric = false } = {}) {
  const { meta, rows } = statement(bank);
  const money = (n) => (numeric ? Math.abs(n) : fmt(n));
  if (bank === 'uob') {
    // UOB account history export: preamble, newest transaction first, running balance.
    return [
      ['United Overseas Bank Limited'], ['Account Transaction History'], ['Account Number:', meta.number], ['Account Type:', meta.name],
      ['Statement Period:', `${dmy(meta.from)} To ${dmy(meta.to)}`], [],
      ['Transaction Date', 'Transaction Description', 'Withdrawal', 'Deposit', 'Available Balance'],
      ...rows.slice().reverse().map((r) => [dmy(r.date), r.lines.join(' '), r.amount < 0 ? money(r.amount) : '', r.amount > 0 ? money(r.amount) : '', money(r.balance)]),
    ];
  }
  // DBS / POSB iBanking CSV: preamble, oldest first, no running balance.
  return [
    ['Account Details For:', `${meta.name} ${meta.number}`], ['Statement as at:', dmy(meta.to)], ['Available Balance:', money(meta.closing)],
    ['Ledger Balance:', money(meta.closing)], [], [],
    ['Transaction Date', 'Reference', 'Debit Amount', 'Credit Amount', 'Transaction Ref1', 'Transaction Ref2', 'Transaction Ref3'],
    ...rows.map((r) => {
      const [code, ...rest] = r.lines[0].split(' ');
      const known = ['GIRO', 'POS', 'FAST', 'PAYNOW', 'BUS/MRT', 'INTEREST'].includes(code);
      return [dmy(r.date), known ? code : 'MST', r.amount < 0 ? money(r.amount) : '', r.amount > 0 ? money(r.amount) : '', known ? rest.join(' ') : r.lines[0], r.lines[1] ?? '', ''];
    }),
  ];
}

export const csv = (bank) => Buffer.from(`${table(bank).map((r) => r.map((c) => q(String(c))).join(',')).join('\r\n')}\r\n`);

// ---- xlsx --------------------------------------------------------------------------------------

/** Minimal zip writer (deflate). `entries`: [name, Buffer|string][] */
export function zip(entries, { method = 8 } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.from(content);
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    const nameBuf = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, data);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = (i) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));

/** An .xlsx workbook with one sheet. Numbers become numeric cells; with `sharedStrings` text goes there. */
export function xlsxFromRows(rows, { sharedStrings = false } = {}) {
  const strings = [];
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => {
    const ref = `${colName(ci)}${ri + 1}`;
    if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
    if (c === '') return '';
    if (sharedStrings) { strings.push(c); return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`; }
    return `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Transactions" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
  if (sharedStrings) files.push(['xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`]);
  return zip(files);
}

/** Excel export: amounts as numbers; UOB's dates as Excel serial numbers, DBS/POSB's as text in shared strings. */
export function xlsx(bank) {
  const rows = table(bank, { numeric: true });
  if (bank === 'uob') {
    for (const r of rows) {
      const d = /^\d{2} \w{3} \d{4}$/.test(r[0] ?? '') ? new Date(`${r[0]} UTC`) : null;
      if (d && !Number.isNaN(d.getTime())) r[0] = Math.round((d.getTime() - Date.UTC(1899, 11, 30)) / 864e5);
    }
  }
  return xlsxFromRows(rows, { sharedStrings: bank !== 'uob' });
}

// ---- pdf ---------------------------------------------------------------------------------------

/** Right-aligned text at `right` (Helvetica digits ≈ 5pt at 9pt). */
const ra = (right, y, s) => [right - s.length * 5, y, s];

export function pdf(bank, { password = null } = {}) {
  const { meta, rows } = statement(bank);
  const uob = bank === 'uob';
  const header = (y) => [[40, y, 'Date'], [110, y, 'Description'], [330, y, uob ? 'Withdrawals' : 'Withdrawal (-)'], [420, y, uob ? 'Deposits' : 'Deposit (+)'], [510, y, 'Balance']];
  const pages = [];
  let page = [];
  let y;
  let bal = meta.opening;
  const startPage = (first) => {
    page = [];
    pages.push(page);
    y = 800;
    if (first) {
      if (uob) {
        page.push([40, y, 'United Overseas Bank Limited', 12], [40, (y -= 16), 'Statement of Account (SAMPLE - NOT A REAL STATEMENT)'],
          [40, (y -= 14), 'SAMPLE CUSTOMER, 1 SAMPLE ROAD'], [40, (y -= 14), `Period: ${dmy(meta.from)} to ${dmy(meta.to)}`],
          [40, (y -= 20), `${meta.name}  ${meta.number}`]);
      } else {
        page.push([40, y, bank === 'posb' ? 'POSB  (a member of DBS Bank Ltd)' : 'DBS Bank Ltd', 12], [40, (y -= 16), 'CONSOLIDATED STATEMENT (SAMPLE - NOT REAL)'],
          [40, (y -= 14), 'SAMPLE CUSTOMER, 1 SAMPLE ROAD'], [40, (y -= 14), `Details as at ${dmy(meta.to)}`],
          [40, (y -= 20), meta.name], [300, y, `Account No. ${meta.number}`]);
      }
    } else page.push([40, y, `${uob ? 'United Overseas Bank Limited' : 'DBS Bank Ltd'} - continued`]);
    page.push(...header((y -= 24)));
    page.push([110, (y -= 16), uob ? 'BALANCE B/F' : 'Balance Brought Forward'], ra(560, y, fmt(bal)));
  };
  startPage(true);
  rows.forEach((r, i) => {
    if (i === 9) { // page break with carried/brought forward lines
      page.push([110, (y -= 16), uob ? 'BALANCE C/F' : 'Balance Carried Forward'], ra(560, y, fmt(bal)), [260, 40, 'Page 1 of 2']);
      startPage(false);
    }
    bal = r.balance;
    page.push([40, (y -= 16), uob ? dm(r.date) : `${r.date.slice(8)}/${r.date.slice(5, 7)}/${r.date.slice(0, 4)}`], [110, y, r.lines[0]],
      ra(r.amount < 0 ? 390 : 470, y, fmt(r.amount)), ra(560, y, fmt(r.balance)));
    for (const extra of r.lines.slice(1)) page.push([110, (y -= 11), extra]);
  });
  page.push([110, (y -= 16), uob ? 'BALANCE C/F' : 'Balance Carried Forward'], ra(560, y, fmt(bal)), [260, 40, 'Page 2 of 2']);
  return makePdf(pages, { password });
}

/** A one-page PDF whose content stream inflates to `bytes` of spaces (decompression bomb). */
export async function bombPdf(bytes) {
  const deflate = zlib.createDeflate({ level: 9 });
  const parts = [];
  deflate.on('data', (b) => parts.push(b));
  const done = new Promise((r) => deflate.on('end', r));
  const chunk = Buffer.alloc(16 * 1024 * 1024, 0x20);
  for (let left = bytes; left > 0; left -= chunk.length) if (!deflate.write(chunk)) await new Promise((r) => deflate.once('drain', r));
  deflate.end();
  await done;
  const stream = Buffer.concat(parts);
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << >> >>'];
  const chunks = [Buffer.from('%PDF-1.4\n')];
  let len = chunks[0].length;
  const offs = [];
  const add = (b) => { chunks.push(b); len += b.length; };
  objs.forEach((o, i) => { offs.push(len); add(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)); });
  offs.push(len);
  add(Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`));
  add(stream);
  add(Buffer.from('\nendstream\nendobj\n'));
  const xref = len;
  add(Buffer.from(`xref\n0 ${offs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : HERE;
  for (const bank of Object.keys(BANKS)) {
    fs.writeFileSync(path.join(out, `${bank}.csv`), csv(bank));
    fs.writeFileSync(path.join(out, `${bank}.xlsx`), xlsx(bank));
    fs.writeFileSync(path.join(out, `${bank}.pdf`), pdf(bank));
  }
  fs.writeFileSync(path.join(out, 'uob-protected.pdf'), pdf('uob', { password: PDF_PASSWORD }));
  console.log(`wrote sample statements to ${out}`);
}
