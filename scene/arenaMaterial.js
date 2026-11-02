// SPIKE STUB — replaces upstream src/scene/arenaMaterial.js (878 lines: the
// arena's lit-surface pipeline). Bolts.js imports { arenaUniforms } from here
// but reads only arenaUniforms.uStoneNoise, and only while constructing the
// floor-mirror mesh (Q.reflectFx), which this spike disables. A 1x1
// placeholder texture is all the import needs to resolve honestly.
import * as THREE from 'three';

const tex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
tex.needsUpdate = true;

export const arenaUniforms = { uStoneNoise: { value: tex } };
