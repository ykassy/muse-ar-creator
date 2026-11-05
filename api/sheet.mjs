// A mascot's owner already has the art, often as a three-view sheet (front, side, back on one page).
// When the picture is on a clean white background its own pixels are used: nothing is redrawn.
// Everything that touches the white border is background; each large shape left is one view.
const SIZE = 1024, FILL = 900;

function background({ w, h, rgba }) {
  const white = (i) => rgba[i * 4 + 3] < 16 || (rgba[i * 4] > 232 && rgba[i * 4 + 1] > 232 && rgba[i * 4 + 2] > 232);
  let edge = 0, clean = 0;
  const count = (i) => { edge++; if (white(i)) clean++; };
  for (let x = 0; x < w; x++) { count(x); count((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { count(y * w); count(y * w + w - 1); }
  if (clean / edge < 0.97) return null;   // a photo or a coloured page: not ours to cut by colour
  const bg = new Uint8Array(w * h), stack = [];
  const push = (i) => { if (!bg[i] && white(i)) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return bg;
}

function shapes({ w, h }, bg) {
  const label = new Int32Array(w * h), found = [], stack = [];
  for (let s = 0; s < w * h; s++) {
    if (bg[s] || label[s]) continue;
    const id = found.length + 1, c = { id, area: 0, x0: w, x1: 0, y0: h, y1: 0 };
    label[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (n >= 0 && !bg[n] && !label[n]) { label[n] = id; stack.push(n); }
      }
    }
    found.push(c);
  }
  return { label, found };
}

// Returns null when the picture is not clean enough. Otherwise `views` holds one shape for a single
// drawing, or the views of a sheet from left to right: shapes of about the same height, side by side.
export function findViews(img) {
  const bg = background(img);
  if (!bg) return null;
  const { label, found } = shapes(img, bg);
  if (!found.length) return null;
  const biggest = Math.max(...found.map((c) => c.area));
  const tall = Math.max(...found.filter((c) => c.area === biggest).map((c) => c.y1 - c.y0));
  const views = found.filter((c) => c.area > biggest * 0.2 && (c.y1 - c.y0) > tall * 0.7).sort((a, b) => a.x0 - b.x0);
  const sheet = views.length >= 2;
  // One drawing can be several shapes (a floating hat, a separate tail): those stay with it.
  const groups = sheet ? views.map((c) => [c]) : [found.filter((c) => c.area > biggest * 0.002)];
  return { sheet, label, views: groups };
}

function cropView({ w, rgba }, label, group) {
  const ids = new Set(group.map((c) => c.id));
  const x0 = Math.min(...group.map((c) => c.x0)), x1 = Math.max(...group.map((c) => c.x1));
  const y0 = Math.min(...group.map((c) => c.y0)), y1 = Math.max(...group.map((c) => c.y1));
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const s = (y + y0) * w + x + x0, d = (y * cw + x) * 4;
    if (!ids.has(label[s])) continue;
    out[d] = rgba[s * 4]; out[d + 1] = rgba[s * 4 + 1]; out[d + 2] = rgba[s * 4 + 2]; out[d + 3] = 255;
  }
  return { w: cw, h: ch, rgba: out };
}

// The same scale for every view, centred on one square, so that front and back line up.
function onSquare(view, k, scaleRgba) {
  const tw = Math.max(1, Math.round(view.w * k)), th = Math.max(1, Math.round(view.h * k));
  const small = scaleRgba(view, tw, th);
  const out = new Uint8Array(SIZE * SIZE * 4), ox = Math.round((SIZE - tw) / 2), oy = Math.round((SIZE - th) / 2);
  for (let y = 0; y < th; y++) out.set(small.rgba.subarray(y * tw * 4, (y + 1) * tw * 4), ((y + oy) * SIZE + ox) * 4);
  return { w: SIZE, h: SIZE, rgba: out };
}

// The art on the key colour, for the image edits that need a flat background.
function onKey(cut, ch) {
  const out = new Uint8Array(cut.rgba), key = ch === 1 ? [0, 255, 0] : [0, 0, 255];
  for (let i = 0; i < cut.w * cut.h; i++) {
    const a = out[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(out[i * 4 + c] * a + key[c] * (1 - a));
    out[i * 4 + 3] = 255;
  }
  return { w: cut.w, h: cut.h, rgba: out };
}

// front and back are the character's own pixels. Other views of a sheet are not used: the model is a
// plate, so it has no side to put them on. `pick` says which view is which (numbered from 1, back 0
// when there is none). Without it the usual order is assumed: front on the left, back on the right.
export function ownArt(img, keyChannel, scaleRgba, found = findViews(img), pick = null) {
  if (!found) return null;
  const crops = found.views.map((g) => cropView(img, found.label, g));
  const front = crops[(pick?.front || 1) - 1] || crops[0];
  const back = !found.sheet ? null : pick ? (crops[pick.back - 1] || null) : crops[crops.length - 1];
  const k = Math.min(FILL / Math.max(front.w, front.h, back?.w || 0, back?.h || 0), 2);
  const cut = onSquare(front, k, scaleRgba);
  return { cut, raw: onKey(cut, keyChannel), back: back ? onSquare(back, k, scaleRgba) : null, views: crops.length };
}
