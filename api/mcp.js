// AR Creator — 「Talk to Muse, unlock AR」
// Muse の会話からコネクターがアクションし、Meta Model API で AR の中身を組み立てて、
// アプリレス WebAR として公開する MCP サーバー（Streamable HTTP・ステートレス）。
// 構造は 以前の自社コネクター試作と同じ流儀：単一ファイル＋署名付き「カード」メモで状態を持つ。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import VFX_SOURCES from './vfx-sources.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createHmac } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { z } from 'zod';

const BASE = process.env.PUBLIC_BASE_URL || 'https://hackathon-ar-creator.vercel.app';
const SECRET = process.env.CARD_SECRET || 'removed';
const MODEL_API_KEY = process.env.MODEL_API_KEY || '';
const HACKARS_API_KEY = process.env['HACKARS_API_KEY'] || '';
const HACKARS_API_URL = process.env.HACKARS_API_URL || 'https://hackar-s.com/api/project-create';
const API_BASE = 'https://api.meta.ai/v1';
const SPARK_MODEL = 'muse-spark-1.3';
const IMAGE_MODEL = 'muse-image-1.0';

const EFFECTS = ['flame', 'ice', 'lightning', 'petal'];

// ---- 署名付きトークン（以前の自社試作と同じ仕組みを新規実装） ----
// カード：会話の状態（同意・テーマ・AR・証明）を Muse 経由で持ち回るメモ。
// AR／証明トークン：表示に必要な最小データを署名付きで URL 自体に埋め込む（ページは再起動後も開ける）。
const sign = (s) => createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 10);
const packTok = (obj) => { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${b}.${sign(b)}`; };
const readTok = (tok) => {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{10})$/.exec((tok || '').trim());
  if (!m || sign(m[1]) !== m[2]) return null;
  try { return JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { return null; }
};
const packCard = (u) => `HC1.${packTok({ n: u.nickname, a: u.agreed ? 1 : 0, t: u.theme || null, ar: u.arTok || null, c: u.certTok || null, us: u.usage || null })}`;
const readCard = (card) => {
  const m = /^HC1\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10})$/.exec((card || '').trim());
  return m ? readTok(m[1]) : null;
};

// ---- 状態：サーバーメモリ＋カードの2本立て（メモリが消えたらカードを正にする） ----
const users = new Map(); // nickname -> { nickname, agreed, theme, arTok, arId, certTok, usage }
// 生成画像（WebP 約430KB）は URL トークンに入らないので、短いIDでメモリ保持し /img/<id> で配信する。
// メモリが落ちたら画像は 404 になり、ARページはエフェクト＋テキストだけで成立させる（graceful degradation）。
const imgs = new Map();  // imgId -> { buf: Buffer, type } | { remote: url }
const keyOf = (nickname) => (nickname || 'guest').trim().toLowerCase() || 'guest';
const getU = (nickname, card) => {
  const k = keyOf(nickname);
  if (!users.has(k)) users.set(k, { nickname: k, agreed: false, theme: null, arTok: null, arId: null, certTok: null, usage: null });
  const u = users.get(k), c = readCard(card);
  if (c) {
    if (c.a) u.agreed = true;
    if (c.t && !u.theme) u.theme = c.t;
    if (c.ar && !u.arTok) { u.arTok = c.ar; const p = readTok(c.ar); if (p) u.arId = p.i; }
    if (c.c && !u.certTok) u.certTok = c.c;
    if (c.us && !u.usage) u.usage = c.us;
  }
  return u;
};
const cardArg = z.string().optional().describe('前のツールの structuredContent にある card（HC1. で始まる文字列）。あればそのまま入れる');
const nickArg = z.string().optional().describe('ユーザーの呼び名（毎回同じものを入れる）');

// ---- Meta Model API ----
async function fetchSpark(theme) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model: SPARK_MODEL,
      temperature: 0.8,
      // muse-spark-1.3 は推論モデル：推論トークンで本文が食い尽くされないよう上限を広く取る
      max_tokens: 2500,
      messages: [
        { role: 'system', content: 'You are an AR experience composer for an app-less WebAR product. Reply with ONE JSON object only, no markdown, no code fences, no commentary.' },
        { role: 'user', content: `Compose a small AR overlay for the theme: "${theme}".\nReturn JSON with exactly these keys:\n- "title": a short English title, at most 5 words\n- "text": one English line shown over the camera view, at most 90 characters\n- "color": one base color as #RRGGBB that matches the mood\n- "effect": one of "flame", "ice", "lightning", "petal" — pick the particle effect that best matches the theme\n- \"action\": one short English sentence describing how the character moves in a seamless in-place loop (e.g. \"hops happily with squash and stretch\", \"sways gently like a jellyfish\")` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`spark http ${res.status}`);
  const data = await res.json();
  return { raw: data?.choices?.[0]?.message?.content || '', usage: data?.usage || null };
}

// content が null/空（推論で食い尽くされた等）や JSON が読めない場合は1回だけ再試行し、
// それでもダメなら例外にして呼び出し側のテンプレートフォールバックに委ねる。
async function callSpark(theme) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { raw, usage } = await fetchSpark(theme);
    const cleaned = String(raw).replace(/```(?:json)?/gi, '');
    const m = /\{[\s\S]*\}/.exec(cleaned);
    if (m) {
      try { return { comp: normalizeComp(JSON.parse(m[0]), theme), usage }; }
      catch (e) { lastErr = e; }
    } else {
      lastErr = new Error('spark returned empty/unparseable content');
    }
    console.log('[AR] spark-retry', JSON.stringify({ theme, attempt: attempt + 1, reason: String(lastErr?.message || lastErr) }));
  }
  throw lastErr || new Error('spark failed');
}

// クロマキーのキー色：被写体が緑系のテーマだけ青、それ以外は緑（被写体と背景を分けるため）
const keyFor = (theme) => /(葉|緑|グリーン|カエル|森|草|抹茶|苔|leaf|green|frog|forest|moss)/i.test(String(theme || ''))
  ? { name: 'blue', hex: '#0000FF', ch: 2 }
  : { name: 'green', hex: '#00FF00', ch: 1 };

async function callImage(theme, comp, background) {
  const key = keyFor(theme);
  const basePrompt = `A single charming mascot-like character illustration for an AR overlay, theme: "${theme}" (${comp.title}). Flat vector style, bold shapes, bold dark outline, no text, no letters, centered, full body, playful.`;
  const prompt = background === 'transparent'
    ? `${basePrompt} The character stands on a completely solid vivid ${key.name} (${key.hex}) chroma key background that fills the entire frame edge to edge. No shadow, no gradient, no floor, no ground line, no other objects, no floating decorations.`
    : `${basePrompt} Clean solid background in the base color ${comp.color}.`;
  const mkBody = (png) => JSON.stringify({
    model: IMAGE_MODEL, prompt, size: '1024x1024',
    ...(png ? { output_format: 'png' } : {}),
  });
  const attempt = async (png) => {
    const res = await fetch(`${API_BASE}/images/generations`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${MODEL_API_KEY}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(40_000),
      body: mkBody(png),
    });
    if (!res.ok) throw new Error(`image http ${res.status}`);
    const data = await res.json();
    const d = data?.data?.[0] || {};
    // 返却は URL ではなく data[0].b64_json。バイト列は呼び出し側で /img/<id> 配信に回す。
    if (d.b64_json) return { b64: d.b64_json, remote: null, usage: data?.usage || null, type: png ? 'image/png' : 'image/webp', keyCh: key.ch };
    if (d.url) return { b64: null, remote: d.url, usage: data?.usage || null, type: 'image/webp', keyCh: key.ch };
    throw new Error('image returned no data');
  };
  if (background === 'transparent') {
    try { return await attempt(true); } // PNG で受けてサーバー側で色抜きする
    catch (e) { console.log('[AR] image-png-failed', JSON.stringify({ error: String(e?.message || e) })); return await attempt(false); }
  }
  return attempt(false);
}

// ---- PNG コーデック＋クロマキー（純JS・依存なし。8bit / color type 2,6 / 非インタレース） ----
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error('unsupported png format');
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idats));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  let p = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, rgba: out };
}
const PNG_CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (let i = 0; i < td.length; i++) c = PNG_CRC_TABLE[(c ^ td[i]) & 255] ^ (c >>> 8);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// キー色の「勝ち具合」でアルファを作り、最大の連結成分（本体）だけ残し、フチの色かぶりを抑える
function keyOut(rgba, w, h, keyChannel) {
  const n = w * h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const key = keyChannel === 1 ? g : b;
    const other = keyChannel === 1 ? Math.max(r, b) : Math.max(r, g);
    let a = (110 - (key - other)) / 110; if (a < 0) a = 0; else if (a > 1) a = 1;
    alpha[i] = a * 255;
  }
  const sw = Math.max(1, Math.floor(w / 4)), sh = Math.max(1, Math.floor(h / 4));
  const sm = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sm[y * sw + x] = alpha[(y * 4) * w + x * 4] > 110 ? 1 : 0;
  const lab = new Int32Array(sw * sh).fill(-1);
  let best = -1, bestSize = 0, cur = 0;
  const stack = [];
  for (let s = 0; s < sw * sh; s++) {
    if (!sm[s] || lab[s] >= 0) continue;
    let size = 0; stack.length = 0; stack.push(s); lab[s] = cur;
    while (stack.length) {
      const q = stack.pop(); size++;
      const qx = q % sw, qy = (q / sw) | 0;
      if (qx > 0 && sm[q - 1] && lab[q - 1] < 0) { lab[q - 1] = cur; stack.push(q - 1); }
      if (qx < sw - 1 && sm[q + 1] && lab[q + 1] < 0) { lab[q + 1] = cur; stack.push(q + 1); }
      if (qy > 0 && sm[q - sw] && lab[q - sw] < 0) { lab[q - sw] = cur; stack.push(q - sw); }
      if (qy < sh - 1 && sm[q + sw] && lab[q + sw] < 0) { lab[q + sw] = cur; stack.push(q + sw); }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
    cur++;
  }
  if (best >= 0 && cur > 1) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (lab[((y / 4) | 0) * sw + ((x / 4) | 0)] !== best) alpha[y * w + x] = 0;
    }
  }
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if (a < 255) {
      if (keyChannel === 1) { const mx = Math.max(rgba[i * 4], rgba[i * 4 + 2]); if (rgba[i * 4 + 1] > mx + 12) rgba[i * 4 + 1] = mx + 12; }
      else { const mx = Math.max(rgba[i * 4], rgba[i * 4 + 1]); if (rgba[i * 4 + 2] > mx + 12) rgba[i * 4 + 2] = mx + 12; }
    }
    rgba[i * 4 + 3] = a;
  }
}
function makeTransparent(buf, keyChannel) {
  const { w, h, rgba } = decodePng(buf);
  keyOut(rgba, w, h, keyChannel);
  return encodePng(w, h, rgba);
}

// Spark が返した構成を安全な値に寄せる
// ---- animated GIF synthesis: bake looping character motion from the still cutout ----
// The HACKAR:S player loops GIF overlays natively (isGif), so a baked GIF is
// what makes the character keep moving there. Frames are transforms of the
// one generated still: hop / bounce / float / sway, bottom-center pivot.
function scaleRgba(img, tw, th) {
  const { w, h, rgba: data } = img;
  const out = new Uint8Array(tw * th * 4);
  const xr = w / tw, yr = h / th;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const gx = (x + 0.5) * xr - 0.5, gy = (y + 0.5) * yr - 0.5;
      const x0 = Math.max(0, Math.floor(gx)), y0 = Math.max(0, Math.floor(gy));
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, gx - x0)), fy = Math.min(1, Math.max(0, gy - y0));
      for (let c = 0; c < 4; c++) {
        const top = data[(y0 * w + x0) * 4 + c] * (1 - fx) + data[(y0 * w + x1) * 4 + c] * fx;
        const bot = data[(y1 * w + x0) * 4 + c] * (1 - fx) + data[(y1 * w + x1) * 4 + c] * fx;
        out[(y * tw + x) * 4 + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return { w: tw, h: th, rgba: out };
}
function xformFrame(img, o) {
  const { w, h, rgba: data } = img;
  const out = new Uint8Array(w * h * 4);
  const px = w / 2, py = h;
  const cos = Math.cos(o.rot || 0), sin = Math.sin(o.rot || 0);
  const sx = o.sx || 1, sy = o.sy || 1, dy = o.dy || 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - px, dyy = (y - dy) - py;
      const rx = dx * cos + dyy * sin, ry = -dx * sin + dyy * cos;
      const srcX = Math.round(px + rx / sx), srcY = Math.round(py + ry / sy);
      if (srcX < 0 || srcY < 0 || srcX >= w || srcY >= h) continue;
      const si = (srcY * w + srcX) * 4, di = (y * w + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return { w, h, rgba: out };
}
function buildPalette(img, maxColors = 255) {
  const d = img.rgba;
  const pixels = [];
  for (let i = 0; i < d.length; i += 32) {
    if (d[i + 3] >= 128) pixels.push([d[i], d[i + 1], d[i + 2]]);
  }
  if (!pixels.length) return [[255, 0, 255]];
  let boxes = [pixels];
  while (boxes.length < maxColors) {
    let bi = -1, bc = 0, bestScore = -1;
    boxes.forEach((box, idx) => {
      if (box.length < 2) return;
      const min = [255, 255, 255], max = [0, 0, 0];
      for (const p of box) for (let c = 0; c < 3; c++) { if (p[c] < min[c]) min[c] = p[c]; if (p[c] > max[c]) max[c] = p[c]; }
      let ch = 0, range = -1;
      for (let c = 0; c < 3; c++) { const r = max[c] - min[c]; if (r > range) { range = r; ch = c; } }
      const score = range * box.length;
      if (score > bestScore) { bestScore = score; bi = idx; bc = ch; }
    });
    if (bi < 0) break;
    const box = boxes.splice(bi, 1)[0];
    box.sort((a, b) => a[bc] - b[bc]);
    const mid = box.length >> 1;
    boxes.push(box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => {
    const s = [0, 0, 0];
    for (const p of box) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    const n = Math.max(1, box.length);
    return [Math.round(s[0] / n), Math.round(s[1] / n), Math.round(s[2] / n)];
  });
}
function mapToPalette(img, palette) {
  const idx = new Uint8Array(img.w * img.h);
  const cache = new Map();
  const d = img.rgba;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    if (d[i + 3] < 128) { idx[p] = 0; continue; }
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let v = cache.get(key);
    if (v === undefined) {
      let best = 1, bd = Infinity;
      for (let j = 1; j < palette.length; j++) {
        const dr = d[i] - palette[j][0], dg = d[i + 1] - palette[j][1], db = d[i + 2] - palette[j][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bd) { bd = dist; best = j; }
      }
      v = best; cache.set(key, v);
    }
    idx[p] = v;
  }
  return idx;
}
function gifLzw(indices, minCodeSize) {
  const bytes = [];
  let acc = 0, accBits = 0;
  const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map(), nextCode = eoiCode + 1;
  function emit(code) {
    acc |= code << accBits; accBits += codeSize;
    while (accBits >= 8) { bytes.push(acc & 0xff); acc >>= 8; accBits -= 8; }
  }
  function resetDict() { dict = new Map(); nextCode = eoiCode + 1; codeSize = minCodeSize + 1; }
  emit(clearCode);
  let prevCode = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prevCode * 256 + k;
    const existing = dict.get(key);
    if (existing !== undefined) { prevCode = existing; continue; }
    emit(prevCode);
    dict.set(key, nextCode++);
    if (nextCode - 1 === (1 << codeSize) && codeSize < 12) codeSize++;
    if (nextCode > 4095) { emit(clearCode); resetDict(); }
    prevCode = k;
  }
  emit(prevCode);
  emit(eoiCode);
  if (accBits > 0) bytes.push(acc & 0xff);
  return Buffer.from(bytes);
}
function motionFrameOpts(motion, i, n) {
  const t = i / n, TAU = Math.PI * 2;
  if (motion === 'hop') {
    const s = Math.sin(Math.PI * t), contact = 1 - s;
    return { dy: -Math.round(36 * s), sy: 1 - 0.12 * contact + 0.04 * s, sx: 1 + 0.09 * contact - 0.02 * s, rot: 0 };
  }
  if (motion === 'bounce') {
    const tt = (t * 2) % 1, s = Math.sin(Math.PI * tt), contact = 1 - s;
    return { dy: -Math.round(22 * s), sy: 1 - 0.16 * contact + 0.03 * s, sx: 1 + 0.11 * contact - 0.02 * s, rot: 0 };
  }
  if (motion === 'float') {
    return { dy: -Math.round(12 + 9 * Math.sin(TAU * t)), sy: 1 + 0.02 * Math.sin(TAU * t), sx: 1, rot: 0.03 * Math.sin(TAU * t) };
  }
  if (motion === 'sway') {
    return { dy: -4, sy: 1, sx: 1, rot: 0.10 * Math.sin(TAU * t) };
  }
  return { dy: 0, sy: 1, sx: 1, rot: 0 };
}
function makeAnimGif(pngBuf, motion) {
  const src = decodePng(pngBuf);
  const maxDim = 640;
  const scale = Math.min(1, (maxDim * 0.86) / Math.max(src.w, src.h));
  const inner = scale < 1 ? scaleRgba(src, Math.round(src.w * scale), Math.round(src.h * scale)) : src;
  // pad onto a square canvas (headroom so hops/rotations never clip the frame)
  const S = Math.round(Math.max(inner.w, inner.h) / 0.86);
  const canvas = new Uint8Array(S * S * 4);
  const ox = Math.round((S - inner.w) / 2), oy = S - inner.h;
  for (let y = 0; y < inner.h; y++) {
    canvas.set(inner.rgba.subarray(y * inner.w * 4, (y + 1) * inner.w * 4), ((y + oy) * S + ox) * 4);
  }
  const img = { w: S, h: S, rgba: canvas };
  const colors = buildPalette(img);
  const palette = [[0, 0, 0], ...colors].slice(0, 256);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const N = 12, delay = motion === 'bounce' ? 8 : 9;
  const parts = [];
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(img.w, 6); head.writeUInt16LE(img.h, 8);
  head[10] = 0xf7; head[11] = 0; head[12] = 0;
  parts.push(head);
  const gct = Buffer.alloc(256 * 3);
  palette.forEach((c, i) => { gct[i * 3] = c[0]; gct[i * 3 + 1] = c[1]; gct[i * 3 + 2] = c[2]; });
  parts.push(gct);
  parts.push(Buffer.from([0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00]));
  for (let i = 0; i < N; i++) {
    const frame = xformFrame(img, motionFrameOpts(motion, i, N));
    const idx = mapToPalette(frame, palette);
    const lzw = gifLzw(idx, 8);
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x09, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00]);
    const idesc = Buffer.alloc(10);
    idesc[0] = 0x2c;
    idesc.writeUInt16LE(img.w, 5); idesc.writeUInt16LE(img.h, 7);
    parts.push(gce, idesc, Buffer.from([8]));
    for (let off = 0; off < lzw.length; off += 255) {
      const chunk = lzw.subarray(off, Math.min(lzw.length, off + 255));
      parts.push(Buffer.from([chunk.length]), chunk);
    }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function normalizeComp(c, theme) {
  const color = /^#[0-9a-fA-F]{6}$/.test(c?.color || '') ? c.color : fallbackComp(theme).color;
  let effect = EFFECTS.includes(c?.effect) ? c.effect : null;
  if (!effect) { // 言い換え・表記ゆれを吸収する
    const s = String(c?.effect || '').toLowerCase();
    effect = EFFECTS.find((e) => s.includes(e)) || ({ fire: 'flame', snow: 'ice', thunder: 'lightning', flower: 'petal', sakura: 'petal' })[Object.keys({ fire: 1, snow: 1, thunder: 1, flower: 1, sakura: 1 }).find((k) => s.includes(k))] || fallbackComp(theme).effect;
  }
  return {
    title: String(c?.title || '').slice(0, 60) || fallbackComp(theme).title,
    text: String(c?.text || '').slice(0, 120) || fallbackComp(theme).text,
    color, effect,
    action: String(c?.action || '').slice(0, 120),
  };
}

// 生成に失敗しても AR は必ず立てるためのテンプレート構成（テーマのハッシュで決定的に選ぶ）
const PALETTES = [
  { color: '#FF7A1A', effect: 'flame' },
  { color: '#39B5FF', effect: 'ice' },
  { color: '#7A5CFF', effect: 'lightning' },
  { color: '#FF8FB3', effect: 'petal' },
];
function fallbackComp(theme) {
  const t = String(theme || '');
  const kw = [/(炎|火|燃|ドラゴン|fire|flame|dragon)/i, /(雪|氷|冬|snow|ice|winter)/i, /(雷|電|光|lightning|thunder|spark)/i, /(花|桜|春|petal|flower|sakura)/i];
  const ki = kw.findIndex((re) => re.test(t));
  let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const p = PALETTES[ki >= 0 ? ki : h % PALETTES.length];
  return { title: `${theme} AR`, text: `Welcome to the world of ${theme}.`, color: p.color, effect: p.effect, action: 'hops happily in place with squash and stretch' };
}

// chat（prompt/completion_tokens）と image（input/output_tokens）で形が違う usage を共通形に寄せる
const normUsage = (u) => {
  if (!u) return null;
  const inp = u.prompt_tokens ?? u.input_tokens ?? null;
  const out = u.completion_tokens ?? u.output_tokens ?? null;
  const total = u.total_tokens ?? (((inp ?? 0) + (out ?? 0)) || null);
  return { in: inp, out, total };
};
const usageText = (label, usage) => {
  const n = normUsage(usage);
  return n
    ? `${label}: ${n.total ?? '?'} トークン（入力 ${n.in ?? '?'} / 出力 ${n.out ?? '?'}）`
    : `${label}: トークン数なし`;
};

// ---- HTML ページ ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const jsJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

function arPage(tok) {
  const p = readTok(tok);
  if (!p) return new Response(pageShell('リンクが無効です', '<p>この AR のリンクは確認できませんでした。Muse で作り直してね。</p>'), { status: 404, headers: htmlHeaders() });
  const cfg = { title: p.ti, text: p.tx, color: p.c, effect: p.e, theme: p.th, image: p.im ? `/img/${p.im}` : null, bg: p.bg || 'card', mo: p.mo || 'bounce' };
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(p.ti)} — AR Creator</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0b0b10;font-family:-apple-system,'Hiragino Sans',sans-serif;color:#fff}
#cam{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;background:linear-gradient(160deg,${esc(p.c)},#14141d 75%)}
#fx{position:fixed;inset:0;touch-action:none}
.hud{position:fixed;left:0;right:0;text-align:center;pointer-events:none;padding:0 18px;box-sizing:border-box}
#ttl{top:calc(18px + env(safe-area-inset-top));font-size:30px;font-weight:900;letter-spacing:.02em;text-shadow:0 2px 18px rgba(0,0,0,.55)}
#sub{top:calc(64px + env(safe-area-inset-top));font-size:14px;opacity:.92;text-shadow:0 1px 10px rgba(0,0,0,.6)}
#theme{bottom:calc(20px + env(safe-area-inset-bottom));font-size:13px;opacity:.85;text-shadow:0 1px 8px rgba(0,0,0,.6)}
#hint{position:fixed;left:50%;bottom:calc(52px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:13px;font-weight:700;background:rgba(0,0,0,.5);padding:8px 16px;border-radius:999px;white-space:nowrap;display:none}
#note{position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:12px;background:rgba(0,0,0,.45);padding:6px 12px;border-radius:999px;display:none;white-space:nowrap}
#start{position:fixed;inset:0;display:grid;place-items:center;background:rgba(8,8,14,.55);backdrop-filter:blur(3px);z-index:5}
#start button{border:0;border-radius:999px;padding:16px 34px;font-size:17px;font-weight:800;background:${esc(p.c)};color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.45)}
#fallback{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(62vw,260px);border-radius:20px;overflow:hidden;display:none;box-shadow:0 14px 44px rgba(0,0,0,.5)}
#fallback img{display:block;width:100%;height:auto}
</style></head><body>
<video id="cam" autoplay playsinline muted></video>
<canvas id="fx"></canvas>
<div class="hud" id="ttl">${esc(p.ti)}</div>
<div class="hud" id="sub">${esc(p.tx)}</div>
<div class="hud" id="theme">theme: ${esc(p.th)} ・ Talk to Muse, unlock AR</div>
<div id="hint">真ん中の輪を床に合わせて、タップで置く</div>
<div id="note"></div>
${cfg.image ? `<div id="fallback"><img src="${esc(cfg.image)}" alt=""></div>` : ''}
<div id="start"><button id="go">カメラで見る</button></div>
<script src="https://unpkg.com/three@0.152.2/build/three.min.js"></script>
<script>
var CFG = ${jsJson(cfg)};
// ---- 3Dパーティクル（Ultra Elements の考え方：1エフェクト=1パラメータセット） ----
var PARAMS = {
  flame:     { n: 260, dir: 'up',    speed: [0.5, 1.1], sway: 0.10, size: 30, ramp: ['#fff3b0', CFG.color, '#e62e00'] },
  ice:       { n: 200, dir: 'down',  speed: [0.12, 0.35], sway: 0.22, size: 17, ramp: ['#ffffff', '#bfefff', '#7fd4ff'] },
  lightning: { n: 170, dir: 'burst', speed: [0.7, 1.6], sway: 0.03, size: 15, ramp: ['#ffffff', '#cfe8ff', '#5aa2ff'] },
  petal:     { n: 140, dir: 'down',  speed: [0.15, 0.4], sway: 0.55, size: 25, ramp: ['#ffffff', '#ffc2d6', '#ff8fb3'] },
  sparkle:   { n: 170, dir: 'burst', speed: [0.12, 0.35], sway: 0.05, size: 13, ramp: ['#ffffff', '#fff3b0', '#ffd94d'] },
  bubble:    { n: 120, dir: 'up',    speed: [0.15, 0.35], sway: 0.30, size: 34, ramp: ['#ffffff', '#d8f4ff', '#9fdcff'] },
  confetti:  { n: 190, dir: 'down',  speed: [0.30, 0.60], sway: 0.80, size: 21, ramp: ['#ff8fb3', '#fff3b0', '#9fdcff', '#b6ffc8'] }
};
var P = PARAMS[CFG.effect] || PARAMS.petal;
function easeOutBack(t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }

var started = false;
document.getElementById('go').addEventListener('click', function () {
  document.getElementById('start').style.display = 'none';
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) { document.getElementById('cam').srcObject = s; })
      .catch(function () { showNote('カメラが使えないので背景モードで表示しています'); });
  }
  var begin = function () { if (!started) { started = true; initScene(); } };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(begin).catch(begin);
  } else { begin(); }
});
function showNote(msg) { var n = document.getElementById('note'); n.style.display = 'block'; n.textContent = msg; }

function initScene() {
  if (!window.THREE) { var f = document.getElementById('fallback'); if (f) f.style.display = 'block'; return; }
  var hint = document.getElementById('hint'); hint.style.display = 'block';
  var canvas = document.getElementById('fx');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.05, 60);
  camera.position.set(0, 1.35, 0);
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  resize(); addEventListener('resize', resize);

  // ---- 端末の向き → カメラ（DeviceOrientationControls と同じ変換。効かない環境ではドラッグで見回す） ----
  var orient = { has: false, q: new THREE.Quaternion() };
  var zee = new THREE.Vector3(0, 0, 1), eu = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  addEventListener('deviceorientation', function (e) {
    if (e.alpha === null || e.alpha === undefined) return;
    orient.has = true;
    var alpha = THREE.MathUtils.degToRad(e.alpha), beta = THREE.MathUtils.degToRad(e.beta || 0), gamma = THREE.MathUtils.degToRad(e.gamma || 0);
    var so = THREE.MathUtils.degToRad((screen.orientation && screen.orientation.angle) || window.orientation || 0);
    eu.set(beta, alpha, -gamma, 'YXZ');
    orient.q.setFromEuler(eu); orient.q.multiply(q1); orient.q.multiply(q0.setFromAxisAngle(zee, -so));
  });
  var dragYaw = 0, dragPitch = -0.25, dragging = false, lastX = 0, lastY = 0, moved = 0;
  canvas.addEventListener('touchstart', function (e) { dragging = true; moved = 0; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!dragging) return;
    var dx = e.touches[0].clientX - lastX, dy = e.touches[0].clientY - lastY; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (!orient.has) { dragYaw -= dx * 0.005; dragPitch -= dy * 0.005; dragPitch = Math.max(-1.2, Math.min(0.6, dragPitch)); }
  }, { passive: true });
  canvas.addEventListener('touchend', function (e) { dragging = false; if (moved < 12) placeAtCenter(); });
  canvas.addEventListener('click', function () { placeAtCenter(); });

  // ---- 置かれるもの一式（カード＋影＋粒子）を group にまとめる ----
  var group = new THREE.Group(); scene.add(group);
  var tilt = new THREE.Group(); tilt.rotation.x = -0.10; group.add(tilt);
  var cardGroup = new THREE.Group(); cardGroup.position.y = 0.52; tilt.add(cardGroup);
  var frame = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.98), new THREE.MeshBasicMaterial({ color: new THREE.Color(CFG.color) }));
  frame.position.z = -0.012; cardGroup.add(frame);
  if (CFG.bg === 'transparent') frame.visible = false; // 透過モードでは色枠を出さず、キャラだけを浮かせる
  var cardMat = new THREE.MeshBasicMaterial({ color: 0x22222c, transparent: true });
  var card = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), cardMat); cardGroup.add(card);
  if (CFG.image) {
    new THREE.TextureLoader().load(CFG.image, function (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      cardMat.map = tex; cardMat.color.set(0xffffff); cardMat.needsUpdate = true;
      if (tex.image && tex.image.height && tex.image.width) { var a = tex.image.height / tex.image.width; card.scale.y = a; frame.scale.y = a; }
      if (CFG.bg === 'transparent') buildPlate(tex);
    }, undefined, function () { /* 画像が落ちていたら色カードのまま成立させる */ });
  }
  // ---- 板レシピ方式：透過シルエットから半立体プレート（かき割り状）を生成し、頂点シェーダのスカッシュ＆ストレッチで跳ねさせる ----
  var plateOn = false;
  var deform = { uSquash: { value: 0 }, uHeight: { value: 1 } };
  function addDeform(mat) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uSquash = deform.uSquash; sh.uniforms.uHeight = deform.uHeight;
      sh.vertexShader = 'uniform float uSquash;\\nuniform float uHeight;\\n' + sh.vertexShader.replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float dyn_ = clamp(position.y / uHeight, 0.0, 1.0);',
        'float dwgt_ = 0.35 + 0.65 * dyn_;',
        'float dsy_ = mix(1.0, 1.0 - uSquash, dwgt_);',
        'float dsxz_ = mix(1.0, 1.0 / sqrt(max(1.0 - uSquash, 0.25)), dwgt_);',
        'transformed.y = position.y * dsy_;',
        'transformed.x = position.x * dsxz_;',
        'transformed.z = position.z * dsxz_;'
      ].join('\\n'));
    };
  }
  function buildPlate(tex) {
    try {
      var img = tex.image; if (!img || !img.width) return;
      var MAXD = 340, sc2 = Math.min(1, MAXD / Math.max(img.width, img.height));
      var w = Math.max(2, Math.round(img.width * sc2)), h = Math.max(2, Math.round(img.height * sc2));
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var cx2 = cv.getContext('2d'); cx2.drawImage(img, 0, 0, w, h);
      var data = cx2.getImageData(0, 0, w, h).data;
      var mask = new Uint8Array(w * h);
      for (var i = 0, pz = 0; i < data.length; i += 4, pz++) mask[pz] = data[i + 3] >= 128 ? 1 : 0;
      var lab = new Int32Array(w * h).fill(-1);
      var best = -1, bestN = 0, comp = 0, stack = [];
      for (var s0 = 0; s0 < w * h; s0++) {
        if (!mask[s0] || lab[s0] >= 0) continue;
        var n = 0; stack.length = 0; stack.push(s0); lab[s0] = comp;
        while (stack.length) { var q = stack.pop(); n++; var qx = q % w, qy = (q / w) | 0;
          if (qx > 0 && mask[q - 1] && lab[q - 1] < 0) { lab[q - 1] = comp; stack.push(q - 1); }
          if (qx < w - 1 && mask[q + 1] && lab[q + 1] < 0) { lab[q + 1] = comp; stack.push(q + 1); }
          if (qy > 0 && mask[q - w] && lab[q - w] < 0) { lab[q - w] = comp; stack.push(q - w); }
          if (qy < h - 1 && mask[q + w] && lab[q + w] < 0) { lab[q + w] = comp; stack.push(q + w); } }
        if (n > bestN) { bestN = n; best = comp; }
        comp++;
      }
      if (best < 0 || bestN < 40) return;
      for (var m2 = 0; m2 < w * h; m2++) mask[m2] = lab[m2] === best ? 1 : 0;
      var sx = -1, sy = -1;
      findStart: for (var yy = 0; yy < h; yy++) { for (var xx = 0; xx < w; xx++) { if (mask[yy * w + xx]) { sx = xx; sy = yy; break findStart; } } }
      var OFF = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
      function dirIdx(dx, dy) { for (var di = 0; di < 8; di++) if (OFF[di][0] === dx && OFF[di][1] === dy) return di; return 0; }
      var contour = [], px2 = sx, py2 = sy, bkx = sx - 1, bky = sy, startBack = dirIdx(-1, 0), guard = 0;
      while (guard++ < w * h * 3) {
        contour.push([px2, py2]);
        var bIdx = dirIdx(bkx - px2, bky - py2), next = null, nbk = null;
        for (var kk = 1; kk <= 8; kk++) {
          var idx = (bIdx + kk) % 8, nx = px2 + OFF[idx][0], ny = py2 + OFF[idx][1];
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[ny * w + nx]) { next = [nx, ny]; var pb = (bIdx + kk - 1) % 8; nbk = [px2 + OFF[pb][0], py2 + OFF[pb][1]]; break; }
        }
        if (!next) break;
        bkx = nbk[0]; bky = nbk[1]; px2 = next[0]; py2 = next[1];
        if (px2 === sx && py2 === sy && dirIdx(bkx - px2, bky - py2) === startBack) break;
      }
      if (contour.length < 12) return;
      var dec = [], lastP = null;
      for (var ci = 0; ci < contour.length; ci++) { var cp = contour[ci]; if (!lastP || Math.abs(cp[0] - lastP[0]) + Math.abs(cp[1] - lastP[1]) >= 3) { dec.push(cp); lastP = cp; } }
      if (dec.length < 8) dec = contour.filter(function (_, ix) { return ix % 3 === 0; });
      for (var sm = 0; sm < 2; sm++) {
        var out2 = [];
        for (var cj = 0; cj < dec.length; cj++) {
          var pA = dec[cj], pB = dec[(cj + 1) % dec.length];
          out2.push([pA[0] * 0.75 + pB[0] * 0.25, pA[1] * 0.75 + pB[1] * 0.25]);
          out2.push([pA[0] * 0.25 + pB[0] * 0.75, pA[1] * 0.25 + pB[1] * 0.75]);
        }
        dec = out2;
      }
      if (dec.length > 460) { var stp = Math.ceil(dec.length / 460); dec = dec.filter(function (_, ix) { return ix % stp === 0; }); }
      var shape = new THREE.Shape();
      dec.forEach(function (pt, ix) { var X = pt[0], Y = h - pt[1]; if (ix === 0) shape.moveTo(X, Y); else shape.lineTo(X, Y); });
      shape.closePath();
      var depth = Math.max(4, h * 0.07);
      var geo = new THREE.ExtrudeGeometry(shape, { depth: depth, steps: 1, bevelEnabled: true, bevelThickness: depth * 0.22, bevelSize: Math.max(0.8, w * 0.004), bevelSegments: 1, UVGenerator: {
        generateTopUV: function (g2, verts, a2, b2, c2) { return [new THREE.Vector2(verts[a2 * 3] / w, verts[a2 * 3 + 1] / h), new THREE.Vector2(verts[b2 * 3] / w, verts[b2 * 3 + 1] / h), new THREE.Vector2(verts[c2 * 3] / w, verts[c2 * 3 + 1] / h)]; },
        generateSideWallUV: function () { return [new THREE.Vector2(0, 0), new THREE.Vector2(1, 0), new THREE.Vector2(1, 1), new THREE.Vector2(0, 1)]; }
      } });
      geo.translate(-w / 2, 0, -depth / 2);
      var frontMat = new THREE.MeshBasicMaterial({ map: tex });
      var sideMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(CFG.color) });
      addDeform(frontMat); addDeform(sideMat);
      var plate = new THREE.Mesh(geo, [frontMat, sideMat]);
      var ps = 0.92 / w; plate.scale.set(ps, ps, ps);
      plate.position.y = -0.47;
      deform.uHeight.value = h;
      cardGroup.add(plate);
      card.visible = false;
      plateOn = true;
    } catch (e) { /* 失敗したら平面カードのまま成立させる */ }
  }
  // 影（床にだけ落ちる柔らかい丸影）
  var sc = document.createElement('canvas'); sc.width = sc.height = 128;
  var sg = sc.getContext('2d'), grad = sg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = grad; sg.fillRect(0, 0, 128, 128);
  var shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.35), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.012; group.add(shadow);

  // ---- パーティクル（カードの周りの3D空間に湧く） ----
  var N = P.n, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), life = new Float32Array(N), vel = new Float32Array(N * 3), seed = new Float32Array(N);
  var ramp = P.ramp.map(function (c) { return new THREE.Color(c); });
  function respawn(i, randY) {
    var a = Math.random() * Math.PI * 2, r = 0.25 + Math.random() * 0.75;
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 2] = Math.sin(a) * r;
    var s = P.speed[0] + Math.random() * (P.speed[1] - P.speed[0]);
    if (P.dir === 'up') { pos[i * 3 + 1] = randY ? Math.random() * 1.5 : 0.02; vel[i * 3] = 0; vel[i * 3 + 1] = s; vel[i * 3 + 2] = 0; life[i] = 0.7 + Math.random() * 0.5; }
    else if (P.dir === 'down') { pos[i * 3 + 1] = randY ? Math.random() * 1.7 : 1.7; vel[i * 3] = 0; vel[i * 3 + 1] = -s; vel[i * 3 + 2] = 0; life[i] = 0.8 + Math.random() * 0.6; }
    else { pos[i * 3] = (Math.random() - 0.5) * 0.3; pos[i * 3 + 1] = 0.55; pos[i * 3 + 2] = (Math.random() - 0.5) * 0.3; var th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI; vel[i * 3] = Math.sin(ph) * Math.cos(th) * s; vel[i * 3 + 1] = Math.cos(ph) * s * 0.7; vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * s; life[i] = 0.25 + Math.random() * 0.3; }
    seed[i] = Math.random() * 100;
    var c = ramp[Math.floor(Math.random() * ramp.length)];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  for (var i = 0; i < N; i++) respawn(i, true);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  var points = new THREE.Points(geo, new THREE.PointsMaterial({ size: P.size / 420, vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
  points.position.y = 0.02; group.add(points);

  // ---- レティクル（画面中央の床の位置を示す輪） ----
  var ret = new THREE.Group();
  var ring = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.105, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ret.add(ring);
  var dot = new THREE.Mesh(new THREE.CircleGeometry(0.016, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
  dot.rotation.x = -Math.PI / 2; ret.add(dot);
  ret.position.y = 0.015; scene.add(ret);

  // ---- 配置時の衝撃リング（足元にバンッと広がって消える） ----
  var rings = [];
  for (var ri = 0; ri < 3; ri++) {
    var rm = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.5, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(CFG.color), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    rm.rotation.x = -Math.PI / 2; rm.position.y = 0.02; rm.visible = false; scene.add(rm);
    rings.push({ m: rm, t: 1e9 });
  }
  function spawnRings(x, z) {
    for (var i = 0; i < rings.length; i++) { rings[i].t = -i * 0.13; rings[i].m.position.x = x; rings[i].m.position.z = z; }
  }

  // ---- 配置：レイを仮想の床（y=0）に当てて置く ----
  var ray = new THREE.Raycaster(), center = new THREE.Vector2(0, 0), hitP = new THREE.Vector3();
  function groundHit() {
    ray.setFromCamera(center, camera);
    var o = ray.ray.origin, d = ray.ray.direction;
    if (d.y > -0.06) return null;
    var t = -o.y / d.y; if (t < 0.5 || t > 5) return null;
    hitP.copy(o).addScaledVector(d, t);
    var dist = Math.sqrt(hitP.x * hitP.x + hitP.z * hitP.z);
    if (dist > 3.2) { hitP.x *= 3.2 / dist; hitP.z *= 3.2 / dist; }
    if (dist < 0.55) { var d2 = Math.max(dist, 0.001); hitP.x *= 0.55 / d2; hitP.z *= 0.55 / d2; }
    return hitP;
  }
  var placed = false, popT = 1;
  var startPop = function () { popT = CFG.mo === 'still' ? 1 : 0; };
  function placeAtCenter() {
    var h = groundHit(); if (!h) { showNote('床のほうを向けてタップしてね'); return; }
    group.position.set(h.x, 0, h.z);
    placed = true; startPop(); spawnRings(h.x, h.z);
    hint.textContent = '置いた！ タップで置き直せる ・ 近づいたり回り込んでみて';
  }
  // 最初は正面1.4mに仮置きして、すぐ絵が見えるようにする
  group.position.set(0, 0, -1.4); placed = true; startPop(); spawnRings(0, -1.4);

  var clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    var dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    // カメラの向き
    if (orient.has) { camera.quaternion.slerp(orient.q, 0.5); }
    else { camera.quaternion.setFromEuler(new THREE.Euler(dragPitch, dragYaw, 0, 'YXZ')); }
    // レティクル
    var h = groundHit();
    if (h) { ret.visible = true; ret.position.x = h.x; ret.position.z = h.z; var pulse = 1 + Math.sin(t * 3.2) * 0.07; ret.scale.set(pulse, 1, pulse); }
    else ret.visible = false;
    // 登場のポップ（bounce=easeOutBack / float=なめらかに）と、待機中の揺れ・浮遊
    if (popT < 1) { popT = Math.min(1, popT + dt / (CFG.mo === 'float' ? 0.85 : 0.55)); var s = Math.max(0.001, CFG.mo === 'float' ? easeInOutSine(popT) : easeOutBack(popT)); group.scale.set(s, s, s); }
    else {
      var sway = Math.sin(t * 0.9) * 0.02;
      group.scale.set(1, 1 + sway * 0.4, 1);
      tilt.rotation.z = Math.sin(t * 0.7) * 0.012;
      if (CFG.mo === 'float') { // ふわふわ：カード全体が上下に漂い、影が追従する
        cardGroup.position.y = 0.52 + Math.sin(t * 1.6) * 0.045;
        var shs = 1 - Math.sin(t * 1.6) * 0.06; shadow.scale.set(shs, shs, 1);
      }
      if (CFG.mo === 'hop' || CFG.mo === 'bounce') { // 跳ね続け、着地で潰れ、影が追従する
        var jp = Math.abs(Math.sin(t * (CFG.mo === 'hop' ? 2.7 : 3.5)));
        cardGroup.position.y = 0.52 + jp * (CFG.mo === 'hop' ? 0.17 : 0.11);
        if (!plateOn) group.scale.set(1 + (1 - jp) * 0.07, 1 - (1 - jp) * 0.09, 1);
        var shj = 1 - jp * 0.22; shadow.scale.set(shj, shj, 1);
      }
      if (CFG.mo === 'sway') { // ゆらゆら：左右に揺れる
        tilt.rotation.z = Math.sin(t * 1.9) * 0.085;
        cardGroup.position.y = 0.52 + Math.sin(t * 2.6) * 0.012;
      }
    }
    if (plateOn) { // 板レシピ方式：頂点シェーダのスカッシュ＆ストレッチ（着地で潰れ、頂点で伸びる）
      var sqT = 0;
      if (CFG.mo === 'hop' || CFG.mo === 'bounce') { var jpq = Math.abs(Math.sin(t * (CFG.mo === 'hop' ? 2.7 : 3.5))); sqT = (1 - jpq) * 0.24 - jpq * jpq * 0.07; }
      else if (CFG.mo === 'float') sqT = Math.sin(t * 1.6) * 0.03;
      else if (CFG.mo === 'sway') sqT = Math.sin(t * 2.6) * 0.045;
      if (popT < 1) sqT += -Math.sin(popT * Math.PI) * 0.10;
      deform.uSquash.value += (sqT - deform.uSquash.value) * Math.min(1, dt * 16);
    }
    // カードは常にこちらを向く（縦軸だけ）
    var dx = camera.position.x - group.position.x, dz = camera.position.z - group.position.z;
    var targetYaw = Math.atan2(dx, dz);
    var cur = tilt.rotation.y, diff = targetYaw - cur;
    while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
    tilt.rotation.y = cur + diff * Math.min(1, dt * 7) + Math.sin(t * 0.8) * 0.004;
    // 粒子
    for (var i = 0; i < N; i++) {
      life[i] -= dt * (P.dir === 'burst' ? 1.5 : 0.4);
      pos[i * 3] += (vel[i * 3] + Math.sin(t * 1.6 + seed[i]) * P.sway * 0.12) * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += (vel[i * 3 + 2] + Math.cos(t * 1.3 + seed[i]) * P.sway * 0.12) * dt;
      if (life[i] <= 0 || pos[i * 3 + 1] > 1.9 || pos[i * 3 + 1] < -0.05) respawn(i, false);
    }
    geo.attributes.position.needsUpdate = true;
    // 衝撃リングの進行
    for (var rj = 0; rj < rings.length; rj++) {
      var R = rings[rj]; R.t += dt;
      if (R.t < 0) { R.m.visible = false; continue; }
      var rp = R.t / 0.75;
      if (rp >= 1) { R.m.visible = false; continue; }
      R.m.visible = true;
      var rs = 0.25 + rp * 1.6; R.m.scale.set(rs, rs, 1);
      R.m.material.opacity = 0.85 * (1 - rp);
    }
    renderer.render(scene, camera);
  })();
}
</script></body></html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

// 生成画像の配信。メモリに無ければ 404（ARページ側は onerror で画像カードを消して成立させる）。
function arPageUltra(tok) {
  const p = readTok(tok);
  if (!p) return new Response(pageShell('リンクが無効です', '<p>この AR のリンクは確認できませんでした。Muse で作り直してね。</p>'), { status: 404, headers: htmlHeaders() });
  const cfg = { title: p.ti, text: p.tx, color: p.c, effect: p.e, theme: p.th, image: p.im ? `/img/${p.im}` : null, bg: p.bg || 'card', mo: p.mo || 'bounce' };
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(p.ti)} — AR Creator</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0b0b10;font-family:-apple-system,'Hiragino Sans',sans-serif;color:#fff}
#cam{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;background:linear-gradient(160deg,${esc(p.c)},#14141d 75%)}
#fx{position:fixed;inset:0;touch-action:none}
.hud{position:fixed;left:0;right:0;text-align:center;pointer-events:none;padding:0 18px;box-sizing:border-box}
#ttl{top:calc(18px + env(safe-area-inset-top));font-size:30px;font-weight:900;letter-spacing:.02em;text-shadow:0 2px 18px rgba(0,0,0,.55)}
#sub{top:calc(64px + env(safe-area-inset-top));font-size:14px;opacity:.92;text-shadow:0 1px 10px rgba(0,0,0,.6)}
#theme{bottom:calc(20px + env(safe-area-inset-bottom));font-size:13px;opacity:.85;text-shadow:0 1px 8px rgba(0,0,0,.6)}
#hint{position:fixed;left:50%;bottom:calc(52px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:13px;font-weight:700;background:rgba(0,0,0,.5);padding:8px 16px;border-radius:999px;white-space:nowrap;display:none}
#note{position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom));transform:translateX(-50%);font-size:12px;background:rgba(0,0,0,.45);padding:6px 12px;border-radius:999px;display:none;white-space:nowrap}
#start{position:fixed;inset:0;display:grid;place-items:center;background:rgba(8,8,14,.55);backdrop-filter:blur(3px);z-index:5}
#start button{border:0;border-radius:999px;padding:16px 34px;font-size:17px;font-weight:800;background:${esc(p.c)};color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.45)}
#fallback{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(62vw,260px);border-radius:20px;overflow:hidden;display:none;box-shadow:0 14px 44px rgba(0,0,0,.5)}
#fallback img{display:block;width:100%;height:auto}
</style>
<script type="importmap">
{"imports":{"three":"https://unpkg.com/three@0.186.1/build/three.module.js","three/addons/":"https://unpkg.com/three@0.186.1/examples/jsm/"}}
</script>
</head><body>
<video id="cam" autoplay playsinline muted></video>
<canvas id="fx"></canvas>
<div class="hud" id="ttl">${esc(p.ti)}</div>
<div class="hud" id="sub">${esc(p.tx)}</div>
<div class="hud" id="theme">theme: ${esc(p.th)} ・ Talk to Muse, unlock AR</div>
<div id="hint">真ん中の輪を床に合わせて、タップで置く</div>
<div id="note"></div>
${cfg.image ? `<div id="fallback"><img src="${esc(cfg.image)}" alt=""></div>` : ''}
<div id="start"><button id="go">カメラで見る</button></div>
<script>
window.__ultraReady = false;
document.getElementById('go').addEventListener('click', function () {
  setTimeout(function () {
    if (window.__ultraReady) return;
    var s = document.getElementById('start'); if (s) s.style.display = 'none';
    var f = document.getElementById('fallback'); if (f) f.style.display = 'block';
    var n = document.getElementById('note'); if (n) { n.style.display = 'block'; n.textContent = '演出を読み込めなかったので、画像で表示しています'; }
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(function (st) { document.getElementById('cam').srcObject = st; }).catch(function () {});
    }
  }, 9000);
});
</script>
<script type="module">
import * as THREE from 'three';
import { U } from '/vfx/common.js';
import { Bolts } from '/vfx/Bolts.js?v=2';
import { Shockwaves } from '/vfx/Shockwaves.js?v=2';
// Ultra Elements (MIT, (c) Humpalumps) — Bolts + Shockwaves, AR-adapted single-pass rendering. License: /vfx/LICENSE-ultra-elements.txt
var CFG = ${jsJson(cfg)};
function easeOutBack(t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
function showNote(msg) { var n = document.getElementById('note'); n.style.display = 'block'; n.textContent = msg; }
function showFallback() { var f = document.getElementById('fallback'); if (f) f.style.display = 'block'; showNote('演出を読み込めなかったので、画像で表示しています'); }
var started = false;
document.getElementById('go').addEventListener('click', function () {
  document.getElementById('start').style.display = 'none';
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) { document.getElementById('cam').srcObject = s; })
      .catch(function () { showNote('カメラが使えないので背景モードで表示しています'); });
  }
  var begin = function () { if (!started) { started = true; try { initScene(); } catch (e) { showFallback(); } } };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(begin).catch(begin);
  } else { begin(); }
});
function initScene() {
  var hint = document.getElementById('hint'); hint.style.display = 'block';
  var canvas = document.getElementById('fx');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) { showFallback(); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.05, 60);
  camera.position.set(0, 1.35, 0);
  function syncU() { var s = renderer.getDrawingBufferSize(new THREE.Vector2()); U.uResolution.value.copy(s); U.uFxResolution.value.set(s.x * 0.5, s.y * 0.5); }
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); syncU(); }
  resize(); addEventListener('resize', resize);
  var orient = { has: false, q: new THREE.Quaternion() };
  var zee = new THREE.Vector3(0, 0, 1), eu = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  addEventListener('deviceorientation', function (e) {
    if (e.alpha === null || e.alpha === undefined) return;
    orient.has = true;
    var alpha = THREE.MathUtils.degToRad(e.alpha), beta = THREE.MathUtils.degToRad(e.beta || 0), gamma = THREE.MathUtils.degToRad(e.gamma || 0);
    var so = THREE.MathUtils.degToRad((screen.orientation && screen.orientation.angle) || window.orientation || 0);
    eu.set(beta, alpha, -gamma, 'YXZ');
    orient.q.setFromEuler(eu); orient.q.multiply(q1); orient.q.multiply(q0.setFromAxisAngle(zee, -so));
  });
  var dragYaw = 0, dragPitch = -0.25, dragging = false, lastX = 0, lastY = 0, moved = 0;
  canvas.addEventListener('touchstart', function (e) { dragging = true; moved = 0; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    if (!dragging) return;
    var dx = e.touches[0].clientX - lastX, dy = e.touches[0].clientY - lastY; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (!orient.has) { dragYaw -= dx * 0.005; dragPitch -= dy * 0.005; dragPitch = Math.max(-1.2, Math.min(0.6, dragPitch)); }
  }, { passive: true });
  canvas.addEventListener('touchend', function (e) { dragging = false; if (moved < 12) placeAtCenter(); });
  canvas.addEventListener('click', function () { placeAtCenter(); });
  var group = new THREE.Group(); scene.add(group);
  var tilt = new THREE.Group(); tilt.rotation.x = -0.10; group.add(tilt);
  var cardGroup = new THREE.Group(); cardGroup.position.y = 0.52; tilt.add(cardGroup);
  var frame = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.98), new THREE.MeshBasicMaterial({ color: new THREE.Color(CFG.color) }));
  frame.position.z = -0.012; cardGroup.add(frame);
  if (CFG.bg === 'transparent') frame.visible = false;
  var cardMat = new THREE.MeshBasicMaterial({ color: 0x22222c, transparent: true });
  var card = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), cardMat); cardGroup.add(card);
  if (CFG.image) {
    new THREE.TextureLoader().load(CFG.image, function (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      cardMat.map = tex; cardMat.color.set(0xffffff); cardMat.needsUpdate = true;
      if (tex.image && tex.image.height && tex.image.width) { var a = tex.image.height / tex.image.width; card.scale.y = a; frame.scale.y = a; }
    }, undefined, function () {});
  }
  var sc = document.createElement('canvas'); sc.width = sc.height = 128;
  var sg = sc.getContext('2d'), grad = sg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = grad; sg.fillRect(0, 0, 128, 128);
  var shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.35), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.012; group.add(shadow);
  var bolts = new Bolts({ max: 8 }); scene.add(bolts.cores); scene.add(bolts.glows);
  var shocks = new Shockwaves({ max: 16 }); scene.add(shocks.mesh);
  var shockColor = new THREE.Color(CFG.color);
  function spawnShock(x, z) {
    shocks.spawn({ pos: new THREE.Vector3(x, 0.02, z), ground: true, radius0: 0.15, radius1: 2.3, duration: 0.8, thickness: 0.5, color: shockColor, intensity: 3, distortion: 0 });
  }
  var ret = new THREE.Group();
  var ring = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.105, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ret.add(ring);
  var dot = new THREE.Mesh(new THREE.CircleGeometry(0.016, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
  dot.rotation.x = -Math.PI / 2; ret.add(dot);
  ret.position.y = 0.015; scene.add(ret);
  var ray = new THREE.Raycaster(), center = new THREE.Vector2(0, 0), hitP = new THREE.Vector3();
  function groundHit() {
    ray.setFromCamera(center, camera);
    var o = ray.ray.origin, d = ray.ray.direction;
    if (d.y > -0.06) return null;
    var t = -o.y / d.y; if (t < 0.5 || t > 5) return null;
    hitP.copy(o).addScaledVector(d, t);
    var dist = Math.sqrt(hitP.x * hitP.x + hitP.z * hitP.z);
    if (dist > 3.2) { hitP.x *= 3.2 / dist; hitP.z *= 3.2 / dist; }
    if (dist < 0.55) { var d2 = Math.max(dist, 0.001); hitP.x *= 0.55 / d2; hitP.z *= 0.55 / d2; }
    return hitP;
  }
  var placed = false, popT = 1;
  var startPop = function () { popT = CFG.mo === 'still' ? 1 : 0; };
  function placeAtCenter() {
    var h = groundHit(); if (!h) { showNote('床のほうを向けてタップしてね'); return; }
    group.position.set(h.x, 0, h.z);
    placed = true; startPop();
    spawnShock(h.x, h.z);
    startStrike(clock.elapsedTime, h.x, h.z);
    hint.textContent = '置いた！ タップで置き直せる ・ 近づいたり回り込んでみて';
  }
  group.position.set(0, 0, -1.4); placed = true; startPop();
  var strike = null;
  function startStrike(now, gx, gz) {
    if (strike) return;
    var h = bolts.acquire({ a: new THREE.Vector3(gx + (Math.random() - 0.5) * 0.5, 3.3, gz), b: new THREE.Vector3(gx, 0.02, gz), jag: 0.085, branches: 8, width: 0.03 });
    if (!h) return;
    h.color.set('#d6e6ff'); h.glowColor.setRGB(0.05, 0.075, 0.2); h.branchLevel = 0.35;
    h.reveal = 0; h.stroke = 0; h.dart = -1; h.residual = 0; h.intensity = 5;
    strike = { h: h, t0: now, gx: gx, gz: gz, hit: false, darts: [0.46, 0.72] };
  }
  function stepStrike(now) {
    if (!strike) return;
    var h = strike.h, age = now - strike.t0;
    if (age < 0.26) { h.reveal = age / 0.26; h.intensity = 5; }
    else if (age < 0.34) {
      if (!strike.hit) { strike.hit = true; spawnShock(strike.gx, strike.gz); }
      h.reveal = 1;
      h.stroke = Math.min(1, (age - 0.26) / 0.05);
      h.branchLevel = 1;
      h.intensity = 26;
    } else {
      h.stroke = 1;
      h.intensity = 26 * Math.exp(-(age - 0.34) * 5.5) + 1.2;
      h.dart = -1;
      for (var di = 0; di < strike.darts.length; di++) {
        var dd = (age - strike.darts[di]) / 0.06;
        if (dd >= 0 && dd <= 1) { h.dart = dd; h.intensity = Math.max(h.intensity, 15); }
      }
      h.residual = Math.max(0, Math.min(1, (age - 0.55) / 0.8));
    }
    if (age > 1.6) { h.release(); strike = null; }
  }
  var nextAuto = 1.0;
  var clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    var dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    if (orient.has) { camera.quaternion.slerp(orient.q, 0.5); }
    else { camera.quaternion.setFromEuler(new THREE.Euler(dragPitch, dragYaw, 0, 'YXZ')); }
    var h = groundHit();
    if (h) { ret.visible = true; ret.position.x = h.x; ret.position.z = h.z; var pulse = 1 + Math.sin(t * 3.2) * 0.07; ret.scale.set(pulse, 1, pulse); }
    else ret.visible = false;
    if (popT < 1) { popT = Math.min(1, popT + dt / (CFG.mo === 'float' ? 0.85 : 0.55)); var s = Math.max(0.001, CFG.mo === 'float' ? easeInOutSine(popT) : easeOutBack(popT)); group.scale.set(s, s, s); }
    else {
      var sway = Math.sin(t * 0.9) * 0.02;
      group.scale.set(1, 1 + sway * 0.4, 1);
      tilt.rotation.z = Math.sin(t * 0.7) * 0.012;
      if (CFG.mo === 'float') {
        cardGroup.position.y = 0.52 + Math.sin(t * 1.6) * 0.045;
        var shs = 1 - Math.sin(t * 1.6) * 0.06; shadow.scale.set(shs, shs, 1);
      }
      if (CFG.mo === 'hop' || CFG.mo === 'bounce') {
        var jp = Math.abs(Math.sin(t * (CFG.mo === 'hop' ? 2.7 : 3.5)));
        cardGroup.position.y = 0.52 + jp * (CFG.mo === 'hop' ? 0.17 : 0.11);
        group.scale.set(1 + (1 - jp) * 0.07, 1 - (1 - jp) * 0.09, 1);
        var shj = 1 - jp * 0.22; shadow.scale.set(shj, shj, 1);
      }
      if (CFG.mo === 'sway') {
        tilt.rotation.z = Math.sin(t * 1.9) * 0.085;
        cardGroup.position.y = 0.52 + Math.sin(t * 2.6) * 0.012;
      }
    }
    var dx = camera.position.x - group.position.x, dz = camera.position.z - group.position.z;
    var targetYaw = Math.atan2(dx, dz);
    var cur = tilt.rotation.y, diff = targetYaw - cur;
    while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
    tilt.rotation.y = cur + diff * Math.min(1, dt * 8);
    U.uTime.value = t % 3600;
    if (!strike && t > nextAuto) { startStrike(t, group.position.x + (Math.random() - 0.5) * 0.4, group.position.z + (Math.random() - 0.5) * 0.4); nextAuto = t + 2.6 + Math.random() * 1.2; }
    stepStrike(t);
    bolts.update();
    shocks.update(dt);
    renderer.render(scene, camera);
    window.__ultraReady = true;
  })();
}
</script>
</body></html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

function imgResponse(id) {
  const rec = imgs.get(id);
  if (!rec) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (rec.remote) return Response.redirect(rec.remote, 302);
  return new Response(rec.buf, { status: 200, headers: { 'content-type': rec.type || 'image/webp', 'cache-control': 'public, max-age=86400' } });
}

function certPage(tok) {
  const p = readTok(tok);
  if (!p) return new Response(pageShell('リンクが無効です', '<p>この制作証明は確認できませんでした。</p>'), { status: 404, headers: htmlHeaders() });
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>制作証明 — AR Creator</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101018;color:#f5f0e6;font-family:-apple-system,'Hiragino Sans',sans-serif;padding:24px 16px;box-sizing:border-box}
.card{max-width:420px;width:100%;border:1.5px solid #d4af37;border-radius:18px;padding:30px 26px;background:linear-gradient(165deg,#1b1b28,#12121c);box-shadow:0 18px 50px rgba(0,0,0,.5);text-align:center}
h1{font-size:15px;letter-spacing:.35em;color:#d4af37;margin:0 0 6px}p{line-height:1.8;margin:6px 0;color:#cfc9bb}.title{font-size:24px;font-weight:900;color:#fff;margin:14px 0 2px}.theme{font-size:14px}.row{margin-top:16px;font-size:13px;color:#9d968a}.seal{margin:18px auto 4px;width:64px;height:64px;border-radius:50%;border:1.5px solid #d4af37;display:grid;place-items:center;font-size:24px;color:#d4af37}</style></head>
<body><div class="card"><h1>CERTIFICATE</h1><p>AR 制作証明</p><div class="seal">✦</div>
<div class="title">${esc(p.ti)}</div><p class="theme">theme: ${esc(p.th)}</p>
<p>この AR は Muse との会話から生まれ、<br>Meta Model API（Muse Spark / Muse Image）で<br>構成・生成されました。</p>
${p.us ? `<div class="row">Meta Model API usage（実行証跡）<br>${p.us.s ? `muse-spark-1.3： ${p.us.s.total ?? '?'} トークン（入力 ${p.us.s.in ?? '?'} / 出力 ${p.us.s.out ?? '?'}）<br>` : ''}${p.us.i ? `muse-image-1.0： ${p.us.i.total ?? '?'} トークン（入力 ${p.us.i.in ?? '?'} / 出力 ${p.us.i.out ?? '?'}）` : ''}</div>` : ''}
<div class="row">creator: ${esc(p.n)}<br>date: ${esc(p.d)}<br>Talk to Muse, unlock AR — HACK IT INC.</div></div></body></html>`;
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

const htmlHeaders = () => ({ 'content-type': 'text/html; charset=utf-8' });
const pageShell = (title, inner) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F4F2;color:#1C1C1E;font-family:-apple-system,'Hiragino Sans',sans-serif;padding:24px;text-align:center}p{line-height:1.8;color:#55555B}</style></head><body><main><h1>${esc(title)}</h1>${inner}</main></body></html>`;

const browserPage = () => new Response(pageShell('AR Creator は Muse で使ってね', '<p>この入口は Muse の相棒が AR を作りに来る場所です。<br>Muse アプリで AR Creator をつないで、「AR作って」と話しかけてみて。</p>'), { status: 200, headers: htmlHeaders() });

// ---- Muse への話し方ガイド ----
const VOICE = 'AR Creator は、ユーザーが Muse との会話で AR（カメラに重なる小さな体験）を作って公開できる仕組み。あなたはユーザーの相棒として、いつもの自分の名前と口調で案内する。'
  + 'コネクター・MCP・API・トークン・サーバーなどの仕組みの言葉は、必要なとき以外は使わない。'
  + '進め方は3つだけ：① start_create で参加の確認とテーマを聞く（テーマはユーザー本人の言葉をそのまま渡す。あなたが勝手にテーマを決めない）'
  + '② テーマが決まったら compose_ar を呼ぶ（AR の中身の構成はサーバー側のモデルが行う）'
  + '③ compose の結果はプレビューとして見せ、publish_ar で HACKAR:S（hackar-s.com）に公開した URL を成果物として渡す。最後に issue_certificate で制作証明を出す。'
  + '案内役としてユーザーを迷わせないこと：テーマに迷っていたら例を3つ提案する。各ステップでは、次にできることを短い選択肢で提示して選んでもらう（考えさせるだけの質問で終わらせない）。公開できたら、制作証明を出すか、動きやエフェクトを変えた別バージョンを作るか、新しいテーマで作るかを提案する。'
  + 'ツールが返した URL・タイトル・トークン数の要約は、中身を変えずに伝える。'
  + 'リンクの統一ルール：ユーザーが開く AR のリンクは hackar-s.com の URL だけ。ビューアの URL は内部プレビュー用で、成果物として渡さない。HACKAR:S への公開に失敗したときは、別の URL に差し替えず、失敗したこと自体をそのまま伝える。';

function buildServer() {
  const server = new McpServer(
    { name: 'ar-creator', title: 'AR Creator', version: '1.0.0' },
    { instructions: VOICE },
  );

  server.registerTool('start_create', {
    title: 'AR作りを始める',
    description: 'AR作りを始める。ユーザーが「AR作って」「ARを作りたい」と言ったら、聞き返しをせず、すぐに agreed を付けずに呼ぶ（参加の確認文が返る）。返ってきた文を相棒の口調で伝える。ユーザーが「いいよ」「OK」などはっきり同意したときだけ agreed=true で呼び直す。あなたの判断で agreed=true にしない。作りたいARのテーマをユーザーが言っていたら theme にその言葉をそのまま入れる。',
    inputSchema: {
      nickname: nickArg,
      theme: z.string().optional().describe('ユーザーが言った作りたいARのテーマ（一言、そのまま）'),
      agreed: z.boolean().optional().describe('ユーザーが参加の確認に同意したら true'),
      card: cardArg,
    },
    annotations: { title: 'AR作りを始める', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ nickname, theme, agreed, card }) => {
    const u = getU(nickname, card);
    if (!agreed && !u.agreed) {
      return {
        content: [{ type: 'text', text: 'AR、一緒に作ろう！\nその前にひとつだけ。呼び名と、作りたいテーマ、作ったARの情報だけを AR Creator に預けるね。それ以外は渡さないよ。\n\n「いいよ」で始めよう。どんなARにしたい？テーマを一言で教えて。' }],
        structuredContent: { needsAgreement: true, shares: ['呼び名', 'テーマ', '作ったARの情報'] },
      };
    }
    u.agreed = true;
    if (theme) u.theme = String(theme).slice(0, 60);
    if (!u.theme) {
      return {
        content: [{ type: 'text', text: 'ありがとう！じゃあ、どんなARにする？テーマを一言で教えて。迷ったらこの中から選んでもOK：「焚き火の精霊」「月夜のたぬき」「推しの誕生日ケーキ」。もちろん別のテーマでも大丈夫だよ。' }],
        structuredContent: { needsTheme: true, card: packCard(u) },
      };
    }
    return {
      content: [{ type: 'text', text: `テーマは「${u.theme}」だね。そのまま compose_ar で中身を組み立てて。` }],
      structuredContent: { theme: u.theme, ready: true, card: packCard(u) },
    };
  });

  server.registerTool('compose_ar', {
    title: 'ARの中身を組み立てる',
    description: 'テーマからARの中身（タイトル・表示テキスト・色・エフェクト・素材画像）をサーバー側の Meta モデルで組み立てる。テーマが決まったら呼ぶ。呼ぶ前に、ユーザーの意向がまだ分からなければ、3つだけ短く聞いてから呼ぶこと：①背景は「キャラだけ透過（背景なし）」か「カード型（背景あり）」か。②動きは「ぴょんぴょん（跳ね続ける）」「バウンス（弾んで登場）」「ふわふわ（浮いて揺れる）」「ゆらゆら（揺れる）」「そのまま（静止）」のどれか。③エフェクトは「おまかせ」「炎」「氷」「稲妻」「花びら」「きらきら」「泡」「紙吹雪」「ウルトラ稲妻（プレビュー専用）」のどれか。ユーザーが「おまかせ」と言ったら聞かずに既定（透過＋バウンス＋エフェクトおまかせ）で呼ぶ。既に聞いている・決まっている場合は聞き直さない。返ってきたプレビューURLと要約（どのモデルが何トークン使ったか）をユーザーに伝える。そのうえで、公開するか、動きやエフェクトを変える（remix_ar）かをユーザーに選んでもらうこと。成果物として渡す URL は publish_ar が返す hackar-s.com の URL だけ。',
    inputSchema: {
      nickname: nickArg,
      theme: z.string().optional().describe('テーマ（一言）。前に start_create で受け取っていれば省略可'),
      background: z.enum(['transparent', 'card']).optional().describe('背景：transparent=キャラだけ透過（既定）、card=カード型'),
      motion: z.enum(['bounce', 'float', 'hop', 'sway', 'still']).optional().describe('動き：bounce=弾んで登場（既定）、hop=ぴょんぴょん跳ね続ける、float=浮いて揺れる、sway=ゆらゆら揺れる、still=静止'),
      effect: z.enum(['auto', 'flame', 'ice', 'lightning', 'petal', 'sparkle', 'bubble', 'confetti', 'ultra']).optional().describe('エフェクト：auto=おまかせ（既定）、flame=炎、ice=氷、lightning=稲妻、petal=花びら、sparkle=きらきら、bubble=泡、confetti=紙吹雪、ultra=ウルトラ稲妻（本物three.js・ビューア限定）'),
      card: cardArg,
    },
    annotations: { title: 'ARの中身を組み立てる', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ nickname, theme, background, motion, effect, card }) => {
    const u = getU(nickname, card);
    if (theme) u.theme = String(theme).slice(0, 60);
    if (!u.theme) {
      return { content: [{ type: 'text', text: 'テーマがまだ決まってないみたい。先に start_create でテーマを聞いてね。' }], structuredContent: { needsTheme: true, card: packCard(u) } };
    }
    const th = u.theme;
    const bgChoice = background || 'transparent';
    const moChoice = motion || 'bounce';
    let comp = null, imgId = null, sparkUsage = null, imageUsage = null, usedModel = false, notes = [], transparentApplied = false;
    if (MODEL_API_KEY) {
      try {
        const r = await callSpark(th);
        comp = r.comp; sparkUsage = r.usage; usedModel = true;
        console.log('[AR] model-usage', JSON.stringify({ at: new Date().toISOString(), model: SPARK_MODEL, theme: th, usage: sparkUsage }));
      } catch (e) { console.log('[AR] spark-failed', JSON.stringify({ theme: th, error: String(e?.message || e) })); notes.push('構成モデルが応答しなかったのでテンプレート構成に切り替えました'); }
      if (comp) {
        try {
          const r = await callImage(th, comp, bgChoice);
          imageUsage = r.usage;
          imgId = Math.floor(Math.random() * 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
          if (r.b64) {
            let buf = Buffer.from(r.b64, 'base64');
            let type = r.type || 'image/webp';
            if (bgChoice === 'transparent' && type === 'image/png') {
              try { buf = makeTransparent(buf, r.keyCh || 1); transparentApplied = true; }
              catch (ke) { console.log('[AR] keying-failed', JSON.stringify({ theme: th, error: String(ke?.message || ke) })); notes.push('透過処理ができなかったので、そのままの画像で表示します'); }
            }
            imgs.set(imgId, { buf, type });
          }
          else if (r.remote) imgs.set(imgId, { remote: r.remote });
          console.log('[AR] model-usage', JSON.stringify({ at: new Date().toISOString(), model: IMAGE_MODEL, theme: th, usage: imageUsage ?? 'n/a' }));
        } catch (e) { console.log('[AR] image-failed', JSON.stringify({ theme: th, error: String(e?.message || e) })); notes.push('素材画像の生成に失敗したので色の背景で代替します'); }
      }
    } else {
      notes.push('APIキー未設定のためテンプレート構成です');
    }
    if (!comp) comp = fallbackComp(th);
    if (effect && effect !== 'auto') comp.effect = effect;
    const action = comp.action || '';
    const effBg = transparentApplied ? 'transparent' : 'card';

    // usage は Tooling の証拠として、カードとARトークン（→制作証明）の両方に保持する
    const usage = (sparkUsage || imageUsage) ? { s: normUsage(sparkUsage), i: normUsage(imageUsage) } : null;
    u.usage = usage;

    const arId = Date.now().toString(36).toUpperCase().slice(-6) + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
    const arTok = packTok({ i: arId, ti: comp.title, tx: comp.text, c: comp.color, e: comp.effect, th, im: imgId, us: usage, bg: effBg, mo: moChoice, ac: action || undefined });
    u.arTok = arTok; u.arId = arId; u.certTok = null; // 新しいARを作ったら証明は作り直し
    const url = `${BASE}/ar/${arTok}`;
    const summary = usedModel
      ? `Muse Spark が構成しました（${usageText('Spark', sparkUsage)}${imgId ? `／素材画像は Muse Image で生成（${usageText('Image', imageUsage)}）` : ''}）`
      : 'テンプレート構成で組み立てました（モデル未使用）';
    const styleLine = `背景：${transparentApplied ? '透過（キャラだけ浮き出る）' : 'カード型'}／動き：${{ bounce: 'バウンスで登場', hop: 'ぴょんぴょん跳ね続ける', float: 'ふわふわ浮く', sway: 'ゆらゆら揺れる', still: 'そのまま静止' }[moChoice]}${action ? `／動きの演出：${action}` : ''}`;
    const text = `できたよ！「${comp.title}」\n${comp.text}\nエフェクト：${comp.effect}／基調色：${comp.color}\n${styleLine}\n${summary}${notes.length ? `\n（${notes.join('／')}）` : ''}\n\nプレビュー（スマホで確認してね）：\n${url}\n\nこのまま公開する？（公開すると hackar-s.com のURLが発行されるよ）動きやエフェクトを変えたくなったら、言ってくれたらすぐ作り直すよ。`;
    console.log('[AR] composed', JSON.stringify({ nickname: u.nickname, theme: th, arId, usedModel, effect: comp.effect, bg: effBg, mo: moChoice, transparentApplied }));
    return {
      content: [{ type: 'text', text }],
      structuredContent: { url, title: comp.title, text: comp.text, color: comp.color, effect: comp.effect, theme: th, usedModel, sparkUsage, imageUsage, usage, hasImage: !!imgId, background: effBg, motion: moChoice, transparentApplied, action, card: packCard(u) },
    };
  });

  server.registerTool('publish_ar', {
    title: 'ARを公開する',
    description: '作ったARを HACKAR:S に実プロジェクトとして公開し、hackar-s.com のURLを返す。成果物のURLはこれだけに統一する。公開できない場合は失敗として返す（別のURLで代用しない）。compose_ar のあとに呼ぶ。',
    inputSchema: { nickname: nickArg, card: cardArg },
    annotations: { title: 'ARを公開する', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ nickname, card }) => {
    const u = getU(nickname, card);
    if (!u.arTok) return { content: [{ type: 'text', text: 'まだARができてないみたい。先に compose_ar で組み立ててね。' }], structuredContent: { needsCompose: true, card: packCard(u) } };
    const builtinUrl = `${BASE}/ar/${u.arTok}`;
    // HACKAR:S 連携: キーが設定されていて素材画像が手元にあれば、HACKAR:S に
    // 実プロジェクトを作成して、その /slam-ar/ URL を公開リンクにする。
    // 失敗したら失敗として返す（成果物URLの差し替えはしない＝URL統一ルール）。
    let hackars = null;
    let animatedGif = false;
    if (HACKARS_API_KEY && !u.hackarsUrl) {
      try {
        const p = readTok(u.arTok) || {};
        const img = p.im ? imgs.get(p.im) : null;
        if (img?.buf) {
          const moP = p.mo || 'bounce';
          let pubBuf = img.buf, pubType = img.type === 'image/png' ? 'image/png' : 'image/webp';
          if (moP !== 'still' && img.type === 'image/png') {
            try {
              const gif = makeAnimGif(img.buf, moP);
              if (gif && gif.length < 3.9 * 1024 * 1024) { pubBuf = gif; pubType = 'image/gif'; }
            } catch (ge) { console.log('[AR] gif-failed', JSON.stringify({ error: String(ge?.message || ge) })); }
          }
          animatedGif = pubType === 'image/gif';
          const r = await fetch(HACKARS_API_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': HACKARS_API_KEY },
            body: JSON.stringify({
              name: p.ti || 'Muse AR',
              effect: p.e || 'petal',
              color: p.c || '#FFC2D6',
              imageBase64: pubBuf.toString('base64'),
              imageContentType: pubType,
              entranceAnim: moP === 'float' || moP === 'sway' ? 'fadeIn' : moP === 'still' ? 'none' : 'bounce',
              billboard: moP === 'float',
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.url) {
            hackars = j;
            u.hackarsUrl = j.url; u.hackarsProjectId = j.projectId || null;
            console.log('[AR] hackars-created', JSON.stringify({ nickname: u.nickname, projectId: j.projectId }));
          } else {
            console.log('[AR] hackars-failed', JSON.stringify({ status: r.status, error: j.error || 'unknown' }));
          }
        } else {
          console.log('[AR] hackars-skipped', JSON.stringify({ reason: img ? 'remote-image' : 'no-image' }));
        }
      } catch (e) {
        console.log('[AR] hackars-error', JSON.stringify({ error: String(e?.message || e) }));
      }
    }
    if (u.hackarsUrl) hackars = { url: u.hackarsUrl, projectId: u.hackarsProjectId || null };
    const url = hackars?.url || builtinUrl;
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(url)}`;
    console.log('[AR] publish', JSON.stringify({ nickname: u.nickname, arId: u.arId, hackars: !!hackars }));
    const isUltra = (readTok(u.arTok) || {}).e === 'ultra';
    const text = hackars
      ? `公開したよ！このARは HACKAR:S のプロジェクトとして作成されたよ。スマホで開くと、そのままARが見られるよ（アプリ不要）。\n${url}\n\nQRコード用リンク：\n${qr}${isUltra ? '\n\n※ウルトラ稲妻の演出はプレビュー専用で、HACKAR:S版では花びらのエフェクトになっているよ。' : ''}\n\n次はどうする？「制作証明を出す」「動きやエフェクトを変えた別バージョンを作る」「新しいテーマで作る」から選んでね。`
      : `HACKAR:S への公開がうまくいかなかったよ。時間をおいて、もう一度「公開して」と言ってね。（確認用プレビュー：${builtinUrl}）`;
    return {
      content: [{ type: 'text', text }],
      structuredContent: { url: hackars?.url || null, publishFailed: !hackars, qr: hackars ? qr : null, hackarsUrl: hackars?.url || null, hackarsProjectId: hackars?.projectId || null, previewUrl: builtinUrl, animated: animatedGif, card: packCard(u) },
    };
  });

  server.registerTool('remix_ar', {
    title: '動きとエフェクトを変える',
    description: '作ったARの素材はそのままに、動きとエフェクトだけを変えた別バージョンを作る（画像の再生成はしないので速い）。ユーザーが「動きを変えて」「エフェクトを変えて」と言ったら呼ぶ。呼んだら、続けて publish_ar を呼んで新しい公開リンクを出すこと。',
    inputSchema: {
      nickname: nickArg,
      motion: z.enum(['bounce', 'float', 'hop', 'sway', 'still']).optional().describe('新しい動き（省略時は今のまま）'),
      effect: z.enum(['flame', 'ice', 'lightning', 'petal', 'sparkle', 'bubble', 'confetti', 'ultra']).optional().describe('新しいエフェクト（省略時は今のまま）。ultra=ウルトラ稲妻（本物three.js・ビューア限定）'),
      card: cardArg,
    },
    annotations: { title: '動きとエフェクトを変える', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ nickname, motion, effect, card }) => {
    const u = getU(nickname, card);
    if (!u.arTok) return { content: [{ type: 'text', text: 'まだARができてないみたい。先に compose_ar で組み立ててね。' }], structuredContent: { needsCompose: true, card: packCard(u) } };
    const p = readTok(u.arTok) || {};
    const mo = motion || p.mo || 'bounce';
    const ef = effect || p.e || 'petal';
    const arId = Date.now().toString(36).toUpperCase().slice(-6) + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
    const arTok = packTok({ i: arId, ti: p.ti, tx: p.tx, c: p.c, e: ef, th: p.th, im: p.im, us: p.us, bg: p.bg, mo, ac: p.ac });
    u.arTok = arTok; u.arId = arId; u.hackarsUrl = null; u.hackarsProjectId = null; u.certTok = null;
    const url = `${BASE}/ar/${arTok}`;
    const text = `変えたよ！動き：${mo}／エフェクト：${ef}\nビューア（スマホで開いてね）：\n${url}\n\nこのまま publish_ar で新しい公開リンクを出すね。`;
    return { content: [{ type: 'text', text }], structuredContent: { url, title: p.ti, motion: mo, effect: ef, card: packCard(u) } };
  });

  server.registerTool('issue_certificate', {
    title: '制作証明を出す',
    description: '作ったARの「制作証明」ページを発行する。証明は1人1枚で、もう出している場合は同じリンクを返す。ARを作り終えたら呼ぶ。',
    inputSchema: { nickname: nickArg, card: cardArg },
    annotations: { title: '制作証明を出す', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ nickname, card }) => {
    const u = getU(nickname, card);
    if (!u.arTok) return { content: [{ type: 'text', text: 'まだARができてないみたい。先に AR を作ってね。' }], structuredContent: { needsCompose: true, card: packCard(u) } };
    const p = readTok(u.arTok) || {};
    const again = !!u.certTok;
    if (!again) u.certTok = packTok({ n: u.nickname, ti: p.ti || 'My AR', th: p.th || u.theme || '', d: new Date().toISOString().slice(0, 10), us: p.us || u.usage || null, h: u.hackarsUrl || null });
    const url = `${BASE}/c/${u.certTok}`;
    console.log('[AR] certificate', JSON.stringify({ nickname: u.nickname, again }));
    return {
      content: [{ type: 'text', text: (again ? `制作証明はひとり1枚だよ。さっきのと同じものをもう一度出すね。\n${url}` : `おつかれさま！「${p.ti || 'My AR'}」の制作証明だよ。\n${url}\n\nよかったら、動きやエフェクトを変えた別バージョンや、新しいテーマでも作ってみてね。`) }],
      structuredContent: { url, again, card: packCard(u) },
    };
  });

  return server;
}

// 実行ログ：Tooling の証拠として、モデル実行は compose 内で [AR] model-usage として残る
async function logRequest(request) {
  try {
    const body = await request.clone().json();
    for (const msg of Array.isArray(body) ? body : [body]) {
      if (msg.method === 'initialize') console.log('[AR] initialize', JSON.stringify({ clientInfo: msg.params?.clientInfo, protocolVersion: msg.params?.protocolVersion }));
      else if (msg.method === 'tools/call') console.log('[AR] tools/call', JSON.stringify({ name: msg.params?.name }));
      else if (msg.method) console.log('[AR]', msg.method);
    }
  } catch { /* 本文が JSON でないときは記録しない */ }
}

// ブラウザで /mcp を開いた人には、エラーの代わりに案内ページを出す
const isBrowser = (request) => request.method === 'GET' && !(request.headers.get('accept') || '').includes('text/event-stream');

async function handle(request) {
  const url = new URL(request.url);
  const arTok = url.searchParams.get('ar');
  const certTok = url.searchParams.get('cert');
  const imgId = url.searchParams.get('img');
  const staticPath = url.searchParams.get('static');
  if (request.method === 'GET' && staticPath && VFX_SOURCES[staticPath]) {
    return new Response(Buffer.from(VFX_SOURCES[staticPath], 'base64'), { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=120' } });
  }
  if (request.method === 'GET' && arTok) return ((readTok(arTok) || {}).e === 'ultra' ? arPageUltra(arTok) : arPage(arTok));
  if (request.method === 'GET' && certTok) return certPage(certTok);
  if (request.method === 'GET' && imgId) return imgResponse(imgId);
  if (isBrowser(request)) return browserPage();
  if (request.method === 'POST') await logRequest(request);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
