// Pet: raise the character like a virtual pet. Hunger and mood fall with time (also while the page is
// closed: saved per work on this device), care raises them and earns friendship XP; levels make it
// grow. The UI lives in space next to the character, not on the screen (AR-glasses ready): a status
// panel over its head and four floating buttons - food / play / talk / pet. Press a button by tapping
// it on screen, or by holding your index fingertip on it for a moment (hand tracking).

const ICONS = { food: '🍎', play: '⚽', talk: '💬', pet: '🖐️' }
const FOODS = ['🍎', '🍙', '🍪', '🍓', '🍩']
const LABELS = {
  ja: { food: 'ごはん', play: 'あそぶ', talk: 'おはなし', pet: 'なでる', hunger: 'おなか', mood: 'ごきげん', lv: 'Lv' },
  en: { food: 'Food', play: 'Play', talk: 'Talk', pet: 'Pet', hunger: 'Food', mood: 'Mood', lv: 'Lv' },
}
const HUNGER_PER_S = 1 / 40, MOOD_PER_S = 1 / 60   // 100 -> 0 in about 67 min / 100 min
const AWAY_CAP = 60                                  // at most this much lost while the page was closed
const DWELL_S = 0.6                                  // fingertip on a button this long = press
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
  const pc = document.createElement('canvas'); pc.width = 512; pc.height = 200
  const ptex = new THREE.CanvasTexture(pc); ptex.colorSpace = THREE.SRGBColorSpace
  const panel = new THREE.Sprite(new THREE.SpriteMaterial({ map: ptex, transparent: true, depthWrite: false, depthTest: false }))
  panel.renderOrder = 997
  scene.add(panel)
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
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }))
    sp.renderOrder = 998
    scene.add(sp)
    const b = { id, sp, c, tex, hover: 0, pressT: 0 }
    drawButton(b)
    return b
  })
  function drawButton(b) {
    const x = b.c.getContext('2d')
    x.clearRect(0, 0, 256, 256)
    const g = x.createRadialGradient(128, 110, 20, 128, 128, 110)
    g.addColorStop(0, 'rgba(255,255,255,0.97)'); g.addColorStop(1, 'rgba(235,240,255,0.9)')
    x.fillStyle = g; x.beginPath(); x.arc(128, 116, 92, 0, Math.PI * 2); x.fill()
    x.lineWidth = 6; x.strokeStyle = 'rgba(255,255,255,1)'; x.stroke()
    if (b.hover > 0) {   // fingertip dwell progress
      x.lineWidth = 14; x.strokeStyle = '#ff6fa3'; x.lineCap = 'round'
      x.beginPath(); x.arc(128, 116, 100, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, b.hover)); x.stroke()
    }
    x.font = '84px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'
    x.fillText(ICONS[b.id], 128, 112)
    x.font = font(900, 34); x.fillStyle = '#fff'; x.strokeStyle = 'rgba(40,40,60,0.75)'; x.lineWidth = 8
    x.strokeText(L[b.id], 128, 232); x.fillText(L[b.id], 128, 232)
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

  // --- pressing: tap on screen, or fingertip dwell ----------------------------------------------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
  canvas.addEventListener('pointerdown', (e) => {
    if (!panel.visible) return
    const r = canvas.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, getCamera())
    const hit = ray.intersectObjects(buttons.filter((b) => b.sp.visible).map((b) => b.sp), false)[0]
    if (hit) { window.__hpUiTapAt = performance.now(); press(buttons.find((b) => b.sp === hit.object)) }
  }, true)
  function screenOf(obj) {
    const p = obj.position.clone().project(getCamera())
    return { x: (p.x + 1) / 2 * canvas.clientWidth, y: (1 - p.y) / 2 * canvas.clientHeight }
  }
  function updateDwell(dt) {
    const h = getHand && getHand()
    let target = null
    if (h && h.seen && h.indexPx && !state().grabbing) {
      for (const b of buttons) {
        if (!b.sp.visible) continue
        const c = screenOf(b.sp)
        const edge = screenOf({ position: b.sp.position.clone().addScaledVector(right, b.sp.scale.x * 0.42) })
        const rad = Math.max(28, Math.hypot(edge.x - c.x, edge.y - c.y))
        if (Math.hypot(h.indexPx.x - c.x, h.indexPx.y - c.y) < rad) { target = b; break }
      }
    }
    for (const b of buttons) {
      const before = b.hover
      b.hover = b === target ? b.hover + dt / DWELL_S : Math.max(0, b.hover - dt * 3)
      if (b === target && b.hover >= 1) { b.hover = 0; press(b) }
      if (Math.abs(b.hover - before) > 0.02 || (before > 0 && b.hover === 0)) drawButton(b)
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
    // tests / demos
    set(v) { Object.assign(st, v); growth = growthOf(st.level); drawPanel(); save() },
    press(id) { press(buttons.find((b) => b.id === id)) },
    stop() { panel.removeFromParent(); for (const b of buttons) b.sp.removeFromParent() },
  }
}
