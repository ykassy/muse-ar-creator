// Pet: raise the character like a virtual pet. Hunger and mood fall with time (also while the page is
// closed: saved per work on this device), care raises them and earns friendship XP; levels make it
// grow. The UI lives in space next to the character, not on the screen (AR-glasses ready): a status
// panel over its head and four floating buttons - food / play / talk / pet. Press a button by tapping
// it on screen, or with your hand: point with the index finger and touch it with the fingertip.

const ICONS = { food: 1, play: 1, talk: 1, pet: 1 }   // ids of the floating buttons (drawn as pictograms)
const FOODS = ['🍎', '🍙', '🍪', '🍓', '🍩']
const COLORS = { food: ['#ffb347', '#ff7a1a'], play: ['#7ee08a', '#2fb457'], talk: ['#6cc4ff', '#2f86e8'], pet: ['#ff9cc4', '#ff4f8f'] }
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
  const pc = document.createElement('canvas'); pc.width = 512; pc.height = 200
  Object.assign(pc.style, uiStyle, { pointerEvents: 'none' }); document.body.appendChild(pc)
  const ptex = { needsUpdate: false }
  const panel = new THREE.Object3D()
  function drawPanel() {
    const x = pc.getContext('2d')
    x.clearRect(0, 0, 512, 200)
    x.fillStyle = 'rgba(255,255,255,0.88)'; roundRect(x, 6, 6, 500, 188, 40); x.fill()
    x.strokeStyle = 'rgba(255,111,163,0.9)'; x.lineWidth = 5; x.stroke()
    x.fillStyle = '#ff5c8a'; x.font = font(900, 40); x.fillText(`${L.lv}${st.level}`, 30, 58)
    x.fillStyle = '#333'; x.font = font(800, 34); x.fillText(name.slice(0, 9), 128, 56)
    // XP bar
    const need = xpFor(st.level), k = Math.min(1, st.xp / need)
    x.fillStyle = '#f1e7ee'; roundRect(x, 30, 72, 452, 14, 7); x.fill()
    x.fillStyle = '#ff8fb5'; roundRect(x, 30, 72, Math.max(14, 452 * k), 14, 7); x.fill()
    const bar = (y, label, v, col) => {
      x.fillStyle = '#555'; x.font = font(800, 28); x.fillText(label, 30, y + 22)
      x.fillStyle = '#eee'; roundRect(x, 170, y, 312, 26, 13); x.fill()
      x.fillStyle = v < 30 ? '#ff5470' : col; roundRect(x, 170, y, Math.max(26, 312 * v / 100), 26, 13); x.fill()
    }
    bar(104, L.hunger, st.hunger, '#ffb347')
    bar(146, L.mood, st.mood, '#5ec8ff')
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
    x.save(); x.shadowColor = 'rgba(0,0,0,0.35)'; x.shadowBlur = 14; x.shadowOffsetY = 5
    const g = x.createLinearGradient(0, 30, 0, 200); g.addColorStop(0, c0); g.addColorStop(1, c1)
    x.fillStyle = g; x.beginPath(); x.arc(128, 112, 86, 0, Math.PI * 2); x.fill(); x.restore()
    x.lineWidth = 7; x.strokeStyle = '#fff'; x.beginPath(); x.arc(128, 112, 86, 0, Math.PI * 2); x.stroke()
    if (b.aim) {                 // the fingertip is on it: glow so you know what you are about to press
      x.lineWidth = 12; x.strokeStyle = 'rgba(255,255,255,0.9)'; x.beginPath(); x.arc(128, 112, 101, 0, Math.PI * 2); x.stroke()
    }
    if (b.hover > 0) {           // the short touch before it counts
      x.lineWidth = 12; x.strokeStyle = '#ffe45c'; x.lineCap = 'round'
      x.beginPath(); x.arc(128, 112, 101, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, b.hover)); x.stroke()
    }
    pictogram(x, b.id)
    x.font = font(900, 32); x.textAlign = 'center'; x.textBaseline = 'middle'
    const w = x.measureText(L[b.id]).width + 30
    x.fillStyle = 'rgba(30,30,45,0.78)'; roundRect(x, 128 - w / 2, 212, w, 40, 20); x.fill()
    x.fillStyle = '#fff'; x.fillText(L[b.id], 128, 233)
    b.tex.needsUpdate = true
  }

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
    panel.scale.set(H * 0.85, H * 0.85 * 200 / 512, 1)
    const n = buttons.length, gap = H * 0.36
    buttons.forEach((b, i) => {
      const off = (i - (n - 1) / 2) * gap
      const pop = b.pressT > 0 ? 1 - 0.18 * Math.sin(Math.min(1, b.pressT / 0.25) * Math.PI) : 1
      b.sp.position.copy(base).addScaledVector(right, off).addScaledVector(f, -H * 0.55)
      b.sp.position.y = g.position.y + H * 0.2 + Math.sin(t * 2 + i) * H * 0.015
      b.sp.scale.setScalar(H * 0.3 * pop * (1 + b.hover * 0.12))
    })
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
    placeEl(pc, panel, panel.scale.x, 200 / 512)
    for (const b of buttons) placeEl(b.c, b.sp, b.sp.scale.x, 1)
  }
  function screenOf(obj) {
    const p = obj.position.clone().project(getCamera())
    return { x: (p.x + 1) / 2 * canvas.clientWidth, y: (1 - p.y) / 2 * canvas.clientHeight }
  }
  // pressing with the hand: touch a button with the index fingertip - it glows, and after a short touch
  // it is pressed, like poking a button in the air. To press it again, take the finger off first.
  // No hand-shape check: pointing at something in AR points the finger away from the camera, so it
  // looks short and never reads as "extended". Only a pinch (carrying) never presses.
  const TOUCH_S = 0.25
  const dbgState = {}
  let touched = null, touchT = 0, lockedOn = null
  function updateDwell(dt) {
    const h = getHand && getHand()
    let target = null
    const pointing = !!(h && h.seen && h.indexPx && !h.pinch && !state().grabbing)
    if (pointing) {
      for (const b of buttons) {
        if (!b.sp.visible) continue
        const c = screenOf(b.sp)
        const edge = screenOf({ position: b.sp.position.clone().addScaledVector(right, b.sp.scale.x * 0.45) })
        const rad = Math.max(34, Math.hypot(edge.x - c.x, edge.y - c.y) * 1.15)
        if (Math.hypot(h.indexPx.x - c.x, h.indexPx.y - c.y) < rad) { target = b; break }
      }
    }
    if (lockedOn && target !== lockedOn) lockedOn = null      // finger left the button: it can be pressed again
    if (target && target !== lockedOn) {
      if (touched !== target) { touched = target; touchT = 0 }
      touchT += dt
      if (touchT >= TOUCH_S) { lockedOn = target; touched = null; press(target) }
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
    sp.position.copy(b.sp.position); sp.scale.setScalar(state().height * 0.22)
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

  // --- needs: says so when hungry / bored --------------------------------------------------------
  let needT = 12, t = 0
  function update(dt) {
    t += dt
    const s = state()
    st.hunger = Math.max(0, st.hunger - dt * HUNGER_PER_S)
    st.mood = Math.max(0, st.mood - dt * MOOD_PER_S * (st.hunger < 30 ? 2 : 1))
    saveT += dt
    if (saveT > 5) { saveT = 0; save(); drawPanel() }
    growthShown += (growth - growthShown) * (1 - Math.exp(-dt * 2))
    layout()
    syncDom()
    updateDwell(dt)
    updateFoods(dt)
    for (const b of buttons) if (b.pressT > 0) { b.pressT += dt; if (b.pressT > 0.25) b.pressT = 0 }
    if (s.ready && !s.talking && !s.grabbing && !s.challenge) {
      needT -= dt
      if (needT <= 0) {
        needT = 25 + Math.random() * 10
        if (st.hunger < 30) fire('need', 'hungry')
        else if (st.mood < 30) fire('need', 'bored')
      }
    }
  }

  return {
    update, on, gain,
    get growth() { return growthShown },
    get stats() { return { ...st } },
    get debug() { return { ...dbgState } },
    get aiming() { return !!dbgState.target },   // fingertip on a button: hand-play skips poking the character
    // tests / demos
    set(v) { Object.assign(st, v); growth = growthOf(st.level); drawPanel(); save() },
    press(id) { press(buttons.find((b) => b.id === id)) },
    stop() { pc.remove(); for (const b of buttons) b.c.remove() },
  }
}
