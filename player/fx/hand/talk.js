import { C, FONT, loadFont } from './cozy.js?v=20261104k'

// Talk: a talk button fixed on screen (also: poke the character with the hand, or tap it) -> the
// character turns to you and listens until you stop speaking, then answers with a speech bubble and
// the device voice. The button shows every state: idle / listening (live mic level + time left) /
// thinking / speaking. Audio is recorded as 16 kHz mono WAV (what Muse Voice Transcribe accepts) and
// sent to the AR Creator /api/talk endpoint (Transcribe + Muse Spark).
// iOS needs a user gesture before the mic / speech synthesis work: the first button press or tap unlocks.
// same origin: the AR pages' CSP only allows connecting to hackar-s.com itself; vercel.json proxies /x/talk
const ENDPOINT = '/x/talk'
const RATE = 16000
const MAX_MS = 7000, NO_SPEECH_MS = 4000, TAIL_MS = 900   // listen at most 7 s; stop 0.9 s after you stop talking
const VOICE_RMS = 0.025                                     // above this counts as speech

const ICON = {
  mic: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4h4l5 4V6L8 10z"/><path class="w1" d="M16 9.5a3.5 3.5 0 0 1 0 5"/><path class="w2" d="M18.5 7a7 7 0 0 1 0 10"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
}

const CSS = `
.hp-talk{position:fixed;z-index:61;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;font:600 15px/1.3 -apple-system,"Hiragino Sans",sans-serif}
.hp-heard{max-width:70vw;padding:6px 12px;border-radius:14px;background:rgba(0,0,0,.45);color:#fff;font-weight:500;font-size:13px;opacity:0;transition:opacity .25s;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.hp-btn{pointer-events:auto;position:relative;display:flex;align-items:center;gap:10px;height:52px;padding:0 20px 0 16px;border:1px solid rgba(255,255,255,.35);border-radius:26px;
  background:rgba(20,20,28,.42);color:#fff;backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);box-shadow:0 8px 28px rgba(0,0,0,.28);
  -webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;cursor:pointer;transition:background .2s,transform .12s,border-color .2s;overflow:hidden}
.hp-btn:active{transform:scale(.96)}
.hp-ico{display:flex;width:30px;height:30px;align-items:center;justify-content:center;border-radius:15px;background:rgba(255,255,255,.16)}
.hp-bars{display:none;align-items:center;gap:3px;height:22px}
.hp-bars i{display:block;width:4px;height:4px;border-radius:2px;background:#fff;transition:height .08s}
.hp-dots{display:none;gap:5px}
.hp-dots i{display:block;width:7px;height:7px;border-radius:4px;background:#fff;animation:hpdot 1s infinite ease-in-out}
.hp-dots i:nth-child(2){animation-delay:.15s}.hp-dots i:nth-child(3){animation-delay:.3s}
@keyframes hpdot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-4px)}}
.hp-prog{position:absolute;left:0;bottom:0;height:3px;background:#fff;opacity:.85;width:0}
.hp-btn[data-s=listen]{background:rgba(255,64,96,.62);border-color:rgba(255,255,255,.6)}
.hp-btn[data-s=listen] .hp-bars{display:flex}
.hp-btn[data-s=think] .hp-dots{display:flex}
.hp-btn[data-s=speak]{background:rgba(40,150,255,.55)}
.hp-btn[data-s=speak] .w1{animation:hpw 1s infinite}.hp-btn[data-s=speak] .w2{animation:hpw 1s .2s infinite}
@keyframes hpw{0%,100%{opacity:.2}50%{opacity:1}}
.hp-ring{position:absolute;inset:-6px;border-radius:32px;border:2px solid rgba(255,90,120,.8);opacity:0;pointer-events:none}
.hp-btn[data-s=listen] + .hp-ring{animation:hpring 1.2s infinite}
@keyframes hpring{0%{opacity:.8;transform:scale(1)}100%{opacity:0;transform:scale(1.18)}}
`

export function createTalk({ THREE, getCamera, canvas, content, getRect, ov = {}, dbg = () => {} }) {
  const lang = ov.talkLang === 'en' ? 'en' : 'ja'
  const L = (ja, en) => (lang === 'en' ? en : ja)
  const name = ov.talkName || ov.name || ''
  const persona = ov.talkPersona || ''
  const history = []
  let stream = null, ctx = null, busy = false, voice = null, stopEarly = null

  if (!document.getElementById('hp-talk-css')) {
    const st = document.createElement('style'); st.id = 'hp-talk-css'; st.textContent = CSS; document.head.appendChild(st)
  }

  // the character's reply: a cozy dialogue card with its name on a tag and a blinking ▼
  loadFont()
  if (!document.getElementById('hp-talk-cozy')) {
    const st = document.createElement('style'); st.id = 'hp-talk-cozy'
    st.textContent = `.hp-say{position:fixed;z-index:60;max-width:76vw;padding:20px 22px 18px;border-radius:26px;background:${C.paper};color:${C.ink};font:800 16px/1.5 ${FONT};
      box-shadow:0 8px 22px ${C.shadow};transform:translate(-50%,-100%);pointer-events:none;opacity:0;transition:opacity .2s}
      .hp-say:before{content:"";position:absolute;inset:6px;border:2.5px dashed ${C.stitch};border-radius:21px}
      .hp-say:after{content:"";position:absolute;left:50%;bottom:-11px;margin-left:-11px;border:11px solid transparent;border-bottom:0;border-top-color:${C.paper}}
      .hp-say .tagn{position:absolute;left:16px;top:-14px;transform:rotate(-4deg);background:${C.tag};color:#fff;font:900 13px/1 ${FONT};padding:7px 13px;border-radius:999px;box-shadow:0 3px 8px ${C.shadow}}
      .hp-say .nx{position:absolute;right:14px;bottom:6px;color:${C.tag};font-size:11px;animation:hpnx2 1s infinite}
      @keyframes hpnx2{0%,100%{transform:translateY(0);opacity:1}50%{transform:translateY(3px);opacity:.45}}
      .hp-heard{background:${C.paper}!important;color:${C.ink}!important;font:800 13px/1.3 ${FONT}!important;box-shadow:0 4px 12px ${C.shadow};border-radius:999px!important;backdrop-filter:none!important}`
    document.head.appendChild(st)
  }
  const bubble = document.createElement('div')
  bubble.className = 'hp-say'
  document.body.appendChild(bubble)
  const tagName = String(name).replace(/[&<>"']/g, '')

  // the talk button, fixed above the shutter, with what you said shown just above it
  const wrap = document.createElement('div'); wrap.className = 'hp-talk'
  const heard = document.createElement('div'); heard.className = 'hp-heard'
  const btn = document.createElement('div'); btn.className = 'hp-btn'; btn.setAttribute('role', 'button'); btn.dataset.s = 'idle'
  const ring = document.createElement('div'); ring.className = 'hp-ring'
  btn.innerHTML = `<span class="hp-ico"></span><span class="hp-bars">${'<i></i>'.repeat(7)}</span><span class="hp-dots"><i></i><i></i><i></i></span><span class="hp-label"></span><span class="hp-prog"></span>`
  const btnBox = document.createElement('div'); btnBox.style.position = 'relative'
  btnBox.append(btn, ring)
  wrap.append(heard, btnBox)
  document.body.appendChild(wrap)
  const ico = btn.querySelector('.hp-ico'), label = btn.querySelector('.hp-label'), prog = btn.querySelector('.hp-prog')
  const bars = [...btn.querySelectorAll('.hp-bars i')]
  let btnHidden = false
  function setState(s, text) {
    btn.dataset.s = s
    // with the pet's floating talk button, the fixed button only appears while a talk is going on,
    // so "listening / thinking / talking" (with the mic level and time left) is always visible
    if (btnHidden) btnBox.style.display = s === 'idle' ? 'none' : ''
    ico.innerHTML = s === 'listen' ? ICON.stop : s === 'speak' ? ICON.speaker : ICON.mic
    label.textContent = text || { idle: L('話しかける', 'Talk'), listen: L('聞いてるよ', 'Listening'), think: L('考え中', 'Thinking'), speak: L('おしゃべり中', 'Talking') }[s]
    if (s !== 'listen') { prog.style.width = '0'; bars.forEach(b => { b.style.height = '4px' }) }
  }
  setState('idle')
  let heardT = 0
  function showHeard(text) {
    heard.textContent = text
    heard.style.opacity = text ? '1' : '0'
    clearTimeout(heardT)
    if (text) heardT = setTimeout(() => { heard.style.opacity = '0' }, 6000)
  }
  const press = (e) => {
    e.preventDefault(); e.stopPropagation()
    if (btn.dataset.s === 'listen') { stopEarly?.(); return }
    if (btn.dataset.s === 'speak') { speechSynthesis?.cancel(); return }
    poke()
  }
  btn.addEventListener('touchend', press, { passive: false })
  btn.addEventListener('click', press)
  btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true })

  function place() {
    const r = canvas.getBoundingClientRect()
    wrap.style.left = (r.left + r.width / 2) + 'px'
    wrap.style.top = (Math.min(r.bottom, innerHeight) - Math.min(170, r.height * 0.2)) + 'px'
  }
  // above the character's head: its on-screen bounds (character meshes only), clamped into view
  function placeBubble() {
    if (bubble.style.opacity === '0') return
    const rc = getRect && getRect()
    if (!rc) return
    const r = canvas.getBoundingClientRect(), vt = Math.max(r.top, 0, window.__hpHudBottom || 0), vb = Math.min(r.bottom, innerHeight)
    const half = bubble.offsetWidth / 2 + 8
    const x = Math.min(r.right - half, Math.max(r.left + half, r.left + (rc.x0 + rc.x1) / 2))
    const y = Math.min(vb - 8, Math.max(vt + bubble.offsetHeight + 8, r.top + rc.y0 + (rc.y1 - rc.y0) * 0.1))
    bubble.style.left = x + 'px'
    bubble.style.top = y + 'px'
  }
  const say = (text, ms) => {
    bubble.innerHTML = ''
    if (text && tagName) { const t = document.createElement('span'); t.className = 'tagn'; t.textContent = tagName; bubble.appendChild(t) }
    bubble.appendChild(document.createTextNode(text || ''))
    if (text) { const n = document.createElement('span'); n.className = 'nx'; n.textContent = '▼'; bubble.appendChild(n) }
    bubble.style.opacity = text ? '1' : '0'
    clearTimeout(say._t)
    if (ms) say._t = setTimeout(() => { bubble.style.opacity = '0' }, ms)
  }

  // iOS only lets audio start inside the tap itself: everything before the first await runs in it
  let voiceUnlocked = false
  async function unlock() {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)()
      const resumed = ctx.state === 'suspended' ? ctx.resume() : null
      if (window.speechSynthesis && !voiceUnlocked) {
        voiceUnlocked = true
        const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u)
        const pick = () => { voice = speechSynthesis.getVoices().find(v => v.lang.startsWith(lang === 'en' ? 'en' : 'ja')) || null }
        pick(); speechSynthesis.onvoiceschanged = pick
      }
      if (!stream || !stream.active) stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      if (resumed) await Promise.race([resumed, new Promise(r => setTimeout(r, 1500))])
      if (ctx.state !== 'running') { try { await ctx.resume() } catch { /* retried on the next tap */ } }
      dbg('Talk: mic + voice unlocked (' + ctx.state + ')')
      return true
    } catch (e) { dbg('Talk: unlock failed ' + e.message); return false }
  }

  // listen until the speaker goes quiet (or MAX_MS), drive the level bars, encode 16 kHz mono WAV.
  // Resolves null when nothing was said.
  function record() {
    return new Promise((resolve) => {
      const src = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(2048, 1, 1)
      const chunks = []
      const t0 = performance.now()
      let spoke = false, lastVoice = 0, done = false
      const finish = () => {
        if (done) return
        done = true; stopEarly = null
        proc.disconnect(); src.disconnect()
        if (!spoke) return resolve(null)
        const total = chunks.reduce((n, c) => n + c.length, 0), pcm = new Float32Array(total)
        let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length }
        resolve(encodeWav(pcm, ctx.sampleRate))
      }
      stopEarly = () => { spoke = spoke || chunks.length > 4; finish() }
      proc.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0)
        chunks.push(new Float32Array(d))
        let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i]
        const rms = Math.sqrt(sum / d.length), now = performance.now()
        if (rms > VOICE_RMS) { spoke = true; lastVoice = now }
        // level bars (a little randomness so they look alive) and the time left
        const lv = Math.min(1, rms * 9)
        bars.forEach((b, i) => { b.style.height = (4 + lv * 18 * (0.55 + 0.45 * Math.abs(Math.sin(now / 90 + i * 1.3)))) + 'px' })
        prog.style.width = Math.min(100, (now - t0) / MAX_MS * 100) + '%'
        if (now - t0 > MAX_MS || (spoke && now - lastVoice > TAIL_MS) || (!spoke && now - t0 > NO_SPEECH_MS)) finish()
      }
      src.connect(proc); proc.connect(ctx.destination)
    })
  }
  function encodeWav(pcm, inRate) {
    const n = Math.floor(pcm.length * RATE / inRate), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf)
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true)
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true)
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, pcm[Math.floor(i * inRate / RATE)] || 0))
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return buf
  }
  const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s) }

  // speak the reply; the button shows "talking" until the voice ends
  function speak(text) {
    const est = Math.min(9000, 900 + text.length * 140)
    let ended = false
    const end = () => { if (ended) return; ended = true; talkT = 0; if (btn.dataset.s === 'speak') setState('idle') }
    setState('speak')
    talkT = est / 1000
    if (!window.speechSynthesis) { setTimeout(end, est); return }
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang === 'en' ? 'en-US' : 'ja-JP'; if (voice) u.voice = voice
    u.pitch = 1.35; u.rate = 1.05
    u.onend = end; u.onerror = end
    speechSynthesis.speak(u)
    setTimeout(end, est + 4000)   // some browsers never fire onend
  }

  // the character reacts: turns to the camera while listening / talking and bobs while it talks.
  // hand-play.js owns the transform: this only reports the wanted yaw, how much to face, and the bob
  let talkT = 0, faceT = 0, faceW = 0
  function update(dt) {
    place()
    placeBubble()
    const c = content(), cam = getCamera()
    if (!c || !cam) return
    const on = faceT > 0 || busy
    if (faceT > 0) faceT -= dt
    faceW += ((on ? 1 : 0) - faceW) * (1 - Math.exp(-dt * (on ? 8 : 2)))
    const g = c.parent, p = new THREE.Vector3(); g.getWorldPosition(p)
    c.userData._talkYaw = Math.atan2(cam.position.x - p.x, cam.position.z - p.z) - (g.rotation.y || 0)
    c.userData._talkFace = faceW
    if (talkT > 0) talkT -= dt
    c.userData._talkBob = talkT > 0 ? 1 + Math.abs(Math.sin(talkT * 14)) * 0.05 : 1
  }

  async function poke(text) {
    if (busy) return
    busy = true; faceT = 8
    try {
      let body = { name, persona, lang, history }
      if (typeof text === 'string') body.text = text
      else {
        if (!stream || !ctx || !stream.active || ctx.state !== 'running') {
          const ok = await unlock()
          if (!ok) { setState('idle'); say(L('マイクを許可してね', 'Please allow the microphone'), 3500); return }
        }
        speechSynthesis?.cancel()
        say('')
        showHeard('')
        setState('listen')
        const wav = await record()
        if (!wav) { setState('idle'); showHeard(L('聞こえなかったよ。もう一回押してね', "I couldn't hear you. Tap again")); return }
        body.audio = b64(wav)
      }
      setState('think')
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await res.json()
      if (!res.ok || !j.reply) throw new Error(j.error || 'no reply')
      if (j.heard) { history.push({ role: 'user', content: j.heard }); showHeard(L('あなた：', 'You: ') + j.heard) }
      history.push({ role: 'assistant', content: j.reply })
      say(j.reply, Math.min(12000, 4000 + j.reply.length * 160))
      speak(j.reply)
      window.dispatchEvent(new CustomEvent('handplay:reply', { detail: j }))
    } catch (e) {
      dbg('Talk: ' + e.message)
      setState('idle')
      say(L('ん？もう一回言って？', 'Hmm? Say that again?'), 3000)
    } finally { busy = false; faceT = 3 }
  }

  return {
    unlock, poke, update, get busy() { return busy },
    // the pet's floating talk button replaces the on-screen one (what you said still shows)
    hideButton() { btnHidden = true; if (btn.dataset.s === 'idle') btnBox.style.display = 'none' },
    stop() { bubble.remove(); wrap.remove(); stream?.getTracks().forEach(t => t.stop()) },
  }
}
