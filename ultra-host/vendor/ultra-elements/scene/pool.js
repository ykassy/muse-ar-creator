import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { ARENA, U, COMMON_GLSL, WORLD_GLSL, LIGHTS_GLSL, GROUND_GLSL } from '../vfx/common.js';
import { arenaUniforms, worldUniforms, worldDefines, LIGHT_FN_GLSL } from './arenaMaterial.js';

// The reflecting pool: a ripple height field on the wave equation, ping-ponged on the GPU, after
// Evan Wallace's WebGL Water (MIT, madebyevan.com/webgl-water): height + velocity per texel, the
// four-neighbour Laplacian, drops as cosine bumps, walls reflect (clamp-to-edge). Square cells:
// 128 x 256 over the 4.5 x 9 m basin (3.5 cm). Fixed 120 Hz steps, at most 4 per frame.
// Surface (refract scene): refraction of the resolved opaque frame with depth validation (UW's
// water), Beer-Lambert absorption, Fresnel between that and the sky-cube reflection (the
// horizon darkened where the rim hides it), sun and spell-light speculars, frost from the ground field turning it into an ice sheet,
// acid tinting it toxic, and flash() lighting the water from inside (lightning on water).
const NX = 128, NZ = 256, STEP = 1 / 120;
const C = 1.4;                                        // wave speed (m/s)
const DX = (ARENA.pool.half.x * 2) / NX;
const C2 = (C * STEP / DX) ** 2;                      // < 0.5 for stability
const MAX_DROPS = 8;

const SIM_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform vec4 uDrops[${MAX_DROPS}];   // u, v, amplitude (m), radius (m)
uniform int uDropCount;
uniform vec4 uSwirl;                 // u, v, strength, radius (m)
uniform float uPhase;
in vec2 vUv;
out vec4 fragColor;
const vec2 SIZE = vec2(${(ARENA.pool.half.x * 2).toFixed(3)}, ${(ARENA.pool.half.y * 2).toFixed(3)});
void main() {
  vec4 s = texture(uPrev, vUv);
  float hl = texture(uPrev, vUv - vec2(uTexel.x, 0.0)).r, hr = texture(uPrev, vUv + vec2(uTexel.x, 0.0)).r;
  float hd = texture(uPrev, vUv - vec2(0.0, uTexel.y)).r, hu = texture(uPrev, vUv + vec2(0.0, uTexel.y)).r;
  s.g += (hl + hr + hd + hu - 4.0 * s.r) * ${C2.toFixed(5)};
  s.g *= 0.9965;
  s.r += s.g;
  vec2 m = vUv * SIZE;
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= uDropCount) break;
    vec4 d = uDrops[i];
    float k = max(0.0, 1.0 - length(m - d.xy * SIZE) / d.w);
    s.r += (0.5 - 0.5 * cos(k * 3.14159265)) * d.z;
  }
  if (uSwirl.z > 0.0) {
    // rotating three-armed forcing: spiral waves winding round the centre
    vec2 q = m - uSwirl.xy * SIZE;
    float r = length(q), a = atan(q.y, q.x);
    s.g += uSwirl.z * exp(-r * r / (uSwirl.w * uSwirl.w)) * sin(3.0 * a - r * 9.0 + uPhase) * 2e-4;
  }
  // slope (dh/dx, dh/dz) for the surface, from this step's neighbours
  s.ba = vec2(hr - hl, hu - hd) / (2.0 * ${DX.toFixed(5)});
  fragColor = s;
}`;

const SURF_VERT = /* glsl */`
out vec3 vW;
out vec2 vUv;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SURF_FRAG = COMMON_GLSL + WORLD_GLSL + LIGHTS_GLSL + LIGHT_FN_GLSL + GROUND_GLSL + /* glsl */`
precision highp sampler2DShadow;
uniform mat4 projectionMatrix;
uniform sampler2D uSim;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform samplerCube uSkyCube;
uniform float uEnvScale;   // arena's sky-reflection scale (a storm deck hides the sky)
uniform sampler2D uStoneNoise;
uniform sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uAbsorption;
uniform vec3 uScatter;
uniform vec3 uFlash;
in vec3 vW;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 gA = groundA(vW.xz), gB = groundB(vW.xz);
  vec4 nz = texture(uStoneNoise, vW.xz * 0.23);

  // ripples from the sim, plus a faint breeze texture so the mirror never looks dead
  vec2 slope = texture(uSim, vUv).ba;
  vec2 br = (texture(uStoneNoise, vW.xz * 0.6 + vec2(uTime * 0.03, uTime * 0.017)).rg
           + texture(uStoneNoise, vW.xz * 1.3 - vec2(uTime * 0.021, uTime * 0.04)).gr - 1.0);
  slope += br * 0.012;
  float ice = smoothstep(0.12, 0.55, clamp(gA.w, 0.0, 1.0) + (nz.b - 0.5) * 0.35);
  slope *= 1.0 - ice;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  float NoV = max(dot(N, V), 1e-4);
  // the normal's tilt as a screen offset
  vec3 vp = (viewMatrix * vec4(vW, 1.0)).xyz;
  vec3 dv = mat3(viewMatrix) * vec3(N.x, 0.0, N.z);
  vec2 nS = dv.xy - vp.xy / vp.z * dv.z;

  // --- refraction, validated against the depth (never pick up something in front) ------
  float wz = linearDepth(gl_FragCoord.z);
  float rayK = length(vp) / max(-vp.z, 1e-3);       // view-z difference -> path length
  float thick = max(linearDepth(texture(uSceneDepth, uv).r) - wz, 0.0) * rayK;
  vec2 ruv = uv + nS * 0.5 * clamp(thick * 6.0, 0.0, 1.0) / max(wz * 0.05, 1.0);
  float rz = linearDepth(texture(uSceneDepth, ruv).r);
  float keep = smoothstep(wz - 0.05, wz + 0.05, rz);
  ruv = mix(uv, ruv, keep);
  thick = mix(thick, max(rz - wz, 0.0) * rayK, keep);
  vec3 refr = texture(uSceneColor, ruv).rgb;
  float acid = clamp(gB.y, 0.0, 1.0);
  vec3 absorb = mix(uAbsorption, vec3(1.8, 0.4, 4.4), acid);
  vec3 scat = mix(uScatter, vec3(0.06, 0.16, 0.01), acid);
  vec3 T = exp(-absorb * thick);
  vec3 body = refr * T + scat * (uAmbient * 1.5 + uSunColor * max(uSunDir.y, 0.0) * 0.5) * (1.0 - T);
  // flash: light scattered inside the water (lightning striking it), caustic-veined
  float vein = 1.0 - abs(texture(uStoneNoise, vW.xz * 0.35 + floor(uTime * 24.0) * 0.173).r * 2.0 - 1.0);
  body += uFlash * (0.4 + 2.0 * pow(vein, 6.0)) * (1.0 - ice * 0.7);
  body += vec3(0.2, 1.0, 0.1) * acid * (0.03 + 0.1 * smoothstep(0.6, 0.9, nz.r));

  // --- reflection: the sky cube; the horizon darkens where the rim wall would hide it -------
  float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
  vec3 R = reflect(-V, N);
  vec3 refl = textureLod(uSkyCube, vec3(R.x, abs(R.y), R.z), mix(0.0, 3.0, ice)).rgb * mix(0.15, 1.0, smoothstep(0.0, 0.18, R.y)) * uEnvScale;

  // --- sun and spell-light speculars ---------------------------------------------------
  float sh = 1.0;
  if (uShadowOn > 0.5) {
    vec4 sc = uShadowMatrix * vec4(vW, 1.0);
    if (all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xyz, vec3(1.0)))) sh = texture(uShadowMap, vec3(sc.xy, sc.z - 0.0005));
  }
  float aS = mix(0.02, 0.25, ice);
  vec3 H = normalize(uSunDir + V);
  float nl = max(dot(N, uSunDir), 0.0);
  vec3 spec = uSunColor * sh * (spellD_GGX(max(dot(N, H), 0.0), aS * aS) * spellV_Smith(NoV, nl, aS * aS) * nl * F * PI);
  vec3 sd, ss;
  arenaSpellLights(vW, N, V, aS, vec3(0.02), vec3(0.0), sd, ss);
  spec += ss;

  vec3 col = mix(body, refl, F) + spec;
  // ice sheet: clear blue-tinted glass you still see the mosaic through, frosted white toward
  // its thin growing edge and along the crazing (cracks scatter, so they read white, not dark)
  if (ice > 0.0) {
    float crack = smoothstep(0.03, 0.0, texture(uStoneNoise, vW.xz * 0.5).b) + 0.5 * smoothstep(0.02, 0.0, texture(uStoneNoise, vW.xz * 1.7 + 0.3).b);
    vec3 frostCol = vec3(0.72, 0.84, 0.95) * (uAmbient * 1.3 + uSunColor * max(uSunDir.y, 0.0) * sh * 0.8) + sd * 0.8;
    float milk = clamp(0.18 + 0.25 * nz.g + 0.55 * (1.0 - smoothstep(0.3, 0.85, ice)) + 0.6 * crack, 0.0, 1.0);
    vec3 iceCol = mix(body * vec3(0.72, 0.9, 1.05), frostCol, milk);
    col = mix(col, mix(iceCol, refl, F * 0.6) + spec, ice);
  }
  fragColor = vec4(col, 1.0);
}`;

// renderer: picks Float (Wallace's precision) when it can be linearly filtered, else HalfFloat
export function createPool(renderer) {
  const P = ARENA.pool;
  const type = renderer.extensions.has('OES_texture_float_linear') ? THREE.FloatType : THREE.HalfFloatType;
  const rt = () => new THREE.WebGLRenderTarget(NX, NZ, {
    type, depthBuffer: false, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  const targets = [rt(), rt()];
  let cur = 0, acc = 0, phase = 0, dropCount = 0;
  const drops = Array.from({ length: MAX_DROPS }, () => new THREE.Vector4());
  const simU = {
    uPrev: { value: null }, uTexel: { value: new THREE.Vector2(1 / NX, 1 / NZ) },
    uDrops: { value: drops }, uDropCount: { value: 0 },
    uSwirl: { value: new THREE.Vector4() }, uPhase: { value: 0 },
  };
  const sim = new FullscreenQuad(rawPass(SIM_FRAG, simU));

  const uniforms = {
    ...U, ...worldUniforms,
    uSim: { value: targets[0].texture },
    uStoneNoise: arenaUniforms.uStoneNoise, uEnvScale: arenaUniforms.uEnvScale,
    uShadowMap: arenaUniforms.uShadowMap, uShadowMatrix: arenaUniforms.uShadowMatrix, uShadowOn: arenaUniforms.uShadowOn,
    // a dark, deep-looking pool: strong red/green absorption, little scatter
    uAbsorption: { value: new THREE.Vector3(2.2, 0.75, 0.55) },
    uScatter: { value: new THREE.Vector3(0.0, 0.035, 0.05) },
    uFlash: { value: new THREE.Vector3() },
  };
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(P.half.x * 2, P.half.y * 2).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SURF_VERT, fragmentShader: SURF_FRAG, uniforms, defines: worldDefines() }),
  );
  // PlaneGeometry uv: u along x, v along -z after the rotation; flip v so it matches the sim
  const uv = mesh.geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  mesh.position.set(P.center.x, P.water, P.center.y);

  const flash = new THREE.Vector3();
  const toUv = (x, z, out) => out.set((x - P.center.x) / (P.half.x * 2) + 0.5, (z - P.center.y) / (P.half.y * 2) + 0.5);
  const _uv = new THREE.Vector2();
  let swirlStrength = 0, calm = 0;

  return {
    mesh, uniforms, targets,
    // a drop: amp in metres (+ raises), radius in metres. Ignored outside the basin.
    ripple(x, z, amp = 0.02, radius = 0.3) {
      if (dropCount >= MAX_DROPS) return;
      calm = 0;
      toUv(x, z, _uv);
      if (_uv.x < -0.1 || _uv.x > 1.1 || _uv.y < -0.1 || _uv.y > 1.1) return;
      drops[dropCount++].set(_uv.x, _uv.y, amp, Math.max(radius, DX * 1.5));
    },
    // call every frame while it should swirl; fades in ~0.25 s when it stops
    swirl(x, z, strength = 1) {
      calm = 0;
      toUv(x, z, _uv);
      simU.uSwirl.value.set(_uv.x, _uv.y, 0, 2.0);
      swirlStrength = Math.max(swirlStrength, strength);
    },
    flash(color, amount = 1) {
      flash.set(color.r, color.g, color.b).multiplyScalar(amount).max(uniforms.uFlash.value);
      uniforms.uFlash.value.copy(flash);
    },
    update(renderer, dt) {
      dt = Math.min(dt, 0.1);
      uniforms.uFlash.value.multiplyScalar(Math.exp(-dt / 0.12));
      simU.uSwirl.value.z = swirlStrength;
      swirlStrength *= Math.exp(-dt * 4);
      if ((calm += dt) > 8) return;   // waves halve every 1.6 s: a settled pool needs no passes
      acc = Math.min(acc + dt, STEP * 4);
      const prev = renderer.getRenderTarget();
      let first = true;
      while (acc >= STEP) {
        acc -= STEP;
        phase += STEP * 5;
        simU.uPhase.value = phase;
        simU.uDropCount.value = first ? dropCount : 0;
        simU.uPrev.value = targets[cur].texture;
        cur ^= 1;
        sim.render(renderer, targets[cur]);
        first = false;
      }
      if (!first) dropCount = 0;
      renderer.setRenderTarget(prev);
      uniforms.uSim.value = targets[cur].texture;
    },
  };
}
