import { readFileSync } from 'node:fs';
import * as zlib from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = 0xfd2fb528;
function invalid(message, offset, incomplete = false) { throw Object.assign(new Error(`${message} at byte ${offset}`), { code: incomplete ? 'INCOMPLETE' : 'INVALID_ZSTD', offset }); }
export function splitZstdFrames(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('Expected Buffer');
  if (!buf.length) invalid('Empty input', 0);
  const frames = [];
  let p = 0;
  const need = n => { if (p + n > buf.length) invalid('Incomplete frame', p, true); };
  while (p < buf.length) {
    need(4);
    const magic = buf.readUInt32LE(p), start = p;
    p += 4;
    // Skippable frames have an explicit payload length; never search inside their bytes.
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      need(4); const size = buf.readUInt32LE(p); p += 4; need(size); p += size;
      continue;
    }
    if (magic !== MAGIC) invalid('Unexpected frame magic', start);
    need(1);
    const descriptor = buf[p++];
    if (descriptor & 8) invalid('Reserved frame bit', p - 1);
    const fcsFlag = descriptor >>> 6, single = Boolean(descriptor & 32);
    const headerBytes = (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]);
    need(headerBytes); p += headerBytes;
    let last = false;
    while (!last) {
      need(3);
      const header = buf.readUIntLE(p, 3); p += 3;
      last = Boolean(header & 1);
      const type = (header >>> 1) & 3, size = header >>> 3;
      if (type === 3) invalid('Reserved block type', p - 3);
      if (size > 128 * 1024) invalid('Oversized block', p - 3);
      const stored = type === 1 ? 1 : size;
      need(stored); p += stored;
    }
    if (descriptor & 4) { need(4); p += 4; }
    frames.push(buf.subarray(start, p));
  }
  if (!frames.length) invalid('No data frames', p);
  return frames;
}
export function decodeAll(file, { maxOutputBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw Object.assign(new Error('This Node runtime lacks zstdDecompressSync'), { code: 'RUNTIME' });
  const frames = splitZstdFrames(readFileSync(file));
  const parts = [];
  let bytes = 0;
  for (const frame of frames) {
    const part = zlib.zstdDecompressSync(frame, { maxOutputLength: maxOutputBytes - bytes });
    bytes += part.length;
    if (bytes > maxOutputBytes) throw new Error('Decoded data exceeds limit');
    parts.push(part);
  }
  return { text: Buffer.concat(parts).toString('utf8'), total: frames.length, ok: frames.length, failed: 0, complete: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node zstd-frames.mjs FILE');
    const { text, ...stats } = decodeAll(process.argv[2]);
    console.log(JSON.stringify({ ...stats, chars: text.length }));
  } catch (e) { console.error(JSON.stringify({ complete: false, error: e.code || 'DECODE_ERROR', message: e.message })); process.exitCode = 2; }
}
