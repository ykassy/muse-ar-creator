// Local smoke test for api/glb.mjs: builds a GLB from raw RGBA on disk.
// Usage: node tools/test_glb_local.mjs [<rgba.bin> <w> <h> <out.glb>]
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { buildGlb, buildFittingGlb } from '../api/glb.mjs';
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
let w = Number(wS), h = Number(hS), rgba;
if (binPath) rgba = new Uint8Array(readFileSync(binPath));
else {
  // No input: draw a small blob, so this runs with no files and no network.
  w = h = 256; rgba = new Uint8Array(w * h * 4);
  const blobs = [[128, 110, 60], [85, 130, 45], [170, 130, 45], [128, 170, 50]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (blobs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 < r * r)) rgba.set([150, 200, 240, 255], (y * w + x) * 4);
  }
}
const { glb, aspect } = buildGlb({ rgba, w, h, encodePng, name: 'test' });
if (outPath) writeFileSync(outPath, glb);
const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
const clips = gltf.animations.map((a) => a.name);
console.log('built', glb.length, 'bytes, aspect', aspect.toFixed(4));
console.log('clips', clips.join(' '));
const want = ['idle', 'happy', 'surprised', 'sad', 'angry', 'talk', 'dangle', 'land', 'zap'];
if (want.some((n) => !clips.includes(n))) throw new Error('a clip is missing');

// With no back drawing, the back of the plate is the body's colour, not the dark outline.
if (!gltf.materials.some((m) => m.name === 'BackArt')) throw new Error('the plate has no back material');

// A drawing too detailed for the asset store still has to end up small enough to store.
const noisy = { w: 900, h: 900, rgba: new Uint8Array(900 * 900 * 4) };
for (let i = 0; i < noisy.rgba.length; i += 4) { noisy.rgba[i] = Math.random() * 256; noisy.rgba[i + 1] = Math.random() * 256; noisy.rgba[i + 2] = Math.random() * 256; noisy.rgba[i + 3] = 255; }
const limit = 1_000_000;
const fitted = buildFittingGlb({ front: noisy, back: noisy, encodePng, limit });
console.log('fitted', fitted.glb.length, 'bytes at texture scale', fitted.texScale.toFixed(2));
if (fitted.glb.length > limit) throw new Error('the model is still too large');
if (fitted.texScale >= 1) throw new Error('the textures were not made smaller');

// Shrinking must not change the outline: a thin line still holds the top part on.
const held = { w: 800, h: 800, rgba: new Uint8Array(800 * 800 * 4) };
const fill = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) held.rgba.set([Math.random() * 256, Math.random() * 256, Math.random() * 256, 255], (y * 800 + x) * 4); };
fill(50, 750, 325, 750); fill(100, 700, 50, 200); fill(399, 404, 200, 325);
const whole = buildGlb({ rgba: held.rgba, w: 800, h: 800, encodePng });
const small = buildFittingGlb({ front: held, encodePng, limit: 400_000 });
console.log('held part', whole.aspect.toFixed(3), small.aspect.toFixed(3), 'texture scale', small.texScale.toFixed(2));
if (small.texScale >= 1) throw new Error('the textures were not made smaller');
if (small.aspect !== whole.aspect) throw new Error('shrinking changed the outline');
