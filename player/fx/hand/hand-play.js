// Hand Play: touch the AR character with your hand (opt-in per project via an isHandPlay overlay).
// MediaPipe HandLandmarker reads the AR camera (8th Wall CameraPixelArray on devices, a test canvas in
// the emulator). Pinch near the character to pick it up, carry it across the floor and let go to drop
// it; poke it with the index finger to make it react (event); open a palm toward it to cast (event).
// Gestures are judged in screen space against the character's projected bounds. While held, the pinch
// point is cast onto an upright plane through the character facing the camera (raise the hand = lift,
// move sideways = carry), and the hand's apparent size pushes that plane nearer / farther. The body
// swings from the pinch point like a pendulum and kicks its legs; the floor shadow stays on the floor.
const MP = '/external/mediapipe-0.10.32'
const MODEL = '/external/mediapipe-models/hand_landmarker.task'

const PINCH_ON = 0.32, PINCH_OFF = 0.5    // thumb-index gap / hand size, with hysteresis
const DETECT_HZ = 15, LOST_MS = 400

export async function start(opts) {
  const { THREE, marker, getCamera, scene, canvas, ov = {}, dbg = () => {} } = opts
  const vision = await import(`${MP}/vision_bundle.mjs`)
  const files = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`)
  let landmarker
  for (const delegate of ['GPU', 'CPU']) {
    try {
      landmarker = await vision.HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numHands: 1,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      })
      dbg(`HandPlay: landmarker ready (${delegate})`)
      break
    } catch (e) { dbg(`HandPlay: ${delegate} failed: ${e.message}`) }
  }
  if (!landmarker) return null

  // --- camera frames -------------------------------------------------------------------------
  let frame = null   // { data: ImageData | canvas, w, h }
  const testSource = () => window.__handPlaySource || null   // emulator: a canvas the test harness draws
  if (!window.__emu && window.XR8?.CameraPixelArray) {
    XR8.addCameraPipelineModule(XR8.CameraPixelArray.pipelineModule({ luminance: false, maxDimension: 256 }))
    XR8.addCameraPipelineModule({
      name: 'hand-play-pixels',
      onProcessCpu: ({ processGpuResult }) => {
        const r = processGpuResult && processGpuResult.camerapixelarray
        if (!r || !r.pixels) return
        if (r.rowBytes !== r.cols * 4) return
        frame = { data: new ImageData(new Uint8ClampedArray(r.pixels), r.cols, r.rows), w: r.cols, h: r.rows }
      },
    })
  }

  // --- state ---------------------------------------------------------------------------------
  const hand = { seen: false, lastSeen: 0, lm: null, pinch: false, pinchPx: null, poke: false, palm: false }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const hit = new THREE.Vector3(), box = new THREE.Box3(), corner = new THREE.Vector3()
  const grab = {
    on: false, offset: new THREE.Vector3(), lift: 0, t: 0, fallV: 0, falling: false,
    plane: new THREE.Plane(), fwd: new THREE.Vector3(), p0: new THREE.Vector3(), y0: 0, lift0: 0,
    size0: 0, dist0: 1, depth: 0, pivot: 0.3, theta: 0, omega: 0, vLat: 0, squash: 0, squashV: 0, base: null,
  }
  const hit2 = new THREE.Vector3(), tmp = new THREE.Vector3(), axis = new THREE.Vector3(), invQ = new THREE.Quaternion()
  const mA = new THREE.Matrix4(), mB = new THREE.Matrix4()
  const MAX_LIFT = 1.5   // metres above the floor

  // floor cursor: shows where the hand points, fills when pinched
  const cursor = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.07, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthTest: false }))
  cursor.rotation.x = -Math.PI / 2
  cursor.renderOrder = 998
  scene.add(cursor)

  // debug: ?handdebug draws the landmarks over the screen
  let dbgCanvas = null
  if (/[?&]handdebug\b/.test(location.search)) {
    dbgCanvas = document.createElement('canvas')
    Object.assign(dbgCanvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 50 })
    document.body.appendChild(dbgCanvas)
  }

  const group = () => marker.parent && marker.parent.parent   // _slamContent -> _slamGroup
  const content = () => marker.parent

  // emotions: named GLB clips (container.userData.playClip) + face textures (Artwork overlay .expressions)
  const faceCache = {}
  let baseMap = null
  function artworkMesh() {
    let m = null
    content()?.traverse((o) => { if (!m && o.isMesh && o.material?.name === 'Artwork') m = o })
    return m
  }
  function expressions() {
    const ovs = (window.__overlayData && Object.values(window.__overlayData).find(v => v && v.overlays)?.overlays) || []
    return ovs.find(o => o.expressions)?.expressions || null
  }
  function clip(name) {
    let done = false
    content()?.traverse((o) => { if (!done && o.userData.playClip) done = o.userData.playClip(name) })
    return done
  }
  // Expression images come as the full generated canvas (art in the middle, transparent around it),
  // while the GLB's own texture is cropped to the art and flooded with the edge colour. Swapping one
  // for the other as-is shrinks / shifts the drawing on the plate (it reads as a doubled image), so
  // each face is cropped to its art, scaled to the base texture's size and flooded the same way.
  function fitFace(img) {
    const base = baseMap.image, W = base.width, H = base.height
    const src = document.createElement('canvas'); src.width = img.width; src.height = img.height
    const sx = src.getContext('2d', { willReadFrequently: true }); sx.drawImage(img, 0, 0)
    const a = sx.getImageData(0, 0, img.width, img.height).data
    let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      if (a[(y * img.width + x) * 4 + 3] > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    }
    if (x1 < 0) return null
    // the plate's outline was eroded a little before cropping: trim the same amount
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1
    const ix = Math.max(0, Math.min(8, Math.round((bw - W) / 2))), iy = Math.max(0, Math.min(8, Math.round((bh - H) / 2)))
    const out = document.createElement('canvas'); out.width = W; out.height = H
    const ox = out.getContext('2d')
    // edge colour: a corner of the base texture (outside the art, flooded)
    const probe = document.createElement('canvas'); probe.width = probe.height = 1
    const px = probe.getContext('2d'); px.drawImage(base, 1, 1, 1, 1, 0, 0, 1, 1)
    const e = px.getImageData(0, 0, 1, 1).data
    ox.fillStyle = `rgb(${e[0]},${e[1]},${e[2]})`; ox.fillRect(0, 0, W, H)
    ox.drawImage(src, x0 + ix, y0 + iy, bw - ix * 2, bh - iy * 2, 0, 0, W, H)
    const t = new THREE.CanvasTexture(out)
    t.flipY = baseMap.flipY; t.colorSpace = baseMap.colorSpace; t.wrapS = baseMap.wrapS; t.wrapT = baseMap.wrapT
    t.anisotropy = baseMap.anisotropy || 1
    return t
  }
  function loadFace(url) {
    if (faceCache[url]) return faceCache[url]
    faceCache[url] = new Promise((res) => {
      const img = new Image(); img.crossOrigin = 'anonymous'
      img.onload = () => { try { res(fitFace(img)) } catch (e) { dbg('HandPlay: face ' + e.message); res(null) } }
      img.onerror = () => res(null)
      img.src = url
    })
    return faceCache[url]
  }
  function face(name) {
    const m = artworkMesh(), ex = expressions()
    if (!m || !ex) return
    if (!baseMap) baseMap = m.material.map
    const url = ex[name]
    if (!url || name === 'neutral' || !baseMap?.image) { if (baseMap) { m.material.map = baseMap; m.material.needsUpdate = true } return }
    const want = name
    face.want = want
    loadFace(url).then((t) => { if (t && face.want === want) { m.material.map = t; m.material.needsUpdate = true } })
  }
  // fetch + fit every face early, so the first switch is instant
  setTimeout(function prefetch() {
    const m = artworkMesh(), ex = expressions()
    if (!m || !ex) return void setTimeout(prefetch, 1500)
    if (!baseMap) baseMap = m.material.map
    if (!baseMap?.image) return void setTimeout(prefetch, 1500)
    for (const [k, u] of Object.entries(ex)) if (k !== 'neutral' && u) loadFace(u)
  }, 2500)
  let faceTimer = 0
  function emote(name, ms = 4000) {
    if (!grab.on && !grab.falling) moves.play(name)
    clip(name)
    face(name)
    clearTimeout(faceTimer)
    if (ms) faceTimer = setTimeout(() => face('neutral'), ms)
  }
  window.addEventListener('handplay:reply', (e) => { const em = e.detail && e.detail.emotion; if (em) emote(em) })
  window.addEventListener('handplay:palm', () => setTimeout(() => emote('zap', 2500), 700))

  // in-house floor-AR style choreography (moves.js): rise from the floor, hop laps, spins, emotions
  const { createMoves } = await import('./moves.js?v=20261103x')
  const moves = createMoves()
  let H = 0, T = 0   // character height / thickness in the group's units, measured once at rest

  // talk: the talk button (talk.js). A tap anywhere also unlocks the mic / voice for iOS
  let talk = null
  if (ov.handTalk !== false) {
    const { createTalk } = await import('./talk.js?v=20261104k')
    talk = createTalk({ THREE, getCamera, canvas, content, getRect: () => charRect(), ov, dbg })
    // talking starts only from the talk button; a poke (finger or tap on the character) just makes it react
    window.addEventListener('handplay:poke', () => { if (!talk.busy && !game?.chasing) emote('happy', 1500) })
    let unlocked = false
    const onTap = (e) => {
      const r = canvas.getBoundingClientRect(), t = e.changedTouches ? e.changedTouches[0] : e
      const px = { x: t.clientX - r.left, y: t.clientY - r.top }
      if (!unlocked) { unlocked = true; talk.unlock() }
      if (inRect(px, charRect()) && !grab.on && !game?.chasing && performance.now() - (window.__hpUiTapAt || 0) > 300) window.dispatchEvent(new CustomEvent('handplay:poke', { detail: { x: px.x, y: px.y, tap: true } }))
    }
    canvas.addEventListener('touchend', onTap, { passive: true })
    canvas.addEventListener('click', onTap)
  }

  // wish game for kids (game.js): the character asks, you grant it, hearts and friendship levels
  let game = null, replyAt = -1e9
  window.addEventListener('handplay:reply', () => { replyAt = performance.now(); window.__hpPet?.gain(4, 0, 8) })
  if (ov.handGame !== false) {
    const { createGame } = await import('./game.js?v=20261104k')
    game = createGame({
      THREE, scene, getCamera, canvas, group, getRect: () => charRect(), getBox: () => (charRect() ? box : null), emote, moves, ov, dbg,
      state: () => {
        const s = group()?.scale.y || 1
        return {
          ready: !!grab.base && moves.name !== 'rise', grabbing: grab.on, carried: grab.on || grab.falling,
          liftWorld: grab.lift * s, height: H * s,
          talking: !!(talk && talk.busy) || performance.now() - replyAt < 6500,
        }
      },
    })
  }

  // raise it like a virtual pet (pet.js): hunger / mood / level, floating status panel and buttons
  let pet = null
  if (ov.handPet !== false && game) {
    const { createPet } = await import('./pet.js?v=20261104l')
    pet = createPet({
      THREE, scene, getCamera, canvas, group, getRect: () => charRect(), getBox: () => (charRect() ? box : null),
      emote, moves, ov, dbg, getHand: () => hand,
      state: () => {
        const s = group()?.scale.y || 1
        return {
          ready: !!grab.base && moves.name !== 'rise', grabbing: grab.on, height: H * s, challenge: !!game?.challenge,
          talking: !!(talk && talk.busy) || performance.now() - replyAt < 6500,
        }
      },
    })
    game.setPet(pet)
    talk?.hideButton()
    const J = ov.talkLang === 'en' ? 0 : 1, T2 = (en, ja) => (J ? ja : en)
    pet.on('pet', () => { emote('happy', 1500); game.pop(T2('♪', '♪')) ; window.dispatchEvent(new CustomEvent('handplay:poke', { detail: { pet: true } })) })
    pet.on('talk', () => { talk?.unlock(); talk?.poke() })
    pet.on('play', () => game.startChallenge())
    pet.on('ate', () => { emote('happy', 1800); game.pop(T2('Yum!', 'もぐもぐ！'), '#ffb347') })
    pet.on('full', () => { moves.play('lookAround'); game.say(T2("I'm full!", 'おなかいっぱい！'), 2500) })
    pet.on('need', (k) => {
      emote('sad', 3000)
      game.say(k === 'hungry' ? T2("I'm hungry… (press Food)", 'おなかすいた…（ごはんを押してね）') : T2('Play with me!', 'あそんで〜！'), 4500)
    })
    pet.on('levelup', (lv) => game.celebrate(lv))
    window.__hpPet = pet
  }

  // landmark -> CSS pixel on the AR canvas. Devices draw the camera "cover" (cropped to fill);
  // the emulator stretches its fake feed over the whole canvas.
  function toScreen(p, w, h) {
    const W = canvas.clientWidth, Hh = canvas.clientHeight
    if (window.__emu) return { x: p.x * W, y: p.y * Hh }
    const s = Math.max(W / w, Hh / h)
    return { x: p.x * w * s - (w * s - W) / 2, y: p.y * h * s - (h * s - Hh) / 2 }
  }
  function floorAt(px) {
    const cam = getCamera()
    ndc.set((px.x / canvas.clientWidth) * 2 - 1, -(px.y / canvas.clientHeight) * 2 + 1)
    ray.setFromCamera(ndc, cam)
    const g = group()
    floor.constant = -(g ? g.position.y : 0)
    return ray.ray.intersectPlane(floor, hit) ? hit : null
  }
  // the character's bounds on screen (all GLB / image meshes in the content group)
  function charRect() {
    const c = content(), cam = getCamera()
    if (!c || !cam) return null
    box.makeEmpty()
    // the character only: skip shadow catchers / baked shadow planes and see-through helpers
    c.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry || o === cursor) return
      if (/shadow/i.test(o.name || '') || o.material?.isShadowMaterial || (o.material?.transparent && o.material?.depthWrite === false)) return
      if (o.isSkinnedMesh || o.userData._overlayId) box.expandByObject(o)
    })
    if (box.isEmpty()) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(cam)
      const sx = (corner.x + 1) / 2 * canvas.clientWidth, sy = (1 - corner.y) / 2 * canvas.clientHeight
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy)
    }
    const padX = (x1 - x0) * 0.25, padY = (y1 - y0) * 0.15
    return { x0: x0 - padX, y0: y0 - padY, x1: x1 + padX, y1: y1 + padY }
  }
  const inRect = (p, r) => r && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1

  // held: the pinch ray on the upright plane through the character (normal = camera forward, flat)
  function grabPoint(px) {
    ndc.set((px.x / canvas.clientWidth) * 2 - 1, -(px.y / canvas.clientHeight) * 2 + 1)
    ray.setFromCamera(ndc, getCamera())
    grab.plane.setFromNormalAndCoplanarPoint(grab.fwd, tmp.copy(grab.p0).addScaledVector(grab.fwd, grab.depth))
    return ray.ray.intersectPlane(grab.plane, hit2) ? hit2 : null
  }
  // baked floor shadows inside the GLB stay where they were on the floor while the body is lifted
  function shadows(c) {
    const out = []
    c.traverse((o) => { if (o.isMesh && (/shadow/i.test(o.name || '') || o.material?.isShadowMaterial)) out.push(o) })
    return out
  }
  // shadow matrices relative to the group, taken once at rest; each frame they follow the travel
  // offset on the floor and fade / shrink with the height
  const mOff = new THREE.Matrix4()
  function restShadowRel(c, g) {
    g.updateMatrixWorld(true)
    mA.copy(g.matrixWorld).invert()
    for (const o of shadows(c)) {
      o.userData._hpRest = { op: o.material.opacity }
      o.userData._hpRel = mA.clone().multiply(o.matrixWorld)
      // the baked blob sits exactly at floor height, where the floor / shadow-catcher plane is too:
      // it lost the depth test and vanished. Draw it just above and after the floor.
      o.material.polygonOffset = true; o.material.polygonOffsetFactor = -4; o.material.polygonOffsetUnits = -4
      // and draw both faces: older generated GLBs wound the blob facing down, so from above it was culled
      o.material.side = THREE.DoubleSide; o.material.needsUpdate = true
      o.renderOrder = Math.max(o.renderOrder, 2)
    }
  }
  function pinShadows(c, g, heightWorld, ox, oz) {
    mOff.makeTranslation(ox, 0.004 / (g.scale.y || 1), oz)   // ~4 mm above the floor
    for (const o of shadows(c)) {
      const u = o.userData
      if (!u._hpRel) continue
      mA.multiplyMatrices(g.matrixWorld, mOff).multiply(u._hpRel)
      mB.copy(o.parent.matrixWorld).invert().multiply(mA)
      mB.decompose(o.position, o.quaternion, o.scale)
      const f = Math.max(0.25, 1 - heightWorld / 0.9)
      o.scale.multiplyScalar(0.6 + 0.4 * f)
      o.material.opacity = u._hpRest.op * f
    }
  }

  // --- gestures from 21 landmarks ----------------------------------------------------------------
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  function classify(lm) {
    const size = d2(lm[0], lm[9]) || 1e-3
    const gap = d2(lm[4], lm[8]) / size
    const ext = (tip, pip) => d2(lm[0], lm[tip]) > d2(lm[0], lm[pip]) * 1.12
    const index = ext(8, 6), middle = ext(12, 10), ring = ext(16, 14), pinky = ext(20, 18)
    return {
      gap,
      poke: index && !middle && !ring && !pinky && gap > PINCH_OFF,
      palm: index && middle && ring && pinky && gap > 0.6,
    }
  }

  let lastDetect = 0
  function detect(now) {
    if (now - lastDetect < 1000 / DETECT_HZ) return
    const src = testSource()
    // emulator tests may inject landmarks directly ({ lm: [21 points], w, h }) to drive the gestures
    const inj = window.__emu && window.__handPlayInject
    const input = inj ? { w: inj.w || 390, h: inj.h || 844 } : src ? { data: src, w: src.width, h: src.height } : frame
    if (!input) return
    lastDetect = now
    const res = inj ? { landmarks: inj.lm ? [inj.lm] : [] } : landmarker.detectForVideo(input.data, now)
    const lm = res.landmarks && res.landmarks[0]
    if (!lm) { if (now - hand.lastSeen > LOST_MS) hand.seen = false; return }
    hand.seen = true; hand.lastSeen = now; hand.lm = lm
    const g = classify(lm)
    hand.pinch = hand.pinch ? g.gap < PINCH_OFF : g.gap < PINCH_ON
    const mid = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 }
    hand.pinchPx = toScreen(mid, input.w, input.h)
    hand.indexPx = toScreen(lm[8], input.w, input.h)
    hand.palmPx = toScreen(lm[9], input.w, input.h)
    const w0 = toScreen(lm[0], input.w, input.h)
    hand.size = d2(w0, hand.palmPx)
    hand.poke = g.poke; hand.palm = g.palm
    if (dbgCanvas) drawDebug(lm, input.w, input.h)
  }
  function drawDebug(lm, w, h) {
    const c = dbgCanvas, x = c.getContext('2d'), rc = canvas.getBoundingClientRect()
    Object.assign(c.style, { left: rc.left + 'px', top: rc.top + 'px', width: rc.width + 'px', height: rc.height + 'px', inset: 'auto' })
    c.width = rc.width; c.height = rc.height
    x.clearRect(0, 0, c.width, c.height)
    x.fillStyle = hand.pinch ? '#29e0ff' : '#fff'
    for (const p of lm) { const s = toScreen(p, w, h); x.fillRect(s.x - 3, s.y - 3, 6, 6) }
    const r = charRect()
    if (r) { x.strokeStyle = '#ffd400'; x.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0) }
  }

  // --- interaction --------------------------------------------------------------------------------
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent('handplay:' + name, { detail }))
  let pokeArmed = true, palmSince = 0
  let last = performance.now()
  function update(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now
    detect(now)
    talk?.update(dt)
    game?.update(dt)
    pet?.update(dt)
    const g = group(), c = content()
    if (!g || !c || !g.parent) { cursor.material.opacity = 0; return }

    const p = hand.seen && hand.pinchPx ? floorAt(hand.pinchPx) : null
    if (p) { cursor.position.set(p.x, p.y + 0.005, p.z); cursor.material.opacity = 0.85 } else cursor.material.opacity = 0
    const rect = hand.seen ? charRect() : null
    const over = hand.seen && inRect(hand.pinchPx, rect)
    cursor.material.color.set(grab.on ? 0x29e0ff : over ? 0xffd400 : 0xffffff)
    cursor.scale.setScalar(grab.on ? 1.6 : 1)

    // first frame with the character: measure it at rest, keep the shadows' rest place, rise from the floor
    if (!grab.base) {
      if (!charRect()) return
      const sc = g.scale.y || 1
      H = Math.max(0.05, (box.max.y - box.min.y) / sc); T = Math.min(0.2 * H, (box.max.z - box.min.z) / sc)
      c.rotation.order = 'ZXY'
      grab.base = { x: c.position.x, z: c.position.z }
      restShadowRel(c, g)
      if (ov.handMoves !== false) moves.play('rise')
    }

    // pinch: pick up / carry / drop
    if (!grab.on && hand.seen && hand.pinch && over && p && ov.handGrab !== false) {
      // whatever move it was in, it is caught where it is: fold the travel / hop into the carry
      const mp = moves.pose
      if (H && (mp.x || mp.z || mp.y)) {
        tmp.set(mp.x * H, 0, mp.z * H).multiplyScalar(g.scale.y || 1).applyQuaternion(g.quaternion)
        g.position.add(tmp)
        grab.lift += mp.y * H
      }
      moves.cancel()
      const cam = getCamera()
      cam.getWorldDirection(grab.fwd); grab.fwd.y = 0
      if (grab.fwd.lengthSq() < 1e-6) grab.fwd.set(0, 0, -1)
      grab.fwd.normalize()
      grab.p0.set(g.position.x, g.position.y, g.position.z); grab.depth = 0
      const hp = grabPoint(hand.pinchPx)
      if (hp) {
        const s = g.scale.y || 1, H = Math.max(0.05, box.max.y - box.min.y)   // box: world bounds from charRect()
        grab.on = true; grab.falling = false
        grab.offset.set(g.position.x - hp.x, 0, g.position.z - hp.z)
        grab.y0 = hp.y; grab.lift0 = grab.lift; grab.size0 = hand.size || 0
        grab.dist0 = Math.max(0.3, Math.hypot(g.position.x - cam.position.x, g.position.z - cam.position.z))
        grab.pivot = Math.min(H, Math.max(H * 0.35, hp.y - g.position.y - grab.lift * s)) / s
        grab.vLat = 0
        emit('grab', {}); clip('dangle'); face('surprised')
      }
    } else if (grab.on && (!hand.seen || !hand.pinch)) {
      grab.on = false; grab.falling = true; grab.fallV = 0
      emit('drop', {}); setTimeout(() => face('neutral'), 900)
    }
    const s = g.scale.y || 1
    let accel = 0
    if (grab.on) {
      // nearer / farther from the apparent hand size (bigger hand = closer to the camera)
      if (hand.seen && hand.size && grab.size0) {
        const r = grab.size0 / hand.size
        let want = Math.abs(r - 1) < 0.08 ? 0 : grab.dist0 * (r - 1)
        want = Math.max(0.3 - grab.dist0, Math.min(1.2, want))
        grab.depth += (want - grab.depth) * (1 - Math.exp(-dt * 4))
      }
      const hp = hand.seen && hand.pinchPx ? grabPoint(hand.pinchPx) : null
      if (hp) {
        const k = 1 - Math.exp(-dt * 14)
        const px0 = g.position.x, pz0 = g.position.z
        const tx = hp.x + grab.offset.x, tz = hp.z + grab.offset.z
        g.position.x += (tx - px0) * k
        g.position.z += (tz - pz0) * k
        // sideways speed along the camera's right drives the swing
        const vl = dt > 0 ? ((g.position.x - px0) * -grab.fwd.z + (g.position.z - pz0) * grab.fwd.x) / dt : 0
        accel = Math.max(-25, Math.min(25, dt > 0 ? (vl - grab.vLat) / dt : 0))
        grab.vLat = vl
        const want = Math.max(0.06 / s, Math.min(MAX_LIFT / s, grab.lift0 + (hp.y - grab.y0) / s))
        grab.lift += (want - grab.lift) * k
      }
      grab.t += dt
    } else if (grab.falling) {
      grab.fallV -= 9.8 * dt / s
      grab.lift += grab.fallV * dt
      if (grab.lift <= 0) {
        if (grab.fallV < -0.3) { grab.squash = Math.min(0.28, -grab.fallV * s * 0.09); grab.squashV = 0; clip('land') }
        grab.lift = 0; grab.fallV = -grab.fallV * 0.3
        if (Math.abs(grab.fallV) * s < 0.25) { grab.falling = false; grab.fallV = 0 }
      }
    }
    // pendulum from the pinch point: theta'' = -(g/L) theta - c theta' + a/L
    const L = Math.max(0.05, grab.pivot * s)
    // (sign: the body lags behind the hand; the feet trail the way it came from)
    const onFloor = !grab.on && grab.lift <= 0.001
    grab.omega += (-(9.8 / L) * grab.theta - (grab.on ? 2.2 : onFloor ? 18 : 5) * grab.omega - (grab.on ? accel / L : 0)) * dt
    grab.theta = Math.max(-0.6, Math.min(0.6, grab.theta + grab.omega * dt))
    if (onFloor) grab.theta *= Math.exp(-dt * 10)   // feet on the floor: stand back up
    // legs kicking while held
    const kick = grab.on ? Math.sin(grab.t * 11) * 0.07 + Math.sin(grab.t * 17.3) * 0.03 : 0
    // landing squash spring
    grab.squashV += (-220 * grab.squash - 14 * grab.squashV) * dt
    grab.squash += grab.squashV * dt
    // compose everything on the content group: the move (travel / hop / turn / lean / lying flat /
    // squash), the carry (lift + pendulum around the pinch point), talk's facing and bob
    const mp = moves.update(dt, ov.handMoves !== false && !grab.on && !grab.falling && !(talk && talk.busy) && !game?.chasing)
    invQ.copy(g.quaternion).invert(); axis.copy(grab.fwd).applyQuaternion(invQ)
    const phi = grab.theta + kick
    const tf = c.userData._talkFace || 0
    c.rotation.y = mp.yaw * (1 - tf) + (c.userData._talkYaw || 0) * tf
    c.rotation.x = phi * axis.x - mp.flat * Math.PI / 2 + mp.lean
    c.rotation.z = phi * axis.z
    const pivot = grab.on || grab.falling || Math.abs(phi) > 1e-3 ? grab.pivot : 0
    tmp.set(0, pivot, 0).applyEuler(c.rotation)
    c.position.set(grab.base.x + mp.x * H - tmp.x, grab.lift + mp.y * H + mp.flat * T + pivot - tmp.y, grab.base.z + mp.z * H - tmp.z)
    const gr = pet ? pet.growth : 1
    let sx = mp.sx * gr, sy = mp.sy * gr
    if (grab.on) { const st = 1.05 + Math.sin(grab.t * 11 + 1) * 0.03; sy *= st; sx /= Math.sqrt(st) }
    else { sy *= 1 - grab.squash; sx *= 1 + grab.squash * 0.6 }
    const bob = c.userData._talkBob || 1
    c.scale.set(sx * bob, sy * bob, sx * bob)
    c.updateMatrixWorld(true)
    pinShadows(c, g, (grab.lift + mp.y * H) * s, mp.x * H, mp.z * H)
    if (!grab.on && !grab.falling && Math.abs(grab.theta) < 0.002 && Math.abs(grab.omega) < 0.01) grab.theta = grab.omega = 0
    if (grab.on) { cursor.position.set(g.position.x, g.position.y + 0.005, g.position.z); cursor.material.opacity = 0.85 }

    // poke the character with the index finger: it reacts
    if (!grab.on && hand.seen && hand.poke && inRect(hand.indexPx, rect) && !pet?.aiming) {
      if (pokeArmed) { pokeArmed = false; emit('poke', { x: hand.indexPx.x, y: hand.indexPx.y }) }
    } else if (!hand.poke) pokeArmed = true

    // open palm held toward the character: cast from the hand
    if (!grab.on && hand.seen && hand.palm) {
      if (!palmSince) palmSince = now
      if (now - palmSince > 450) {
        palmSince = now + 2500   // one cast, then a cool-down
        const from = floorAt(hand.palmPx)
        emit('palm', { from: from ? [from.x, from.y + 0.6, from.z] : null })
      }
    } else if (palmSince && palmSince < now) palmSince = 0
  }

  let running = true
  ;(function loop() { if (!running) return; try { update(performance.now()) } catch (e) { dbg('HandPlay: ' + e.message) } requestAnimationFrame(loop) })()

  return {
    get hand() { return hand },
    get talk() { return talk },
    get grabbing() { return grab.on },
    get carried() { return grab.on || grab.falling },
    get game() { return game },
    stop() { running = false; cursor.removeFromParent(); dbgCanvas?.remove(); landmarker.close() },
  }
}
