// Cozy: the shared look of the Hand Play UI - warm cream paper, cocoa-brown text, soft pastel accents,
// a rounded font, stitched edges and name tags. One place for colours, the font and canvas helpers,
// so the status panel, floating buttons, dialogue cards and game screens read as one family.

export const C = {
  paper: '#fff8e7', paper2: '#fdf0d2', line: '#e9dcc0', stitch: '#dccaa4',
  ink: '#6b5340', inkDark: '#4f3b2b', shadow: 'rgba(92, 66, 44, 0.28)',
  leaf: '#8fcf6e', leafDark: '#5c9e45', sky: '#7ec8ea', skyDark: '#4a9fca',
  peach: '#ffb98a', peachDark: '#f08a4b', pink: '#f7a3bd', pinkDark: '#e46f93',
  sun: '#ffd95c', sunDark: '#e8b52a', tag: '#f59e4c',
}
export const FONT = '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Hiragino Sans", "Arial Rounded MT Bold", sans-serif'
export const font = (w, px) => `${w} ${px}px ${FONT}`

// the rounded font (Google Fonts is allowed by the AR pages' CSP); resolves when ready (or after 3 s)
let fontReady = null
export function loadFont() {
  if (fontReady) return fontReady
  if (!document.getElementById('cozy-font')) {
    const l = document.createElement('link'); l.id = 'cozy-font'; l.rel = 'stylesheet'
    l.href = 'https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@500;700;800;900&display=swap'
    document.head.appendChild(l)
  }
  fontReady = Promise.race([
    Promise.all([document.fonts.load(font(800, 20), 'あA1'), document.fonts.load(font(900, 20), 'あA1'), document.fonts.load(font(700, 20), 'あA1')]),
    new Promise((r) => setTimeout(r, 3000)),
  ]).catch(() => {})
  return fontReady
}

export function roundRect(x, x0, y0, w, h, r) {
  x.beginPath(); x.moveTo(x0 + r, y0); x.arcTo(x0 + w, y0, x0 + w, y0 + h, r); x.arcTo(x0 + w, y0 + h, x0, y0 + h, r)
  x.arcTo(x0, y0 + h, x0, y0, r); x.arcTo(x0, y0, x0 + w, y0, r); x.closePath()
}
// cream card with a soft drop shadow and a stitched (dashed) inner edge
export function card(x, x0, y0, w, h, r, fill = C.paper) {
  x.save(); x.shadowColor = C.shadow; x.shadowBlur = 16; x.shadowOffsetY = 6
  x.fillStyle = fill; roundRect(x, x0, y0, w, h, r); x.fill(); x.restore()
  x.save(); x.setLineDash([10, 8]); x.lineWidth = 3; x.strokeStyle = C.stitch
  roundRect(x, x0 + 9, y0 + 9, w - 18, h - 18, Math.max(4, r - 9)); x.stroke(); x.restore()
}
// a slightly tilted name tag
export function tag(x, cx, cy, text, px = 30, fill = C.tag) {
  x.save(); x.font = font(900, px)
  const w = x.measureText(text).width + px * 1.2, h = px * 1.55
  x.translate(cx, cy); x.rotate(-0.06)
  x.shadowColor = C.shadow; x.shadowBlur = 6; x.shadowOffsetY = 3
  x.fillStyle = fill; roundRect(x, -w / 2, -h / 2, w, h, h / 2); x.fill()
  x.shadowColor = 'transparent'; x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'
  x.fillText(text, 0, 1); x.restore()
  return w
}
// a leaf badge (level)
export function leaf(x, cx, cy, s, fill = C.leaf, dark = C.leafDark) {
  x.save(); x.translate(cx, cy); x.rotate(-0.5)
  x.fillStyle = fill; x.strokeStyle = dark; x.lineWidth = s * 0.08
  x.beginPath(); x.moveTo(-s, 0); x.quadraticCurveTo(0, -s * 0.95, s, 0); x.quadraticCurveTo(0, s * 0.95, -s, 0); x.closePath(); x.fill(); x.stroke()
  x.beginPath(); x.moveTo(-s * 0.85, 0); x.lineTo(s * 0.8, 0); x.stroke()
  x.restore()
}
// a rounded gauge on a beige track
export function gauge(x, x0, y0, w, h, v, fill, dark) {
  x.fillStyle = C.line; roundRect(x, x0, y0, w, h, h / 2); x.fill()
  const fw = Math.max(h, w * Math.max(0, Math.min(1, v)))
  const g = x.createLinearGradient(0, y0, 0, y0 + h); g.addColorStop(0, fill); g.addColorStop(1, dark)
  x.fillStyle = g; roundRect(x, x0, y0, fw, h, h / 2); x.fill()
  x.fillStyle = 'rgba(255,255,255,0.45)'; roundRect(x, x0 + h * 0.3, y0 + h * 0.18, Math.max(0, fw - h * 0.6), h * 0.26, h * 0.13); x.fill()
}

// page CSS shared by the DOM parts (dialogue cards, game screens, toasts)
export const CSS = `
.cz-card{background:${C.paper};color:${C.ink};border-radius:26px;box-shadow:0 8px 22px ${C.shadow};font-family:${FONT};font-weight:700}
.cz-stitch{position:relative}
.cz-stitch:before{content:"";position:absolute;inset:7px;border:2.5px dashed ${C.stitch};border-radius:20px;pointer-events:none}
.cz-tag{position:absolute;left:14px;top:-15px;transform:rotate(-4deg);background:${C.tag};color:#fff;font:900 14px/1 ${FONT};padding:7px 14px;border-radius:999px;box-shadow:0 3px 8px ${C.shadow};white-space:nowrap}
.cz-next{position:absolute;right:16px;bottom:8px;color:${C.tag};font-size:12px;animation:czb 1s infinite}
@keyframes czb{0%,100%{transform:translateY(0);opacity:1}50%{transform:translateY(3px);opacity:.5}}
.cz-btn{border:0;border-radius:999px;padding:11px 18px;font:900 15px/1 ${FONT};cursor:pointer;box-shadow:0 4px 0 rgba(0,0,0,.12)}
.cz-btn:active{transform:translateY(2px);box-shadow:0 2px 0 rgba(0,0,0,.12)}
.cz-go{background:${C.leaf};color:#fff}.cz-quiet{background:${C.paper2};color:${C.ink}}.cz-blue{background:${C.sky};color:#fff}
`
export function injectCSS() {
  loadFont()
  if (document.getElementById('cozy-css')) return
  const st = document.createElement('style'); st.id = 'cozy-css'; st.textContent = CSS; document.head.appendChild(st)
}
