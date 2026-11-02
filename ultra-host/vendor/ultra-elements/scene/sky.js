import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { Atmosphere, ATMOSPHERE_GLSL, OBSERVER_ALTITUDE, atmosphereCoefficients, transmittance } from './atmosphere.js';
import { U } from '../vfx/common.js';

// Adapted from Ultra Water's sky (MIT): Hillaire 2020 atmosphere (atmosphere.js) + clouds baked
// into a mipmapped HDR cube whenever the sun or sky params change; nothing runs per frame. The
// cube is the background, the IBL (scene.environment) and the reflection fallback. The sun disc
// is analytic (background shader), so it's left out of the cube; alpha holds the cloud
// transmittance (1 = clear) so the disc and the stars hide behind clouds.
//
// Units: the sky is lit by sun illuminance pi * sunIntensity at the top of the atmosphere, i.e. the
// cube is radiance in the same units as sunColor (sunColor = E_sun,ground / pi; the arena's
// DirectionalLight gets pi * lightRadiance).
//
// Night: the sun is below the horizon and contributes nothing, so the atmosphere is lit by the
// moon instead (same scattering, ~1/600 the light, tinted cool), the Milky Way is baked into
// the cube and point stars are drawn analytically in the background (a cube texel is ~2 px, so
// baked stars would be blurry blobs). lightDir / lightRadiance always describe the one
// directional light the arena uses: the sun by day, the moon at night.
const CUBE_SIZE = 512;   // the arena only sees the sky blurred by the floor's roughness
const CLOUD_H = 2.5;     // cloud deck altitude for lighting / aerial perspective (km)

export const SKY_PRESETS = {
  // low warm sun behind the targets: the polished floor carries the sunset
  dusk: { elevation: 4, azimuth: 200, cloudCoverage: 0.36, turbidity: 2.4, sunIntensity: 9 },
  noon: { elevation: 55, azimuth: 150, cloudCoverage: 0.3, turbidity: 1.6, sunIntensity: 9 },
  night: { elevation: -16, azimuth: 290, cloudCoverage: 0.16, turbidity: 1.3, sunIntensity: 9 },
};

const BG_VERT = /* glsl */`
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww; // far plane
}`;

const BG_FRAG = /* glsl */`
uniform samplerCube uCube;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uNight;
uniform float uTime;
in vec3 vDir;
out vec4 fragColor;
vec3 h33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
void main() {
  vec3 d = normalize(vDir);
  vec4 sky = textureLod(uCube, vec3(d.x, max(d.y, 0.0), d.z), 0.0);
  float c = dot(d, uLightDir);
  vec3 col = sky.rgb;
  float above = step(0.0, d.y) * sky.a;
  if (uNight < 0.5) {
    // 0.27 deg disc with limb darkening, plus a tight glow; hidden by clouds (cube alpha)
    float disc = smoothstep(0.999985, 0.999992, c) * (0.6 + 0.4 * smoothstep(0.999985, 1.0, c));
    col += uLightColor * (disc * 900.0 + pow(max(c, 0.0), 2200.0) * 1.5) * above;
  } else {
    // moon: a slightly enlarged disc (0.45 deg) with maria from the cell hash, plus a halo
    float r = sqrt(max(2.0 * (1.0 - c), 0.0)) / 0.0079;   // 0..1 across the disc
    vec3 t = normalize(cross(uLightDir, vec3(0.0, 1.0, 0.0))), b = cross(t, uLightDir);
    vec2 q = vec2(dot(d, t), dot(d, b)) / 0.0079;
    float maria = 0.0;
    for (int i = 0; i < 5; i++) { vec3 h = h33(vec3(float(i) * 7.1, 3.3, 1.7)); maria += smoothstep(0.42, 0.1, length(q - (h.xy - 0.5) * 1.1)) * (0.25 + 0.2 * h.z); }
    float disc = smoothstep(1.0, 0.92, r) * (1.0 - 0.5 * clamp(maria, 0.0, 0.7)) * (0.75 + 0.25 * sqrt(max(1.0 - r * r, 0.0)));
    col += uLightColor * (disc * 2600.0 + pow(max(c, 0.0), 900.0) * 2.0 + pow(max(c, 0.0), 40.0) * 0.12) * above;
    // stars: one candidate per cell of a 3D grid over the direction, centred within the cell so
    // the star never clips; brightness ~ hash^24 (few bright, many faint), colour from a
    // rough temperature, twinkle stronger near the horizon (longer air path)
    vec3 p = d * 380.0, cell = floor(p), h = h33(cell);
    if (h.x > 0.86) {
      vec3 sp = cell + 0.3 + 0.4 * h33(cell + 17.0);
      float px = length(fwidth(p)) * 0.7;
      float s = smoothstep(px + 0.08, 0.0, length(p - sp));
      float mag = pow(h.y, 24.0) * 40.0 + h.y * 0.15;
      float tw = 1.0 + (0.25 + 0.5 * (1.0 - d.y)) * sin(uTime * (3.0 + h.z * 9.0) + h.x * 50.0);
      vec3 tint = mix(vec3(1.0, 0.72, 0.5), vec3(0.62, 0.78, 1.0), h.z);
      col += tint * s * mag * tw * 0.02 * smoothstep(0.0, 0.12, d.y) * sky.a;
    }
  }
  fragColor = vec4(col, 1.0);
}`;

// One cube face per draw: GL cube-map texel -> world direction (three's cube render targets are
// sampled with plain world directions).
const CUBE_FRAG = ATMOSPHERE_GLSL + /* glsl */`
const float CLOUD_H = ${CLOUD_H.toFixed(2)};
const vec3 GROUND = vec3(0.05, 0.043, 0.036);  // dark earth around the arena (lower hemisphere)
uniform int uFace;
uniform vec3 uSunDir;      // the light lighting the atmosphere (the moon at night)
uniform vec3 uSunColor;
uniform float uCloudCoverage;
uniform float uNight;
in vec2 vUv;
out vec4 fragColor;

vec3 faceDir(vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  if (uFace == 0) return vec3(1.0, -c.y, -c.x);
  if (uFace == 1) return vec3(-1.0, -c.y, c.x);
  if (uFace == 2) return vec3(c.x, 1.0, c.y);
  if (uFace == 3) return vec3(c.x, -1.0, -c.y);
  if (uFace == 4) return vec3(c.x, -c.y, 1.0);
  return vec3(-c.x, -c.y, -1.0);
}

// cloud layer ported from three's Sky.js (static: time = 0, its cloudScale/elevation/density)
vec2 gradient(vec2 i) {
  vec3 p = fract(i.xyx * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.xx + p.yz) * p.zy) * 2.0 - 1.0;
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(gradient(i), f);
  float b = dot(gradient(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(gradient(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(gradient(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.6;
}
float fbm(vec2 p) {
  float s = 0.0, a = 1.0;
  for (int i = 0; i < 4; i++) { s += a * noise(p); a *= 0.5; p *= 2.0; }
  return s;
}

// Milky Way: a band around a tilted great circle, mottled and split by dust lanes
vec3 milkyWay(vec3 d) {
  const vec3 N = normalize(vec3(0.35, 0.42, 0.84));
  float lat = dot(d, N);
  vec3 t = normalize(cross(N, vec3(0.0, 1.0, 0.0))), b = cross(N, t);
  vec2 q = vec2(atan(dot(d, b), dot(d, t)) * 3.0, lat * 9.0);
  float band = exp(-lat * lat / 0.035) * clamp(fbm(q * 1.7) * 0.6 + 0.6, 0.0, 1.5);
  float dust = smoothstep(0.1, 0.5, fbm(q * 3.1 + 7.0)) * exp(-lat * lat / 0.004);
  float core = exp(-pow(length(q - vec2(1.4, 0.0)) / 2.2, 2.0));
  return vec3(0.75, 0.8, 1.0) * band * (1.0 - 0.75 * dust) * (1.0 + 2.0 * core) * 0.0035;
}

void main() {
  vec3 d = normalize(faceDir(vUv));
  vec3 up = skyView(vec3(0.0, 1.0, 0.0), uSunDir);
  if (d.y < 0.0) {
    // below the horizon: dark ground lit by the light and the sky, fading into the horizon haze
    vec3 ground = GROUND * (uSunColor * max(uSunDir.y, 0.0) + up);
    fragColor = vec4(mix(ground, skyView(vec3(d.x, 0.0, d.z), uSunDir), exp(d.y * 40.0) * 0.6), 1.0);
    return;
  }
  vec3 col = skyView(d, uSunDir);
  if (uNight > 0.5) col += milkyWay(d) * smoothstep(0.0, 0.25, d.y);
  float vis = 1.0;
  if (d.y > 1e-3 && uCloudCoverage > 0.0) {
    vec2 p = d.xz / d.y * 0.396;   // cloudScale 2e-4 * 1000 / mix(1, 0.1, cloudElevation 0.55)
    float n = clamp(fbm(p) * 0.7 + 0.5, 0.0, 1.0);
    float th = 1.0 - clamp(uCloudCoverage + noise(p * 0.3) * 0.222, 0.0, 1.0);  // clear gaps / dense banks
    float fade = smoothstep(0.0, 0.063, d.y);
    float mask = smoothstep(th, th + 0.3, n) * fade;
    float depth = max(0.0, n - th);
    float beer = exp(-4.0 * depth);
    float shade = mix(0.45, 1.0, clamp(beer * (1.0 - beer * beer) * 2.6, 0.0, 1.0));  // beer-powder
    float c = dot(d, uSunDir);
    float silver = clamp(0.51 / pow(1.49 - c * 1.4, 1.5), 0.0, 3.0);  // HG g = 0.7 rim toward the sun
    float edge = mask * (1.0 - mask) * 4.0;
    float alpha = (1.0 - exp(-depth * 6.6)) * fade;                    // cloudDensity 0.55

    // the deck point along d: sunlight through the atmosphere (and planet shadow) to it, and the
    // eye-to-deck transmittance so distant clouds dissolve into the haze
    float r0 = RB + OBS_H, rc = RB + CLOUD_H;
    float t = -r0 * d.y + sqrt(r0 * r0 * d.y * d.y + (rc - r0) * (rc + r0));
    float muV = (r0 * d.y + t) / rc;
    float muS = clamp((r0 * uSunDir.y + t * c) / rc, -1.0, 1.0);
    vec3 sun = uSunIllum * transmittance(CLOUD_H, muS) * sunVisible(CLOUD_H, rc, muS) * 0.22;  // albedo/pi
    vec3 cloud = up + sun * (shade + silver * edge * 0.6);
    vec3 tv = clamp(transmittance(OBS_H, d.y) / max(transmittance(CLOUD_H, muV), vec3(1e-4)), 0.0, 1.0);
    col = mix(col, mix(col, cloud, tv), alpha);
    vis = 1.0 - alpha;
  }
  fragColor = vec4(col, vis);
}`;

// Irradiance / pi of an upward-facing surface: the cube averaged over 64 cosine-weighted
// directions (a blurred mip, so 64 taps are plenty). Read back once per bake.
const AMBIENT_FRAG = /* glsl */`
precision highp float;
uniform samplerCube uCube;
out vec4 fragColor;
void main() {
  vec3 s = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    float u = (float(i) + 0.5) / 64.0, a = float(i) * 2.39996;   // Fibonacci spiral
    float r = sqrt(u);
    s += textureLod(uCube, vec3(r * cos(a), sqrt(1.0 - u), r * sin(a)), 5.0).rgb;
  }
  fragColor = vec4(s / 64.0, 1.0);
}`;

const MOON = { elevation: 34, azimuth: 150, intensity: 0.016, tint: [0.6, 0.76, 1.0] };

export class SkySystem {
  constructor(renderer) {
    this.renderer = renderer;
    this.cubeSize = CUBE_SIZE;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunColor = new THREE.Vector3(1, 1, 1);
    this.params = { ...SKY_PRESETS.dusk, rayleigh: 1 };
    this.preset = 'dusk';
    this.moon = { ...MOON };
    // the arena's directional light: the sun, or the moon at night
    this.night = false;
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.lightRadiance = new THREE.Vector3(1, 1, 1);   // = E / pi, like sunColor
    this.lightColor = new THREE.Color(1, 1, 1);         // normalised (max component 1)
    this.lightIntensity = Math.PI;                      // DirectionalLight.intensity
    this.ambient = new THREE.Vector3(0.1, 0.1, 0.12);   // sky irradiance / pi (main -> U.uAmbient)

    this.atmosphere = new Atmosphere();
    this.cubeRT = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, {
      type: THREE.HalfFloatType, generateMipmaps: true, depthBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    this.cube = this.cubeRT.texture;
    this.cubePass = new FullscreenQuad(rawPass(CUBE_FRAG, {
      ...this.atmosphere.uniforms,
      uFace: { value: 0 }, uSunDir: { value: this.lightDir }, uSunColor: { value: this.lightRadiance },
      uCloudCoverage: { value: 0 }, uNight: { value: 0 },
    }));
    this.camera = new THREE.Camera();   // unused by the fullscreen vertex shader
    this.ambientRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    this.ambientPass = new FullscreenQuad(rawPass(AMBIENT_FRAG, { uCube: { value: this.cube } }));
    this._px = new Float32Array(4);

    this.background = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: BG_VERT, fragmentShader: BG_FRAG,
        uniforms: {
          uCube: { value: this.cube }, uLightDir: { value: this.lightDir }, uLightColor: { value: this.lightRadiance },
          uNight: { value: 0 }, uTime: U.uTime,
        },
        side: THREE.BackSide, depthWrite: false,
      }),
    );
    this.background.frustumCulled = false;
    // drawn after the opaque scene at the far plane, so only visible sky pixels shade
    this.background.renderOrder = 1000;
  }

  // 'dusk' | 'noon' | 'night'; rebakes immediately
  setPreset(name) {
    const p = SKY_PRESETS[name];
    if (!p) return;
    this.preset = name;
    Object.assign(this.params, p);
    this.update();
  }

  update() {
    const p = this.params, r = this.renderer;
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - p.elevation), THREE.MathUtils.degToRad(p.azimuth));

    // sun radiance factor at sea level: sunIntensity x transmittance (same integral as the LUT),
    // faded out as the disc sinks below the horizon
    const c = atmosphereCoefficients(p);
    const T = transmittance(c, OBSERVER_ALTITUDE, Math.max(this.sunDir.y, 0));
    const fade = THREE.MathUtils.smoothstep(p.elevation, -2, 2);
    this.sunColor.set(T[0], T[1], T[2]).multiplyScalar(p.sunIntensity * fade);

    // below -3 deg the sun's twilight is negligible next to moonlight: the moon takes over
    this.night = p.elevation < -3;
    let illum = p.sunIntensity;
    if (this.night) {
      const m = this.moon;
      this.lightDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - m.elevation), THREE.MathUtils.degToRad(m.azimuth));
      const Tm = transmittance(c, OBSERVER_ALTITUDE, Math.max(this.lightDir.y, 0));
      this.lightRadiance.set(Tm[0] * m.tint[0], Tm[1] * m.tint[1], Tm[2] * m.tint[2]).multiplyScalar(m.intensity);
      illum = m.intensity;
    } else {
      this.lightDir.copy(this.sunDir);
      this.lightRadiance.copy(this.sunColor);
    }
    const peak = Math.max(this.lightRadiance.x, this.lightRadiance.y, this.lightRadiance.z, 1e-6);
    this.lightColor.setRGB(this.lightRadiance.x / peak, this.lightRadiance.y / peak, this.lightRadiance.z / peak);
    this.lightIntensity = Math.PI * peak;

    const target = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    this.atmosphere.update(r, c, this.lightDir.y, Math.PI * illum);
    const u = this.cubePass.material.uniforms;
    u.uCloudCoverage.value = p.cloudCoverage;
    u.uNight.value = this.night ? 1 : 0;
    this.background.material.uniforms.uNight.value = this.night ? 1 : 0;
    // three builds the mip chain after a render into the cube, so only after the last face
    for (let f = 0; f < 6; f++) {
      u.uFace.value = f;
      this.cube.generateMipmaps = f === 5;
      r.setRenderTarget(this.cubeRT, f);
      r.render(this.cubePass.mesh, this.camera);
    }
    // ambient for particles: a 1x1 readback, once per bake (a sync stall of well under 1 ms)
    this.ambientPass.render(r, this.ambientRT);
    r.readRenderTargetPixels(this.ambientRT, 0, 0, 1, 1, this._px);
    this.ambient.set(this._px[0], this._px[1], this._px[2]);
    r.setRenderTarget(target, face, mip);
    this.cube.needsPMREMUpdate = true;
  }
}
