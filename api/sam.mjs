// SAM 3.1 (Meta Model API, POST /v1/responses) — wire-format helpers.
//
// SAM 3.1 returns segmentation as special-token text in the response's
// output_text lane (protocol: meta-models/meta-sam, protocol/sam3.md):
//   <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;x=0;y=0;data=H,W,payload|>
// The mask payload is base85 (custom alphabet) with a 5-digit length prefix,
// then an arithmetic-coded (range-coded) one_bit raster using an adaptive
// order-2 bit context model. decodeOneBitMask below is a decoder for that
// one_bit format, ported from Meta's reference parser semantics
// (meta-sam-parser, _mask_codec.py). Only decoding is implemented; malformed
// payloads throw and callers fall back.

const EXCLUDED = new Set(['"', '\\', ',', ';', '<', '>', '|']);
const ALPHABET = [];
for (let code = 0x21; code < 0x7f; code++) {
  const ch = String.fromCharCode(code);
  if (!EXCLUDED.has(ch)) ALPHABET.push(ch);
}
const CHAR_VALUES = new Int16Array(128).fill(-1);
ALPHABET.forEach((ch, i) => { CHAR_VALUES[ch.charCodeAt(0)] = i; });
const RADIX = 85;
const PREFIX_LENGTH = 5;
const TOP = 1 << 24;
const BOTTOM = 1 << 16;
const INCREMENT = 14;
const COUNT_LIMIT = 4096;
const CONTEXT_COUNT = 1 << 12;
const PADDING = 2;

const u32 = (v) => v >>> 0;

function digit(ch) {
  const code = ch.charCodeAt(0);
  const v = code < 128 ? CHAR_VALUES[code] : -1;
  if (v < 0 || v >= RADIX) throw new Error('sam: invalid payload character');
  return v;
}

function unpack(payload) {
  if (payload.length < PREFIX_LENGTH) throw new Error('sam: missing length prefix');
  let length = 0;
  for (let i = 0; i < PREFIX_LENGTH; i++) length = length * RADIX + digit(payload[i]);
  const remainder = length % 4;
  const expected = PREFIX_LENGTH + Math.floor(length / 4) * 5 + (remainder === 0 ? 0 : remainder + 1);
  if (payload.length !== expected) throw new Error('sam: payload length mismatch');
  const out = new Uint8Array(length);
  let source = PREFIX_LENGTH;
  let destination = 0;
  const full = length - remainder;
  while (destination < full) {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * RADIX + digit(payload[source + i]);
    if (value > 0xffffffff) throw new Error('sam: group out of range');
    source += 5;
    out[destination] = (value >>> 24) & 0xff;
    out[destination + 1] = (value >>> 16) & 0xff;
    out[destination + 2] = (value >>> 8) & 0xff;
    out[destination + 3] = value & 0xff;
    destination += 4;
  }
  if (remainder > 0) {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * RADIX + (i < remainder + 1 ? digit(payload[source + i]) : RADIX - 1);
    if (value > 0xffffffff) throw new Error('sam: tail out of range');
    for (let i = 0; i < remainder; i++) out[destination + i] = (value >>> (24 - i * 8)) & 0xff;
  }
  return out;
}

class RangeDecoder {
  constructor(input) {
    if (input.length < 4) throw new Error('sam: missing finalization');
    this.input = input;
    this.position = 0;
    this.low = 0;
    this.range = 0xffffffff;
    this.code = 0;
    this.scaled = 0;
    for (let i = 0; i < 4; i++) this.code = u32((this.code << 8) | this.read());
  }
  read() {
    if (this.position >= this.input.length) throw new Error('sam: payload ended early');
    return this.input[this.position++];
  }
  frequency(total) {
    this.scaled = Math.floor(this.range / total);
    if (this.scaled === 0) throw new Error('sam: invalid coding state');
    const value = Math.floor(u32(this.code - this.low) / this.scaled);
    return value >= total ? total - 1 : value;
  }
  decode(cumulative, frequency) {
    this.low = u32(this.low + this.scaled * cumulative);
    this.range = this.scaled * frequency;
    for (;;) {
      if (u32(this.low ^ u32(this.low + this.range)) < TOP) {
        // shift out one byte
      } else if (this.range < BOTTOM) {
        this.range = u32(-this.low) & (BOTTOM - 1);
      } else break;
      this.code = u32((this.code << 8) | this.read());
      this.low = u32(this.low << 8);
      this.range = u32(this.range << 8);
    }
  }
}

function contextAt(raster, position, prior, earlier) {
  return (
    raster[position - 1] |
    (raster[position - 2] << 1) |
    (raster[prior - 2] << 2) |
    (raster[prior - 1] << 3) |
    (raster[prior] << 4) |
    (raster[prior + 1] << 5) |
    (raster[prior + 2] << 6) |
    (raster[earlier - 2] << 7) |
    (raster[earlier - 1] << 8) |
    (raster[earlier] << 9) |
    (raster[earlier + 1] << 10) |
    (raster[earlier + 2] << 11)
  );
}

function updateCounts(counts, offset, bit) {
  counts[offset + bit] = (counts[offset + bit] + INCREMENT) & 0xffff;
  if (counts[offset] + counts[offset + 1] >= COUNT_LIMIT) {
    counts[offset] = (counts[offset] >> 1) || 1;
    counts[offset + 1] = (counts[offset + 1] >> 1) || 1;
  }
}

// Decode a one_bit payload (starts with '!') into a Uint8Array of 0/1,
// row-major, width*height entries.
export function decodeOneBitMask(payload, width, height) {
  if (!payload.startsWith('!')) throw new Error('sam: not a one_bit payload');
  const decoder = new RangeDecoder(unpack(payload.slice(1)));
  const counts = new Uint16Array(CONTEXT_COUNT * 2).fill(1);
  const paddedWidth = width + 2 * PADDING;
  const padded = new Uint8Array(paddedWidth * (height + PADDING));
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = (y + PADDING) * paddedWidth + PADDING;
    for (let x = 0; x < width; x++) {
      const position = row + x;
      const context = contextAt(padded, position, position - paddedWidth, position - 2 * paddedWidth);
      const offset = context << 1;
      const zero = counts[offset];
      const one = counts[offset + 1];
      const value = decoder.frequency(zero + one);
      const bit = value < zero ? 0 : 1;
      if (bit === 0) decoder.decode(0, zero); else decoder.decode(zero, one);
      padded[position] = bit;
      output[y * width + x] = bit;
      updateCounts(counts, offset, bit);
    }
  }
  return output;
}

// Parse the first complete record of a SAM output_text lane.
// Returns { box: {x1,y1,x2,y2,w,h}, maskW, maskH, payload, confidence } or null.
export function parseSamText(text) {
  if (!text) return null;
  const boxM = /<\|box;x1=(-?\d+);y1=(-?\d+);x2=(-?\d+);y2=(-?\d+);w=(\d+);h=(\d+)(?:;c=([0-9.eE+-]+))?\|>/.exec(text);
  const maskM = /<\|mask;x=0;y=0;(?:c=([0-9.eE+-]+);)?data=(\d+),(\d+),([^|>]+)\|>/.exec(text);
  if (!boxM || !maskM) return null;
  return {
    box: { x1: +boxM[1], y1: +boxM[2], x2: +boxM[3], y2: +boxM[4], w: +boxM[5], h: +boxM[6] },
    confidence: boxM[7] ? Number(boxM[7]) : (maskM[1] ? Number(maskM[1]) : null),
    maskH: +maskM[2],
    maskW: +maskM[3],
    payload: maskM[4],
  };
}
