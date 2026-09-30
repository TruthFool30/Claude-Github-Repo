// Detect real image files from their bytes (never trust the client's MIME type or file name).
// Supports JPEG, PNG, GIF, WebP and AVIF, and reads pixel dimensions.
import fs from 'node:fs';

export const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif' };
export const MAX_IMAGE_SIDE = 30000;

function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b) {
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

function avifSize(b) {
  // Find the first 'ispe' box: [size][ 'ispe' ][version/flags 4][width 4][height 4]
  const idx = b.indexOf('ispe', 0, 'ascii');
  if (idx < 4 || idx + 16 > b.length) return null;
  return { width: b.readUInt32BE(idx + 8), height: b.readUInt32BE(idx + 12) };
}

/** Inspect a buffer. Returns { mime, ext, width, height } or null when it isn't a supported, sane image. */
export function sniffImageBuffer(b) {
  if (!Buffer.isBuffer(b) || b.length < 16) return null;
  let mime = null;
  let size = null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { mime = 'image/jpeg'; size = jpegSize(b); }
  else if (b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('ascii', 12, 16) === 'IHDR') {
    mime = 'image/png'; size = { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } else if (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') {
    mime = 'image/gif'; size = { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  } else if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp'; size = webpSize(b);
  } else if (b.toString('ascii', 4, 8) === 'ftyp' && /avi[fs]/.test(b.toString('ascii', 8, 32))) {
    mime = 'image/avif'; size = avifSize(b);
  }
  if (!mime || !size) return null;
  const { width, height } = size;
  if (!(width >= 1 && height >= 1 && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE)) return null;
  return { mime, ext: IMAGE_EXT[mime], width, height };
}

/** Same as sniffImageBuffer for a file on disk (reads at most the first 256 KB). */
export function sniffImageFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return sniffImageBuffer(buf.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
