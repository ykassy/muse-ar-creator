import * as THREE from 'three';
import { ARENA, U, occluders, lights } from '../vfx/common.js';
import { floorMaterial, stoneMaterial, withAO, STONE, arenaUniforms, configureWorldFetch } from './arenaMaterial.js';
import { createDummies } from './dummies.js';
import { createPool } from './pool.js';

// "The Proving Ground": the layout is ARENA (common.js); this builds it, kept lean (the spells
// are the product). Opaque scene (group): polished basalt floor with the pool recessed into it,
// rim wall, 8 plain columns with rune bands, the focus pedestal + orb, 3 dummies. Refract scene
// (refractGroup): the pool surface and the dummies' ice shells. One DirectionalLight (sun, or
// the moon at night) with a static shadow map, re-rendered only when the light moves.
export const REFLECT_LAYER = 1;

// --- lathe with hard/soft edges and AO per profile point --------------------------------------
// profile: [r, y, ao?] in order, outside on the right of travel (outer faces go up, inner faces
// down). Corners sharper than 40 deg get their own ring per side, so computeVertexNormals keeps
// them crisp.
function lathe(profile, segs) {
  const pos = [], ao = [], idx = [];
  const rings = [];
  const dir = (a, b) => { const dr = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dr, dy) || 1; return [dr / l, dy / l]; };
  const ring = (p) => {
    const start = pos.length / 3;
    for (let j = 0; j <= segs; j++) {
      const t = (j / segs) * Math.PI * 2;
      pos.push(Math.cos(t) * p[0], p[1], Math.sin(t) * p[0]);
      ao.push(p[2] ?? 1);
    }
    return start;
  };
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    const a = i > 0 ? dir(profile[i - 1], p) : null, b = i < profile.length - 1 ? dir(p, profile[i + 1]) : null;
    const hard = a && b && a[0] * b[0] + a[1] * b[1] < Math.cos(THREE.MathUtils.degToRad(40));
    const r0 = ring(p);
    rings.push([r0, hard ? ring(p) : r0]);   // [ring ending the previous segment, ring starting the next]
  }
  for (let i = 0; i < profile.length - 1; i++) {
    const s0 = rings[i][1], s1 = rings[i + 1][0];
    for (let j = 0; j < segs; j++) {
      const a = s0 + j, b = s1 + j, c = s0 + j + 1, d = s1 + j + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(ao, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const arc = (out, cx, cy, rad, a0, a1, steps, ao = 1) => {
  for (let i = 0; i <= steps; i++) {
    const a = THREE.MathUtils.degToRad(a0 + (a1 - a0) * (i / steps));
    out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a), ao]);
  }
};

// A plain column: plinth, shaft, capital block (the rune bands at 1.62-1.86 m and 4.34-4.52 m
// are shader-only). 32 sides is round enough at arena distances.
function pillarGeometry() {
  const R = ARENA.pillarRadius;
  return lathe([[R + 0.2, 0, 0.7], [R + 0.2, 0.3], [R, 0.36, 0.8], [R, 5.6], [R + 0.22, 5.68, 0.85], [R + 0.22, 6.0], [0.0, 6.0]], 32);
}

function rimGeometry() {
  const o = ARENA.radius + ARENA.wallThickness, i = ARENA.radius, h = ARENA.wallHeight;
  return lathe([
    [o + 0.02, 0, 0.7], [o + 0.02, h - 0.22], [o + 0.06, h - 0.2], [o + 0.06, h - 0.04], [o + 0.03, h],
    [i - 0.03, h], [i - 0.06, h - 0.04], [i - 0.06, h - 0.2], [i - 0.02, h - 0.22, 0.85], [i - 0.02, 0.15], [i - 0.06, 0.13], [i - 0.06, 0, 0.6],
  ], 128);
}

function pedestalGeometry() {
  const p = [[0.5, 0, 0.7], [0.5, 0.11], [0.47, 0.14], [0.44, 0.155]];
  arc(p, 0.43, 0.19, 0.03, -90, 90, 5);
  p.push([0.38, 0.22, 0.75], [0.33, 0.27], [0.3, 0.3], [0.27, 0.6], [0.262, 0.62, 0.85], [0.262, 0.82, 0.85], [0.27, 0.84], [0.26, 0.95], [0.29, 0.972, 0.8]);
  arc(p, 0.3, 1.0, 0.025, -90, 90, 4);
  p.push([0.32, 1.035, 0.8], [0.38, 1.07], [0.43, 1.1], [0.45, 1.12], [0.45, 1.14], [0.43, 1.15], [0.36, 1.15], [0.28, 1.13, 0.8], [0.0, 1.11, 0.7]);
  return lathe(p, 32);
}

function floorGeometry() {
  const P = ARENA.pool, shape = new THREE.Shape();
  shape.absarc(0, 0, ARENA.radius + 0.3, 0, Math.PI * 2, false);
  // ShapeGeometry is in xy; after rotateX(-90) shape y = -world z
  const hole = new THREE.Path();
  const x0 = P.center.x - P.half.x, x1 = P.center.x + P.half.x, y0 = -P.center.y - P.half.y, y1 = -P.center.y + P.half.y;
  hole.moveTo(x0, y0); hole.lineTo(x0, y1); hole.lineTo(x1, y1); hole.lineTo(x1, y0); hole.lineTo(x0, y0);
  shape.holes.push(hole);
  return withAO(new THREE.ShapeGeometry(shape, 64).rotateX(-Math.PI / 2));
}

// the pool's basin: bottom + four inward-facing walls
function basinGeometry() {
  const P = ARENA.pool, d = P.depth, w = P.half.x * 2, l = P.half.y * 2, cx = P.center.x, cz = P.center.y;
  const parts = [
    new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2).translate(cx, -d, cz),
    new THREE.PlaneGeometry(l, d).rotateY(Math.PI / 2).translate(cx - w / 2, -d / 2, cz),
    new THREE.PlaneGeometry(l, d).rotateY(-Math.PI / 2).translate(cx + w / 2, -d / 2, cz),
    new THREE.PlaneGeometry(w, d).translate(cx, -d / 2, cz - l / 2),
    new THREE.PlaneGeometry(w, d).rotateY(Math.PI).translate(cx, -d / 2, cz + l / 2),
  ];
  const g = new THREE.BufferGeometry();
  let pos = [], nrm = [], idx = [], base = 0;
  for (const p of parts) {
    pos.push(...p.attributes.position.array); nrm.push(...p.attributes.normal.array);
    idx.push(...Array.from(p.index.array, (i) => i + base));
    base += p.attributes.position.count;
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return withAO(g, 0.75);
}

const ORB_VERT = /* glsl */`
out vec3 vN;
out vec3 vP;
out vec3 vV;
void main() {
  vP = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
// the focus orb: a swirling plasma core with a bright Fresnel rim (HDR, blooms)
const ORB_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
uniform sampler2D uStoneNoise;
in vec3 vN;
in vec3 vP;
in vec3 vV;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vN), v = normalize(vV);
  float nv = abs(dot(n, v));
  vec3 d = normalize(vP);
  vec2 sp = vec2(atan(d.z, d.x) / 6.2831853, d.y * 0.5 + 0.5);
  float s = texture(uStoneNoise, sp * vec2(2.0, 1.0) + vec2(uTime * 0.05, -uTime * 0.03)).r;
  float s2 = texture(uStoneNoise, sp * vec2(3.0, 1.5) - vec2(uTime * 0.08, uTime * 0.02)).g;
  float swirl = pow(1.0 - abs(s - s2), 6.0);
  vec3 core = uColor * (1.2 + 6.0 * swirl + 4.0 * pow(nv, 6.0));
  vec3 rim = uColor * pow(1.0 - nv, 2.5) * 3.0;
  fragColor = vec4(core + rim + vec3(1.0) * pow(nv, 16.0) * dot(uColor, vec3(0.3)) * 6.0, 1.0);
}`;

export function createArena({ renderer, sky }) {
  configureWorldFetch(renderer);   // before any arena material is made
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;   // static: refreshed in updateSun()
  const group = new THREE.Group(), refractGroup = new THREE.Group();
  const reflect = (o) => { o.layers.enable(REFLECT_LAYER); return o; };
  const solid = (o, cast = true) => { o.castShadow = cast; o.receiveShadow = true; return o; };
  U.uSkyCube.value = sky.cube;

  // Draw order (three sorts opaque by renderOrder, then material, then depth): the upright
  // occluders (0) go first so early-z rejects the floor (1) under them; the sky is 1000. Beyond
  // the rim there is nothing but the sky cube's dark ground.
  const late = (o, order) => { o.renderOrder = order; return o; };
  group.add(late(solid(new THREE.Mesh(floorGeometry(), floorMaterial())), 1));
  group.add(late(solid(new THREE.Mesh(basinGeometry(), stoneMaterial(STONE.basin)), false), 1));

  // rim wall, pillars
  group.add(reflect(solid(new THREE.Mesh(rimGeometry(), stoneMaterial(STONE.rim)))));
  const pillarGeo = pillarGeometry(), pillarMat = stoneMaterial(STONE.pillar);
  const pillars = reflect(solid(new THREE.InstancedMesh(pillarGeo, pillarMat, ARENA.pillars.length)));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
  ARENA.pillars.forEach((p, i) => {
    pillars.setMatrixAt(i, m.compose(p, q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 0.7), sc));   // rotation varies the runes
    occluders.add(p, new THREE.Vector3(p.x, ARENA.pillarHeight, p.z), ARENA.pillarRadius, 0);
  });
  pillars.computeBoundingSphere();
  group.add(pillars);

  // pedestal + focus orb + its two brass rings
  const ped = ARENA.pedestal;
  group.add(reflect(solid(new THREE.Mesh(pedestalGeometry(), stoneMaterial(STONE.pedestal))).translateX(ped.pos.x).translateZ(ped.pos.z)));
  occluders.add(ped.pos, new THREE.Vector3(ped.pos.x, ped.height, ped.pos.z), ped.radius, 4);
  const orbColor = new THREE.Color();
  const orb = reflect(new THREE.Mesh(new THREE.SphereGeometry(0.19, 32, 20), new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: ORB_VERT, fragmentShader: ORB_FRAG,
    uniforms: { uColor: { value: orbColor }, uTime: U.uTime, uStoneNoise: arenaUniforms.uStoneNoise },
  })));
  orb.position.copy(ARENA.focus);
  group.add(orb);
  const brass = stoneMaterial(STONE.brass);
  const rings = [0.31, 0.38].map((r) => {
    const g = reflect(solid(new THREE.Mesh(withAO(new THREE.TorusGeometry(r, 0.009, 6, 48)), brass), false));
    g.position.copy(ARENA.focus);
    group.add(g);
    return g;
  });
  const orbLight = lights.acquire();
  // no capsule shadow (the floor shades the pedestal's own shadow analytically): saves ~0.08 ms at
  // 3.3 MP and leaves every shadowed slot (Q.shadowLights) to the spells
  Object.assign(orbLight, { range: 5.5, type: 0, shadow: false });
  orbLight.pos.copy(ARENA.focus);
  const focus = { color: new THREE.Color(1.0, 0.72, 0.42), intensity: 1 };

  // dummies (opaque) + their ice shells (refract)
  const dummies = createDummies();
  for (const d of dummies) {
    group.add(d.group);
    reflect(d.mesh);
    refractGroup.add(d.shellGroup);
  }
  const pool = createPool(renderer);
  refractGroup.add(pool.mesh);

  // --- the sun (or moon): static shadow map fitted to the arena in light space ------------
  const sunLight = new THREE.DirectionalLight(0xffffff, Math.PI);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.025;
  sunLight.shadow.radius = 2;
  reflect(sunLight);   // lights are layer-tested too: the reflection pass must see the same light
  group.add(sunLight, sunLight.target);
  arenaUniforms.uShadowMatrix.value = sunLight.shadow.matrix;   // every arena surface + the pool

  const _p = new THREE.Vector3(), box = new THREE.Box3();
  function fitShadow() {
    const cam = sunLight.shadow.camera;
    cam.position.copy(sunLight.position);
    cam.lookAt(sunLight.target.position);
    cam.updateMatrixWorld();
    box.makeEmpty();
    const r = ARENA.radius + ARENA.wallThickness + 0.2;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      for (const y of [-0.2, ARENA.pillarHeight + 0.2]) box.expandByPoint(_p.set(Math.cos(a) * r, y, Math.sin(a) * r).applyMatrix4(cam.matrixWorldInverse));
    }
    Object.assign(cam, { left: box.min.x, right: box.max.x, bottom: box.min.y, top: box.max.y, near: Math.max(0.1, -box.max.z - 1), far: -box.min.z + 1 });
    cam.updateProjectionMatrix();
  }
  // Re-render the static shadow map now, through a camera that sees every layer (the shadow pass
  // tests the viewing camera's layers: done during the reflection pass it would drop the floor)
  // and nothing else (it looks away from everything, so no colour draws happen).
  const shadowRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const shadowCam = new THREE.PerspectiveCamera(1, 1, 1, 2);
  shadowCam.layers.enableAll();
  shadowCam.position.set(0, -2000, 0);
  shadowCam.lookAt(0, -3000, 0);
  shadowCam.updateMatrixWorld();
  function refreshShadow() {
    const prev = renderer.getRenderTarget();
    renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(shadowRT);
    renderer.render(group, shadowCam);
    renderer.setRenderTarget(prev);
  }

  function updateSun() {
    sunLight.color.copy(sky.lightColor);
    sunLight.intensity = sky.lightIntensity;
    sunLight.position.copy(sky.lightDir).multiplyScalar(80);
    sunLight.target.position.set(0, 0, 0);
    sunLight.updateMatrixWorld();
    sunLight.target.updateMatrixWorld();
    fitShadow();
    // the shared world sees the same light (particles light themselves with these)
    U.uSunDir.value.copy(sky.lightDir);
    U.uSunColor.value.copy(sky.lightRadiance);
    U.uAmbient.value.copy(sky.ambient);
    U.uSkyCube.value = sky.cube;
    refreshShadow();
  }

  function setFocus(color, intensity = 1) {
    focus.color.copy(color);
    focus.intensity = intensity;
  }

  let t = 0;
  function update(rendererIn, dt) {
    t += dt;
    for (const d of dummies) d.update(dt);
    pool.update(rendererIn, dt);
    // orb: slow breathing, rings precessing; its spell light follows the colour
    const breathe = 1 + 0.08 * Math.sin(t * 2.1) + 0.04 * Math.sin(t * 5.3);
    orbColor.copy(focus.color).multiplyScalar(focus.intensity * 2.2 * breathe);
    arenaUniforms.uFocusColor.value.copy(focus.color).multiplyScalar(focus.intensity * 0.9 * breathe);
    orbLight.color.copy(focus.color);
    orbLight.intensity = 2.5 * focus.intensity * breathe;
    orb.position.y = ARENA.focus.y + Math.sin(t * 1.3) * 0.025;
    orbLight.pos.copy(orb.position);
    rings[0].rotation.set(t * 0.7, t * 0.4, 0);
    rings[1].rotation.set(-t * 0.3, 0, t * 0.55);
    rings[0].position.y = rings[1].position.y = orb.position.y;
    const map = sunLight.shadow.map;
    arenaUniforms.uShadowMap.value = map ? map.depthTexture : null;
    arenaUniforms.uShadowOn.value = map ? 1 : 0;
  }

  updateSun();
  // three sets a render list's light state up after its shadow pass, so the very first shadow
  // render compiles depth programs for "no lights"; a second one compiles the variants every
  // later updateSun() uses (otherwise the first preset change hitches on two compiles)
  refreshShadow();
  return {
    group, refractGroup, sunLight, dummies, pool, orb, orbLight, focus,
    uniforms: { uReflection: arenaUniforms.uReflection, uReflMatrix: arenaUniforms.uReflMatrix },
    materials: arenaUniforms,
    setFocus, updateSun, update,
  };
}
