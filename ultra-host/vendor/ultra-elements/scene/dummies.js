import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA, U, occluders, COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL } from '../vfx/common.js';
import { arenaMaterial, arenaUniforms, worldUniforms, worldDefines, LIGHT_FN_GLSL } from './arenaMaterial.js';

// Three training dummies (post, straw-stuffed burlap torso and head, wooden arm beam, iron
// bands, rope). Statuses are targets 0..1 that spells set (dummy.status.burn = 1); what is shown
// eases towards them (the ice front climbs, dissolve eats in) and the targets decay on their own.
// Every status goes through the shared arena response pipeline (burn = char + ember heat, wet,
// shock = electric crackle, corrupt = veins), plus two of its own: dissolve (noise-threshold
// discard with a green edge) and frozen (a refractive ice shell in the refract scene).
const PART = { wood: 0, burlap: 1, iron: 2, rope: 3 };

// rise rate (1/s, shown -> target) and decay (target per second)
const RISE = { frozen: 1.6, shock: 12, wet: 3, burn: 4, dissolve: 1.2, corrupt: 2 };
const DECAY = { frozen: 0.07, shock: 1.5, wet: 0.05, burn: 0.12, dissolve: 0.1, corrupt: 0.06 };

function part(geo, id, ao = 1) {
  geo.deleteAttribute('uv');
  const n = geo.attributes.position.count;
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(id), 1));
  geo.setAttribute('aAO', new THREE.Float32BufferAttribute(new Float32Array(n).fill(ao), 1));
  return geo;
}

// sack silhouette (radius by height), shared by the torso lathe and the ice shell envelope
const SACK = [[0.0, 0.6], [0.11, 0.62], [0.2, 0.7], [0.27, 0.84], [0.3, 1.0], [0.29, 1.16], [0.25, 1.3], [0.16, 1.39], [0.08, 1.43], [0.0, 1.44]];

function dummyGeometry() {
  const parts = [];
  // base: banded wooden drum
  parts.push(part(new THREE.CylinderGeometry(0.3, 0.33, 0.12, 24).translate(0, 0.06, 0), PART.wood, 0.8));
  parts.push(part(new THREE.CylinderGeometry(0.335, 0.335, 0.03, 24, 1, true).translate(0, 0.06, 0), PART.iron));
  parts.push(part(new THREE.CylinderGeometry(0.055, 0.065, 1.62, 10).translate(0, 0.93, 0), PART.wood));
  // torso: a burlap sack, a little flatter front to back
  const sack = new THREE.LatheGeometry(SACK.map(([r, y]) => new THREE.Vector2(r, y)), 28).scale(1, 1, 0.82);
  parts.push(part(sack, PART.burlap));
  for (const [y, r] of [[0.95, 0.305], [1.21, 0.285]]) parts.push(part(new THREE.CylinderGeometry(r, r, 0.045, 28, 1, true).scale(1, 1, 0.82).translate(0, y, 0), PART.iron));
  parts.push(part(new THREE.TorusGeometry(0.13, 0.022, 6, 20).rotateX(Math.PI / 2).translate(0, 0.66, 0), PART.rope, 0.8));
  parts.push(part(new THREE.TorusGeometry(0.085, 0.02, 6, 16).rotateX(Math.PI / 2).translate(0, 1.43, 0), PART.rope, 0.8));
  // arm beam with rope-wrapped ends
  parts.push(part(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 8).rotateZ(Math.PI / 2).translate(0, 1.27, 0), PART.wood));
  for (const x of [-0.52, 0.52]) parts.push(part(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10).rotateZ(Math.PI / 2).translate(x, 1.27, 0), PART.rope));
  // head
  parts.push(part(new THREE.SphereGeometry(0.16, 20, 14).scale(1, 1.1, 0.95).translate(0, 1.62, 0), PART.burlap));
  return mergeGeometries(parts);
}

// the ice shell: a coarse, chunky block around the body (a 9-sided lathe of the silhouette plus
// a hexagonal prism around the arms), a few crystals breaking out of it; every vertex pushed
// in or out by a hash of its position (seams stay closed), so the flat derivative normals give
// big irregular facets like hand-hewn or grown ice, not a smooth glassy skin
function shellGeometry() {
  const prof = [[0.46, -0.02], [0.47, 0.17], [0.24, 0.32], [0.2, 0.56], [0.33, 0.7], [0.43, 0.96], [0.4, 1.2], [0.3, 1.42], [0.3, 1.6], [0.27, 1.8], [0.12, 1.95], [0.0, 1.98]];
  const parts = [new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 9).scale(1, 1, 0.9)];
  parts.push(new THREE.CylinderGeometry(0.15, 0.15, 1.36, 6, 2).rotateZ(Math.PI / 2).translate(0, 1.27, 0));
  // crystals: [x, y, z, tilt about z, tilt about x, length, radius]
  for (const [x, y, z, az, ax, l, r] of [[0.3, 1.38, 0.05, -0.7, 0.2, 0.5, 0.07], [-0.36, 1.45, -0.05, 0.9, -0.15, 0.42, 0.06], [0.08, 1.8, 0.04, -0.25, 0.3, 0.38, 0.05],
    [0.32, 0.18, 0.28, -1.0, 0.6, 0.42, 0.075], [-0.38, 0.12, -0.2, 1.1, -0.5, 0.36, 0.065], [0.05, 0.9, 0.36, 0.1, 1.05, 0.3, 0.05]]) {
    const c = new THREE.CylinderGeometry(0, r, l, 6, 1).translate(0, l * 0.5, 0);
    c.rotateX(ax).rotateZ(az).translate(x, y, z);
    parts.push(c);
  }
  const g = mergeGeometries(parts.map((x) => { x.deleteAttribute('uv'); x.deleteAttribute('normal'); return x; }));
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const h = Math.sin(v.x * 91.7 + v.y * 37.3 + v.z * 53.1) * 43758.5453, k = (h - Math.floor(h) - 0.4) * 0.07;
    const q = Math.sin(v.x * 17.1 + v.y * 71.9 + v.z * 23.3) * 24634.6345, kq = (q - Math.floor(q) - 0.5) * 0.05;
    p.setXYZ(i, v.x * (1 + k), v.y + kq, v.z * (1 + k));
  }
  return g;
}

const DUMMY_PARS = /* glsl */`
uniform vec4 uStatusA;   // shown: frozen, shock, wet, burn
uniform vec4 uStatusB;   // shown: dissolve, corrupt, seed, ice front height (m)
flat varying float vPart;
`;
const DUMMY_VERT_PARS = /* glsl */`
attribute float aPart;
`;
const DUMMY_VERT = /* glsl */`
  vPart = aPart;
`;
const DUMMY_SURFACE = /* glsl */`
{
  vec3 lp = vLocal;
  float rr = length(lp.xz);
  sp2 = vec2(atan(lp.z, lp.x) * 0.3, lp.y);
  vec4 nA = texture(uStoneNoise, sp2 * vec2(1.0, 0.7) + uStatusB.z);
  vec4 nB = texture(uStoneNoise, sp2 * 3.0 + uStatusB.z * 2.0);
  gAO = vAO;
  if (vPart < 0.5) {
    // wood: grain along the post (vertical) or the arm beam (horizontal)
    bool beam = abs(lp.x) > 0.07 && abs(lp.y - 1.27) < 0.06;
    vec2 gu = beam ? vec2((lp.y + lp.z) * 9.0, lp.x * 0.5) : vec2((lp.x + lp.z) * 9.0, lp.y * 0.5);
    float grain = texture(uStoneNoise, gu * vec2(1.0, 0.25) + uStatusB.z).r;
    grain = 0.5 + 0.5 * sin(grain * 40.0);
    albedo = mix(vec3(0.17, 0.10, 0.05), vec3(0.30, 0.19, 0.10), grain) * (0.8 + 0.3 * nA.g);
    rough = 0.72;
    crevice = (1.0 - grain) * 0.4;
  } else if (vPart < 1.5) {
    // burlap: an open weave, a painted target on the chest
    float s = atan(lp.z, lp.x) * max(rr, 0.12);
    vec2 wv = vec2(s, lp.y) * 260.0;
    float aa = clamp(px * 260.0, 0.0, 1.0);
    float weave = mix(0.5 + 0.5 * sin(wv.x) * sin(wv.y + 1.57 * step(0.0, sin(wv.x * 0.5))), 0.5, aa);
    albedo = vec3(0.40, 0.31, 0.19) * (0.7 + 0.45 * nA.r) * (0.75 + 0.35 * weave);
    rough = 0.92;
    crevice = (1.0 - weave) * 0.6 + smoothstep(0.55, 0.8, nB.r) * 0.6;
    if (lp.z > 0.0 && lp.y < 1.45) {
      float d = length(vec2(lp.x, lp.y - 1.04)) / 0.045;
      float ring = mod(floor(d), 2.0);
      float paint = step(d, 4.99) * smoothstep(0.25, 0.55, nB.g + 0.2);   // worn
      albedo = mix(albedo, ring < 0.5 ? vec3(0.42, 0.04, 0.03) : vec3(0.55, 0.48, 0.34), paint * 0.85);
    }
  } else if (vPart < 2.5) {
    // iron: dark, rust in patches
    float rust = smoothstep(0.45, 0.75, nB.r);
    albedo = mix(vec3(0.06, 0.058, 0.055), vec3(0.2, 0.08, 0.03), rust);
    metal = 1.0 - rust;
    rough = mix(0.38, 0.85, rust);
  } else {
    // rope: twisted strands
    float tw = 0.5 + 0.5 * sin((lp.y * 3.0 + atan(lp.z, lp.x)) * 14.0 + lp.x * 60.0);
    albedo = vec3(0.36, 0.28, 0.17) * (0.7 + 0.4 * tw);
    rough = 0.88;
    crevice = 1.0 - tw;
  }
  // statuses -> the shared state (responses run after this block)
  float burn = uStatusA.w;
  if (burn > 0.0) {
    // charred all over, embers glowing only in a network of cracks, breathing
    float flick = 0.55 + 0.45 * sin(uTime * 3.1 + nA.r * 14.0) * sin(uTime * 1.7 + nB.g * 9.0);
    // alligatored char: thin voronoi borders (stone noise .b = F2-F1), only where the fbm says it caught
    float cracks = (1.0 - smoothstep(0.02, 0.09, nB.b)) * smoothstep(0.42, 0.62, nA.r + 0.1 * burn)
                 * (vPart < 1.5 ? 1.0 : 0.3);
    stA.y = max(stA.y, burn * 0.95);
    stA.x = max(stA.x, burn * (0.12 + 0.4 * flick * cracks));
    crevice = max(crevice * 0.1, cracks);
  }
  // under the ice: a thin frost film and the dark, saturated look of a surface wetted by the ice
  float under = smoothstep(uStatusB.w + 0.05, uStatusB.w - 0.15, lp.y);
  stA.z = max(stA.z, max(uStatusA.z, uStatusA.x * 0.45 * under));
  stA.w = max(stA.w, uStatusA.x * 0.3 * under);
  stB.z = max(stB.z, uStatusB.y);
  stElec = max(stElec, uStatusA.y);
  // dissolve: noise threshold with a glowing green edge
  float dis = uStatusB.x;
  if (dis > 0.0) {
    float n = 0.5 * (texture(uStoneNoise, lp.xy * 0.9 + 0.13).r + texture(uStoneNoise, lp.zy * 0.9 + 0.57).g) + (nB.a - 0.5) * 0.2;
    float th = dis * 0.95 + (1.0 - smoothstep(0.0, 1.9, lp.y)) * dis * 0.1 - 0.02;
    if (n < th) discard;
    float edge = smoothstep(th + 0.05, th, n) * step(0.001, dis);
    emit += vec3(0.25, 1.0, 0.2) * edge * 8.0;
    albedo *= 1.0 - edge;
  }
}
`;

// --- ice shell (refract scene) -------------------------------------------------------------
const SHELL_VERT = /* glsl */`
uniform vec4 uStatusB;
uniform vec4 uStatusA;
out vec3 vW;
out vec3 vL;
void main() {
  vL = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  if (uStatusA.x < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // not frozen: culled, no fragments
}`;

// Solid ice around the dummy (reference: objects frozen into clear block ice, ice sculptures).
// Thickness = the ray's path to whatever is behind (the dummy, from the scene depth), capped by a
// chord of the block: the dummy reads through 5-15 cm of ice, the edges through more. The view
// behind is refracted, blurred and cyan-absorbed (Beer-Lambert) by that path, clouded by trapped
// air that thickens towards the frozen surface; two parallax layers of bubbles and a few internal
// fracture sheets give it depth. Outside: sharp sky reflection (Fresnel, IOR 1.31), sun glints on
// the facets, rime frost in patches and heavy at the foot.
const SHELL_FRAG = COMMON_GLSL + NOISE_GLSL + WORLD_GLSL + LIGHTS_GLSL + LIGHT_FN_GLSL + /* glsl */`
uniform mat4 projectionMatrix;
uniform vec4 uStatusA;
uniform vec4 uStatusB;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform samplerCube uSkyCube;
uniform sampler2D uStoneNoise;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
in vec3 vW;
in vec3 vL;
out vec4 fragColor;
void main() {
  // growth front climbing from the feet, ragged by noise
  vec4 n = texture(uStoneNoise, vec2(atan(vL.z, vL.x) * 0.4, vL.y * 0.5) + uStatusB.z);
  float front = uStatusB.w + (n.r - 0.5) * 0.25;
  if (vL.y > front) discard;
  vec3 N = normalize(cross(dFdx(vW), dFdy(vW)));   // flat facets
  vec3 V = normalize(cameraPosition - vW);
  if (dot(N, V) < 0.0) N = -N;
  float nv = max(dot(N, V), 1e-3);
  float F = 0.018 + 0.982 * pow(1.0 - nv, 5.0);   // IOR 1.31
  vec2 uv = gl_FragCoord.xy / uResolution;
  float here = linearDepth(gl_FragCoord.z);
  float thick = clamp(min(linearDepth(texture(uSceneDepth, uv).r) - here, 0.5 * nv + 0.08), 0.02, 0.6);
  // refraction: the screen offset of a step along the refracted ray; depth-validated so it
  // never picks up something in front of the shell; blurred by the path (4 taps)
  vec3 T = refract(-V, N, 1.0 / 1.31);
  vec4 c0 = projectionMatrix * viewMatrix * vec4(vW + T * (0.06 + 0.5 * thick), 1.0);
  vec2 ruv = clamp(c0.xy / c0.w * 0.5 + 0.5, vec2(0.002), vec2(0.998));
  float keep = step(here, linearDepth(texture(uSceneDepth, ruv).r));
  ruv = mix(uv, ruv, keep);
  vec2 o = vec2(1.0, uResolution.x / uResolution.y) * (0.012 * thick / max(here, 0.5));
  vec3 body = 0.25 * (texture(uSceneColor, ruv + o * vec2(0.7, 0.3)).rgb + texture(uSceneColor, ruv - o * vec2(0.7, 0.3)).rgb
                    + texture(uSceneColor, ruv + o * vec2(-0.3, 0.7)).rgb + texture(uSceneColor, ruv - o * vec2(-0.3, 0.7)).rgb);
  body *= exp(-vec3(2.2, 0.55, 0.2) * thick);
  // light inside the block: what the sky and sun put into it, scattered by trapped air
  vec3 scatter = (uAmbient * 1.5 + uSunColor * (0.15 + 0.3 * max(uSunDir.y, 0.0))) * vec3(0.78, 0.9, 1.0);
  vec3 Tl = T;   // the shell barely tilts; local ~ world directions
  vec4 nc = noise3v(vL * 0.9 + uStatusB.z);
  float cloud = clamp(0.12 + 0.9 * thick * (0.5 + nc.r) + 0.3 * (1.0 - smoothstep(0.0, 0.45, vL.y)), 0.0, 0.85);
  body = mix(body, scatter * 0.9, cloud * 0.6);
  // bubbles at two depths (parallax), small and round; nearer ones sharper and brighter
  float bub = 0.0;
  for (int k = 0; k < 2; k++) {
    vec3 q = vL + Tl * thick * (0.3 + 0.45 * float(k));
    float w = noise3v(q * 3.6 + float(k) * 0.37 + uStatusB.z).a;
    bub += smoothstep(0.9, 0.95, w) * (1.0 - 0.45 * float(k)) * smoothstep(0.45, 0.7, nc.g);
  }
  // fracture sheets: a thin iso-surface of the fbm seen half way in, only in a few places
  vec3 qc = vL + Tl * thick * 0.5;
  float fn = noise3v(qc * 0.7 + 0.53).r, fw = fwidth(fn), cw = 0.008;
  float crack = (1.0 - smoothstep(cw, cw + fw * 1.5, abs(fn - 0.5))) * cw / (cw + 0.75 * fw) * smoothstep(0.55, 0.7, nc.b);
  body += scatter * (bub * 0.9 + crack * 1.4);
  vec3 R = reflect(-V, N);
  vec3 refl = textureLod(uSkyCube, vec3(R.x, max(R.y, 0.0), R.z), 0.4).rgb;
  vec3 col = mix(body, refl, F);
  // sun glints on the facets (sharp GGX), spell-light speculars
  vec3 H = normalize(uSunDir + V);
  float nl = max(dot(N, uSunDir), 0.0);
  col += uSunColor * spellD_GGX(max(dot(N, H), 0.0), 0.02) * spellV_Smith(nv, nl, 0.02) * nl * 0.25;
  vec3 sd, ss;
  arenaSpellLights(vW, N, V, 0.08, vec3(0.02), vec3(0.4, 0.5, 0.6) * cloud, sd, ss);
  col += sd + ss;
  // rime: patchy on the faces, heavy at the foot; lit like snow
  // (fine grain, mostly on the up-facing facets and the foot)
  float rg = noise3v(vL * 4.0 + 0.21).a;
  float rime = smoothstep(0.7, 0.85, rg * 0.5 + 0.2 * nc.a + 0.3 * max(N.y, 0.0) + 0.55 * (1.0 - smoothstep(0.0, 0.3, vL.y)));
  vec3 snow = (uAmbient * 1.3 + uSunColor * (0.25 + 0.75 * nl)) * vec3(0.82, 0.88, 0.95);
  col = mix(col, snow, rime * 0.8);
  // light caught at grazing edges (total internal reflection) and the glowing growth edge
  col += scatter * smoothstep(0.35, 0.0, nv) * 0.35;
  col += vec3(0.55, 0.85, 1.0) * smoothstep(0.1, 0.0, front - vL.y) * 4.0 * smoothstep(2.0, 1.8, uStatusB.w);   // only while it climbs
  fragColor = vec4(col, 1.0);
}`;


const _q = new THREE.Quaternion(), _ax = new THREE.Vector3(), _v = new THREE.Vector3();

export function createDummies() {
  const geo = dummyGeometry(), shellGeo = shellGeometry();
  return ARENA.dummies.map((pos, i) => {
    const status = { frozen: 0, shock: 0, wet: 0, burn: 0, dissolve: 0, corrupt: 0 };
    const shown = { ...status };
    const uStatusA = { value: new THREE.Vector4() }, uStatusB = { value: new THREE.Vector4(0, 0, i * 0.37, 0) };
    const mat = arenaMaterial({
      mode: 'dummy', surface: DUMMY_SURFACE, uniforms: { uStatusA, uStatusB },
      parsGLSL: DUMMY_PARS, vertexParsGLSL: DUMMY_VERT_PARS, vertexGLSL: DUMMY_VERT,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.position.copy(pos);
    group.add(mesh);
    const shell = new THREE.Mesh(shellGeo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
      uniforms: { ...U, ...worldUniforms, uStatusA, uStatusB, uStoneNoise: arenaUniforms.uStoneNoise }, defines: worldDefines(),
    }));
    shell.frustumCulled = false;
    const shellGroup = new THREE.Group();   // goes into the refract scene, follows the wobble
    shellGroup.position.copy(pos);
    shellGroup.add(shell);

    const occ = occluders.add(new THREE.Vector3(pos.x, 0.35, pos.z), new THREE.Vector3(pos.x, 1.55, pos.z), ARENA.dummyRadius, 1);
    const tilt = new THREE.Vector2(), vel = new THREE.Vector2();
    return {
      pos, group, shellGroup, mesh, shell, status, shown, occluder: occ,
      // dir: world direction of the hit (only xz matters); strength ~ 1 for a solid hit
      hit(dir, strength = 1) {
        const l = Math.hypot(dir.x, dir.z) || 1;
        vel.x += (dir.x / l) * strength * 2.2;
        vel.y += (dir.z / l) * strength * 2.2;
      },
      update(dt) {
        dt = Math.min(dt, 0.1);
        const s = status, w = shown;
        // burning melts ice and dries; ice and water put fire out
        const melt = s.burn > 0.05 ? 5 : 1;
        if (s.frozen > 0.1 || s.wet > 0.3) s.burn = Math.max(0, s.burn - dt * 0.6);
        for (const k in s) {
          s[k] = Math.max(0, s[k] - DECAY[k] * (k === 'frozen' || k === 'wet' ? melt : 1) * dt);
          w[k] += (s[k] - w[k]) * Math.min(1, RISE[k] * dt);
        }
        uStatusA.value.set(w.frozen, w.shock, w.wet, w.burn);
        uStatusB.value.x = w.dissolve < 0.003 ? 0 : w.dissolve;
        uStatusB.value.y = w.corrupt;
        uStatusB.value.w = w.frozen * 2.15 - 0.12;   // ice front (m above the base)
        shell.visible = w.frozen >= 0.002;   // the vertex shader culls it below this anyway; skip the draw
        // spring wobble about the base: k 55 (~1.2 Hz), lightly damped
        vel.x += (-55 * tilt.x - 3.2 * vel.x) * dt; vel.y += (-55 * tilt.y - 3.2 * vel.y) * dt;
        tilt.x += vel.x * dt; tilt.y += vel.y * dt;
        const a = tilt.length();
        if (a > 0.45) tilt.multiplyScalar(0.45 / a);
        if (a > 1e-5) _q.setFromAxisAngle(_ax.set(tilt.y, 0, -tilt.x).normalize(), Math.min(a, 0.45));
        else _q.identity();
        group.quaternion.copy(_q);
        shellGroup.quaternion.copy(_q);
        // the capsule occluder follows the lean
        occ?.a.copy(_v.set(0, 0.35, 0).applyQuaternion(_q).add(pos));
        occ?.b.copy(_v.set(0, 1.55, 0).applyQuaternion(_q).add(pos));
      },
    };
  });
}
