// Screenshot and video capture with native APIs only.
// screenshot(): call it in the same task as the frame's last draw (main does, right after post.render).
// toBlob snapshots the canvas synchronously, so the drawing buffer is still there and the renderer
// doesn't need preserveDrawingBuffer (which would cost a copy every frame).

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function screenshot(canvas, name = `ultra-elements-${stamp()}`) {
  canvas.toBlob((blob) => blob && download(blob, `${name}.png`), 'image/png');
}

// canvas.captureStream + MediaRecorder: H.264 MP4 where supported (Chrome 126+, plays anywhere), else VP9 /
// VP8 WebM; the file downloads on stop(). High bitrate because particles and noise are the worst case for an encoder.
// start(name, overlays) films a 2D canvas instead: the WebGL frame with those DOM elements painted on top
// (the reel's caption and lab panel). frame() copies each frame across, so call it right after the frame's
// last draw. Chrome's own tab capture would do this too, but at about 2 Mbps. start(..., true) takes a frame only
// when frame() asks (captureStream(0) + requestFrame): one per rendered frame, for footage stepped at a fixed rate.
export function createRecorder(canvas, fps = 60) {
  const ok = typeof MediaRecorder !== 'undefined' && !!canvas.captureStream;
  const mimeType = ok ? ['video/mp4;codecs=avc1.640033', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) : undefined;
  let rec = null, comp = null, ctx = null, layers = [], track = null;
  return {
    supported: ok,
    get recording() { return rec !== null; },
    start(name = `ultra-elements-${stamp()}`, overlays = null, manual = false) {
      if (rec || !ok) return;
      if (overlays) {
        comp = Object.assign(document.createElement('canvas'), { width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio });
        ctx = comp.getContext('2d');
        layers = overlays;
      }
      const chunks = [], stream = (comp ?? canvas).captureStream(manual ? 0 : fps);
      track = manual ? stream.getVideoTracks()[0] : null;
      const rec0 = rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 40e6 });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec0.mimeType.split(';')[0] || 'video/webm';
        download(new Blob(chunks, { type }), `${name}.${type === 'video/mp4' ? 'mp4' : 'webm'}`);
      };
      rec.start(1000); // 1 s chunks: a long take never sits in one giant buffer
      return new Promise((r) => { rec0.onstart = r; });   // the encoder is up: frames sent before this can be lost
    },
    stop() {
      if (!rec) return;
      rec.stop();
      rec = comp = ctx = track = null;
    },
    frame() {
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(canvas, 0, 0, comp.width, comp.height);
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        for (const el of layers) paint(ctx, el, 1);
      }
      track?.requestFrame();
    },
  };
}

// Paints an element's subtree the way it looks on screen, for the few things the overlays use: background
// boxes, borders (lil-gui's slider knobs are one), text (font, colour, spacing, upper case, first
// text-shadow) and input values. Not a general HTML renderer: no radii, images or pseudo-elements.
const range = document.createRange();
function paint(ctx, el, alpha) {
  const cs = getComputedStyle(el), a = alpha * +cs.opacity;
  if (cs.display === 'none' || cs.visibility === 'hidden' || a < 0.01) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  ctx.globalAlpha = a;
  if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') { ctx.fillStyle = cs.backgroundColor; ctx.fillRect(r.x, r.y, r.width, r.height); }
  const bw = (side) => (cs[`border${side}Style`] === 'none' ? 0 : parseFloat(cs[`border${side}Width`]));
  const L = bw('Left'), R = bw('Right'), T = bw('Top'), B = bw('Bottom');
  for (const [side, x, y, w, h] of [['Left', r.x, r.y, L, r.height], ['Right', r.right - R, r.y, R, r.height], ['Top', r.x, r.y, r.width, T], ['Bottom', r.x, r.bottom - B, r.width, B]]) {
    if (w > 0 && h > 0) { ctx.fillStyle = cs[`border${side}Color`]; ctx.fillRect(x, y, w, h); }
  }
  if (el instanceof HTMLInputElement) text(ctx, el.value, cs, r.x + parseFloat(cs.paddingLeft), r.y + r.height / 2);
  for (const n of el.childNodes) {
    if (n.nodeType === Node.ELEMENT_NODE) paint(ctx, n, a);
    else if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) {
      range.selectNodeContents(n);
      const t = range.getBoundingClientRect();
      ctx.globalAlpha = a;
      text(ctx, n.textContent.trim(), cs, t.x, t.y + t.height / 2);
    }
  }
}
function text(ctx, s, cs, x, y) {
  const sh = cs.textShadow.match(/^(rgba?\([^)]*\)) (-?[\d.]+)px (-?[\d.]+)px ([\d.]+)px/);
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  ctx.fillStyle = cs.color;
  ctx.textBaseline = 'middle';
  [ctx.shadowColor, ctx.shadowOffsetX, ctx.shadowOffsetY, ctx.shadowBlur] = sh ? [sh[1], +sh[2], +sh[3], +sh[4]] : ['transparent', 0, 0, 0];
  ctx.fillText(cs.textTransform === 'uppercase' ? s.toUpperCase() : s, x, y);
  ctx.shadowColor = 'transparent';
}
