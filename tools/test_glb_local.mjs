// Local smoke test for api/glb.mjs: builds a GLB from raw RGBA on disk.
// Usage: node tools/test_glb_local.mjs <rgba.bin> <w> <h> <out.glb>
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { buildGlb } from '../api/glb.mjs';
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff; for (const b of td) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, td, c]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) { raw[p++] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, p); p += w * 4; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
const [, , binPath, wS, hS, outPath] = process.argv;
const rgba = new Uint8Array(readFileSync(binPath));
const { glb, aspect } = buildGlb({ rgba, w: Number(wS), h: Number(hS), encodePng, name: 'test' });
writeFileSync(outPath, glb);
console.log('built', glb.length, 'bytes, aspect', aspect.toFixed(4));
