// glb.mjs - pure-JS semi-3D plate GLB builder (server-side port of the Blender
// pipeline in pipeline/). Transparent RGBA art in -> GLB out with:
//   - silhouette plate (front = flooded opaque texture, rim/back = edge colour)
//   - contour eroded ~2px and the texture flooded with the edge colour, so rim
//     vertices never open a see-through hole into the plate's inside
//   - 3-joint squash & stretch rig (legs -> belly -> head, height smoothstep)
//   - named clips baked per frame, LINEAR: idle (first) / happy / surprised /
//     sad / angry / talk / dangle / land / zap
//   - a baked BlobShadow ground disc (the player recognises the name and
//     keeps it from casting a square shadow)
// No dependencies: the caller passes its PNG encoder (mcp.js has one).

const FPS = 24;
const FIG_H = 0.578;

// ---------- easing + timelines (same key schema as the Blender build) ----------
const EASE = {
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInQuad: (t) => t * t,
  easeInCubic: (t) => t * t * t,
  easeOutBack: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  hold: (t) => (t >= 1 ? 1 : 0),
};
function key(t, o = {}) {
  return { t, feet: 1, belly: 1, head: 1, posZ: 0, rotZ: 0, rotX: 90, legSwing: 0, posX: 0, ease: 'easeInOutSine', ...o };
}
function sampleKeys(keys, t) {
  const chans = ['feet', 'belly', 'head', 'posZ', 'rotZ', 'rotX', 'legSwing', 'posX'];
  if (t <= keys[0].t) { const d = {}; for (const c of chans) d[c] = keys[0][c]; return d; }
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t <= b.t) {
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      const e = (EASE[b.ease] || EASE.easeInOutSine)(u);
      const d = {}; for (const c of chans) d[c] = a[c] + (b[c] - a[c]) * e;
      return d;
    }
  }
  const d = {}; for (const c of chans) d[c] = keys[keys.length - 1][c]; return d;
}
function makeClips() {
  const idle = { dur: 2.4, keys: [
    key(0.00, { feet: 0.94, belly: 0.96, head: 0.98 }),
    key(0.60, { feet: 0.90, belly: 0.93, head: 0.96 }),
    key(1.10, { feet: 1.05, belly: 1.03, head: 1.01, posZ: 0.055, ease: 'easeOutQuad' }),
    key(1.55, { feet: 1.02, belly: 1.01, head: 1.00, posZ: 0.028 }),
    key(1.95, { feet: 0.97, belly: 0.98, head: 0.99 }),
    key(2.40, { feet: 0.94, belly: 0.96, head: 0.98 }),
  ] };
  const happy = { dur: 1.6, keys: [
    key(0.00, { feet: 0.94, belly: 0.96, head: 0.98 }),
    key(0.18, { feet: 0.76, belly: 0.84, head: 0.92, ease: 'easeInQuad' }),
    key(0.95, { feet: 1.13, belly: 1.09, head: 1.04, posZ: 0.300, rotZ: 360, ease: 'easeOutQuad' }),
    key(1.25, { feet: 0.98, belly: 0.99, head: 1.00, posZ: 0.020, rotZ: 360, ease: 'easeInQuad' }),
    key(1.45, { feet: 0.82, belly: 0.88, head: 0.94, rotZ: 360, ease: 'easeOutQuad' }),
    key(1.60, { feet: 0.94, belly: 0.96, head: 0.98, rotZ: 360 }),
  ] };
  const surprised = { dur: 1.3, keys: [
    key(0.00, { feet: 0.94, belly: 0.96, head: 0.98 }),
    key(0.10, { feet: 1.24, belly: 1.19, head: 1.11, posZ: 0.055, ease: 'easeOutQuad' }),
    key(0.75, { feet: 1.22, belly: 1.17, head: 1.10, posZ: 0.050 }),
    key(1.30, { feet: 0.94, belly: 0.96, head: 0.98 }),
  ] };
  const sad = { dur: 1.8, keys: [
    key(0.00, { feet: 0.94, belly: 0.96, head: 0.98 }),
    key(0.90, { feet: 0.80, belly: 0.85, head: 0.91, posZ: -0.012, rotX: 103 }),
    key(1.80, { feet: 0.79, belly: 0.84, head: 0.90, posZ: -0.012, rotX: 104 }),
  ] };
  const angryKeys = [key(0.00, { feet: 0.92, belly: 0.95, head: 0.97 })];
  { let tt = 0.12, flip = 1;
    while (tt < 1.02) {
      angryKeys.push(key(Math.round(tt * 1000) / 1000, {
        feet: flip > 0 ? 0.88 : 1.03, belly: flip > 0 ? 0.92 : 1.01, head: flip > 0 ? 0.95 : 1.0,
        posZ: (Math.abs(tt - 0.48) < 0.01 || Math.abs(tt - 0.96) < 0.01) ? 0.030 : 0.004,
        posX: 0.010 * flip, ease: 'easeInOutQuad' }));
      flip = -flip; tt += 0.12;
    } }
  angryKeys.push(key(1.20, { feet: 0.80, belly: 0.87, head: 0.93, ease: 'easeOutQuad' }));
  angryKeys.push(key(1.50, { feet: 0.92, belly: 0.95, head: 0.97 }));
  const talk = { dur: 1.6, keys: [
    key(0.00, { feet: 0.96, belly: 0.97, head: 0.99, posZ: 0.006 }),
    key(0.20, { feet: 1.01, belly: 1.00, head: 1.00, posZ: 0.016 }),
    key(0.40, { feet: 0.96, belly: 0.97, head: 0.99, posZ: 0.006 }),
    key(0.60, { feet: 1.01, belly: 1.00, head: 1.00, posZ: 0.016 }),
    key(0.80, { feet: 0.96, belly: 0.97, head: 0.99, posZ: 0.006 }),
    key(1.00, { feet: 1.01, belly: 1.00, head: 1.00, posZ: 0.016 }),
    key(1.20, { feet: 0.96, belly: 0.97, head: 0.99, posZ: 0.006 }),
    key(1.40, { feet: 1.00, belly: 0.99, head: 1.00, posZ: 0.012 }),
    key(1.60, { feet: 0.96, belly: 0.97, head: 0.99, posZ: 0.006 }),
  ] };
  const dangle = { dur: 1.6, keys: [
    key(0.00, { feet: 1.02, belly: 1.01, head: 1.00, rotZ: -5, legSwing: 22 }),
    key(0.40, { feet: 1.02, belly: 1.01, head: 1.00, rotZ: 0, legSwing: -22 }),
    key(0.80, { feet: 1.02, belly: 1.01, head: 1.00, rotZ: 5, legSwing: 22 }),
    key(1.20, { feet: 1.02, belly: 1.01, head: 1.00, rotZ: 0, legSwing: -22 }),
    key(1.60, { feet: 1.02, belly: 1.01, head: 1.00, rotZ: -5, legSwing: 22 }),
  ] };
  const land = { dur: 0.8, keys: [
    key(0.00, { feet: 0.64, belly: 0.72, head: 0.82 }),
    key(0.22, { feet: 1.10, belly: 1.06, head: 1.02, posZ: 0.018, ease: 'easeOutQuad' }),
    key(0.45, { feet: 0.90, belly: 0.93, head: 0.97 }),
    key(0.80, { feet: 0.94, belly: 0.96, head: 0.98 }),
  ] };
  const zapKeys = [key(0.00, { feet: 0.96, belly: 0.97, head: 0.99, posZ: 0.004, rotZ: 0 })];
  { let tt = 0.06, flip = 1;
    while (tt < 0.86) {
      zapKeys.push(key(Math.round(tt * 1000) / 1000, {
        feet: flip > 0 ? 0.93 : 1.05, belly: flip > 0 ? 0.95 : 1.03, head: flip > 0 ? 0.97 : 1.01,
        posZ: 0.010, rotZ: 3.5 * flip, ease: 'hold' }));
      flip = -flip; tt += 0.06;
    } }
  zapKeys.push(key(1.00, { feet: 0.94, belly: 0.96, head: 0.98, rotZ: 0 }));
  // idle first: the publish overlay plays animIndex 0.
  return { idle, happy, surprised, sad, angry: { dur: 1.5, keys: angryKeys }, talk, dangle, land, zap: { dur: 1.0, keys: zapKeys } };
}

// ---------- mask, contour, smoothing ----------
function erode(mask, w, h, iters) {
  let cur = mask;
  for (let k = 0; k < iters; k++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!cur[y * w + x]) continue;
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !cur[ny * w + nx]) { ok = false; break; }
      }
      out[y * w + x] = ok ? 1 : 0;
    }
    cur = out;
  }
  return cur;
}
// Crack-following on pixel edges -> closed loops in pixel-corner coordinates.
// Outer loops come out CCW in image space (y down); holes CW.
function traceLoops(mask, w, h) {
  const edges = new Map(); // "x,y" -> list of [nx, ny]
  const add = (x1, y1, x2, y2) => {
    const k = x1 + ',' + y1;
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push([x2, y2]);
  };
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    // directed edges keep the filled pixel on the left (image coords, y down)
    if (!inside(x, y - 1)) add(x, y, x + 1, y);         // top edge, left->right
    if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1); // right edge, top->bottom
    if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1); // bottom edge, right->left
    if (!inside(x - 1, y)) add(x, y + 1, x, y);         // left edge, bottom->top
  }
  const loops = [];
  while (edges.size) {
    const startKey = edges.keys().next().value;
    const [sx, sy] = startKey.split(',').map(Number);
    const loop = [[sx, sy]];
    let cx = sx, cy = sy;
    for (let guard = 0; guard < 1000000; guard++) {
      const k = cx + ',' + cy;
      const outs = edges.get(k);
      if (!outs || !outs.length) break;
      const [nx, ny] = outs.pop();
      if (!outs.length) edges.delete(k);
      if (nx === sx && ny === sy) break;
      loop.push([nx, ny]);
      cx = nx; cy = ny;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}
function signedArea(loop) {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) a += (loop[j][0] + loop[i][0]) * (loop[j][1] - loop[i][1]);
  return a / 2;
}
function simplifyClosed(loop, eps) {
  // Ramer-Douglas-Peucker on a closed loop: split at the topmost and
  // bottommost points and simplify each open half (a single-anchor pass
  // degenerates: the first chord has zero length and nothing ever splits).
  let top = 0, bot = 0;
  for (let i = 1; i < loop.length; i++) {
    if (loop[i][1] < loop[top][1]) top = i;
    if (loop[i][1] > loop[bot][1]) bot = i;
  }
  const chain = (from, to) => {
    const pts = [];
    for (let i = from; ; i = (i + 1) % loop.length) { pts.push(loop[i]); if (i === to) break; }
    return pts;
  };
  const dp = (pts) => {
    if (pts.length <= 2) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const dx = pts[b][0] - pts[a][0], dy = pts[b][1] - pts[a][1], len = Math.hypot(dx, dy) || 1;
      let maxD = 0, maxI = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((pts[i][0] - pts[a][0]) * dy - (pts[i][1] - pts[a][1]) * dx) / len;
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > eps && maxI > 0) { keep[maxI] = 1; stack.push([a, maxI], [maxI, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const half1 = dp(chain(top, bot));
  const half2 = dp(chain(bot, top));
  const out = [...half1.slice(0, -1), ...half2.slice(0, -1)];
  return out.length >= 3 ? out : loop;
}
function chaikinClosed(loop, iters) {
  let pts = loop;
  for (let k = 0; k < iters; k++) {
    const out = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j], b = pts[i];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    pts = out;
  }
  return pts;
}

// ---------- earcut triangulation (compact port of the Mapbox algorithm, MIT) ----------
function earcut(data, holeIndices, dim = 2) {
  const hasHoles = holeIndices && holeIndices.length;
  const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
  const outerNode = linkedList(data, 0, outerLen, dim, true);
  const triangles = [];
  if (!outerNode || outerNode.next === outerNode.prev) return triangles;
  // No z-curve hash: contours here are ~1-2k points, and the plain ear test
  // is fast enough (and far easier to trust than a hand-ported hash index).
  const minX = 0, minY = 0, invSize = undefined;
  if (hasHoles) eliminateHoles(data, holeIndices, outerNode, dim);
  earcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);
  return triangles;
}
function linkedList(data, start, end, dim, clockwise) {
  let last;
  if (clockwise === (signedAreaData(data, start, end, dim) > 0)) {
    for (let i = start; i < end; i += dim) last = insertNode(i / dim, data[i], data[i + 1], last);
  } else {
    for (let i = end - dim; i >= start; i -= dim) last = insertNode(i / dim, data[i], data[i + 1], last);
  }
  if (last && equals(last, last.next)) { removeNode(last); last = last.next; }
  return last;
}
function signedAreaData(data, start, end, dim) {
  let sum = 0;
  for (let i = start, j = end - dim; i < end; j = i, i += dim) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
  }
  return sum;
}
function insertNode(i, x, y, last) {
  const p = { i, x, y, prev: null, next: null, z: 0, prevZ: null, nextZ: null, steiner: false };
  if (!last) { p.prev = p; p.next = p; }
  else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p;
}
function removeNode(p) { p.next.prev = p.prev; p.prev.next = p.next; if (p.prevZ) p.prevZ.nextZ = p.nextZ; if (p.nextZ) p.nextZ.prevZ = p.prevZ; }
function equals(p1, p2) { return p1.x === p2.x && p1.y === p2.y; }
function filterPoints(start, end) {
  if (!start) return start;
  if (!end) end = start;
  let p = start, again;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p); p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else p = p.next;
  } while (again || p !== end);
  return end;
}
function area(p, q, r) { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }
function earcutLinked(ear, triangles, dim, minX, minY, invSize, pass) {
  if (!ear) return;
  if (!pass && invSize) indexCurve(ear, minX, minY, invSize);
  let stop = ear, part;
  while (ear.prev !== ear.next) {
    const prev = ear.prev, next = ear.next;
    if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
      triangles.push(prev.i, ear.i, next.i);
      removeNode(ear);
      ear = next.next; stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) earcutLinked(filterPoints(ear), triangles, dim, minX, minY, invSize, 1);
      else if (pass === 1) { part = cureLocalIntersections(ear, triangles, dim); earcutLinked(part, triangles, dim, minX, minY, invSize, 2); }
      else if (pass === 2) splitEarcut(ear, triangles, dim, minX, minY, invSize);
      break;
    }
  }
}
function isEar(ear) {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;
  let p = ear.next.next;
  while (p !== ear.prev) {
    if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}
function isEarHashed(ear, minX, minY, invSize) {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;
  const minTX = Math.min(a.x, b.x, c.x), minTY = Math.min(a.y, b.y, c.y);
  const minZ = curveZ(minTX, minTY, minX, minY, invSize), maxZ = curveZ(Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y), minX, minY, invSize);
  let p = ear.prevZ, n = ear.nextZ;
  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (p !== ear.prev && p !== ear.next && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.prevZ;
    if (p && p.z >= minZ) continue;
    p = n;
    while (p && p.z <= maxZ) {
      if (p !== ear.prev && p !== ear.next && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
      p = p.nextZ;
    }
    break;
  }
  return true;
}
function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 &&
         (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 &&
         (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0;
}
function cureLocalIntersections(start, triangles, dim) {
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);
      removeNode(p); removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}
function intersects(p1, q1, p2, q2) {
  const o1 = sign(area(p1, q1, p2)), o2 = sign(area(p1, q1, q2)), o3 = sign(area(p2, q2, p1)), o4 = sign(area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}
function onSegment(p, q, r) { return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y); }
function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
function locallyInside(a, b) {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}
function splitEarcut(start, triangles, dim, minX, minY, invSize) {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        a = filterPoints(a, a.next);
        c = filterPoints(c, c.next);
        earcutLinked(a, triangles, dim, minX, minY, invSize, 0);
        earcutLinked(c, triangles, dim, minX, minY, invSize, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}
function isValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
     (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0) || equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0);
}
function intersectsPolygon(a, b) {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}
function middleInside(a, b) {
  let p = a, inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if ((p.y > py) !== (p.next.y > py) && p.next.y !== p.y &&
        px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}
function splitPolygon(a, b) {
  const a2 = insertNode(a.i, a.x, a.y, null), b2 = insertNode(b.i, b.x, b.y, null);
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}
function eliminateHoles(data, holeIndices, outerNode, dim) {
  const queue = [];
  for (let i = 0, len = holeIndices.length; i < len; i++) {
    const start = holeIndices[i] * dim, end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
    const list = linkedList(data, start, end, dim, false);
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort((a, b) => a.x - b.x);
  for (const hole of queue) outerNode = eliminateHole(hole, outerNode);
  return outerNode;
}
function eliminateHole(hole, outerNode) {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = splitPolygon(bridge, hole);
  filterPoints(bridgeReverse, bridgeReverse.next);
  return filterPoints(bridge, bridge.next);
}
function findHoleBridge(hole, outerNode) {
  let p = outerNode, hx = hole.x, hy = hole.y, qx = -Infinity, segment;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) { qx = x; segment = p; if (x === hx) return p; }
    }
    p = p.next;
  } while (p !== outerNode);
  if (!segment) return null;
  const stop = segment, tanPrev = area(hole, segment.prev, hole) < 0 ? segment.prev : null;
  p = segment.next;
  let mx = segment.x, my = segment.y, tan = Infinity, bridge = segment;
  if (qx === hx) return bridge;
  while (p !== stop) {
    const d = (hx - p.x) * (hx - p.x) + (hy - p.y) * (hy - p.y);
    if (hy >= p.y && hy <= p.next.y || hy >= p.next.y && hy <= p.y) {
      // candidate must be visible from the hole point
    }
    if (p.x >= qx && p.x <= hx && d < Infinity) {
      // keep the closest point inside the triangle hole-segment-candidate
    }
    p = p.next;
  }
  // Simpler robust bridge: closest outer vertex visible from the hole point.
  let best = null, bestD = Infinity;
  p = outerNode;
  do {
    const ddx = p.x - hx, ddy = p.y - hy, d = ddx * ddx + ddy * ddy;
    if (d < bestD && !intersectsPolygonPoint(outerNode, hx, hy, p)) { bestD = d; best = p; }
    p = p.next;
  } while (p !== outerNode);
  return best || segment;
}
function intersectsPolygonPoint(outerNode, hx, hy, target) {
  let p = outerNode;
  const from = { x: hx, y: hy, prev: null, next: null };
  const to = { x: target.x, y: target.y, prev: null, next: null };
  do {
    if (p !== target && p.next !== target && intersects(p, p.next, from, to)) return true;
    p = p.next;
  } while (p !== outerNode);
  return false;
}
function getLeftmost(start) {
  let p = start, leftmost = start;
  do { if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p; p = p.next; } while (p !== start);
  return leftmost;
}
function indexCurve(start, minX, minY, invSize) {
  let p = start;
  do { p.z = curveZ(p.x, p.y, minX, minY, invSize); p.prevZ = p.prev; p.nextZ = p.next; p = p.next; } while (p !== start);
  // insertion sort by z
  let sorted = start;
  p = start.next;
  while (p !== start) {
    const next = p.next;
    if (p.z < sorted.z) { p.prev.next = p.next; p.next.prev = p.prev; p.next = sorted; p.prev = sorted.prev; sorted.prev.next = p; sorted.prev = p; sorted = p; }
    p = next;
  }
  // fix prevZ/nextZ links in sorted order
  let q = sorted;
  do { q.prevZ = q.prev; q.nextZ = q.next; q = q.next; } while (q !== sorted);
  return sorted;
}
function curveZ(x, y, minX, minY, invSize) {
  let vx = (x - minX) * invSize | 0, vy = (y - minY) * invSize | 0;
  vx = (vx | (vx << 8)) & 0x00FF00FF; vx = (vx | (vx << 4)) & 0x0F0F0F0F; vx = (vx | (vx << 2)) & 0x33333333; vx = (vx | (vx << 1)) & 0x55555555;
  vy = (vy | (vy << 8)) & 0x00FF00FF; vy = (vy | (vy << 4)) & 0x0F0F0F0F; vy = (vy | (vy << 2)) & 0x33333333; vy = (vy | (vy << 1)) & 0x55555555;
  return vx + (vy << 1);
}

// ---------- GLB assembly ----------
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function quatAxisAngle(ax, ay, az, deg) {
  const rad = (deg * Math.PI) / 180, s = Math.sin(rad / 2);
  return [ax * s, ay * s, az * s, Math.cos(rad / 2)];
}
function quatMul(q1, q2) { // q1 * q2
  const [x1, y1, z1, w1] = q1, [x2, y2, z2, w2] = q2;
  return [w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
          w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
          w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
          w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2];
}

const DBG = typeof process !== 'undefined' && process.env && process.env.GLB_DEBUG;
export function buildGlb({ rgba, w, h, encodePng, name = 'character' }) {
  const _t0 = Date.now(); const _lap = (s) => { if (DBG) console.log('[glb]', s, Date.now() - _t0, 'ms'); };
  if (!rgba || rgba.length < w * h * 4) throw new Error('rgba size mismatch');
  // mask from alpha, largest-component cleanup is skipped (server art is clean)
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = rgba[i * 4 + 3] > 127 ? 1 : 0;
  // edge colour: median RGB of opaque pixels touching transparency (pre-erosion)
  const edgePx = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (!mask[y * w + Math.max(0, x - 1)] || !mask[y * w + Math.min(w - 1, x + 1)] ||
        !mask[Math.max(0, y - 1) * w + x] || !mask[Math.min(h - 1, y + 1) * w + x]) {
      edgePx.push([rgba[(y * w + x) * 4], rgba[(y * w + x) * 4 + 1], rgba[(y * w + x) * 4 + 2]]);
    }
  }
  edgePx.sort((a, b) => a[0] - b[0]);
  const med = edgePx.length ? edgePx[edgePx.length >> 1] : [70, 45, 15];
  const edgeSrgb = [med[0] / 255, med[1] / 255, med[2] / 255];
  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const edgeLin = [...edgeSrgb.map(toLin), 1];
  // erode ~2px, then bbox of the eroded mask
  mask = erode(mask, w, h, 2);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error('empty silhouette');
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  // flooded, cropped, fully opaque texture
  const tex = new Uint8Array(bw * bh * 4);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const si = ((y0 + y) * w + (x0 + x)) * 4, di = (y * bw + x) * 4;
    const a = rgba[si + 3] / 255;
    tex[di] = Math.round(rgba[si] * a + med[0] * (1 - a));
    tex[di + 1] = Math.round(rgba[si + 1] * a + med[1] * (1 - a));
    tex[di + 2] = Math.round(rgba[si + 2] * a + med[2] * (1 - a));
    tex[di + 3] = 255;
  }
  _lap('mask+erode+flood');
  const texPng = encodePng(bw, bh, Buffer.from(tex));
  // contours from the eroded mask (cropped space), simplified + Chaikin x2
  const loopsPx = traceLoops(mask, w, h)
    .map((loop) => loop.map(([x, y]) => [x - x0, y - y0]))
    .filter((loop) => loop.length >= 8);
  if (!loopsPx.length) throw new Error('no contour');
  const loops = loopsPx.map((loop) => {
    const area = signedArea(loop);
    const sm = chaikinClosed(simplifyClosed(loop, 1.1), 2);
    return { pts: sm, area, hole: area > 0 }; // image space: outer CCW has negative signedArea with the formula above? resolved below
  });
  // In image coordinates (y down) with our signedArea (shoelace variant), the
  // outer loop of crack-following has area > 0 and holes < 0. Normalise:
  let outerIdx = 0;
  loops.forEach((L, i) => { if (Math.abs(L.area) > Math.abs(loops[outerIdx].area)) outerIdx = i; });
  loops.forEach((L, i) => { L.hole = i !== outerIdx; });
  // world transform: bbox height -> FIG_H, base at y=0, x centred
  const scale = FIG_H / bh, thick = FIG_H / 15;
  const toWorld = ([px, py]) => [(px - bw / 2) * scale, (bh - py) * scale];
  const outer = loops[outerIdx].pts.map(toWorld);
  const holes = loops.filter((L) => L.hole).map((L) => L.pts.map(toWorld));
  // earcut wants the flat array + hole start indices (point counts)
  const flat = [];
  const holeIdx = [];
  outer.forEach((p) => flat.push(p[0], p[1]));
  for (const hole of holes) { holeIdx.push(flat.length / 2); hole.forEach((p) => flat.push(p[0], p[1])); }
  const allPts = [outer, ...holes];
  _lap('contour+smooth');
  const capTris = earcut(flat, holeIdx.length ? holeIdx : null, 2);
  // vertices: front ring (z=0), back ring (z=-thick), wall rings (own normals)
  const pos = [], nor = [], uv = [], jnt = [], wgt = [];
  const H = FIG_H, J = 0.012 * H;
  const weightsFor = (wy) => {
    const sHip = smoothstep(0.50 * H - 1.6 * J, 0.50 * H + 1.6 * J, wy);
    const wh = smoothstep(0.55 * H, 0.75 * H, wy);
    return [1 - sHip, Math.max(0, sHip - wh), wh, 0];
  };
  const pushVert = (x, y, z, nx, ny, nz, u, v, wts) => {
    pos.push(x, y, z); nor.push(nx, ny, nz); uv.push(u, v);
    jnt.push(0, 1, 2, 0); wgt.push(wts[0], wts[1], wts[2], wts[3]);
    return pos.length / 3 - 1;
  };
  const ringStart = [];
  { let s = 0; for (const ring of allPts) { ringStart.push(s); s += ring.length; } }
  const totalPts = ringStart[ringStart.length - 1] + allPts[allPts.length - 1].length;
  const frontBase = 0, backBase = totalPts, wallBase = totalPts * 2;
  for (let r = 0; r < allPts.length; r++) {
    const ring = allPts[r];
    for (let i = 0; i < ring.length; i++) {
      const [wx, wy] = ring[i];
      const u = (wx / scale + bw / 2) / bw, v = (bh - wy / scale) / bh; // glTF: v=0 is the image top row
      pushVert(wx, wy, 0, 0, 0, 1, u, v, weightsFor(wy));
    }
  }
  for (let r = 0; r < allPts.length; r++) {
    const ring = allPts[r];
    for (let i = 0; i < ring.length; i++) {
      const [wx, wy] = ring[i];
      pushVert(wx, wy, -thick, 0, 0, -1, 0, 0, weightsFor(wy));
    }
  }
  const frontIdx = [], edgeIdx = [];
  for (let i = 0; i < capTris.length; i += 3) {
    frontIdx.push(frontBase + capTris[i], frontBase + capTris[i + 1], frontBase + capTris[i + 2]);
    edgeIdx.push(backBase + capTris[i + 2], backBase + capTris[i + 1], backBase + capTris[i]);
  }
  // walls: duplicate rings with radial normals
  const wallIndex = [];
  for (let r = 0; r < allPts.length; r++) {
    const ring = allPts[r], start = wallBase + ringStart[r] * 2;
    wallIndex.push(start);
    for (let i = 0; i < ring.length; i++) {
      const [wx, wy] = ring[i];
      const [px2, py2] = ring[(i + 1) % ring.length], [qx2, qy2] = ring[(i - 1 + ring.length) % ring.length];
      let tx = px2 - qx2, ty = py2 - qy2;
      let nx = ty, ny = -tx; // outward for CCW-in-world rings; flipped for holes below
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      if (loops[r].hole) { nx = -nx; ny = -ny; }
      const wts = weightsFor(wy);
      pushVert(wx, wy, 0, nx, ny, 0, 0, 0, wts);
      pushVert(wx, wy, -thick, nx, ny, 0, 0, 0, wts);
    }
  }
  for (let r = 0; r < allPts.length; r++) {
    const ring = allPts[r], start = wallIndex[r];
    for (let i = 0; i < ring.length; i++) {
      const a0 = start + i * 2, b0 = start + ((i + 1) % ring.length) * 2;
      if (!loops[r].hole) edgeIdx.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1);
      else edgeIdx.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
    }
  }
  _lap('earcut');
  // blob shadow geometry (own mesh, unskinned)
  const blobSize = FIG_H * 1.09;
  const bpos = [], bnor = [], buv = [], bidx = [0, 2, 1, 0, 3, 2]; // wound so the face normal is +Y (visible from above)
  [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].forEach(([sx, sz], i) => {
    bpos.push(sx * blobSize, 0.003, sz * blobSize); bnor.push(0, 1, 0); buv.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0);
  });
  const S = 256, blobRgba = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
    const r = Math.sqrt(dx * dx + dy * dy);
    const a = Math.pow(Math.max(0, 1 - r), 2) * 0.62;
    const di = (y * S + x) * 4;
    blobRgba[di + 3] = Math.round(a * 255);
  }
  const blobPng = encodePng(S, S, Buffer.from(blobRgba));

  // ---------- binary + JSON ----------
  const binParts = [];
  let binLen = 0;
  const addBuf = (buf, target) => {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) { binParts.push(Buffer.alloc(pad)); binLen += pad; }
    const off = binLen;
    binParts.push(buf); binLen += buf.length;
    return { buffer: 0, byteOffset: off, byteLength: buf.length, ...(target ? { target } : {}) };
  };
  const f32 = (arr) => { const b = Buffer.alloc(arr.length * 4); arr.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
  const u16 = (arr) => { const b = Buffer.alloc(arr.length * 2); arr.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; };
  const u32 = (arr) => { const b = Buffer.alloc(arr.length * 4); arr.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
  const bufferViews = [], accessors = [];
  const acc = (buf, type, comp, count, min, max) => {
    bufferViews.push(addBuf(buf));
    const a = { bufferView: bufferViews.length - 1, componentType: comp, count, type };
    if (min) a.min = min; if (max) a.max = max;
    accessors.push(a); return accessors.length - 1;
  };
  const minMax3 = (arr) => { const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) { if (arr[i + k] < mn[k]) mn[k] = arr[i + k]; if (arr[i + k] > mx[k]) mx[k] = arr[i + k]; } return [mn, mx]; };
  const [pmn, pmx] = minMax3(pos);
  const aPos = acc(f32(pos), 'VEC3', 5126, pos.length / 3, pmn, pmx);
  const aNor = acc(f32(nor), 'VEC3', 5126, nor.length / 3);
  const aUv = acc(f32(uv), 'VEC2', 5126, uv.length / 2);
  const aJnt = acc(u16(jnt), 'VEC4', 5123, jnt.length / 4);
  const aWgt = acc(f32(wgt), 'VEC4', 5126, wgt.length / 4);
  const aIdxF = acc(u32(frontIdx), 'SCALAR', 5125, frontIdx.length);
  const aIdxE = acc(u32(edgeIdx), 'SCALAR', 5125, edgeIdx.length);
  const [bmn, bmx] = minMax3(bpos);
  const aBPos = acc(f32(bpos), 'VEC3', 5126, 4, bmn, bmx);
  const aBNor = acc(f32(bnor), 'VEC3', 5126, 4);
  const aBUv = acc(f32(buv), 'VEC2', 5126, 4);
  const aBIdx = acc(u16(bidx), 'SCALAR', 5123, 6);
  // inverse bind matrices: joints at (0,0,0), (0,0.50H,0), (0,0.64H,0) world
  const ibm = [];
  for (const jy of [0, 0.50 * H, 0.64 * H]) {
    ibm.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -jy, 0, 1);
  }
  const aIbm = acc(f32(ibm), 'MAT4', 5126, 3);
  bufferViews[bufferViews.length - 1].byteStride = undefined;
  const img0View = bufferViews.length; bufferViews.push(addBuf(texPng));
  const img1View = bufferViews.length; bufferViews.push(addBuf(blobPng));

  // animations
  const clips = makeClips();
  const animations = [];
  for (const [clipName, clip] of Object.entries(clips)) {
    const frames = Math.floor(clip.dur * FPS) + 1;
    const times = [], rigT = [], rigR = [], legsS = [], bellyS = [], headS = [], legsR = [];
    for (let f = 0; f < frames; f++) {
      const t = f / FPS, v = sampleKeys(clip.keys, t);
      times.push(t);
      rigT.push(v.posX * H, v.posZ * H, 0);
      const qYaw = quatAxisAngle(0, 1, 0, v.rotZ);
      const qPitch = quatAxisAngle(1, 0, 0, v.rotX - 90);
      rigR.push(...quatMul(qYaw, qPitch));
      for (const [arr, sy] of [[legsS, v.feet], [bellyS, v.belly], [headS, v.head]]) {
        const sx = 1 / Math.sqrt(sy); arr.push(sx, sy, sx);
      }
      legsR.push(...quatAxisAngle(1, 0, 0, v.legSwing));
    }
    const samplers = [], channels = [];
    const samp = (arr, type, target, path) => {
      const input = acc(f32(times), 'SCALAR', 5126, frames, [0], [clip.dur]);
      const output = acc(f32(arr), type, 5126, frames);
      samplers.push({ input, output, interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: target, path } });
    };
    samp(rigT, 'VEC3', 1, 'translation');
    samp(rigR, 'VEC4', 1, 'rotation');
    samp(legsS, 'VEC3', 2, 'scale');
    samp(legsR, 'VEC4', 2, 'rotation');
    samp(bellyS, 'VEC3', 3, 'scale');
    samp(headS, 'VEC3', 4, 'scale');
    animations.push({ name: clipName, samplers, channels });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'AR Creator glb.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: name + '_root', children: [1, 5] },
      { name: name + '_rig', children: [2, 6] },
      { name: 'legs', translation: [0, 0, 0], children: [3] },
      { name: 'belly', translation: [0, 0.50 * H, 0], children: [4] },
      { name: 'head', translation: [0, 0.14 * H, 0] },
      { name: 'BlobShadow', mesh: 1 },
      { name, mesh: 0, skin: 0 },
    ],
    meshes: [
      { name: 'plate', primitives: [
        { attributes: { POSITION: aPos, NORMAL: aNor, TEXCOORD_0: aUv, JOINTS_0: aJnt, WEIGHTS_0: aWgt }, indices: aIdxF, material: 0 },
        { attributes: { POSITION: aPos, NORMAL: aNor, TEXCOORD_0: aUv, JOINTS_0: aJnt, WEIGHTS_0: aWgt }, indices: aIdxE, material: 1 },
      ] },
      { name: 'blob', primitives: [
        { attributes: { POSITION: aBPos, NORMAL: aBNor, TEXCOORD_0: aBUv }, indices: aBIdx, material: 2 },
      ] },
    ],
    skins: [{ inverseBindMatrices: aIbm, joints: [2, 3, 4], skeleton: 2 }],
    materials: [
      { name: 'Artwork', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: 0.5, metallicFactor: 0 },
        emissiveTexture: { index: 0 }, emissiveFactor: [0.5, 0.5, 0.5] },
      { name: 'EdgeSolid', pbrMetallicRoughness: { baseColorFactor: edgeLin, roughnessFactor: 0.34, metallicFactor: 0 },
        emissiveFactor: [edgeLin[0] * 0.18, edgeLin[1] * 0.18, edgeLin[2] * 0.18] },
      { name: 'BlobShadow', pbrMetallicRoughness: { baseColorTexture: { index: 1 }, baseColorFactor: [0, 0, 0, 1], roughnessFactor: 1, metallicFactor: 0 },
        alphaMode: 'BLEND' },
    ],
    textures: [{ source: 0 }, { source: 1 }],
    images: [
      { bufferView: img0View, mimeType: 'image/png' },
      { bufferView: img1View, mimeType: 'image/png' },
    ],
    bufferViews, accessors, animations,
    buffers: [{ byteLength: binLen }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf-8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + binLen;
  const head = Buffer.alloc(12 + 8);
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  head.writeUInt32LE(jsonBuf.length + jsonPad, 12); head.write('JSON', 16);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binLen, 0); binHead.write('BIN\0', 4);
  _lap('geometry+animations');
  const glb = Buffer.concat([head, jsonBuf, Buffer.alloc(jsonPad, 0x20), binHead, ...binParts]);
  return { glb, aspect: bw / bh, edgeColor: edgeSrgb };
}
