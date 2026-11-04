// Moves: CPD floor-AR style choreography for the whole character (no GLB rebuild needed).
// Each move is a list of keys like the CPD motion timelines: t (s), x / z (travel on the floor),
// y (hop height), yaw, lean (forward tilt), flat (0 standing .. 1 lying face-up on the floor),
// sx / sy (squash & stretch), ease (how this key is reached). Distances are in character heights.
// update(dt) returns the pose to apply on top of the GLB's own bone clips.

const E = {
  linear: (t) => t,
  sine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inQuad: (t) => t * t,
  inCubic: (t) => t * t * t,
  inQuart: (t) => t ** 4,
  outBack: (t, s = 1.70158) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t - 0.1) * (2 * Math.PI) / 0.4) + 1),
}
const REST = { x: 0, z: 0, y: 0, yaw: 0, lean: 0, flat: 0, sx: 1, sy: 1 }
const CH = Object.keys(REST)

// one hop from (x0,z0) to (x1,z1), facing the way it goes (a flat picture only turns so far)
function hop(t0, x0, z0, x1, z1, h, keys) {
  const yaw = Math.max(-0.5, Math.min(0.5, Math.atan2(x1 - x0, z1 - z0) * 0.35))
  keys.push({ t: t0 + 0.13, x: x0, z: z0, y: 0, yaw, sx: 1.12, sy: 0.85, ease: 'sine' })                       // crouch
  keys.push({ t: t0 + 0.28, x: x0 + (x1 - x0) * 0.25, z: z0 + (z1 - z0) * 0.25, y: h * 0.3, yaw, sx: 0.92, sy: 1.18, ease: 'outQuad' })   // take off
  keys.push({ t: t0 + 0.5, x: x0 + (x1 - x0) * 0.6, z: z0 + (z1 - z0) * 0.6, y: h, yaw, sx: 0.98, sy: 1.04, ease: 'outQuad' })          // apex
  keys.push({ t: t0 + 0.74, x: x1, z: z1, y: 0, yaw, sx: 1.15, sy: 0.8, ease: 'inQuad' })                          // land
  return t0 + 0.74
}

const MOVES = {
  // lying on the floor like the painting, then it peels itself up (CPD's opening)
  rise: () => [
    { t: 0, flat: 1, ease: 'linear' },
    { t: 0.45, flat: 1, sx: 1.05, sy: 0.95, ease: 'outBack' },
    { t: 0.6, flat: 0.75, y: 0.06, sx: 0.96, sy: 1.28, ease: 'inQuad' },
    { t: 0.76, flat: 0, y: 0.24, sx: 0.95, sy: 1.38, ease: 'outQuad' },
    { t: 0.9, flat: 0, y: 0, sx: 1.14, sy: 0.82, ease: 'inCubic' },
    { t: 1.02, sx: 0.97, sy: 1.08, ease: 'outQuad' },
    { t: 1.12, sx: 1.02, sy: 0.97, ease: 'sine' },
    { t: 1.4, ease: 'outElastic' },
  ],
  // a lap of hops around where it stands, then home
  hopLap: (rand) => {
    const n = 4 + Math.floor(rand() * 3), r = 0.45 + rand() * 0.2, dir = rand() < 0.5 ? 1 : -1, start = rand() * Math.PI * 2
    const keys = [{ t: 0, ease: 'linear' }]
    let t = 0, px = 0, pz = 0
    for (let i = 1; i <= n; i++) {
      const a = start + dir * (i / n) * Math.PI * 2
      const nx = i === n ? 0 : Math.sin(a) * r, nz = i === n ? 0 : (Math.cos(a) - 1) * r * 0.7
      t = hop(t, px, pz, nx, nz, 0.22 + rand() * 0.12, keys)
      px = nx; pz = nz
    }
    keys.push({ t: t + 0.3, ease: 'outBack' })
    return keys
  },
  // crouch, jump with a full turn, overshoot, settle
  spinJump: () => [
    { t: 0, ease: 'linear' },
    { t: 0.3, sx: 1.12, sy: 0.84, ease: 'sine' },
    { t: 0.7, y: 0.24, yaw: Math.PI, sx: 0.93, sy: 1.15, ease: 'inQuart' },
    { t: 1.1, y: 0, yaw: Math.PI * 2 + 0.35, sx: 1.08, sy: 0.9, ease: 'outQuad' },
    { t: 1.35, yaw: Math.PI * 2 - 0.1, sx: 0.98, sy: 1.03, ease: 'sine' },
    { t: 1.7, yaw: Math.PI * 2, ease: 'outBack' },
  ],
  // big jump that hangs at the top, then a hard landing
  bigJump: () => [
    { t: 0, ease: 'linear' },
    { t: 0.35, sx: 1.14, sy: 0.78, ease: 'sine' },
    { t: 0.5, y: 0.18, sx: 0.9, sy: 1.22, ease: 'outQuad' },
    { t: 0.8, y: 0.62, ease: 'outQuad' },
    { t: 1.0, y: 0.62, sx: 0.96, sy: 1.06, ease: 'sine' },
    { t: 1.05, y: 0.62, sx: 1.08, sy: 0.9, ease: 'inQuad' },
    { t: 1.3, y: 0, sx: 0.8, sy: 1.35, ease: 'inQuad' },
    { t: 1.38, y: 0, sx: 1.25, sy: 0.7, ease: 'outQuad' },
    { t: 1.55, sx: 0.95, sy: 1.08, ease: 'outQuad' },
    { t: 1.9, ease: 'outElastic' },
  ],
  // dives flat into the floor, lies there a moment, peels back up (CPD's ending)
  flatPop: () => [
    { t: 0, ease: 'linear' },
    { t: 0.25, sx: 1.1, sy: 0.88, ease: 'sine' },
    { t: 0.45, y: 0.2, sx: 0.85, sy: 1.25, ease: 'outQuad' },
    { t: 0.6, y: 0, flat: 0.6, sx: 0.86, sy: 1.3, ease: 'inQuad' },
    { t: 0.68, y: 0, flat: 1, sx: 1.15, sy: 0.3, ease: 'inQuad' },
    { t: 0.8, flat: 1, sx: 0.95, sy: 1.1, ease: 'outQuad' },
    { t: 1.6, flat: 1, ease: 'sine' },
    { t: 1.75, flat: 1, sx: 1.05, sy: 0.95, ease: 'outBack' },
    { t: 1.9, flat: 0.75, y: 0.06, sx: 0.96, sy: 1.28, ease: 'inQuad' },
    { t: 2.05, flat: 0, y: 0.2, sx: 0.95, sy: 1.32, ease: 'outQuad' },
    { t: 2.2, flat: 0, y: 0, sx: 1.12, sy: 0.85, ease: 'inCubic' },
    { t: 2.5, ease: 'outElastic' },
  ],
  // looks around: leans and turns one way, then the other
  lookAround: () => [
    { t: 0, ease: 'linear' },
    { t: 0.5, yaw: 0.45, lean: -0.08, ease: 'sine' },
    { t: 1.2, yaw: 0.45, lean: -0.08, sy: 1.02, ease: 'sine' },
    { t: 1.7, yaw: -0.45, lean: 0.06, ease: 'sine' },
    { t: 2.4, yaw: -0.45, lean: 0.06, sy: 1.02, ease: 'sine' },
    { t: 2.9, ease: 'outBack' },
  ],
  // emotions
  surprised: () => [
    { t: 0, ease: 'linear' },
    { t: 0.08, sx: 1.1, sy: 0.85, ease: 'outQuad' },
    { t: 0.25, y: 0.35, sx: 0.85, sy: 1.3, ease: 'outQuad' },
    { t: 0.5, y: 0.38, sx: 0.9, sy: 1.2, ease: 'sine' },
    { t: 0.75, y: 0, sx: 1.18, sy: 0.82, ease: 'inQuad' },
    { t: 1.1, ease: 'outElastic' },
  ],
  sad: () => [
    { t: 0, ease: 'linear' },
    // (the GLB's own 'sad' clip already bows forward: keep this lean small or it reads as falling over)
    { t: 0.6, lean: 0.1, yaw: -0.12, sx: 1.08, sy: 0.82, ease: 'sine' },
    { t: 1.6, lean: 0.11, yaw: 0.12, sx: 1.09, sy: 0.8, ease: 'sine' },
    { t: 2.6, lean: 0.1, yaw: -0.08, sx: 1.08, sy: 0.82, ease: 'sine' },
    { t: 3.3, ease: 'sine' },
  ],
  angry: (rand) => {
    const keys = [{ t: 0, ease: 'linear' }]
    let t = 0
    for (let i = 0; i < 4; i++) {
      const s = i % 2 ? 1 : -1
      keys.push({ t: t + 0.08, yaw: 0.15 * s, sx: 1.15, sy: 0.8, ease: 'outQuad' })
      keys.push({ t: t + 0.17, y: 0.08, yaw: 0.15 * s, sx: 0.92, sy: 1.12, ease: 'outQuad' })
      keys.push({ t: t + 0.26, y: 0, yaw: 0.15 * s, sx: 1.18, sy: 0.78, ease: 'inQuad' })
      t += 0.26
    }
    keys.push({ t: t + 0.4, ease: 'outBack' })
    return keys
  },
}
// chase: quick little hops while it runs (the game moves the character across the floor)
MOVES.scamper = () => {
  const keys = [{ t: 0, ease: 'linear' }]
  let t = 0
  for (let i = 0; i < 3; i++) {
    const s = i % 2 ? 1 : -1
    keys.push({ t: t + 0.06, yaw: 0.12 * s, sx: 1.1, sy: 0.88, ease: 'outQuad' })
    keys.push({ t: t + 0.16, y: 0.14, yaw: 0.12 * s, sx: 0.94, sy: 1.12, ease: 'outQuad' })
    keys.push({ t: t + 0.28, y: 0, yaw: 0.12 * s, sx: 1.12, sy: 0.86, ease: 'inQuad' })
    t += 0.28
  }
  keys.push({ t: t + 0.06, ease: 'sine' })
  return keys
}
// chase: a quick sidestep jump (the game slides it sideways at the same time)
MOVES.dodge = () => [
  { t: 0, ease: 'linear' },
  { t: 0.05, sx: 1.15, sy: 0.82, ease: 'outQuad' },
  { t: 0.18, y: 0.2, sx: 0.85, sy: 1.25, lean: -0.1, ease: 'outQuad' },
  { t: 0.34, y: 0, sx: 1.18, sy: 0.8, ease: 'inQuad' },
  { t: 0.55, ease: 'outBack' },
]
// chase: jumps over a bubble when there is no room to sidestep (up before it arrives, hangs, lands)
MOVES.hopOver = () => [
  { t: 0, ease: 'linear' },
  { t: 0.06, sx: 1.15, sy: 0.82, ease: 'outQuad' },
  { t: 0.22, y: 0.75, sx: 0.88, sy: 1.2, ease: 'outQuad' },
  { t: 0.6, y: 0.82, sx: 0.96, sy: 1.05, ease: 'sine' },
  { t: 0.85, y: 0, sx: 1.18, sy: 0.8, ease: 'inQuad' },
  { t: 1.1, ease: 'outBack' },
]
// caught: dizzy wobble
MOVES.dizzy = () => [
  { t: 0, ease: 'linear' },
  { t: 0.15, sx: 1.2, sy: 0.78, ease: 'outQuad' },
  { t: 0.5, yaw: 0.3, lean: 0.12, sx: 0.96, sy: 1.04, ease: 'sine' },
  { t: 0.85, yaw: -0.3, lean: -0.08, ease: 'sine' },
  { t: 1.2, yaw: 0.25, lean: 0.08, ease: 'sine' },
  { t: 1.55, yaw: -0.2, lean: -0.05, ease: 'sine' },
  { t: 1.9, ease: 'outBack' },
]
MOVES.happy = MOVES.spinJump
MOVES.zap = MOVES.surprised
const IDLE = [['hopLap', 3], ['spinJump', 2], ['bigJump', 1.5], ['lookAround', 2], ['flatPop', 1.2]]
// calm (a pet that is just there): only small, rare moves - mostly looking around
const IDLE_CALM = [['lookAround', 4], ['hopLap', 1]]

export function createMoves({ rand = Math.random, calm = false } = {}) {
  const idleList = calm ? IDLE_CALM : IDLE
  const nextWait = () => (calm ? 9 + rand() * 8 : 2.5 + rand() * 3)
  let keys = null, t = 0, name = '', wait = calm ? 6 : 2.5, quiet = false
  const pose = { ...REST }
  function play(n) {
    const f = MOVES[n]
    if (!f) return false
    // start from the current pose so nothing jumps
    const k = f(rand).map((k) => ({ ...REST, ...k }))
    if (n !== 'rise') {
      k[0] = { ...pose, t: 0, ease: 'linear' }
      k[0].yaw = ((pose.yaw % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI
    }
    keys = k; t = 0; name = n
    return true
  }
  function cancel() { keys = null; name = ''; Object.assign(pose, REST); wait = 3 }
  function sample() {
    if (t >= keys[keys.length - 1].t) { Object.assign(pose, keys[keys.length - 1]); return true }
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i]
      if (t <= b.t) {
        const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1, e = E[b.ease](u)
        for (const c of CH) pose[c] = a[c] + (b[c] - a[c]) * e
        return false
      }
    }
    return true
  }
  // idle: true when the character is free (not held / talking): pick a move every few seconds
  function update(dt, idle) {
    if (keys) {
      t += dt
      if (sample()) { keys = null; name = ''; Object.assign(pose, REST); wait = nextWait() }
    } else if (idle && !quiet) {
      wait -= dt
      if (wait <= 0) {
        let total = idleList.reduce((s, [, w]) => s + w, 0), r = rand() * total
        for (const [n, w] of idleList) { if ((r -= w) <= 0) { play(n); break } }
      }
    } else wait = Math.max(wait, 2)
    return pose
  }
  return { play, cancel, update, get name() { return name }, get pose() { return pose }, set quiet(v) { quiet = !!v } }   // quiet: no idle moves (asleep)
}
