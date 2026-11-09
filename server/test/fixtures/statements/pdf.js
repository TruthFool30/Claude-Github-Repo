// Tiny PDF writer for synthetic statement fixtures (tests only): Helvetica text placed at x/y,
// several pages, optional password (standard security handler, RC4 128-bit, revision 3).
//   makePdf([[ [x, y, 'text'], ... ], ...page2], { password: 'secret' }) -> Buffer
import crypto from 'node:crypto';

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();

function rc4(key, data) {
  const s = [...Array(256).keys()];
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const padPw = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

/** Algorithms 3.2–3.5 of the PDF 1.7 spec, revision 3, 16-byte key. */
function security(password, id) {
  const P = -3904;
  let ok = md5(padPw(`${password}-owner`));
  for (let i = 0; i < 50; i++) ok = md5(ok);
  let O = rc4(ok, padPw(password));
  for (let i = 1; i <= 19; i++) O = rc4(ok.map((b) => b ^ i), O);
  const p = Buffer.alloc(4);
  p.writeInt32LE(P);
  let key = md5(padPw(password), O, p, id);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  key = key.subarray(0, 16);
  let U = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++) U = rc4(key.map((b) => b ^ i), U);
  U = Buffer.concat([U, Buffer.alloc(16)]);
  return { key, dict: `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${O.toString('hex')}> /U <${U.toString('hex')}> >>` };
}

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function makePdf(pages, { password = null } = {}) {
  const id = crypto.createHash('md5').update(JSON.stringify(pages)).digest();
  const sec = password != null ? security(password, id) : null;
  const objs = []; // [num, body-builder(num) -> Buffer]
  const add = (fn) => { objs.push(fn); return objs.length; };
  const objKey = (num) => md5(sec.key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 16);
  const stream = (data) => (num) => {
    const body = sec ? rc4(objKey(num), data) : data;
    return Buffer.concat([Buffer.from(`<< /Length ${body.length} >>\nstream\n`), body, Buffer.from('\nendstream')]);
  };
  const text = (s) => () => Buffer.from(s);
  const catalog = add(text('<< /Type /Catalog /Pages 2 0 R >>'));
  const pagesNum = add(null);
  const font = add(text('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  const kids = [];
  for (const items of pages) {
    const content = items.map(([x, y, s, size = 9]) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join('\n');
    const c = add(stream(Buffer.from(content, 'latin1')));
    kids.push(add(text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`)));
  }
  objs[pagesNum - 1] = text(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const enc = sec ? add(text(sec.dict)) : null;

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objs.forEach((fn, i) => {
    const num = i + 1;
    const buf = Buffer.concat([Buffer.from(`${num} 0 obj\n`), fn(num), Buffer.from('\nendobj\n')]);
    offsets.push(offset);
    offset += buf.length;
    chunks.push(buf);
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  const idHex = id.toString('hex');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${enc ? ` /Encrypt ${enc} 0 R` : ''} /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
