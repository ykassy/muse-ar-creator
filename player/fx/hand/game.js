// Wish game (for kids): the character asks for something - lift me up high, carry me to the glowing
// ring, talk to me, show me magic, pet me - with a card over its head and the device voice (small
// children can't read yet). Granting a wish: it cheers (move + spell + chime) and a heart is added;
// hearts raise the friendship level, and level-ups get a bigger celebration. A wish nobody grants in
// 30 s is swapped for another one. Everything it needs comes from hand-play.js through `api`.

const WISHES = {
  lift: { ja: '高いところに連れてって！', en: 'Lift me up high!' },
  ring: { ja: 'あの光の輪まで運んで！', en: 'Carry me to the glowing ring!' },
  talk: { ja: 'お話しして！', en: 'Talk to me!' },
  magic: { ja: '手のひらを見せて！魔法を出すよ', en: 'Show me your palm! I will do magic' },
  pet: { ja: 'なでて！', en: 'Pet me!' },
  chase: { ja: 'つかまえてごらん！タップでシャボン玉！', en: 'Catch me if you can! Tap to blow bubbles!' },
}
const CHASE_S = 25, CHASE_HITS = 3, DODGE_CHANCE = 0.5
const CHALLENGE_S = 20   // the timed mini game: hit it as many times as you can
const THANKS = { ja: ['ありがとう！', 'やったー！', 'だいすき！', 'うれしい！'], en: ['Thank you!', 'Yay!', 'I love it!', 'So happy!'] }
const LEVELS = [3, 6, 10, 15, 21]
const GIVE_UP_S = 30

const HEART = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#ff4d7a" d="M12 21s-7.5-4.6-9.6-9.1C.9 8.6 2.9 4.8 6.6 4.5c2.1-.2 3.9 1 5.4 2.9 1.5-1.9 3.3-3.1 5.4-2.9 3.7.3 5.7 4.1 4.2 7.4C19.5 16.4 12 21 12 21z"/></svg>'
const CSS = `
.hp-hud{position:fixed;z-index:62;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:7px 14px 7px 10px;border-radius:20px;
  background:rgba(20,20,28,.42);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:#fff;font:700 15px/1 -apple-system,"Hiragino Sans",sans-serif;pointer-events:none;transition:transform .2s}
.hp-hud .lv{font-size:12px;font-weight:600;opacity:.85;margin-left:4px}
.hp-hud.pop{transform:translateX(-50%) scale(1.18)}
.hp-wish{position:fixed;z-index:59;transform:translate(-50%,-100%);max-width:70vw;padding:9px 14px;border-radius:16px;background:#ffe45c;color:#3a2a00;
  font:700 15px/1.35 -apple-system,"Hiragino Sans",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none;opacity:0;transition:opacity .25s;white-space:nowrap}
.hp-wish:after{content:"";position:absolute;left:50%;bottom:-7px;margin-left:-7px;border:7px solid transparent;border-bottom:0;border-top-color:#ffe45c}
.hp-wish .bar{position:absolute;left:10px;right:10px;bottom:3px;height:3px;border-radius:2px;background:rgba(58,42,0,.25);overflow:hidden}
.hp-wish .bar i{display:block;height:100%;background:#3a2a00;opacity:.55}
.hp-heart{position:fixed;z-index:63;pointer-events:none;transform:translate(-50%,-50%);transition:left .9s cubic-bezier(.5,0,.75,0),top .9s cubic-bezier(.3,1.4,.6,1),opacity .9s}
.hp-start{position:fixed;z-index:62;display:flex;align-items:center;gap:6px;padding:8px 14px 8px 11px;border-radius:18px;background:linear-gradient(135deg,#ff6fa3,#ffb36b);color:#fff;
  font:800 14px/1 -apple-system,"Hiragino Sans",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
.hp-start:active{transform:scale(.95)}
.hp-timer{position:fixed;z-index:63;transform:translateX(-50%);width:min(78vw,340px);padding:9px 14px 11px;border-radius:18px;background:rgba(20,20,28,.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  color:#fff;font:800 15px/1 -apple-system,"Hiragino Sans",sans-serif;pointer-events:none;display:none}
.hp-timer .row{display:flex;justify-content:space-between;align-items:baseline}
.hp-timer .sec{font-size:26px}.hp-timer .sc{font-size:22px;color:#ffe45c}
.hp-timer .bar{margin-top:8px;height:7px;border-radius:4px;background:rgba(255,255,255,.22);overflow:hidden}
.hp-timer .bar i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#5ef0c2,#ffe45c);transition:background .3s}
.hp-timer.hurry .bar i{background:#ff5470}.hp-timer.hurry .sec{color:#ff7a8e}
.hp-plus{position:fixed;z-index:63;pointer-events:none;transform:translate(-50%,-50%);color:#ffe45c;font:900 26px/1 -apple-system,"Hiragino Sans",sans-serif;text-shadow:0 2px 8px rgba(0,0,0,.4);transition:transform .7s ease-out,opacity .7s}
.hp-result{position:fixed;z-index:65;left:50%;top:50%;transform:translate(-50%,-50%);width:min(82vw,330px);padding:20px 18px 16px;border-radius:24px;background:rgba(255,255,255,.96);color:#222;
  font:600 14px/1.4 -apple-system,"Hiragino Sans",sans-serif;box-shadow:0 16px 44px rgba(0,0,0,.35);text-align:center;display:none}
.hp-result h3{margin:0 0 4px;font-size:16px;color:#888}.hp-result .big{font-size:46px;font-weight:900;color:#ff5c8a;line-height:1.1}
.hp-result ol{list-style:none;margin:12px 0 14px;padding:0;text-align:left}
.hp-result li{display:flex;justify-content:space-between;padding:6px 10px;border-radius:10px}
.hp-result li.me{background:#fff2a8;font-weight:800}
.hp-result .btns{display:flex;gap:8px;justify-content:center}
.hp-result button{border:0;border-radius:14px;padding:10px 16px;font:800 14px/1 -apple-system,"Hiragino Sans",sans-serif;cursor:pointer}
.hp-result .again{background:linear-gradient(135deg,#ff6fa3,#ffb36b);color:#fff}.hp-result .close{background:#eee;color:#555}
.hp-banner{position:fixed;z-index:64;left:50%;top:40%;transform:translate(-50%,-50%) scale(.6);padding:14px 22px;border-radius:22px;background:linear-gradient(135deg,#ff6fa3,#ffb36b);
  color:#fff;font:800 22px/1.2 -apple-system,"Hiragino Sans",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .3s,transform .35s cubic-bezier(.3,1.6,.5,1)}
`

export function createGame(api) {
  const { THREE, scene, getCamera, canvas, group, getRect, getBox, state, emote, moves, ov = {}, dbg = () => {} } = api
  const lang = ov.talkLang === 'en' ? 'en' : 'ja'
  const T = (o) => o[lang]
  let hearts = 0, level = 0, wish = null, wishT = 0, gap = 4, last = '', voiceOK = false

  if (!document.getElementById('hp-game-css')) {
    const st = document.createElement('style'); st.id = 'hp-game-css'; st.textContent = CSS; document.head.appendChild(st)
  }
  const hud = document.createElement('div'); hud.className = 'hp-hud'
  const card = document.createElement('div'); card.className = 'hp-wish'
  const banner = document.createElement('div'); banner.className = 'hp-banner'
  const startBtn = document.createElement('div'); startBtn.className = 'hp-start'; startBtn.setAttribute('role', 'button')
  startBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#fff" d="M7 5v14l11-7z"/></svg>' + (lang === 'en' ? '20s challenge' : '20秒チャレンジ')
  const timer = document.createElement('div'); timer.className = 'hp-timer'
  timer.innerHTML = '<div class="row"><span class="sec"></span><span class="sc"></span></div><div class="bar"><i></i></div>'
  const result = document.createElement('div'); result.className = 'hp-result'
  document.body.append(hud, card, banner, startBtn, timer, result)
  for (const el of [startBtn, result]) { el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true }); el.addEventListener('pointerdown', (e) => e.stopPropagation()) }
  function drawHud() { hud.innerHTML = `${HEART}<span>${hearts}</span><span class="lv">${lang === 'en' ? 'Friend Lv' : 'なかよし Lv'}${level + 1}</span>` }
  drawHud()

  // glowing target ring on the floor (the "carry me there" wish)
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x7fe7ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), ringMat)
  const ringFill = new THREE.Mesh(new THREE.CircleGeometry(0.8, 48), new THREE.MeshBasicMaterial({ color: 0x7fe7ff, transparent: true, opacity: 0, depthWrite: false }))
  const flatG = new THREE.Group(); flatG.add(ring, ringFill); flatG.rotation.x = -Math.PI / 2
  // a soft column of light standing on the ring, so it reads as "bring me here" from anywhere
  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uT: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec2 vUv; uniform float uT; void main(){ float a = (1.0 - vUv.y) * (0.35 + 0.15 * sin(uT * 4.0)) * (0.6 + 0.4 * sin(vUv.x * 6.2832 * 6.0 + uT * 3.0)); gl_FragColor = vec4(0.5, 0.92, 1.0, a); }',
  })
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 3, 40, 1, true), beamMat)
  beam.position.y = 1.5
  const ringG = new THREE.Group(); ringG.add(flatG, beam); ringG.visible = false
  scene.add(ringG)
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3()
  let ringR = 0.2

  // the device voice, same as the character's replies (works once a tap has unlocked speech on iOS)
  function speak(text) {
    if (!window.speechSynthesis || !voiceOK) return
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang === 'en' ? 'en-US' : 'ja-JP'; u.pitch = 1.35; u.rate = 1.05
    const v = speechSynthesis.getVoices().find((x) => x.lang.startsWith(lang)); if (v) u.voice = v
    speechSynthesis.speak(u)
  }
  // a little chime (own audio context, created on the first tap)
  let actx = null
  const unlock = () => {
    voiceOK = true
    try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume() } catch { /* no audio */ }
  }
  window.addEventListener('touchend', unlock, { passive: true })
  window.addEventListener('click', unlock)
  function chime(big) {
    if (!actx || actx.state !== 'running') return
    const notes = big ? [784, 988, 1175, 1568] : [880, 1319]
    notes.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * 0.09
      o.type = 'triangle'; o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45)
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.5)
    })
  }

  // a heart flies from the character to the counter
  function flyHeart() {
    const rc = getRect(), r = canvas.getBoundingClientRect(), h = hud.getBoundingClientRect()
    if (!rc) return
    const el = document.createElement('div'); el.className = 'hp-heart'; el.innerHTML = HEART.replace(/20/g, '34')
    el.style.left = (r.left + (rc.x0 + rc.x1) / 2) + 'px'; el.style.top = (r.top + rc.y0 + (rc.y1 - rc.y0) * 0.3) + 'px'
    document.body.appendChild(el)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.left = (h.left + 18) + 'px'; el.style.top = (h.top + h.height / 2) + 'px'; el.style.opacity = '0.2'
    }))
    setTimeout(() => { el.remove(); hud.classList.add('pop'); setTimeout(() => hud.classList.remove('pop'), 220) }, 900)
  }
  function showBanner(text) {
    banner.textContent = text
    banner.style.opacity = '1'; banner.style.transform = 'translate(-50%,-50%) scale(1)'
    setTimeout(() => { banner.style.opacity = '0'; banner.style.transform = 'translate(-50%,-50%) scale(.6)' }, 2200)
  }

  // --- catch me if you can: it runs around, taps blow bubbles at it, it sometimes dodges -----------
  const chase = { on: false, t: 0, hits: 0, target: new THREE.Vector3(), home: new THREE.Vector3(), dodge: 0, lastDodge: -9 }
  const bubbles = []
  // a bubble you can see against any floor: rainbow rim, bright highlight, soft glow
  const bubbleTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128
    const x = c.getContext('2d')
    const glow = x.createRadialGradient(64, 64, 30, 64, 64, 64)
    glow.addColorStop(0, 'rgba(255,255,255,0)'); glow.addColorStop(0.8, 'rgba(255,255,255,0.18)'); glow.addColorStop(1, 'rgba(255,255,255,0)')
    x.fillStyle = glow; x.fillRect(0, 0, 128, 128)
    x.fillStyle = 'rgba(190,235,255,0.22)'; x.beginPath(); x.arc(64, 64, 50, 0, Math.PI * 2); x.fill()
    x.lineWidth = 7
    for (let a = 0; a < 360; a += 6) {
      x.strokeStyle = `hsla(${a},95%,65%,0.95)`
      x.beginPath(); x.arc(64, 64, 50, (a * Math.PI) / 180, ((a + 7) * Math.PI) / 180); x.stroke()
    }
    x.lineWidth = 2.5; x.strokeStyle = 'rgba(255,255,255,0.95)'; x.beginPath(); x.arc(64, 64, 54, 0, Math.PI * 2); x.stroke()
    x.fillStyle = 'rgba(255,255,255,0.95)'; x.beginPath(); x.ellipse(46, 42, 15, 8, -0.6, 0, Math.PI * 2); x.fill()
    x.beginPath(); x.arc(82, 84, 4, 0, Math.PI * 2); x.fill()
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
  })()
  const sparkTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64
    const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(180,240,255,0.8)'); g.addColorStop(1, 'rgba(120,200,255,0)')
    x.fillStyle = g; x.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(c)
  })()
  const starTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64
    const x = c.getContext('2d'); x.translate(32, 32); x.fillStyle = '#fff3a0'
    x.beginPath()
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 11 : 28, a = (i * Math.PI) / 5 - Math.PI / 2; x.lineTo(Math.cos(a) * r, Math.sin(a) * r) }
    x.closePath(); x.shadowColor = '#ffd23f'; x.shadowBlur = 8; x.fill()
    return new THREE.CanvasTexture(c)
  })()
  // short-lived sprites: the bubble's trail and the burst when it hits
  const bits = []
  function bit(tex, pos, size, vel, life, color) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: color || 0xffffff }))
    sp.position.copy(pos); sp.scale.setScalar(size); scene.add(sp)
    bits.push({ sp, vel: vel || new THREE.Vector3(), life: 0, max: life, size })
  }
  function updateBits(dt) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i]; b.life += dt
      const k = b.life / b.max
      b.sp.position.addScaledVector(b.vel, dt); b.vel.multiplyScalar(Math.exp(-dt * 3)); b.vel.y -= dt * 0.6
      b.sp.material.opacity = Math.max(0, 1 - k); b.sp.scale.setScalar(b.size * (1 - k * 0.5))
      b.sp.material.rotation += dt * 4
      if (k >= 1) { b.sp.removeFromParent(); b.sp.material.dispose(); bits.splice(i, 1) }
    }
  }
  function burst(pos, size) {
    for (let i = 0; i < 12; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(size * (3 + Math.random() * 3))
      bit(starTex, pos, size * (0.35 + Math.random() * 0.25), v, 0.6 + Math.random() * 0.3)
    }
    bit(sparkTex, pos, size * 2.4, null, 0.3)
  }
  // big text over the character: hits and dodges should read at a glance
  function popText(text, color) {
    const [x, y] = charScreen()
    const el = document.createElement('div'); el.className = 'hp-plus'; el.textContent = text
    el.style.color = color; el.style.fontSize = '30px'; el.style.left = x + 'px'; el.style.top = (y - 30) + 'px'
    document.body.appendChild(el)
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transform = 'translate(-50%,-190%) scale(1.25)'; el.style.opacity = '0' }))
    setTimeout(() => el.remove(), 750)
  }
  const tmpV = new THREE.Vector3(), tmpC = new THREE.Vector3(), ndcV = new THREE.Vector2()
  function floorPoint(sx, sy, out) {
    const cam = getCamera(), g = group()
    ray.setFromCamera(ndcV.set(sx * 2 - 1, -(sy * 2 - 1)), cam)
    plane.constant = -g.position.y
    return ray.ray.intersectPlane(plane, out)
  }
  // run targets stay around where the chase started, and on screen (a tall character running at the
  // camera fills the screen)
  function newRunTarget() {
    const cam = getCamera(), s = state(), f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize()
    const right = new THREE.Vector3(-f.z, 0, f.x)
    const c0 = chase.home.clone().project(cam), c1 = chase.home.clone().add(right).project(cam)
    const perM = Math.abs(c1.x - c0.x) || 1
    // keep the whole body on screen: half its on-screen width (charRect is padded 25% per side)
    const rc = getRect(), half = rc ? (rc.x1 - rc.x0) / 1.5 / canvas.clientWidth : 0.2
    const lim = Math.max(0.15, 0.95 - half)
    for (let i = 0; i < 8; i++) {
      const nx = (Math.random() * 2 - 1) * lim   // NDC x offset from home
      chase.target.copy(chase.home).addScaledVector(right, nx / perM).addScaledVector(f, (Math.random() * 2 - 1) * s.height * 0.4)
      const p = chase.target.clone().project(cam)
      if (Math.abs(p.x) < lim) return
    }
    chase.target.copy(chase.home)
  }
  function startChase() {
    chase.on = true; chase.t = 0; chase.hits = 0; chase.dodge = 0; chase.mode = 'wish'; chase.lastDodge = -9; chase.dodges = 0
    chase.home.copy(group().position)
    newRunTarget()
  }
  function endChase() {
    chase.on = false
    for (const b of bubbles) b.sprite.removeFromParent()
    bubbles.length = 0
  }
  function say(text) { card.innerHTML = text; card.style.opacity = '1' }
  function shoot(px, py) {
    const cam = getCamera(), g = group(), s = state()
    if (!cam || !g) return
    ray.setFromCamera(ndcV.set(px * 2 - 1, -(py * 2 - 1)), cam)
    const dir = ray.ray.direction.clone()
    const box = getBox(); if (!box) return
    box.getCenter(tmpC)
    const dist = Math.max(0.3, tmpC.distanceTo(cam.position))
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: bubbleTex, transparent: true, depthWrite: false }))
    const size = Math.max(0.08, s.height * 0.3)
    sprite.scale.setScalar(size * 0.5)
    // starts a little below the middle of the screen, from the phone
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(cam.quaternion)
    sprite.position.copy(cam.position).addScaledVector(dir, 0.15).addScaledVector(down, 0.05)
    scene.add(sprite)
    bubbles.push({ sprite, vel: dir.multiplyScalar(dist / 0.55), life: 0, size, done: false, trail: 0 })
    // will it hit? the character may hop out of the way
    const toC = tmpV.copy(tmpC).sub(cam.position), along = toC.dot(ray.ray.direction)
    const closest = toC.clone().sub(ray.ray.direction.clone().multiplyScalar(along)).length()
    const hitR = Math.max((box.max.x - box.min.x) * 0.5, s.height * 0.3)
    // in the challenge it gets better at dodging as the score goes up
    const dodgeP = chase.mode === 'challenge' ? Math.min(0.8, 0.45 + ch.score * 0.05) : DODGE_CHANCE
    if (closest < hitR && chase.t - chase.lastDodge > (chase.mode === 'challenge' ? 0.45 : 0.7) && Math.random() < dodgeP) {
      const side = new THREE.Vector3(ray.ray.direction.z, 0, -ray.ray.direction.x).normalize()
      const off = toC.clone().sub(ray.ray.direction.clone().multiplyScalar(along))
      let sign = off.dot(side) >= 0 ? 1 : -1
      // sidestep clear of the bubble (its width + the body's) if that stays on screen; otherwise
      // jump over it
      const rc = getRect(), lim = Math.max(0.15, 0.95 - (rc ? (rc.x1 - rc.x0) / 1.5 / canvas.clientWidth : 0.2))
      const need = (box.max.x - box.min.x) * 0.75 + size
      let sideOK = false
      for (let k = 0; k < 2 && !sideOK; k++) {
        chase.target.copy(g.position).addScaledVector(side, sign * need)
        if (Math.abs(chase.target.clone().project(cam).x) < lim) sideOK = true
        else sign = -sign
      }
      if (sideOK) { setTimeout(() => moves.play('dodge'), 60); setTimeout(() => popText(lang === 'en' ? 'Dodge!' : 'ひょいっ！', '#7fe7ff'), 120) }
      else { chase.target.copy(g.position); moves.play('hopOver'); setTimeout(() => popText(lang === 'en' ? 'Jump!' : 'ジャンプ！', '#7fe7ff'), 120) }
      chase.dodge = 0.3; chase.lastDodge = chase.t; chase.dodges = (chase.dodges || 0) + 1
      if (Math.random() < 0.6) setTimeout(() => speak(lang === 'en' ? 'Missed!' : 'はずれ〜！'), 250)
    }
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!chase.on) return
    const r = canvas.getBoundingClientRect()
    shoot((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
  })
  function updateChase(dt, s) {
    const g = group()
    chase.t += dt
    // run around (not while held)
    if (!s.grabbing && !s.carried) {
      const to = tmpV.copy(chase.target).sub(g.position); to.y = 0
      const fast = chase.mode === 'challenge' ? 1 + Math.min(0.8, ch.score * 0.06) : 1
      const d = to.length(), speed = s.height * (chase.dodge > 0 ? 4.5 : 1.3 * fast)
      if (d < s.height * 0.08) newRunTarget()
      else g.position.addScaledVector(to.normalize(), Math.min(d, speed * dt))
      if (!moves.name) moves.play('scamper')
    }
    chase.dodge -= dt
    // bubbles fly, pop on the character or fade out
    const box = getBox()
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i]
      b.life += dt
      if (!b.done) {
        b.sprite.position.addScaledVector(b.vel, dt)
        b.sprite.scale.setScalar(b.size * Math.min(1, 0.5 + b.life * 2.5))
        b.sprite.material.rotation = Math.sin(b.life * 9) * 0.25
        b.trail -= dt
        if (b.trail <= 0) { b.trail = 0.035; bit(sparkTex, b.sprite.position, b.size * 0.35, null, 0.35, 0xbfe8ff) }
        if (box && box.distanceToPoint(b.sprite.position) < b.size * 0.4) {
          b.done = true; b.life = 0
          burst(b.sprite.position, b.size)
          popText(lang === 'en' ? 'HIT!' : 'ヒット！', '#ffe45c')
          chase.hits++
          emote('surprised', 900)
          moves.play('dizzy')
          if (chase.mode === 'challenge') { addScore(1); continue }
          if (chase.hits < CHASE_HITS) speak(lang === 'en' ? 'Hey!' : 'わっ！')
          say(`${T(WISHES.chase)} <b>${'●'.repeat(chase.hits)}${'○'.repeat(Math.max(0, CHASE_HITS - chase.hits))}</b>`)
          if (chase.hits >= CHASE_HITS) { endChase(); speak(lang === 'en' ? 'You caught me!' : 'つかまっちゃった！'); setTimeout(grant, 600); return }
        } else if (b.life > 1.4) b.done = true
      } else {
        b.sprite.scale.multiplyScalar(1 + dt * 3)
        b.sprite.material.opacity = Math.max(0, 1 - b.life * 4)
        if (b.life > 0.3) { b.sprite.removeFromParent(); bubbles.splice(i, 1) }
      }
    }
    if (chase.mode !== 'challenge' && chase.t > CHASE_S) {
      endChase(); wish = null; card.style.opacity = '0'; gap = 4
      speak(lang === 'en' ? 'I got away! Let\'s play again!' : 'にげきった〜！また遊ぼうね')
      moves.play('spinJump')
    }
  }
  // caught with the hand counts too
  window.addEventListener('handplay:grab', () => {
    if (!chase.on) return
    if (chase.mode === 'challenge') {
      if (chase.t - ch.lastGrab > 1.5) { ch.lastGrab = chase.t; addScore(3); emote('surprised', 900); speak(lang === 'en' ? 'Caught!' : 'つかまった〜！') }
      return
    }
    endChase(); speak(lang === 'en' ? 'You caught me!' : 'つかまっちゃった！'); setTimeout(grant, 300)
  })

  // --- 20 s challenge: timer + score on top, the chase without a hit cap, local ranking -------------
  const ch = { on: false, count: 0, left: 0, score: 0, lastGrab: -9 }
  const rankKey = 'hp-rank:' + location.pathname + (new URLSearchParams(location.search).get('params') || '')
  function loadRank() { try { return JSON.parse(localStorage.getItem(rankKey) || '[]') } catch { return [] } }
  function saveRank(list) { try { localStorage.setItem(rankKey, JSON.stringify(list)) } catch { /* private mode */ } }
  function plus(n, x, y) {
    const el = document.createElement('div'); el.className = 'hp-plus'; el.textContent = '+' + n
    el.style.left = (x + 46) + 'px'; el.style.top = (y + 10) + 'px'; document.body.appendChild(el)
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transform = 'translate(-50%,-160%) scale(1.3)'; el.style.opacity = '0' }))
    setTimeout(() => el.remove(), 750)
  }
  function charScreen() {
    const rc = getRect(), r = canvas.getBoundingClientRect()
    return rc ? [r.left + (rc.x0 + rc.x1) / 2, r.top + rc.y0 + (rc.y1 - rc.y0) * 0.3] : [r.left + r.width / 2, r.top + r.height / 2]
  }
  function addScore(n) {
    ch.score += n
    const [x, y] = charScreen(); plus(n, x, y)
    chime(false)
  }
  function startChallenge() {
    if (ch.on) return
    endChase(); wish = null; card.style.opacity = '0'; ringG.visible = false
    result.style.display = 'none'; startBtn.style.display = 'none'; hud.style.display = 'none'
    ch.on = true; ch.count = 3.2; ch.left = CHALLENGE_S; ch.score = 0
    timer.style.display = 'block'; timer.classList.remove('hurry')
    speak(lang === 'en' ? 'Ready? Catch me!' : 'よーい、つかまえてごらん！')
  }
  // shared ranking per project (/api/ar-rank on hackar-s.com), local top 5 as the fallback
  const projectId = (location.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || ''
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  async function rankApi(body) {
    if (!projectId) throw new Error('no project')
    const res = await fetch(body ? '/api/ar-rank' : '/api/ar-rank?project=' + projectId, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: projectId, ...body }) }
      : { cache: 'no-store' })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error || res.status)
    return j
  }
  function finishChallenge() {
    ch.on = false; endChase(); timer.style.display = 'none'
    showBanner(lang === 'en' ? 'Time up!' : 'おしまい！')
    moves.play('spinJump')
    const score = ch.score
    let savedName = ''; try { savedName = localStorage.getItem('hp-name') || '' } catch { /* private mode */ }
    const L = (ja, en) => (lang === 'en' ? en : ja)
    const rows = (list, mine) => list.map((e, i) => `<li class="${e.id && e.id === mine ? 'me' : ''}"><span>${i + 1}. ${esc(e.name || L('ゲスト', 'Guest'))}</span><b>${e.score}</b></li>`).join('')
    result.innerHTML = `<h3>${L('スコア', 'Your score')}</h3><div class="big">${score}</div>`
      + `<div class="reg" style="display:flex;gap:6px;margin:10px 0 2px"><input maxlength="10" placeholder="${L('なまえ', 'Name')}" value="${esc(savedName)}" style="flex:1;min-width:0;border:1px solid #ddd;border-radius:12px;padding:9px 10px;font:600 16px -apple-system,'Hiragino Sans',sans-serif">`
      + `<button class="send" style="background:#3a7bff;color:#fff">${L('ランキングに登録', 'Submit')}</button></div>`
      + `<div class="msg" style="min-height:18px;font-size:13px;color:#888"></div>`
      + `<h3 style="margin-top:6px">${L('みんなのランキング', 'Ranking')}</h3><ol class="list"><li><span>…</span></li></ol>`
      + `<div class="btns"><button class="again">${L('もう一回', 'Play again')}</button><button class="close">${L('とじる', 'Close')}</button></div>`
    const listEl = result.querySelector('.list'), msg = result.querySelector('.msg'), send = result.querySelector('.send'), input = result.querySelector('input')
    // stop the AR page's touch handlers from stealing the keyboard focus
    for (const ev of ['touchstart', 'touchend', 'pointerdown', 'click']) input.addEventListener(ev, (e) => e.stopPropagation(), { passive: true })
    // iOS pans the page up for the keyboard and may leave it there: put it back when typing ends
    input.addEventListener('blur', () => setTimeout(() => window.scrollTo(0, 0), 60))
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); send.click() } })
    let shared = true
    rankApi().then((j) => { listEl.innerHTML = rows(j.list) || `<li><span>${L('まだだれもいないよ', 'No one yet')}</span></li>` }).catch(() => {
      // offline / no project id: the device's own top 5
      shared = false
      const list = loadRank(), me = { score, at: Date.now(), id: 'local' + Date.now() }
      list.push(me); list.sort((a, b) => b.score - a.score || a.at - b.at)
      const top = list.slice(0, 5); saveRank(top)
      result.querySelector('.reg').style.display = 'none'
      result.querySelectorAll('h3')[1].textContent = L('このスマホのランキング', 'On this phone')
      listEl.innerHTML = rows(top.map((e) => ({ ...e, name: e.name || L('じぶん', 'Me') })), me.id)
    })
    send.onclick = async () => {
      if (!shared) return
      send.disabled = true; msg.textContent = L('とうろく中…', 'Sending…')
      const name = input.value.trim()
      try { localStorage.setItem('hp-name', name) } catch { /* private mode */ }
      try {
        const j = await rankApi({ name, score })
        listEl.innerHTML = rows(j.list, j.id)
        result.querySelector('.reg').style.display = 'none'
        msg.textContent = j.rank === 0 ? L('1位！しんきろく！', 'New record! #1') : j.rank >= 0 && j.rank < 10 ? L(`${j.rank + 1}位！`, `#${j.rank + 1}!`) : L('とうろくしたよ', 'Submitted')
        if (j.rank === 0) { chime(true); speak(L('いちいだよ！すごい！', 'Number one! Amazing!')) }
      } catch (e) { msg.textContent = L('とうろくできなかった…', 'Could not submit'); send.disabled = false }
    }
    setTimeout(() => {
      result.style.display = 'block'
      result.querySelector('.again').onclick = () => startChallenge()
      result.querySelector('.close').onclick = () => { result.style.display = 'none'; startBtn.style.display = ''; hud.style.display = ''; gap = 3 }
    }, 1400)
    speak(L(`${score}てん！すごいね！`, `${score} points! Nice!`))
  }
  startBtn.addEventListener('click', (e) => { e.stopPropagation(); unlock(); startChallenge() })
  function updateChallenge(dt, s) {
    const sec = timer.querySelector('.sec'), sc = timer.querySelector('.sc'), bar = timer.querySelector('.bar i')
    if (ch.count > 0) {
      const before = Math.ceil(ch.count - 0.2)
      ch.count -= dt
      const now = Math.ceil(ch.count - 0.2)
      if (now !== before) showBanner(now > 0 ? String(now) : (lang === 'en' ? 'Go!' : 'スタート！'))
      sec.textContent = CHALLENGE_S + (lang === 'en' ? 's' : '秒'); sc.textContent = '0' + (lang === 'en' ? ' pts' : 'てん'); bar.style.width = '100%'
      if (ch.count <= 0) { startChase(); chase.mode = 'challenge' }
      return
    }
    ch.left -= dt
    sec.textContent = Math.max(0, Math.ceil(ch.left)) + (lang === 'en' ? 's' : '秒')
    sc.textContent = ch.score + (lang === 'en' ? ' pts' : 'てん')
    bar.style.width = Math.max(0, ch.left / CHALLENGE_S * 100) + '%'
    timer.classList.toggle('hurry', ch.left < 5)
    updateChase(dt, s)
    if (ch.left <= 0) finishChallenge()
  }

  function pick(force) {
    const g = group(), cam = getCamera()
    if (!g || !cam) return
    const keys = Object.keys(WISHES).filter((k) => k !== last && (k !== 'magic' || window.__ultraFx))
    const k = force || keys[Math.floor(Math.random() * keys.length)]
    wish = k; last = k; wishT = 0
    if (k === 'ring') {
      // beside the character at the same depth (carrying moves it sideways / up, not nearer or
      // farther), about a third of the screen width away, on the side that stays on screen
      const s = state(), f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize()
      const right = new THREE.Vector3(-f.z, 0, f.x)
      const c0 = g.position.clone().project(cam), c1 = g.position.clone().add(right).project(cam)
      const perM = Math.abs(c1.x - c0.x) || 1   // NDC x per metre sideways at the character's depth
      let placed = false
      for (const want of [0.62, 0.5, 0.4]) {
        const sides = c0.x > 0 ? [-1, 1] : [1, -1]
        for (const side of sides) {
          if (Math.abs(c0.x + side * want) > 0.8) continue
          hitP.copy(g.position).addScaledVector(right, side * want / perM)
          placed = true; break
        }
        if (placed) break
      }
      if (!placed) { wish = null; gap = 1; return }
      ringG.position.set(hitP.x, g.position.y + 0.004, hitP.z)
      ringR = Math.max(0.12, s.height * 0.38)
      ringG.scale.setScalar(ringR)
      ringG.visible = true
    }
    if (k === 'chase') startChase()
    card.innerHTML = `${T(WISHES[k])}<span class="bar"><i></i></span>`
    card.style.opacity = '1'
    emote('surprised', 1200)
    speak(T(WISHES[k]))
    dbg('Game: wish ' + k)
  }
  function grant(big) {
    if (!wish) return
    const was = wish
    wish = null; card.style.opacity = '0'; ringG.visible = false
    hearts++
    const up = hearts === LEVELS[level]
    if (up) level++
    drawHud()
    flyHeart()
    chime(up)
    emote('happy', 2500)
    if (window.__ultraFx) window.__ultraFx.cast()
    const thanks = THANKS[lang][Math.floor(Math.random() * THANKS[lang].length)]
    if (up) {
      setTimeout(() => { moves.play('bigJump'); showBanner(lang === 'en' ? `Friend level ${level + 1}!` : `なかよしレベル ${level + 1}！`) }, 1700)
      speak(thanks + (lang === 'en' ? ' We are better friends now!' : ' もっとなかよしになったね！'))
    } else speak(thanks)
    gap = up ? 6 : 3.5 + Math.random() * 2
    dbg('Game: granted ' + was + ' hearts=' + hearts)
  }

  // wishes granted by events from hand-play / talk
  window.addEventListener('handplay:poke', () => { if (wish === 'pet') grant() })
  window.addEventListener('handplay:palm', () => { if (wish === 'magic') setTimeout(grant, 900) })
  window.addEventListener('handplay:reply', () => { if (wish === 'talk') setTimeout(grant, 2500) })
  window.addEventListener('handplay:drop', () => {
    if (wish !== 'ring') return
    const g = group(); if (!g) return
    const dx = g.position.x - ringG.position.x, dz = g.position.z - ringG.position.z
    if (Math.hypot(dx, dz) < ringR * 1.35) setTimeout(grant, 450)
  })

  let started = false, t = 0
  function update(dt) {
    t += dt
    const g = group()
    if (!g || !g.parent) return
    const s = state()
    if (!started) { if (s.ready) { started = true; gap = 3.5 } else return }
    // card over the character's head (the talk bubble takes that place while it talks)
    const rc = getRect(), r = canvas.getBoundingClientRect()
    hud.style.left = (r.left + r.width / 2) + 'px'; hud.style.top = (Math.max(r.top, 0) + 14) + 'px'
    if (wish && rc) {
      const hidden = s.talking
      card.style.opacity = hidden ? '0' : '1'
      const half = card.offsetWidth / 2 + 8
      card.style.left = Math.min(r.right - half, Math.max(r.left + half, r.left + (rc.x0 + rc.x1) / 2)) + 'px'
      card.style.top = Math.max(Math.max(r.top, 0) + card.offsetHeight + 60, r.top + rc.y0 - 6) + 'px'
      const bar = card.querySelector('.bar i'); if (bar) bar.style.width = Math.max(0, 100 - wishT / GIVE_UP_S * 100) + '%'
    }
    if (ringG.visible) {
      const k = 0.5 + 0.5 * Math.sin(t * 4)
      ringMat.opacity = 0.65 + 0.35 * k; ringFill.material.opacity = 0.15 + 0.15 * k
      beamMat.uniforms.uT.value = t
    }
    { const r2 = canvas.getBoundingClientRect(); startBtn.style.left = (r2.left + r2.width / 2 - startBtn.offsetWidth / 2) + 'px'; startBtn.style.top = (Math.max(r2.top, 0) + 56) + 'px'
      timer.style.left = (r2.left + r2.width / 2) + 'px'; timer.style.top = (Math.max(r2.top, 0) + 12) + 'px'
      // overlays centred on the camera view (in the emulator it is not the whole window)
      // ... and kept inside what is actually visible (the keyboard shrinks the visual viewport and
      // iOS scrolls the page under it; position: fixed follows the layout viewport)
      const vv = window.visualViewport, vt = vv ? vv.offsetTop : 0, vh = vv ? vv.height : innerHeight
      for (const el of [result, banner]) {
        const h = el.offsetHeight || 0
        let y = r2.top + r2.height * (el === banner ? 0.4 : 0.5)
        y = Math.min(vt + vh - h / 2 - 8, Math.max(vt + h / 2 + 8, y))
        el.style.left = (r2.left + r2.width / 2) + 'px'; el.style.top = y + 'px'
      } }
    updateBits(dt)
    if (ch.on) { updateChallenge(dt, s); return }
    if (result.style.display === 'block') return   // (placement above already ran)
    if (chase.on) { updateChase(dt, s); const bar = card.querySelector('.bar i'); if (bar) bar.style.width = Math.max(0, 100 - chase.t / CHASE_S * 100) + '%'; return }
    if (wish) {
      if (!s.talking && !s.grabbing) wishT += dt
      if (wish === 'lift' && s.grabbing && s.liftWorld >= Math.max(0.25, s.height * 0.6)) grant()
      else if (wishT > GIVE_UP_S) { card.style.opacity = '0'; ringG.visible = false; wish = null; gap = 1.5 }
    } else if (!s.grabbing && !s.carried && !s.talking) {
      gap -= dt
      if (gap <= 0) pick()
    }
  }

  return {
    update,
    get hearts() { return hearts }, get wish() { return wish }, get chasing() { return chase.on || ch.on },
    get score() { return ch.score }, get dodges() { return chase.dodges || 0 }, get challenge() { return ch.on }, startChallenge,
    // ask for a given wish now (tests / demo recording)
    play(k) { if (!WISHES[k]) return; endChase(); ringG.visible = false; wish = null; pick(k) },
    stop() { hud.remove(); card.remove(); banner.remove(); startBtn.remove(); timer.remove(); result.remove(); ringG.removeFromParent() },
  }
}
