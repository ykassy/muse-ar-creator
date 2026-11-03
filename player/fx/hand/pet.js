// Pet: raise the character like a virtual pet. Hunger and mood fall with time (also while the page is
// closed: saved per work on this device), care raises them and earns friendship XP; levels make it
// grow. The UI lives in space next to the character, not on the screen (AR-glasses ready): a status
// panel over its head and four floating buttons - food / play / talk / pet. Press a button by tapping
// it on screen, or with your hand: point with the index finger and touch it with the fingertip.

import { C as CZ, font as czFont, loadFont, roundRect as czRound, card as czCard, tag as czTag, leaf as czLeaf, gauge as czGauge } from './cozy.js?v=20261104k'

const ICONS = { food: 1, play: 1, talk: 1, pet: 1 }   // ids of the floating buttons (drawn as pictograms)
const FOODS = ['🍎', '🍙', '🍪', '🍓', '🍩']
const COLORS = { food: ['#ffc59a', '#f39457'], play: ['#a6dc85', '#6fb552'], talk: ['#9dd6f2', '#5aaedb'], pet: ['#f9b8cb', '#ea7fa0'] }
const LABELS = {
  ja: { food: 'ごはん', play: 'あそぶ', talk: 'おはなし', pet: 'なでる', hunger: 'おなか', mood: 'ごきげん', lv: 'Lv' },
  en: { food: 'Food', play: 'Play', talk: 'Talk', pet: 'Pet', hunger: 'Food', mood: 'Mood', lv: 'Lv' },
}
const HUNGER_PER_S = 1 / 40, MOOD_PER_S = 1 / 60   // 100 -> 0 in about 67 min / 100 min
const AWAY_CAP = 60                                  // at most this much lost while the page was closed
const xpFor = (lv) => 20 + lv * 15                   // XP to go from lv to lv + 1
const growthOf = (lv) => Math.min(1.3, 0.8 + (lv - 1) * 0.06)

export function createPet(api) {
  const { THREE, scene, getCamera, canvas, group, getRect, state, emote, moves, getHand, ov = {}, dbg = () => {} } = api
  const lang = ov.talkLang === 'en' ? 'en' : 'ja'
  const L = LABELS[lang]
  const name = ov.talkName || ''
  const projectId = (location.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || 'local'
  const key = 'hp-pet:' + projectId

  // --- state (persisted) ---------------------------------------------------------------------
  let st = { hunger: 70, mood: 70, xp: 0, level: 1, at: Date.now() }
  try { const j = JSON.parse(localStorage.getItem(key) || 'null'); if (j && typeof j.level === 'number') st = { ...st, ...j } } catch { /* private mode */ }
  {
    const away = Math.max(0, (Date.now() - (st.at || Date.now())) / 1000)
    st.hunger = Math.max(0, st.hunger - Math.min(AWAY_CAP, away * HUNGER_PER_S))
    st.mood = Math.max(0, st.mood - Math.min(AWAY_CAP, away * MOOD_PER_S))
  }
  let saveT = 0
  const save = () => { st.at = Date.now(); try { localStorage.setItem(key, JSON.stringify(st)) } catch { /* private mode */ } }
  let growth = growthOf(st.level), growthShown = growth

  // --- canvas-texture helpers --------------------------------------------------------------------
  function roundRect(x, x0, y0, w, h, r) { x.beginPath(); x.moveTo(x0 + r, y0); x.arcTo(x0 + w, y0, x0 + w, y0 + h, r); x.arcTo(x0 + w, y0 + h, x0, y0 + h, r); x.arcTo(x0, y0 + h, x0, y0, r); x.arcTo(x0, y0, x0 + w, y0, r); x.closePath() }
  const font = (w, px) => `${w} ${px}px -apple-system, "Hiragino Sans", sans-serif`

  // status panel over the head
  // The panel and buttons are placed in 3D (they follow the character and scale with distance) but
  // drawn as page elements above every canvas: the spell layer is its own canvas over the AR view and
  // would otherwise wash over them.
  const uiStyle = { position: 'fixed', left: '0', top: '0', transform: 'translate(-50%,-50%)', zIndex: 55, display: 'none', willChange: 'transform' }
  const pc = document.createElement('canvas'); pc.width = 512; pc.height = 236
  Object.assign(pc.style, uiStyle, { pointerEvents: 'none' }); document.body.appendChild(pc)
  const ptex = { needsUpdate: false }
  const panel = new THREE.Object3D()
  function drawPanel() {
    const x = pc.getContext('2d')
    x.clearRect(0, 0, 512, 236)
    czCard(x, 8, 30, 496, 196, 44)
    // name tag over the card's top-left corner, level on a leaf at the right
    czTag(x, 40 + Math.min(150, (name.length || 1) * 17), 32, name.slice(0, 9) || '…', 28)
    czLeaf(x, 432, 84, 52)
    x.fillStyle = '#fff'; x.font = czFont(900, 30); x.textAlign = 'center'; x.textBaseline = 'middle'
    x.strokeStyle = CZ.leafDark; x.lineWidth = 6; x.strokeText(`${L.lv}${st.level}`, 432, 86); x.fillText(`${L.lv}${st.level}`, 432, 86)
    // friendship XP: a thin leafy bar
    const need = xpFor(st.level)
    czGauge(x, 40, 76, 330, 16, st.xp / need, CZ.leaf, CZ.leafDark)
    const row = (y, icon, label, v, c0, c1) => {
      x.textAlign = 'left'; x.textBaseline = 'middle'
      x.font = '30px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; x.fillText(icon, 38, y + 2)
      x.fillStyle = CZ.ink; x.font = czFont(800, 26); x.fillText(label, 80, y + 2)
      czGauge(x, 214, y - 15, 258, 30, v / 100, v < 30 ? '#ff9a9a' : c0, v < 30 ? '#e86060' : c1)
    }
    row(126, '🍎', L.hunger, st.hunger, CZ.peach, CZ.peachDark)
    row(178, '🌼', L.mood, st.mood, CZ.sky, CZ.skyDark)
    ptex.needsUpdate = true
  }
  drawPanel()

  // four floating buttons
  const buttons = Object.keys(ICONS).map((id) => {
    const c = document.createElement('canvas'); c.width = c.height = 256
    Object.assign(c.style, uiStyle, { pointerEvents: 'auto', touchAction: 'manipulation', cursor: 'pointer' }); document.body.appendChild(c)
    const tex = { needsUpdate: false }
    const sp = new THREE.Object3D()   // where the button is in space; c is what is drawn
    const b = { id, sp, c, tex, hover: 0, pressT: 0 }
    // tap on the phone screen
    c.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); window.__hpUiTapAt = performance.now(); press(b) })
    for (const ev of ['touchstart', 'touchend', 'click']) c.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev !== 'click' })
    drawButton(b)
    return b
  })
  // coloured disc + bold white pictogram (emoji were too faint on a bright floor), label on a dark pill
  function pictogram(x, id) {
    x.save(); x.translate(128, 112); x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round'
    if (id === 'food') {        // apple
      x.beginPath(); x.moveTo(0, -22); x.bezierCurveTo(-30, -44, -64, -14, -50, 18); x.bezierCurveTo(-40, 46, -16, 58, 0, 46)
      x.bezierCurveTo(16, 58, 40, 46, 50, 18); x.bezierCurveTo(64, -14, 30, -44, 0, -22); x.fill()
      x.lineWidth = 9; x.beginPath(); x.moveTo(0, -24); x.quadraticCurveTo(4, -44, 14, -52); x.stroke()
      x.beginPath(); x.ellipse(24, -44, 16, 8, -0.5, 0, Math.PI * 2); x.fill()
    } else if (id === 'play') { // ball
      x.lineWidth = 9; x.beginPath(); x.arc(0, 4, 50, 0, Math.PI * 2); x.stroke()
      x.beginPath(); for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * Math.PI * 2 / 5; x.lineTo(Math.cos(a) * 20, 4 + Math.sin(a) * 20) } x.closePath(); x.fill()
      for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * Math.PI * 2 / 5; x.beginPath(); x.moveTo(Math.cos(a) * 20, 4 + Math.sin(a) * 20); x.lineTo(Math.cos(a) * 46, 4 + Math.sin(a) * 46); x.stroke() }
    } else if (id === 'talk') { // speech bubble with dots
      x.beginPath(); x.moveTo(-50, -34); x.arcTo(56, -34, 56, 30, 18); x.arcTo(56, 30, -50, 30, 18); x.lineTo(-14, 30); x.lineTo(-34, 54); x.lineTo(-30, 30)
      x.arcTo(-56, 30, -56, -34, 18); x.arcTo(-56, -34, 56, -34, 18); x.closePath(); x.fill()
      x.fillStyle = COLORS.talk[1]; for (const dx of [-24, 0, 24]) { x.beginPath(); x.arc(dx, -2, 8, 0, Math.PI * 2); x.fill() }
    } else {                     // heart (pet / stroke)
      x.beginPath(); x.moveTo(0, 50); x.bezierCurveTo(-64, 8, -50, -50, 0, -22); x.bezierCurveTo(50, -50, 64, 8, 0, 50); x.fill()
    }
    x.restore()
  }
  function drawButton(b) {
    const x = b.c.getContext('2d')
    x.clearRect(0, 0, 256, 256)
    const [c0, c1] = COLORS[b.id]
    const S = 172, X0 = (256 - S) / 2, Y0 = 18, R = 52
    if (b.aim || b.hover > 0) {   // touched: a warm glow around the icon
      x.save(); x.shadowColor = CZ.sun; x.shadowBlur = 26; x.fillStyle = CZ.sun
      czRound(x, X0 - 8, Y0 - 8, S + 16, S + 16, R + 8); x.fill(); x.restore()
    }
    x.save(); x.shadowColor = CZ.shadow; x.shadowBlur = 14; x.shadowOffsetY = 7
    x.fillStyle = '#fff'; czRound(x, X0 - 7, Y0 - 7, S + 14, S + 14, R + 6); x.fill(); x.restore()
    const g = x.createLinearGradient(0, Y0, 0, Y0 + S); g.addColorStop(0, c0); g.addColorStop(1, c1)
    x.fillStyle = g; czRound(x, X0, Y0, S, S, R); x.fill()
    x.fillStyle = 'rgba(255,255,255,0.28)'; czRound(x, X0 + 14, Y0 + 10, S - 28, S * 0.36, R * 0.7); x.fill()   // soft gloss
    if (b.hover > 0) {            // the short touch before it counts
      x.lineWidth = 9; x.strokeStyle = CZ.sun; x.lineCap = 'round'
      x.beginPath(); x.arc(128, Y0 + S / 2, S / 2 + 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, b.hover)); x.stroke()
    }
    x.save(); x.translate(0, Y0 + S / 2 - 112); x.shadowColor = 'rgba(80,50,30,0.25)'; x.shadowBlur = 4; x.shadowOffsetY = 3
    pictogram(x, b.id); x.restore()
    // label on a cream pill
    x.font = czFont(900, 30); x.textAlign = 'center'; x.textBaseline = 'middle'
    const w = x.measureText(L[b.id]).width + 34
    x.save(); x.shadowColor = CZ.shadow; x.shadowBlur = 6; x.shadowOffsetY = 3
    x.fillStyle = CZ.paper; czRound(x, 128 - w / 2, 206, w, 44, 22); x.fill(); x.restore()
    x.fillStyle = CZ.ink; x.fillText(L[b.id], 128, 229)
    b.tex.needsUpdate = true
  }
  // redraw once the rounded font has arrived
  loadFont().then(() => { drawPanel(); buttons.forEach(drawButton) })

  // --- layout: buttons in a row in front of the character's knees, panel over its head ----------
  const f = new THREE.Vector3(), right = new THREE.Vector3(), base = new THREE.Vector3()
  function layout() {
    const g = group(), cam = getCamera(), s = state()
    const vis = !!(g && g.parent && s.ready && !s.challenge)
    panel.visible = vis; for (const b of buttons) b.sp.visible = vis && !s.grabbing
    if (!vis) return
    const H = s.height
    cam.getWorldDirection(f); f.y = 0; f.normalize(); right.set(-f.z, 0, f.x)
    base.copy(g.position)
    const box = api.getBox && api.getBox()
    const top = box ? box.max.y : g.position.y + H
    panel.position.set((box ? (box.min.x + box.max.x) / 2 : base.x), top + H * 0.2, (box ? (box.min.z + box.max.z) / 2 : base.z))
    // keep a readable on-screen size: in landscape (shorter screen) or zoomed out the world sizes
    // project small, so grow them up to a floor in pixels (the row spreads out with them)
    const kB = Math.max(1, BTN_MIN_PX / Math.max(1, pxOf(base, H * 0.3)))
    const kP = Math.max(1, PANEL_MIN_PX / Math.max(1, pxOf(panel.position, H * 1.05)))
    panel.scale.set(H * 1.05 * kP, H * 1.05 * kP * 236 / 512, 1)
    panel.position.y += H * 1.05 * (kP - 1) * 236 / 512 / 2 + H * 0.3 * Math.min(1, kP - 1)   // grown: keep its bottom edge where it was, then lift clear of the head
    const n = buttons.length, gap = H * 0.36 * kB
    buttons.forEach((b, i) => {
      const off = (i - (n - 1) / 2) * gap
      const pop = b.pressT > 0 ? 1 - 0.18 * Math.sin(Math.min(1, b.pressT / 0.25) * Math.PI) : 1
      b.sp.position.copy(base).addScaledVector(right, off).addScaledVector(f, -H * 0.55)
      // grown buttons hang down from a top edge that drops from the knees to the feet, off the body
      b.sp.position.y = g.position.y + H * (0.35 - 0.3 * Math.min(1, kB - 1) - 0.15 * kB) + Math.sin(t * 2 + i) * H * 0.015
      b.sp.scale.setScalar(H * 0.3 * kB * pop * (1 + b.hover * 0.12))
    })
  }
  const BTN_MIN_PX = 64, PANEL_MIN_PX = 230
  // on-screen width (px) of a world length lying sideways at a point
  function pxOf(at, len) {
    const cam = getCamera(), w = canvas.getBoundingClientRect().width
    const a = at.clone().project(cam), c = at.clone().addScaledVector(right, len).project(cam)
    return Math.abs(c.x - a.x) / 2 * w
  }

  // --- pressing ---------------------------------------------------------------------------------
  // project each 3D anchor to the page: centre + on-screen width from its world size
  function placeEl(el, obj, worldW, aspect) {
    if (!obj.visible) { el.style.display = 'none'; return }
    const r = canvas.getBoundingClientRect(), cam = getCamera()
    const p = obj.position.clone().project(cam)
    if (p.z > 1) { el.style.display = 'none'; return }
    const q = obj.position.clone().addScaledVector(right, worldW / 2).project(cam)
    const w = Math.max(24, Math.abs(q.x - p.x) * r.width)
    el.style.display = 'block'
    el.style.width = w + 'px'; el.style.height = (w * aspect) + 'px'
    el.style.transform = `translate(${r.left + (p.x + 1) / 2 * r.width}px, ${r.top + (1 - p.y) / 2 * r.height}px) translate(-50%,-50%)`
  }
  function syncDom() {
    placeEl(pc, panel, panel.scale.x, 236 / 512)
    for (const b of buttons) placeEl(b.c, b.sp, b.sp.scale.x, 1)
    for (const p of poops) placeEl(p.c, p.sp, p.sp.scale.x, 1)
    placeEl(zEl, zAnchor, zAnchor.scale.x, 0.6)
  }
  function screenOf(obj) {
    const p = obj.position.clone().project(getCamera())
    return { x: (p.x + 1) / 2 * canvas.clientWidth, y: (1 - p.y) / 2 * canvas.clientHeight }
  }
  // pressing with the hand: touch a button with the index fingertip - it glows, and after a short touch
  // it is pressed, like poking a button in the air. To press it again, take the finger off first.
  // No hand-shape check: pointing at something in AR points the finger away from the camera, so it
  // looks short - never "extended", and its tip lands next to the thumb, so it even reads as a pinch.
  // Only while actually carrying the character are buttons ignored (hand-play doesn't start a carry
  // while the fingertip is on a button).
  const TOUCH_S = 0.25
  const dbgState = {}
  let touched = null, touchT = 0, lockedOn = null
  function updateDwell(dt) {
    const h = getHand && getHand()
    let target = null
    const pointing = !!(h && h.seen && h.indexPx && !state().grabbing)
    if (pointing) {
      for (const b of buttons) {
        if (!b.sp.visible) continue
        const c = screenOf(b.sp)
        const edge = screenOf({ position: b.sp.position.clone().addScaledVector(right, b.sp.scale.x * 0.45) })
        const rad = Math.max(44, Math.hypot(edge.x - c.x, edge.y - c.y) * 1.2)   // stays touchable when zoomed out
        if (Math.hypot(h.indexPx.x - c.x, h.indexPx.y - c.y) < rad) { target = b; break }
      }
      if (!target) for (const p of poops) {
        if (!p.sp.visible || p.gone) continue
        const c = screenOf(p.sp)
        if (Math.hypot(h.indexPx.x - c.x, h.indexPx.y - c.y) < 50) { target = p; break }
      }
    }
    if (lockedOn && target !== lockedOn) lockedOn = null      // finger left the button: it can be pressed again
    if (target && target !== lockedOn) {
      if (touched !== target) { touched = target; touchT = 0 }
      touchT += dt
      if (touchT >= TOUCH_S) { lockedOn = target; touched = null; target.poop ? clean(target) : press(target) }
    } else { touched = null; touchT = 0 }
    dbgState.pointing = pointing; dbgState.target = target && target.id; dbgState.locked = lockedOn && lockedOn.id
    for (const b of buttons) {
      const aimBefore = b.aim, hoverBefore = b.hover
      b.aim = b === target
      b.hover = b === touched ? Math.min(1, touchT / TOUCH_S) : 0
      if (aimBefore !== b.aim || Math.abs(b.hover - hoverBefore) > 0.05) drawButton(b)
    }
  }

  // --- care ---------------------------------------------------------------------------------------
  const listeners = {}
  const on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn) }
  const fire = (ev, ...a) => (listeners[ev] || []).forEach((fn) => fn(...a))
  function gain(xp, hunger = 0, mood = 0) {
    st.hunger = Math.max(0, Math.min(100, st.hunger + hunger))
    st.mood = Math.max(0, Math.min(100, st.mood + mood))
    st.xp += xp
    let up = false
    while (st.xp >= xpFor(st.level)) { st.xp -= xpFor(st.level); st.level++; up = true }
    if (up) { growth = growthOf(st.level); fire('levelup', st.level) }
    drawPanel(); save()
    return up
  }
  const foods = []
  function press(b) {
    if (!b) return
    b.pressT = 0.0001
    wake('touch')
    fire('press', b.id)
    if (b.id === 'food') feed(b)
    else if (b.id === 'pet') { gain(2, 0, 10); fire('pet') }
    else if (b.id === 'talk') fire('talk')
    else if (b.id === 'play') fire('play')
  }
  function feed(b) {
    if (st.hunger > 92) { fire('full'); return }
    const c = document.createElement('canvas'); c.width = c.height = 128
    const x = c.getContext('2d'); x.font = '96px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'
    x.fillText(FOODS[Math.floor(Math.random() * FOODS.length)], 64, 70)
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
    sp.position.copy(b.sp.position); sp.scale.setScalar(state().height * 0.4)
    scene.add(sp)
    foods.push({ sp, from: b.sp.position.clone(), t: 0 })
  }
  function updateFoods(dt) {
    const box = api.getBox && api.getBox(), s = state()
    for (let i = foods.length - 1; i >= 0; i--) {
      const fd = foods[i]; fd.t += dt
      const k = Math.min(1, fd.t / 0.7)
      // arc into the mouth (about three quarters up the body)
      const to = box ? new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y + (box.max.y - box.min.y) * 0.7, (box.min.z + box.max.z) / 2) : group().position
      fd.sp.position.lerpVectors(fd.from, to, k); fd.sp.position.y += Math.sin(k * Math.PI) * s.height * 0.35
      fd.sp.material.rotation = k * 6
      if (k >= 1) {
        fd.sp.removeFromParent(); fd.sp.material.map.dispose(); fd.sp.material.dispose(); foods.splice(i, 1)
        gain(3, 30, 4); fire('ate')
      }
    }
  }

  // --- poop: a while after a meal a little one drops by its feet; touch it with a fingertip (or tap it)
  // to clean up. Left alone it makes the mood fall faster. Up to two at a time.
  const POOP_AFTER = () => 120 + Math.random() * 120   // s after eating
  let poopIn = null
  const poops = []
  on('ate', () => { if (poopIn == null) poopIn = POOP_AFTER() })
  function addPoop(silent) {
    if (poops.length >= 2) return
    const c = document.createElement('canvas'); c.width = c.height = 128
    const x = c.getContext('2d'); x.font = '92px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'
    x.fillText('💩', 64, 70)
    Object.assign(c.style, uiStyle, { zIndex: 54, pointerEvents: 'auto', touchAction: 'manipulation', cursor: 'pointer', transition: 'opacity .4s, transform .05s' })
    document.body.appendChild(c)
    const p = { poop: true, c, sp: new THREE.Object3D(), side: poops.some((q) => q.side > 0) ? -1 : 1, t: 0, gone: 0 }
    c.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); window.__hpUiTapAt = performance.now(); clean(p) })
    for (const ev of ['touchstart', 'touchend', 'click']) c.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev !== 'click' })
    poops.push(p); st.poops = poops.length; save()
    if (!silent) fire('poop')
  }
  for (let i = 0; i < Math.min(2, st.poops || 0); i++) addPoop(true)
  function clean(p) {
    if (p.gone) return
    p.gone = 0.0001; p.c.style.opacity = '0'
    wake('touch')
    gain(2, 0, 8); fire('clean')
  }
  function updatePoops(dt) {
    const g = group(), s = state()
    if (poopIn != null && !s.challenge) { poopIn -= dt; if (poopIn <= 0) { poopIn = null; addPoop() } }
    for (let i = poops.length - 1; i >= 0; i--) {
      const p = poops[i]
      if (p.gone) { p.gone += dt; if (p.gone > 0.45) { p.c.remove(); poops.splice(i, 1); st.poops = poops.length; save() } }
      p.sp.visible = !!(g && g.parent && s.ready && !s.challenge)
      if (!p.sp.visible) continue
      const H = s.height
      p.sp.position.copy(g.position).addScaledVector(right, p.side * H * 0.48).addScaledVector(f, -H * 0.12)
      p.sp.position.y = g.position.y + H * 0.11
      p.sp.scale.setScalar(H * 0.24 * (p.gone ? 1 - p.gone * 2 : 1))
    }
  }

  // --- sleep: at night (21:00-7:00 on this device) it dozes off - slow breathing and a floating "zzz".
  // Touching it, a button or talking wakes it for a while; then it nods off again.
  const zEl = document.createElement('div')
  zEl.textContent = 'z z z'
  Object.assign(zEl.style, uiStyle, { pointerEvents: 'none', color: '#fff', font: `900 22px/1 ${CZ ? '"M PLUS Rounded 1c", sans-serif' : 'sans-serif'}`,
    textShadow: '0 2px 6px rgba(70,60,120,.5)', letterSpacing: '2px', textAlign: 'center' })
  document.body.appendChild(zEl)
  const zAnchor = new THREE.Object3D()
  let asleep = false, awakeUntil = 0, forceNight = null
  const isNight = () => { if (forceNight != null) return forceNight; const h = new Date().getHours(); return h >= 21 || h < 7 }
  function wake(why) {
    if (!isNight()) return
    awakeUntil = performance.now() + 120000
    if (asleep) { asleep = false; fire('wake', why) }
  }
  window.addEventListener('handplay:poke', () => wake('touch'))
  function updateSleep() {
    const s = state()
    const want = isNight() && performance.now() > awakeUntil && s.ready && !s.grabbing && !s.talking && !s.challenge
    if (want !== asleep) { asleep = want; fire(asleep ? 'sleep' : 'wake', 'time') }
    zAnchor.visible = asleep
    if (!asleep) return
    const g = group(), H = s.height, box = api.getBox && api.getBox()
    const top = box ? box.max.y : g.position.y + H
    zAnchor.position.copy(g.position).addScaledVector(right, H * 0.35)
    zAnchor.position.y = top + H * 0.05 + Math.sin(t * 1.5) * H * 0.04
    zAnchor.scale.setScalar(H * 0.45)
    zEl.style.opacity = String(0.55 + 0.35 * Math.sin(t * 1.5))
    zEl.style.fontSize = Math.max(16, parseFloat(zEl.style.width || '60') * 0.3) + 'px'
  }

  // --- needs: says so when hungry / bored --------------------------------------------------------
  let needT = 12, t = 0
  function update(dt) {
    t += dt
    const s = state()
    st.hunger = Math.max(0, st.hunger - dt * HUNGER_PER_S * (asleep ? 0.5 : 1))
    st.mood = Math.max(0, st.mood - dt * MOOD_PER_S * (st.hunger < 30 ? 2 : 1) * (poops.length ? 1.5 : 1) * (asleep ? 0.5 : 1))
    saveT += dt
    if (saveT > 5) { saveT = 0; save(); drawPanel() }
    growthShown += (growth - growthShown) * (1 - Math.exp(-dt * 2))
    layout()
    updatePoops(dt)
    updateSleep()
    syncDom()
    updateDwell(dt)
    updateFoods(dt)
    for (const b of buttons) if (b.pressT > 0) { b.pressT += dt; if (b.pressT > 0.25) b.pressT = 0 }
    if (s.ready && !s.talking && !s.grabbing && !s.challenge && !asleep) {
      needT -= dt
      if (needT <= 0) {
        needT = 25 + Math.random() * 10
        if (st.hunger < 30) fire('need', 'hungry')
        else if (st.mood < 30) fire('need', 'bored')
        else if (poops.length) fire('poop')
      }
    }
  }

  return {
    update, on, gain,
    get growth() { return growthShown },
    get stats() { return { ...st } },
    get debug() { return { ...dbgState } },
    get aiming() { return !!dbgState.target },
    get asleep() { return asleep },   // fingertip on a button: hand-play skips poking the character
    // tests / demos
    set(v) { Object.assign(st, v); growth = growthOf(st.level); drawPanel(); save() },
    press(id) { press(buttons.find((b) => b.id === id)) },
    poop() { addPoop() }, clean() { if (poops[0]) clean(poops[0]) },
    night(v) { forceNight = v; awakeUntil = 0 },
    stop() { pc.remove(); zEl.remove(); for (const b of buttons) b.c.remove(); for (const p of poops) p.c.remove() },
  }
}
