/**
 * The look of the air: a late-afternoon sky with a low sun and a warm haze at the horizon, the fog that matches it, and a reflection
 * map made from the same sky so paint and glass pick up the sky and sun. Shared by everything so the light is of one place and time.
 */
import type * as T from 'three';
import { REAL, type Palette } from './style.js';

type Three = typeof import('three');

/** Where the sun is, as a direction from the player: low in the west-north-west, about 25 degrees up. */
export const SUN_DIRECTION: [number, number, number] = (() => {
  const x = -0.62;
  const y = 0.42;
  const z = -0.66;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
})();

export const HAZE = '#dcc7ab';
export const SKY_ZENITH = '#4a7fc4';
export const SKY_MID = '#9bbbe0';
export const SUN_COLOUR = '#ffd9a6';

const vertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragment = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHaze;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uGlow;
uniform float uTime;
varying vec3 vDir;
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uHaze, uMid, smoothstep(0.0, 0.22, h));
  col = mix(col, uZenith, smoothstep(0.18, 0.85, h));
  float s = max(dot(d, uSunDir), 0.0);
  // Clouds: a layer drifting overhead, thinning to nothing at the horizon, lit warmly on the sun's side.
  float cloud = 0.0;
  if (d.y > 0.02) {
    vec2 cp = d.xz / (d.y + 0.28) * 1.7 + vec2(uTime * 0.012, uTime * 0.005);
    cloud = smoothstep(0.5, 0.8, fbm(cp)) * smoothstep(0.02, 0.22, d.y);
    vec3 lit = mix(uCloudShade, uCloudLit, pow(s, 2.0) * 0.6 + 0.4);
    col = mix(col, lit, cloud * 0.85);
  }
  // A wide warm glow, a tighter one, and the disc itself (partly hidden behind cloud).
  col += uSun * (0.18 * pow(s, 3.0) + 0.45 * pow(s, 24.0) + 2.4 * pow(s, 700.0)) * uGlow * (1.0 - cloud * 0.7);
  // Haze thickens towards the horizon, and everything below it is haze.
  col = mix(col, uHaze, (1.0 - smoothstep(0.0, 0.12, h)) * 0.55);
  if (d.y < 0.0) col = uHaze;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function skyMaterial(three: Three, look: Palette = REAL): T.ShaderMaterial {
  return new three.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    side: three.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new three.Color(look.sky.zenith) },
      uMid: { value: new three.Color(look.sky.mid) },
      uHaze: { value: new three.Color(look.sky.haze) },
      uSun: { value: new three.Color(look.sky.sun) },
      uSunDir: { value: new three.Vector3(...SUN_DIRECTION) },
      uCloudLit: { value: new three.Color(look.sky.cloudLit) },
      uCloudShade: { value: new three.Color(look.sky.cloudShade) },
      uGlow: { value: look.sky.glow },
      uTime: { value: 0 },
    },
  });
}

export interface Atmosphere {
  /** The dome to add to the scene; keep it centred on the camera. */
  dome: T.Mesh;
  /** A reflection map of this sky, for scene.environment. */
  environment: T.Texture;
  /** Moves the clouds on; pass the time in seconds. */
  tick(seconds: number): void;
  dispose(): void;
}

export function makeAtmosphere(three: Three, renderer: T.WebGLRenderer, look: Palette = REAL): Atmosphere {
  const material = skyMaterial(three, look);
  const dome = new three.Mesh(new three.SphereGeometry(1000, 32, 16), material);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  // The reflection map is rendered from a copy of the sky on its own, at a smaller size.
  const only = new three.Scene();
  const copy = new three.Mesh(new three.SphereGeometry(50, 32, 16), skyMaterial(three, look));
  only.add(copy);
  const pmrem = new three.PMREMGenerator(renderer);
  const target = pmrem.fromScene(only, 0.02);
  pmrem.dispose();
  return {
    dome,
    environment: target.texture,
    tick(seconds) {
      material.uniforms.uTime!.value = seconds;
    },
    dispose() {
      dome.geometry.dispose();
      material.dispose();
      copy.geometry.dispose();
      (copy.material as T.Material).dispose();
      target.dispose();
    },
  };
}
