import * as THREE from 'three';
import { U } from '../vfx/common.js';
import { Q } from './quality.js';

const LEVELS = 6;  // allocated; params.bloomLevels (1..6) picks how many run, no recompile
const STREAKS = 5; // anamorphic: horizontal-only chain under bloom level 0
const METER = 32;  // auto-exposure metering target is METER x METER
const LUT = 48;    // tonemap LUT is LUT^3

const VERT = /* glsl */`
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HEAD = /* glsl */`
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
in vec2 vUv;
out vec4 fragColor;
`;

// 13-tap dual-filter downsample (CoD AW). With PREFILTER: clamp + soft knee per tap, Karis-weighted groups.
const DOWN = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel; // source texel size
#ifdef PREFILTER
uniform vec4 uCurve; // threshold-knee, 2*knee, 0.25/knee, threshold
uniform float uClamp;
#endif

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 tap(vec2 o) {
  vec3 c = texture(tSrc, vUv + o * uTexel).rgb;
#ifdef PREFILTER
  c = max(c, 0.0); // negatives (and NaN on most GPUs) -> 0
  float l = max(luma(c), 1e-4), lc = min(l, uClamp); // clamp luminance, then soft knee on the clamped value;
  float q = clamp(lc - uCurve.x, 0.0, uCurve.y);       // c * (lc / l) * knee(lc) / lc = c * knee(lc) / l
  c *= max(uCurve.z * q * q, lc - uCurve.w) / l;
#endif
  return c;
}

void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0)), l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
  vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;
#ifdef PREFILTER
  float w0 = 0.125 / (1.0 + luma(g0)), w1 = 0.125 / (1.0 + luma(g1));
  float w2 = 0.125 / (1.0 + luma(g2)), w3 = 0.125 / (1.0 + luma(g3));
  float w4 = 0.5 / (1.0 + luma(g4));
  vec3 r = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
#else
  vec3 r = g4 * 0.5 + (g0 + g1 + g2 + g3) * 0.125;
#endif
  fragColor = vec4(r, 1.0);
}`;

// 9-tap tent upsample; blended additively onto the finer level.
const UP = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel; // source (coarser) texel size
void main() {
  vec4 d = uTexel.xyxy * vec4(1.0, 1.0, -1.0, 0.0);
  vec3 s = texture(tSrc, vUv - d.xy).rgb + texture(tSrc, vUv - d.wy).rgb * 2.0 + texture(tSrc, vUv - d.zy).rgb
    + texture(tSrc, vUv + d.zw).rgb * 2.0 + texture(tSrc, vUv).rgb * 4.0 + texture(tSrc, vUv + d.xw).rgb * 2.0
    + texture(tSrc, vUv + d.zy).rgb + texture(tSrc, vUv + d.wy).rgb * 2.0 + texture(tSrc, vUv + d.xy).rgb;
  fragColor = vec4(s * (1.0 / 16.0), 1.0);
}`;

// Anamorphic streaks: the same dual filter, horizontal only. Down halves x (4 bilinear taps = an 8-texel
// 1-3-3-1 tent); FIRST keeps only luminance well above the bloom threshold so hot cores streak and lit
// surfaces don't. Up is a 3-tap tent blended onto the finer level, as for bloom.
const HDOWN = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel; // source texel size
#ifdef FIRST
uniform float uKeep;
#endif
void main() {
  vec2 o = vec2(uTexel.x, 0.0);
  vec3 c = (texture(tSrc, vUv - 3.0 * o).rgb + texture(tSrc, vUv + 3.0 * o).rgb) * 0.125
         + (texture(tSrc, vUv - o).rgb + texture(tSrc, vUv + o).rgb) * 0.375;
#ifdef FIRST
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= max(l - uKeep, 0.0) / max(l, 1e-4);
#endif
  fragColor = vec4(c, 1.0);
}`;

const HUP = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel; // source (coarser) texel size
void main() {
  vec2 o = vec2(uTexel.x, 0.0);
  fragColor = vec4((texture(tSrc, vUv - o).rgb + texture(tSrc, vUv).rgb * 2.0 + texture(tSrc, vUv + o).rgb) * 0.25, 1.0);
}`;

// Auto-exposure 1/2: HDR -> METERxMETER cells. 4x4 bilinear taps per texel over its footprint, the grid
// jittered per frame (the temporal filter averages it out). Like a real camera / UE eye adaptation it
// meters what the lens sees, so a big emissive effect darkens the exposure:
//   r = mean log2 luminance of the scene with the composited FX mixed in at uFxW (the log average)
//   g = mean linear luminance of the composited frame (the highlight term: a bright area weighs by its area)
// Luminance is clamped (64 for the log, 256 linear) so the sun disc / glints / sparks can't pump exposure.
const METER_FRAG = /* glsl */`
uniform sampler2D tSrc;  // scene without FX
uniform sampler2D tFx;   // composited frame (scene + FX)
uniform float uFxW;      // FX weight in the log average
uniform vec2 uJitter;    // [0,1)^2
void main() {
  float s = 0.0, h = 0.0;
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 uv = vUv + ((vec2(float(i), float(j)) + uJitter) * 0.25 - 0.5) * ${(1 / METER).toFixed(8)};
    float ls = dot(max(texture(tSrc, uv).rgb, 0.0), W), lc = dot(max(texture(tFx, uv).rgb, 0.0), W);
    s += log2(clamp(mix(ls, max(lc, ls), uFxW), 1e-4, 64.0));
    h += min(lc, 256.0);
  }
  fragColor = vec4(s * (1.0 / 16.0), h * (1.0 / 16.0), 0.0, 1.0);
}`;

// Auto-exposure 2/2: METERxMETER -> 1x1 mean (16x16 bilinear taps, each = 2x2 texels), then temporal
// adaptation in log2 space, ping-pong with the previous 1x1 state. r = adapted log2(avg luminance),
// g = the exposure it gives (so the composite doesn't pay an exp2 per pixel).
// Target = max(log average, log2(mean luminance) - uHeadroom): a highlight that is both bright and big
// (a light pillar, an inferno, a night-time blast) pulls the exposure down until it keeps its structure;
// small hot spots stay under the headroom and clip as they would on film.
// Brightening adapts fast (UE "speed up"), darkening slowly, each slew-limited (uMaxStep EV per frame):
// a single-frame flash only nudges the eye, a strike or a pillar dims the world within a few frames and
// the world comes back over a second or two (the afterimage of a real camera / eye).
const ADAPT_FRAG = /* glsl */`
uniform sampler2D tSrc;  // metering target, linear filtered
uniform sampler2D tPrev; // previous 1x1 state
uniform vec2 uK;         // blend factor when scene brightens (x) / darkens (y); 1 = snap
uniform vec2 uRange;     // allowed log2 luminance range (from min/max exposure)
uniform vec2 uMaxStep;   // max change this frame, EV: brightening (x) / darkening (y)
uniform float uKey;      // keyValue
uniform float uHeadroom; // EV the area-weighted mean luminance may sit above the log average
void main() {
  vec2 sum = vec2(0.0);
  for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++)
    sum += texture(tSrc, (vec2(float(i), float(j)) + 0.5) * (1.0 / 16.0)).rg;
  sum *= 1.0 / 256.0;
  float t = clamp(max(sum.x, log2(max(sum.y, 1e-6)) - uHeadroom), uRange.x, uRange.y);
  float prev = texelFetch(tPrev, ivec2(0), 0).r;
  bool up = t > prev;
  float k = up ? uK.x : uK.y, m = up ? uMaxStep.x : uMaxStep.y;
  float s = k >= 1.0 ? t : prev + clamp((t - prev) * k, -m, m);
  if (isnan(s)) s = t;
  fragColor = vec4(s, uKey * exp2(-s), 0.0, 1.0); // s stays in uRange, so this is within min/max exposure
}`;

// Lens dirt, baked once at load (RGBA8, 2:1, mapped aspect-correct so hexagons stay hexagons): oily
// smudges, dust specks and faint out-of-focus hexagonal bokeh from a 6-blade aperture. It multiplies
// the bloom, so it only shows where something bright is glowing (Chapman 2013 / UE "dirt mask").
const DIRT_FRAG = /* glsl */`
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash33(vec3(i, 0.0)).x, hash33(vec3(i + vec2(1, 0), 0.0)).x, f.x),
             mix(hash33(vec3(i + vec2(0, 1), 0.0)).x, hash33(vec3(i + vec2(1, 1), 0.0)).x, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return s;
}
float hexSd(vec2 p) { p = abs(p); return max(dot(p, vec2(0.8660254, 0.5)), p.y); }
// one blob per cell: (cells per unit, density, radius range, hex?) -> rgb
vec3 blobs(vec2 p, float scale, float density, vec2 rr, float hex, float seed) {
  vec2 q = p * scale, id = floor(q);
  vec3 o = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { // neighbours: blobs may overhang cells
    vec2 c = id + vec2(x, y);
    vec3 h = hash33(vec3(c, seed)), g = hash33(vec3(c, seed + 9.0));
    if (h.x > density) continue;
    float r = mix(rr.x, rr.y, h.y * h.y) * scale;
    vec2 d = q - c - vec2(h.z, g.x);
    float sd = hex > 0.5 ? hexSd(d) : length(d);
    float a = hex > 0.5
      ? smoothstep(r, r * 0.8, sd) * (0.55 + 0.45 * smoothstep(r * 0.3, r, sd)) // bokeh: soft disc, faint rim
      : smoothstep(r, 0.0, sd);                                                 // speck: soft dot
    vec3 tint = mix(vec3(1.0, 0.86, 0.7), vec3(0.75, 0.9, 1.0), g.y);              // warm or cool coating
    o += a * mix(0.25, 1.0, g.z) * tint;
  }
  return o;
}
void main() {
  vec2 p = vUv * vec2(2.0, 1.0);
  // smudges: noise stretched along a slowly turning direction reads as wipe marks, masked into patches
  float an = fbm(p * 0.8) * 6.2832;
  vec2 q = mat2(cos(an), -sin(an), sin(an), cos(an)) * p;
  float smear = smoothstep(0.35, 0.8, fbm(q * vec2(1.5, 4.0))) * smoothstep(0.45, 0.8, fbm(p * 1.3 + 4.0));
  vec3 c = vec3(smear * 0.4 + 0.03);
  c += blobs(p, 4.0, 0.3, vec2(0.03, 0.07), 1.0, 1.0) * 0.22;          // big faint hex ghosts
  c += blobs(p, 9.0, 0.25, vec2(0.012, 0.03), 1.0, 2.0) * 0.16;        // smaller hex ghosts
  c += blobs(p, 30.0, 0.12, vec2(0.0015, 0.005), 0.0, 3.0) * 0.8;     // dust specks
  c += blobs(p, 70.0, 0.06, vec2(0.0008, 0.002), 0.0, 4.0) * 0.6;     // fine dust
  fragColor = vec4(min(c, 1.0), 1.0);
}`;

// Tonemapping: same math as three's AgXToneMapping chunk (Filament/Blender AgX, iolite contrast approx) and
// NeutralToneMapping chunk (Khronos PBR Neutral); uTonemap picks one, nothing recompiles.
// AgX + its look are baked into a LUT^3 RGBA16F LUT indexed by AgX's own log2 shaper (UE does the same), so
// the composite pays 3 log2 and one 3D tap instead of ~18 transcendentals per pixel (-0.05 ms at 3.3 MP on
// a 3060). The LUT holds linear output and is clamped after the lookup: a clamp, or the sRGB curve, inside
// it puts kinks in cells that trilinear filtering then smears (up to 30/255 on saturated colours). As is:
// max 6/255 on a few saturated pixels, greys within 1/255. Rebaked (48 tiny draws) only when contrast or
// saturation change. Neutral stays analytic: its per-pixel min/max creases don't survive a LUT and it's cheap.
const TONEMAP_GLSL = /* glsl */`
const mat3 SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 REC2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 AGX_INSET = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AGX_OUTSET = mat3(
  vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV = 4.026069;
const mat3 SRGB_TO_AGX = AGX_INSET * SRGB_TO_REC2020; // folded at compile time

// linear sRGB -> AgX log2 encoding in [0,1]^3 (and the LUT coordinate)
vec3 agxShaper(vec3 c) {
  return clamp((log2(max(SRGB_TO_AGX * c, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
}
`;

const LUT_FRAG = TONEMAP_GLSL + /* glsl */`
uniform float uLayer;
uniform vec2 uLook;       // AgX look: power (contrast), saturation

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 c) { // c: agxShaper() output
  c = agxContrast(c);
  // AgX "punchy"-style look in the encoded domain
  c = pow(max(c, 0.0), vec3(uLook.x));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = l + uLook.y * (c - l);
  c = AGX_OUTSET * c;
  return REC2020_TO_SRGB * pow(max(c, 0.0), vec3(2.2)); // clamped after the LUT: a clamp inside it would blur
}

void main() {
  vec3 x = vec3(gl_FragCoord.xy - 0.5, uLayer) / ${LUT - 1}.0; // this texel's shaper value
  fragColor = vec4(agx(x), 1.0);
}`;

const COMP = TONEMAP_GLSL + /* glsl */`
uniform sampler2D tHdr;
uniform sampler2D tBloom;
uniform sampler2D tExp;   // 1x1: r adapted log2 average luminance, g metered exposure
uniform sampler2D tDirt;
uniform sampler2D tStreak;
uniform sampler3D tLut;   // AgX + look, linear out
uniform float uTonemap;   // 0 AgX, 1 Khronos PBR Neutral
uniform float uExposure;  // exposure compensation (auto) or absolute exposure
uniform float uAuto;      // 1 = auto exposure
uniform float uBloom;
uniform float uFrame;     // 0..255, dither seed
uniform float uDroplets;  // 0..1
uniform float uTime;      // seconds, wraps at 4096
uniform float uAspect;    // width / height
uniform float uResY;      // height in pixels
uniform float uCA;        // lateral CA: red/blue magnification difference
uniform float uFlash;     // added to the exposure multiplier
uniform float uVignette;
uniform float uDirt;
uniform float uStreak;
uniform highp sampler2D tDepth; // scene depth [0,1] (motion blur)
uniform mat4 uReproj;     // current NDC -> previous clip (prevViewProj * inverse(viewProj))
uniform float uMB;        // motion blur: shutter fraction of the frame's camera motion; 0 = off
uniform float uMBMax;     // longest blur, in screen heights

// Khronos PBR Neutral: identity below 0.76, then compresses the peak channel towards white. Meant to show
// authored colours as authored, so the AgX look (uLook) is not applied on top.
vec3 neutral(vec3 c) {
  const float START = 0.8 - 0.04, DESAT = 0.15;
  float x = min(c.r, min(c.g, c.b));
  c -= x < 0.08 ? x - 6.25 * x * x : 0.04;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < START) return clamp(c, 0.0, 1.0);
  float d = 1.0 - START, np = 1.0 - d * d / (peak + d - START);
  c *= np / peak;
  return clamp(mix(c, vec3(np), 1.0 - 1.0 / (DESAT * (peak - np) + 1.0)), 0.0, 1.0);
}

// Dave Hoskins hash without sine
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// ---- lens droplets (only evaluated when uDroplets > 0) -----------------------------------------
// All lengths are in screen-height units (p = vUv * vec2(aspect, 1)). Each drop is a tiny lens: the
// image under it is sampled from the mirrored side of its centre, sample = centre - (K-1) * d, so it
// looks inverted and slightly magnified, with a faint dark rim.
const float DROP_K = 1.8;

// d: pixel - drop centre, r: radius. Returns (uv offset, darkening).
vec3 lensDrop(vec2 d, float r) {
  float dist = length(d);
  float cov = clamp((r - dist) * uResY + 0.5, 0.0, 1.0); // 1px AA
  if (cov <= 0.0) return vec3(0.0);
  return vec3(-d * DROP_K * cov, 0.22 * smoothstep(0.6, 1.0, dist / r) * cov);
}

// One drop (at most) per grid cell, kept inside its cell so only the own cell is tested.
vec3 dropLayer(vec2 p, float scale, float density, float seed) {
  vec2 q = p * scale + seed * 17.31;
  vec2 id = floor(q);
  vec3 h = hash33(vec3(id, seed)), g = hash33(vec3(id + 57.0, seed));
  if (h.x > density) return vec3(0.0);
  float fade = clamp((uDroplets - g.x * 0.8) * 6.0, 0.0, 1.0); // drops dry up one by one (order = g.x)
  float rf = mix(0.10, 0.24, h.y * h.y);                          // radius, cell units
  vec2 c = rf + vec2(h.z, g.y) * (1.0 - 2.0 * rf);
  return lensDrop((fract(q) - c) / scale, rf * fade / scale);
}

// A drop sliding down the lens, leaving a thin wet trail above it. speed in cycles/s.
// Head enters above the screen and leaves below with its trail fully off-screen, so the wrap never pops.
vec3 streak(vec2 p, float id, float speed, float amp) {
  const float R = 0.016, L = 0.45, W = 0.0035;
  float u = uTime * speed + id * 0.37;
  float cyc = mod(floor(u), 128.0), f = fract(u);
  f += 0.012 * sin(f * 47.0); // stick-slip
  vec3 h = hash33(vec3(id, cyc, 5.1));
  float x0 = (0.08 + 0.84 * h.x) * uAspect;
  float hy = mix(1.0 + R, -R - L, f);
  float hx = x0 + 0.006 * sin(hy * 14.0 + h.y * 6.28);
  vec3 o = lensDrop(p - vec2(hx, hy), R * amp);
  float ty = p.y - hy;
  if (ty > 0.0 && ty < L) {
    float a = smoothstep(0.0, 0.03, ty) * (1.0 - ty / L) * amp;
    float tx = (p.x - x0 - 0.006 * sin(p.y * 14.0 + h.y * 6.28)) / W;
    float cov = clamp((1.0 - abs(tx)) * W * uResY + 0.5, 0.0, 1.0) * a;
    o += vec3(-tx * W * DROP_K * cov, 0.0, 0.12 * smoothstep(0.5, 1.0, abs(tx)) * cov);
  }
  return o;
}

// Returns (uv offset, darkening).
vec3 droplets() {
  vec2 p = vUv * vec2(uAspect, 1.0);
  float sa = smoothstep(0.0, 0.4, uDroplets);
  vec3 a = dropLayer(p, 6.0, 0.30, 0.0) + dropLayer(p, 10.0, 0.20, 1.0) + dropLayer(p, 17.0, 0.06, 2.0)
    + streak(p, 0.0, 0.0625, sa) + streak(p, 1.0, 0.03125, sa);
  return vec3(a.xy / vec2(uAspect, 1.0), min(a.z, 0.5));
}

vec3 hdrAt(vec2 uv) {
  vec3 c = vec3(0.0);
  vec2 o = vec2(0.0);
  if (uCA > 0.0) o = (uv - 0.5) * uCA; // lateral CA: red imaged slightly larger than green, blue slightly smaller
  c.r = textureLod(tHdr, uv + o, 0.0).r;
  c.g = textureLod(tHdr, uv, 0.0).g;
  c.b = textureLod(tHdr, uv - o, 0.0).b;
  return c;
}

// Camera motion blur (UE's default for static geometry): this pixel's previous screen position from
// depth and last frame's view-projection, then up to 8 taps along the motion, jittered per pixel and
// centred on the pixel. Blur length is clamped; under ~1 px it is a single tap.
vec3 motionBlur(vec2 uv) {
  vec3 s = vec3(0.0);
  float z = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r;
  vec4 q = uReproj * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec2 v = (vUv - (q.xy / max(q.w, 1e-6) * 0.5 + 0.5)) * uMB;
  float len = length(v * vec2(uAspect, 1.0)), lim = min(len, uMBMax); // screen-height units
  float n = 1.0, j = 0.5;
  if (lim * uResY >= 1.0) {
    v *= lim / max(len, 1e-6);
    n = clamp(ceil(lim * uResY * 0.5), 2.0, 8.0);
    j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.618034); // IGN
  } else v = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    if (float(i) >= n) break;
    s += hdrAt(uv + v * ((float(i) + j) / n - 0.5));
  }
  return s / n;
}

void main() {
  float ex = uExposure * (1.0 + uFlash);
  if (uAuto > 0.5) ex *= texelFetch(tExp, ivec2(0), 0).g;

  vec2 uv = vUv;
  float dark = 0.0;
  if (uDroplets > 0.001) {
    vec3 dr = droplets();
    uv += dr.xy;
    dark = dr.z;
  }

  vec3 hdr = uMB > 0.0 ? motionBlur(uv) : hdrAt(uv);

  vec3 bloom = texture(tBloom, uv).rgb;
  if (uDirt > 0.0) bloom *= 1.0 + uDirt * texture(tDirt, (vUv - 0.5) * vec2(uAspect * 0.5, 1.0) + 0.5).rgb;
  vec3 c = hdr + bloom * uBloom;
  if (uStreak > 0.0) c += texture(tStreak, uv).rgb * vec3(0.55, 0.8, 1.35) * uStreak; // anamorphic blue
  vec2 d = (vUv - 0.5) * 1.41421356; // |d|^2 = 1 at corners
  c *= ex * (1.0 - dark) * (1.0 - uVignette * dot(d, d)); // vignette in scene-linear, as a lens does it
  c = uTonemap > 0.5 ? neutral(c) : clamp(texture(tLut, agxShaper(c) * ${(LUT - 1) / LUT} + ${0.5 / LUT}).rgb, 0.0, 1.0);
  vec3 o = mix(pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));

  // TPDF dither, +-1/255, after sRGB encoding and before the 8-bit store
  vec3 n = hash33(vec3(gl_FragCoord.xy, uFrame)) + hash33(vec3(gl_FragCoord.xy, uFrame + 17.0));
  fragColor = vec4(o + (n - 1.0) * (1.0 / 255.0), 1.0);
}`;

const mk = (frag, uniforms, defines = {}, extra = {}) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: HEAD + frag,
  uniforms, defines, depthTest: false, depthWrite: false, ...extra,
});

const ADD = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor };

const rt = (w, h, type, filter = THREE.LinearFilter, format = THREE.RGBAFormat) => new THREE.WebGLRenderTarget(w, h, {
  type, format, minFilter: filter, magFilter: filter,
  wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
});

export class PostFX {
  params = {
    // Exposure. autoExposure: `exposure` is a multiplier on the metered exposure (exposure compensation, 1 = neutral).
    // !autoExposure: `exposure` is the absolute exposure, as before.
    exposure: 1.0,
    autoExposure: true,
    // Metered exposure = keyValue / (log-average scene luminance). 0.18 puts the scene's geometric mean at
    // middle grey, which this AgX look maps to ~0.46 sRGB. Tune: ~0.12 moodier/darker, ~0.3 airy/bright.
    keyValue: 0.18,
    adaptUp: 3.0,    // adaptation rate (1/s) when the scene gets brighter (exposure falls); ~0.33 s time constant
    adaptDown: 0.8,  // rate (1/s) when the scene gets darker (exposure rises); ~1.25 s time constant
    adaptMaxEv: 2.0, // slew limit while darkening, EV/s
    adaptMaxEvUp: 6.0, // slew limit while brightening, EV/s: a 1-frame flash moves the eye by 0.1 EV at most
    meterFx: 0.6,    // weight of the composited FX in the log-average meter (0 = scene only, as before)
    highlightHeadroom: 3.0, // EV the area-weighted mean luminance may sit above the log average before it pulls exposure down
    minExposure: 0.05, // metered exposure clamp (linear multipliers, ~ -4.3 .. +4.3 EV around 1)
    maxExposure: 20.0,
    bloomStrength: 0.12, bloomThreshold: 1.0, bloomClamp: 64.0, contrast: 1.12, saturation: 1.3,
    bloomLevels: 6,  // 1..6 run per frame (mobile: 4); fewer = tighter glow, cheaper
    tonemap: 'agx',  // 'agx' | 'neutral'
    ca: 0.0,         // lateral chromatic aberration, red/blue magnification difference (0.002 subtle, 0.01 strong)
    flash: 0.0,      // added to the exposure multiplier this frame (lightning, explosions); the caller decays and caps it
    vignette: 0.12,  // darkening at the corners
    lensDirt: 0.0,   // dirt mask strength on the bloom (1 = dirt doubles the glow where it is densest)
    anamorphic: 0.0, // horizontal streak strength (Ultra); 0 costs nothing
    droplets: 0.0, // 0..1 lens water droplets; 0 costs nothing
    motionBlur: 0.5, // camera motion blur, shutter fraction (0.5 = 180 degrees); off on the Low tier; needs viewCamera
    motionBlurMax: 0.04, // longest blur, fraction of the screen height
  };
  viewCamera = null; // the scene camera (main sets it); motion blur reprojects with its matrices

  constructor(renderer) {
    this.renderer = renderer;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.mesh = new THREE.Mesh(this.geometry);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const src = () => ({ tSrc: { value: null }, uTexel: { value: null } });
    this.matPre = mk(DOWN, { ...src(), uCurve: { value: new THREE.Vector4() }, uClamp: { value: 64 } }, { PREFILTER: 1 });
    this.matDown = mk(DOWN, src());
    this.matUp = mk(UP, src(), {}, ADD);
    this.matHFirst = mk(HDOWN, { ...src(), uKeep: { value: 2 } }, { FIRST: 1 });
    this.matHDown = mk(HDOWN, src());
    this.matHUp = mk(HUP, src(), {}, ADD);
    this.matMeter = mk(METER_FRAG, { tSrc: { value: null }, tFx: { value: null }, uFxW: { value: 0 }, uJitter: { value: new THREE.Vector2() } });
    this.matAdapt = mk(ADAPT_FRAG, {
      tSrc: { value: null }, tPrev: { value: null }, uK: { value: new THREE.Vector2(1, 1) }, uRange: { value: new THREE.Vector2(-8, 4) },
      uMaxStep: { value: new THREE.Vector2(1, 1) }, uKey: { value: 0.18 }, uHeadroom: { value: 3 },
    });
    this.matLut = mk(LUT_FRAG, { uLayer: { value: 0 }, uLook: { value: new THREE.Vector2(1, 1) } });
    this.matComp = mk(COMP, {
      tHdr: { value: null }, tBloom: { value: null }, tExp: { value: null }, tDirt: { value: null }, tStreak: { value: null },
      uExposure: { value: 1 }, uAuto: { value: 1 },
      tLut: { value: null }, uBloom: { value: 0 },
      uFrame: { value: 0 }, uDroplets: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 }, uResY: { value: 1 },
      uTonemap: { value: 0 }, uCA: { value: 0 }, uFlash: { value: 0 }, uVignette: { value: 0 }, uDirt: { value: 0 }, uStreak: { value: 0 },
      tDepth: { value: null }, uReproj: { value: new THREE.Matrix4() }, uMB: { value: 0 }, uMBMax: { value: 0.04 },
    });
    // motion blur: last frame's view-projection, scratch values (no allocation per frame)
    this._vp = new THREE.Matrix4();
    this._prevVP = new THREE.Matrix4();
    this._hasPrev = false;
    this._c = new THREE.Vector4();

    // Bloom chain in R11G11B10F where renderable: half the bytes of RGBA16F and full-rate filtering on
    // NVIDIA/AMD (64-bit texels filter at half rate), which is most of this chain's cost. Same range.
    const f32 = renderer.extensions.has('EXT_color_buffer_float');
    const chain = () => f32 ? rt(1, 1, THREE.UnsignedInt101111Type, THREE.LinearFilter, THREE.RGBFormat) : rt(1, 1, THREE.HalfFloatType);

    // levels[i] is 1/2^(i+1) of the input; texel[0] is the HDR input, texel[i+1] is levels[i]
    this.levels = [];
    this.texel = [new THREE.Vector2()];
    for (let i = 0; i < LEVELS; i++) {
      this.levels.push(chain());
      this.texel.push(new THREE.Vector2());
    }
    // streaks[i] has levels[0]'s height and 1/2^(i+1) of its width; streakTexel[i] is streaks[i]
    this.streaks = [];
    this.streakTexel = [];
    for (let i = 0; i < STREAKS; i++) {
      this.streaks.push(chain());
      this.streakTexel.push(new THREE.Vector2());
    }

    // auto exposure: METERxMETER log-luminance target, then a 1x1 float ping-pong holding the adapted value
    this.meterRT = rt(METER, METER, THREE.HalfFloatType);
    this.adapt = [0, 1].map(() => rt(1, 1, f32 ? THREE.FloatType : THREE.HalfFloatType, THREE.NearestFilter));
    this._cur = 0;      // adapt[_cur] holds the latest state
    this._snap = true;  // next metered frame replaces the state instead of easing to it
    this._frame = 0;
    this._time = 0;

    // lens dirt: one draw at load
    this.dirtRT = rt(1024, 512, THREE.UnsignedByteType);
    this.dirtRT.texture.wrapS = this.dirtRT.texture.wrapT = THREE.MirroredRepeatWrapping;
    const dirtMat = mk(DIRT_FRAG, {});
    const prev = renderer.getRenderTarget();
    this._pass(dirtMat, this.dirtRT);
    renderer.setRenderTarget(prev);
    dirtMat.dispose();

    // tonemap LUT, rebaked by render() when tonemap / contrast / saturation change
    this.lutRT = new THREE.WebGL3DRenderTarget(LUT, LUT, LUT, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this._lut = [0, 0]; // contrast, saturation it was baked with

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.setSize(size.x, size.y);
  }

  setSize(width, height) {
    let w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
    this.matComp.uniforms.uAspect.value = w / h;
    this.matComp.uniforms.uResY.value = h;
    this._snap = true; // new framebuffer: re-meter instantly
    this.texel[0].set(1 / w, 1 / h);
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this.levels[i].setSize(w, h);
      this.texel[i + 1].set(1 / w, 1 / h);
    }
    w = this.levels[0].width; h = this.levels[0].height;
    for (let i = 0; i < STREAKS; i++) {
      w = Math.max(1, Math.floor(w / 2));
      this.streaks[i].setSize(w, h);
      this.streakTexel[i].set(1 / w, 1 / h);
    }
  }

  _pass(mat, target) {
    this.mesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.mesh, this.camera);
  }

  _blit(mat, src, texel, target) {
    mat.uniforms.tSrc.value = src;
    mat.uniforms.uTexel.value = texel;
    this._pass(mat, target);
  }

  // Two tiny passes: HDR -> 32x32 log2 luminance -> 1x1 mean + temporal adaptation (all on the GPU).
  _meterExposure(hdr, fx, dt) {
    const p = this.params, m = this.matMeter.uniforms, a = this.matAdapt.uniforms, f = this._frame;
    m.tSrc.value = hdr;
    m.tFx.value = fx;
    m.uFxW.value = Math.min(Math.max(p.meterFx ?? 0, 0), 1);
    m.uJitter.value.set((f * 0.7548776662466927) % 1, (f * 0.5698402909980532) % 1); // R2 sequence
    this._pass(this.matMeter, this.meterRT);

    // keep the state inside the range the exposure clamp can actually show, so it never "winds up"
    const key = Math.max(p.keyValue, 1e-4), lo = Math.max(Math.min(p.minExposure, p.maxExposure), 1e-4), hi = Math.max(p.minExposure, p.maxExposure, 1e-4);
    a.tSrc.value = this.meterRT.texture;
    a.tPrev.value = this.adapt[this._cur].texture;
    a.uK.value.set(this._snap ? 1 : 1 - Math.exp(-dt * p.adaptUp), this._snap ? 1 : 1 - Math.exp(-dt * p.adaptDown));
    a.uRange.value.set(Math.log2(key / hi), Math.log2(key / lo));
    a.uMaxStep.value.set(p.adaptMaxEvUp > 0 ? p.adaptMaxEvUp * dt : 1e9, p.adaptMaxEv > 0 ? p.adaptMaxEv * dt : 1e9);
    a.uKey.value = key;
    a.uHeadroom.value = p.highlightHeadroom ?? 1e3;
    this._cur ^= 1;
    this._pass(this.matAdapt, this.adapt[this._cur]);
    this._snap = false;
  }

  _bakeLut() {
    const p = this.params, k = this._lut, u = this.matLut.uniforms;
    if (k[0] === p.contrast && k[1] === p.saturation) return;
    k[0] = p.contrast; k[1] = p.saturation;
    u.uLook.value.set(p.contrast, p.saturation);
    this.mesh.material = this.matLut;
    for (let z = 0; z < LUT; z++) {
      u.uLayer.value = z;
      this.renderer.setRenderTarget(this.lutRT, z);
      this.renderer.render(this.mesh, this.camera);
    }
  }

  // Camera motion blur setup: reprojection = prevViewProj * inverse(viewProj). Returns the shutter
  // fraction to use this frame (0 = off: no camera, Low tier, first frame, a camera cut, or no motion).
  _motionBlur() {
    const p = this.params, cam = this.viewCamera, u = this.matComp.uniforms;
    if (!cam || !(p.motionBlur > 0) || Q.tier === 'low' || !U.uSceneDepth.value) { this._hasPrev = false; return 0; }
    const vp = this._vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const had = this._hasPrev;
    const M = u.uReproj.value.copy(vp).invert().premultiply(this._prevVP);
    this._prevVP.copy(vp);
    this._hasPrev = true;
    if (!had) return 0;
    // where the screen centre and a corner (far-ish depth) were last frame, in NDC: unchanged = no
    // motion (skip the depth fetch), more than a quarter of the screen = a cut (no blur this frame)
    let c = this._c.set(0, 0, 0.9, 1).applyMatrix4(M);
    const d0 = Math.hypot(c.x / c.w, c.y / c.w);
    c = this._c.set(1, 1, 0.9, 1).applyMatrix4(M);
    const d = Math.max(d0, Math.hypot(c.x / c.w - 1, c.y / c.w - 1));
    return d > 0.5 || d < 1e-5 || !Number.isFinite(d) ? 0 : p.motionBlur;
  }

  // meterSrc: the scene without FX; auto exposure meters it mixed with the composited frame (meterFx)
  render(hdrTexture, dt = 1 / 60, meterSrc = hdrTexture) {
    const r = this.renderer, p = this.params, L = this.levels, T = this.texel, S = this.streaks, ST = this.streakTexel;
    dt = dt > 0 ? Math.min(dt, 1) : 0; // also catches NaN
    this._frame = (this._frame + 1) & 255;
    this._time = (this._time + dt) % 4096;

    const prevTarget = r.getRenderTarget(), prevClear = r.autoClear, prevReset = r.info.autoReset;
    r.autoClear = false;
    r.info.autoReset = false; // keep scene stats; our passes would otherwise wipe them

    if (p.tonemap !== 'neutral') this._bakeLut();
    if (p.autoExposure) {
      this._meterDt = (this._meterDt ?? 0) + dt;
      if (this._snap || this._frame % (p.meterEvery ?? 1) === 0) { this._meterExposure(meterSrc, hdrTexture, this._meterDt); this._meterDt = 0; }
    }
    else this._snap = true; // state goes stale while off: snap when it comes back

    const th = p.bloomThreshold, knee = Math.max(th * 0.5, 1e-4);
    const pre = this.matPre.uniforms;
    pre.uCurve.value.set(th - knee, 2 * knee, 0.25 / knee, th);
    pre.uClamp.value = p.bloomClamp;

    const n = Math.min(Math.max(Math.round(p.bloomLevels), 1), LEVELS);
    const streak = p.anamorphic > 0 && p.bloomStrength > 0;
    if (p.bloomStrength > 0) {   // off, the composite scales the stale chain by 0
      this._blit(this.matPre, hdrTexture, T[0], L[0]);
      for (let i = 1; i < n; i++) this._blit(this.matDown, L[i - 1].texture, T[i], L[i]);
      if (streak) {  // from level 0 before the upsample lands on it: thin streaks of what is above threshold
        this.matHFirst.uniforms.uKeep.value = Math.max(th, 0.5) * 2;
        this._blit(this.matHFirst, L[0].texture, T[1], S[0]);
        for (let i = 1; i < STREAKS; i++) this._blit(this.matHDown, S[i - 1].texture, ST[i - 1], S[i]);
        for (let i = STREAKS - 2; i >= 0; i--) this._blit(this.matHUp, S[i + 1].texture, ST[i + 1], S[i]);
      }
      for (let i = n - 2; i >= 0; i--) this._blit(this.matUp, L[i + 1].texture, T[i + 2], L[i]);
    }

    const u = this.matComp.uniforms;
    u.tHdr.value = hdrTexture;
    u.tBloom.value = L[0].texture;
    u.tExp.value = this.adapt[this._cur].texture;
    u.tDirt.value = this.dirtRT.texture;
    u.tStreak.value = S[0].texture;
    u.tLut.value = this.lutRT.texture;
    u.uExposure.value = p.exposure;
    u.uAuto.value = p.autoExposure ? 1 : 0;
    u.uBloom.value = p.bloomStrength;
    u.uFrame.value = this._frame;
    u.uDroplets.value = Math.min(Math.max(p.droplets, 0), 1);
    u.uTime.value = this._time;
    u.uTonemap.value = p.tonemap === 'neutral' ? 1 : 0;
    u.uCA.value = Math.max(p.ca, 0);
    u.uFlash.value = Math.max(p.flash, 0);
    u.uVignette.value = p.vignette;
    u.uDirt.value = p.bloomStrength > 0 ? Math.max(p.lensDirt, 0) : 0;
    u.uStreak.value = streak ? p.anamorphic * p.bloomStrength : 0;
    u.uMB.value = this._motionBlur();
    u.tDepth.value = U.uSceneDepth.value;
    u.uMBMax.value = Math.max(p.motionBlurMax, 0);
    this._pass(this.matComp, null);

    r.setRenderTarget(prevTarget);
    r.autoClear = prevClear;
    r.info.autoReset = prevReset;
  }

  dispose() {
    for (const t of [...this.levels, ...this.streaks, this.meterRT, ...this.adapt, this.dirtRT, this.lutRT]) t.dispose();
    for (const m of [this.matPre, this.matDown, this.matUp, this.matHFirst, this.matHDown, this.matHUp, this.matMeter, this.matAdapt, this.matLut, this.matComp]) m.dispose();
    this.geometry.dispose();
  }
}
