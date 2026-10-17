/**
 * 正确的多帧 zstd 解码 —— 按 zstd 帧格式走结构，而不是「试缩长度」。
 * magic: 28 B5 2F FD
 * Frame_Header_Descriptor (1 byte):
 *   bit7-6 Frame_Content_Size_flag, bit5 Single_Segment_flag,
 *   bit4 Unused, bit3 Reserved, bit2 Content_Checksum_flag, bit1-0 Dictionary_ID_flag
 * 之后按 flag 读 window/frame content size / dictID
 * 再循环 block：Block_Header (3 bytes LE) => bit0 last, bit2-1 type, bit23-3 size
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const DICT_ID_SIZE = [0, 1, 2, 4]
const FCS_SIZE = [0, 2, 4, 8]

export function splitZstdFrames(buf) {
  const frames = []
  let p = 0
  while (p + 4 <= buf.length) {
    // 对齐到 magic
    if (!(buf[p] === 0x28 && buf[p + 1] === 0xb5 && buf[p + 2] === 0x2f && buf[p + 3] === 0xfd)) { p++; continue }
    const start = p
    p += 4
    const fhd = buf[p++]
    const fcsFlag = fhd >> 6
    const singleSegment = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1
    const dictFlag = fhd & 3
    // Window descriptor（singleSegment=0 才有）
    if (!singleSegment) p += 1
    p += DICT_ID_SIZE[dictFlag]
    p += FCS_SIZE[fcsFlag]
    // blocks
    let last = false
    while (!last && p + 3 <= buf.length) {
      const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
      p += 3
      last = Boolean(bh & 1)
      const btype = (bh >> 1) & 3
      const bsize = bh >>> 3
      if (btype === 1) p += 1              // RLE: 1 byte
      else p += bsize                       // raw / compressed: bsize bytes
    }
    if (checksum) p += 4
    frames.push(buf.subarray(start, Math.min(p, buf.length)))
  }
  return frames
}

export function decodeAll(file) {
  const buf = readFileSync(file)
  const frames = splitZstdFrames(buf)
  const parts = []
  let failed = 0
  for (const fr of frames) {
    try { parts.push(zstdDecompressSync(fr)) } catch { failed++ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), total: frames.length, ok: frames.length - failed, failed }
}

if (process.argv[1]?.endsWith('zstd-frames.mjs')) {
  const r = decodeAll(process.argv[2])
  console.log(`frames=${r.total} ok=${r.ok} failed=${r.failed} chars=${r.text.length}`)
}
