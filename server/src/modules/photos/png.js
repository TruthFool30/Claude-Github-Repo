// Tiny dependency-free PNG encoder + image-header size reader (used by the photos module).
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * Encode RGB pixels (Uint8Array/Buffer of width*height*3) as a PNG.
 * Rows use the Sub or Up filter (whichever looks cheaper) for decent compression of gradients.
 */
export function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const sub = Buffer.alloc(stride);
  const up = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let sumSub = 0;
    let sumUp = 0;
    for (let i = 0; i < stride; i++) {
      const v = rgb[row + i];
      const s = (v - (i >= 3 ? rgb[row + i - 3] : 0)) & 0xff;
      const u = (v - (y > 0 ? rgb[row - stride + i] : 0)) & 0xff;
      sub[i] = s;
      up[i] = u;
      sumSub += s < 128 ? s : 256 - s;
      sumUp += u < 128 ? u : 256 - u;
    }
    const out = y * (stride + 1);
    if (sumUp <= sumSub) {
      raw[out] = 2;
      up.copy(raw, out + 1);
    } else {
      raw[out] = 1;
      sub.copy(raw, out + 1);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 7 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Read pixel dimensions from an image header (PNG, JPEG, GIF, WebP). Returns {width,height} or null.
 * JPEG EXIF orientation 5–8 swaps width/height so the result matches what browsers display.
 */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  // GIF
  if (buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X' && buf.length >= 30) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return null;
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    let orientation = 1;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('ascii', off + 4, off + 8) === 'Exif') orientation = exifOrientation(buf, off + 10) || 1;
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        return orientation >= 5 ? { width: height, height: width } : { width, height };
      }
      off += 2 + len;
    }
  }
  return null;
}

/**
 * Cheap integrity check (no decompression, so a "decompression bomb" costs nothing): catches
 * truncated or corrupted uploads that would otherwise become broken tiles.
 * PNG: every chunk fits and has a valid CRC (native zlib.crc32), IHDR first, IDAT present with a
 * valid zlib header, IEND at the end. JPEG: has a scan (SOS) and an end-of-image marker.
 * Other formats: the header check done by ctx.verifyImage.
 */
export function isIntactImage(buf, mime) {
  try {
    if (mime === 'image/png') {
      const crc = zlib.crc32 ?? crc32;
      if (buf.length < 8 + 25 + 12) return false;
      let off = 8;
      let first = true;
      let sawIdat = false;
      while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (off + 12 + len > buf.length) return false;
        if (first && type !== 'IHDR') return false;
        first = false;
        if ((crc(buf.subarray(off + 4, off + 8 + len)) >>> 0) !== buf.readUInt32BE(off + 8 + len)) return false;
        if (type === 'IDAT' && !sawIdat) {
          sawIdat = true;
          const cmf = buf[off + 8];
          const flg = buf[off + 9];
          if (len < 2 || (cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) return false;
        }
        if (type === 'IEND') return sawIdat;
        off += 12 + len;
      }
      return false;
    }
    if (mime === 'image/jpeg') {
      if (buf.indexOf(Buffer.from([0xff, 0xda])) < 0) return false;
      let end = buf.length;
      while (end > 2 && buf[end - 1] === 0) end--;
      return buf[end - 2] === 0xff && buf[end - 1] === 0xd9;
    }
    return true;
  } catch {
    return false;
  }
}

function exifOrientation(buf, tiff) {
  try {
    const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = tiff + u32(tiff + 4);
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) return u16(e + 8);
    }
  } catch {
    /* malformed EXIF */
  }
  return null;
}
