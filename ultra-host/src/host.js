// Ultra FX host: runs Ultra Elements spells (three r186) as an overlay layer on top of a HACKAR:S
// AR scene (three r160). The two never share objects: this module owns its own renderer and canvas,
// copies the AR camera every frame, and draws only the spell effects. The canvas is composited
// over the camera view with mix-blend-mode: screen, so black stays transparent and glow adds.
//
// World mapping: Ultra's arena is in metres with its first dummy standing at ARENA.dummies[0].
// The AR character is mapped onto that dummy, scaled by k = character height / dummy height, so
// a spell that hits "dummy 1" lands on the character. The arena geometry is never drawn, but its
// SDF stays, so the floor at y = 0 is the AR floor and particles bounce on it.
import * as THREE from 'three';
import { Q } from '../vendor/ultra-elements/engine/quality.js';
import { PostFX } from '../vendor/ultra-elements/engine/PostFX.js';
import { CameraRig } from '../vendor/ultra-elements/engine/camera.js';
import { SkySystem } from '../vendor/ultra-elements/scene/sky.js';
import { createArena } from '../vendor/ultra-elements/scene/arena.js';
import { U, ARENA, packWorld, lights, forces, impacts, occluders } from '../vendor/ultra-elements/vfx/common.js';
import { bakeNoise } from '../vendor/ultra-elements/vfx/noise.js';
import { GroundField } from '../vendor/ultra-elements/vfx/GroundField.js';
import { Particles } from '../vendor/ultra-elements/vfx/Particles.js';
import { TrailRibbons, AnalyticRibbons } from '../vendor/ultra-elements/vfx/Ribbons.js';
import { Bolts } from '../vendor/ultra-elements/vfx/Bolts.js';
import { Volumes } from '../vendor/ultra-elements/vfx/Volumes.js';
import { Shockwaves } from '../vendor/ultra-elements/vfx/Shockwaves.js';
import { FxTarget } from '../vendor/ultra-elements/vfx/FxTarget.js';
import { Lens } from '../vendor/ultra-elements/vfx/Lens.js';
import { Spikes } from '../vendor/ultra-elements/vfx/Spikes.js';
import { Sigils } from '../vendor/ultra-elements/vfx/Sigils.js';
import { Metaballs } from '../vendor/ultra-elements/vfx/Metaballs.js';
import { Casts } from '../vendor/ultra-elements/spells/cast.js';
import { SPELLS, ENTRIES } from '../vendor/ultra-elements/spells/index.js';

export const CATALOG = ENTRIES.map((e) => ({ spell: e.spell.id, form: e.form, name: e.name, element: e.element }));

const NO_TIMER = { begin() {}, beginFrame() {}, endFrame() {} };
const DUMMY = ARENA.dummies[0];
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _yaw = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _hit = new THREE.Vector3();

// opts.getCamera(): the AR camera (any three version: matrixWorld, projectionMatrix, near, far).
// opts.getAnchor(): { position: [x, y, z], yaw, height } of the character in AR world space, or null
// while nothing is placed. opts.spell / opts.form pick the spell; opts.interval re-casts it.
export function start(opts) {
  try { return startUnsafe(opts); } catch (e) { console.warn('UltraFX: could not start', e); return null; }   // never take the AR page down
}

function startUnsafe(opts) {
  const { getCamera, getAnchor, interval = 3.5, exposure = 1, parent = document.body, zIndex = 2 } = opts;
  let spell = SPELLS.find((s) => s.id === opts.spell) ?? SPELLS.find((s) => s.id === 'lightning');
  let form = spell.forms?.includes(opts.form) ? opts.form : spell.forms?.[0] ?? '';

  const renderer = new THREE.WebGLRenderer({ antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance' });
  if (!renderer.extensions.has('EXT_color_buffer_float')) { renderer.dispose(); return null; }
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  const el = renderer.domElement;
  Object.assign(el.style, { position: parent === document.body ? 'fixed' : 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', mixBlendMode: 'screen', zIndex: String(zIndex) });
  el.dataset.ultraFx = '1';
  if (opts.after?.parentNode === parent) parent.insertBefore(el, opts.after.nextSibling);   // right above the AR canvas, under the UI
  else parent.appendChild(el);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 400);
  camera.matrixAutoUpdate = false;
  const rig = new CameraRig();
  rig.reduced = true;   // the AR camera is the user's hand: no shake, no punch

  const scenes = { opaque: new THREE.Scene(), refract: new THREE.Scene(), lines: new THREE.Scene(), fx: new THREE.Scene() };
  const sky = new SkySystem(renderer);
  sky.setPreset('dusk');
  bakeNoise(renderer, Q);
  const ground = new GroundField(renderer, Q.groundSize);
  const arena = createArena({ renderer, sky });   // logic only: its meshes are never added to a scene
  U.uSkyCube.value = sky.cube;
  const emptyReflection = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  emptyReflection.needsUpdate = true;
  arena.uniforms.uReflection.value = emptyReflection;

  const particles = new Particles(renderer, { ground });
  const trails = new TrailRibbons({ max: 64, points: 48 });
  const bolts = new Bolts(), volumes = new Volumes(), shocks = new Shockwaves();
  const spikes = new Spikes({ max: 48 }), sigils = new Sigils({ max: 8 }), metaballs = new Metaballs({ max: 4 });
  const fxTarget = new FxTarget(renderer), lens = new Lens(renderer), post = new PostFX(renderer);
  post.viewCamera = camera;
  post.params.bloomLevels = Q.bloomLevels;
  post.params.autoExposure = false;   // the scene is black, metering it would blow every spell out
  post.params.exposure = exposure;
  post.params.meterEvery = 3;

  let seed = 1;
  const fx = {
    renderer, camera, scenes, U, Q, ARENA, sky, arena, ground, particles, trails, bolts, volumes, shocks, spikes, sigils, metaballs,
    lights, forces, impacts, occluders, rig, post, lens, fxTarget, AnalyticRibbons,
    dummies: arena.dummies, pool: arena.pool, spells: {}, reduced: true, systems: [],
    rand() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; },
    flash(amount) { post.params.flash = Math.min(0.15, Math.max(post.params.flash ?? 0, amount * 0.15)); },   // over a camera feed a full-screen flash reads as a white-out
    groundAt: () => null,
  };
  for (const d of arena.dummies) if (d.mesh) d.mesh.visible = false;

  scenes.lines.add(bolts.cores, trails.lines, sigils.mesh);
  scenes.opaque.add(spikes.opaque);
  scenes.refract.add(spikes.refract, metaballs.group);
  scenes.fx.add(bolts.glows, trails.fx, shocks.mesh, volumes.group);
  // every spell's particle kinds are registered (hybrids borrow others', e.g. blizzard emits
  // 'wind.streak'), but only the chosen spell allocates in create(): a phone can't hold all 39
  for (const s of SPELLS) {
    s.params = { ...s.params };
    for (const [k, def] of Object.entries(s.kinds ?? {})) particles.addKind(`${s.id}.${k}`, def);
    fx.spells[s.id] = s;
  }
  const live = [spell];
  for (const s of live) s.inst = s.create(fx);
  particles.build();
  scenes.lines.add(particles.glow);
  scenes.fx.add(particles.media);
  scenes.opaque.add(...particles.debris);
  scenes.refract.add(scenes.lines);
  const casts = new Casts(fx);
  fx.casts = casts;

  let hdrRT = null;
  const size = new THREE.Vector2();
  function resize() {
    const w = parent === document.body ? window.innerWidth : parent.clientWidth;
    const h = parent === document.body ? window.innerHeight : parent.clientHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * Q.resolution);
    renderer.setSize(w, h, false);
    renderer.getDrawingBufferSize(size);
    hdrRT?.dispose();
    hdrRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, samples: Q.msaa, generateMipmaps: false,
      depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType),
    });
    U.uSceneColor.value = hdrRT.texture;
    U.uSceneDepth.value = hdrRT.depthTexture;
    U.uResolution.value.copy(size);
    fxTarget.setSize(size.x, size.y, Q.fxScale);
    post.setSize(size.x, size.y);
    lens.setSize?.(size.x, size.y);
  }
  window.addEventListener('resize', resize);
  resize();
  sky.update();
  arena.updateSun();

  // AR camera -> Ultra camera: Ultra pos = dummy + R(-yaw) * (ar - anchor) / k, same view rotation
  let k = 1;
  function syncCamera(anchor) {
    const ar = getCamera();
    if (!ar) return false;
    ar.updateMatrixWorld?.();
    k = Math.max(1e-3, (anchor.height ?? 0.6) / ARENA.dummyHeight);
    _yaw.setFromAxisAngle(_up, -(anchor.yaw ?? 0));
    _m.fromArray(ar.matrixWorld.elements).decompose(_p, _q, _s);
    _p.sub(_hit.fromArray(anchor.position)).applyQuaternion(_yaw).multiplyScalar(1 / k).add(DUMMY);
    _q.premultiply(_yaw);
    camera.matrixWorld.compose(_p, _q, _s.set(1, 1, 1));
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.position.copy(_p);
    camera.quaternion.copy(_q);
    camera.projectionMatrix.fromArray(ar.projectionMatrix.elements);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.near = (ar.near ?? 0.01) / k;
    camera.far = (ar.far ?? 1000) / k;
    U.uNearFar.value.set(camera.near, camera.far);
    return true;
  }

  function castNow() {
    _hit.copy(DUMMY).setY(1.1);
    casts.cast(spell, _hit.clone(), { form, target: 0 });
  }

  let warm = false, running = true, last = performance.now(), simTime = 0, timer = 0.6;
  (async () => {
    renderer.setRenderTarget(hdrRT);
    for (const sc of Object.values(scenes)) await renderer.compileAsync(sc, camera);
    renderer.setRenderTarget(null);
    warm = true;
  })();

  function frame(dt) {
    const sdt = dt * rig.timeScale;
    simTime += sdt;
    U.uTime.value = simTime % 3600;
    U.uDt.value = sdt;
    U.uFrame.value++;
    casts.update(sdt);
    for (const s of live) s.inst.tick?.(sdt);
    arena.update(renderer, sdt, camera);
    spikes.update(sdt);
    sigils.update();
    packWorld(sdt, { maxLights: Q.maxLights, maxShadowed: 0 });
    particles.update(sdt, simTime);
    ground.update(sdt);
    trails.update(sdt);
    bolts.update();
    volumes.update(camera);
    shocks.update(sdt);
    metaballs.update();
    for (const sys of fx.systems) sys.update(sdt, camera);

    renderer.info.reset();
    renderer.setRenderTarget(hdrRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scenes.opaque, camera);
    renderer.render(scenes.refract, camera);
    let out = fxTarget.render(scenes.fx, camera, hdrRT.texture, NO_TIMER, null);
    if (lens.active) out = lens.render(out, hdrRT.depthTexture, camera);
    post.render(out, dt, hdrRT.texture);
    post.params.flash = Math.max(0, (post.params.flash ?? 0) - dt * 6);
  }

  function loop(now) {
    if (!running) return;
    const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
    last = now;
    const anchor = getAnchor();
    el.style.visibility = anchor ? 'visible' : 'hidden';
    if (anchor && warm && syncCamera(anchor)) {
      timer -= dt;
      if (timer <= 0) { timer = interval; castNow(); }
      frame(dt);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return {
    canvas: el,
    cast: castNow,
    get scale() { return k; },
    stop() {
      running = false;
      window.removeEventListener('resize', resize);
      el.remove();
      renderer.dispose();
    },
  };
}
