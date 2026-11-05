// A clean white page gives its own pixels: one shape is one drawing, shapes side by side are a sheet.
import assert from 'node:assert/strict';
import { findViews, ownArt } from '../api/sheet.mjs';

const page = (w, h, boxes, paper = [255, 255, 255]) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([...paper, 255], i * 4);
  for (const [x0, y0, x1, y1, c] of boxes) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([...c, 255], (y * w + x) * 4);
  return { w, h, rgba };
};
const scale = (img, tw, th) => {
  const rgba = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const s = (Math.floor(y * img.h / th) * img.w + Math.floor(x * img.w / tw)) * 4;
    rgba.set(img.rgba.subarray(s, s + 4), (y * tw + x) * 4);
  }
  return { w: tw, h: th, rgba };
};
const RED = [200, 40, 40], BLUE = [40, 40, 200], GREY = [90, 90, 90];

// Three views and a small caption: the caption is not a view, the back is the last one.
const sheet = page(300, 120, [[10, 10, 70, 100, RED], [120, 10, 170, 100, GREY], [220, 10, 280, 100, BLUE], [230, 106, 250, 112, GREY]]);
const found = findViews(sheet);
assert.equal(found.sheet, true);
assert.equal(found.views.length, 3);
const art = ownArt(sheet, 1, scale);
assert.equal(art.views, 3);
assert.ok(art.back, 'a sheet gives the back');
const centre = (img) => img.rgba.subarray((512 * img.w + 512) * 4, (512 * img.w + 512) * 4 + 4);
assert.deepEqual([...centre(art.cut)], [...RED, 255], 'the front is the first view, unchanged');
assert.deepEqual([...centre(art.back)], [...BLUE, 255], 'the back is the last view, unchanged');
assert.deepEqual([...art.raw.rgba.subarray(0, 4)], [0, 255, 0, 255], 'the raw copy stands on the key colour');
assert.equal(art.cut.rgba[3], 0, 'around the character is transparent');

// One drawing with a small floating part stays one drawing, and the part stays with it.
const single = ownArt(page(200, 200, [[50, 60, 150, 180, RED], [90, 20, 110, 40, BLUE]]), 1, scale);
assert.equal(single.views, 1);
assert.equal(single.back, null, 'one drawing has no back of its own');

// A photo or a coloured page is not cut by colour.
assert.equal(findViews(page(100, 100, [[20, 20, 80, 80, RED]], [120, 90, 60])), null);
console.log('sheet checks passed');
