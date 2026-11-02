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
  document.body.append(hud, card, banner)
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
  const bubbleTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128
    const x = c.getContext('2d')
    const g = x.createRadialGradient(64, 64, 20, 64, 64, 62)
    g.addColorStop(0, 'rgba(200,240,255,0.08)'); g.addColorStop(0.75, 'rgba(170,225,255,0.28)'); g.addColorStop(0.93, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0)')
    x.fillStyle = g; x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fill()
    x.fillStyle = 'rgba(255,255,255,0.9)'; x.beginPath(); x.ellipse(44, 40, 14, 8, -0.6, 0, Math.PI * 2); x.fill()
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
  })()
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
    chase.on = true; chase.t = 0; chase.hits = 0; chase.dodge = 0
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
    const size = Math.max(0.06, s.height * 0.22)
    sprite.scale.setScalar(size * 0.4)
    // starts a little below the middle of the screen, from the phone
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(cam.quaternion)
    sprite.position.copy(cam.position).addScaledVector(dir, 0.15).addScaledVector(down, 0.05)
    scene.add(sprite)
    bubbles.push({ sprite, vel: dir.multiplyScalar(dist / 0.55), life: 0, size, done: false })
    // will it hit? the character may hop out of the way
    const toC = tmpV.copy(tmpC).sub(cam.position), along = toC.dot(ray.ray.direction)
    const closest = toC.clone().sub(ray.ray.direction.clone().multiplyScalar(along)).length()
    const hitR = Math.max((box.max.x - box.min.x) * 0.5, s.height * 0.3)
    if (closest < hitR && chase.t - chase.lastDodge > 0.7 && Math.random() < DODGE_CHANCE) {
      const side = new THREE.Vector3(ray.ray.direction.z, 0, -ray.ray.direction.x).normalize()
      const off = toC.clone().sub(ray.ray.direction.clone().multiplyScalar(along))
      const sign = off.dot(side) >= 0 ? 1 : -1
      chase.target.copy(g.position).addScaledVector(side, sign * s.height * 0.85)
      chase.dodge = 0.3; chase.lastDodge = chase.t
      setTimeout(() => moves.play('dodge'), 120)
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
      const d = to.length(), speed = s.height * (chase.dodge > 0 ? 3.2 : 1.3)
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
        b.sprite.scale.setScalar(b.size * Math.min(1, 0.4 + b.life * 2.5))
        if (box && box.distanceToPoint(b.sprite.position) < b.size * 0.4) {
          b.done = true; b.life = 0
          chase.hits++
          emote('surprised', 900)
          moves.play('dizzy')
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
    if (chase.t > CHASE_S) {
      endChase(); wish = null; card.style.opacity = '0'; gap = 4
      speak(lang === 'en' ? 'I got away! Let\'s play again!' : 'にげきった〜！また遊ぼうね')
      moves.play('spinJump')
    }
  }
  // caught with the hand counts too
  window.addEventListener('handplay:grab', () => {
    if (!chase.on) return
    endChase(); speak(lang === 'en' ? 'You caught me!' : 'つかまっちゃった！'); setTimeout(grant, 300)
  })

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
    get hearts() { return hearts }, get wish() { return wish }, get chasing() { return chase.on },
    // ask for a given wish now (tests / demo recording)
    play(k) { if (!WISHES[k]) return; endChase(); ringG.visible = false; wish = null; pick(k) },
    stop() { hud.remove(); card.remove(); banner.remove(); ringG.removeFromParent() },
  }
}
