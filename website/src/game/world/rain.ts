/**
 * Rain as thousands of thin falling streaks in a box that follows the camera. Each streak is two points; the graphics card moves them
 * down, wraps them round the camera so the rain never runs out, slants them with the wind, and hides the ones above the current
 * intensity, so light rain and a downpour are the same object drawn with a different amount. Nothing is moved by the CPU.
 */
import type * as T from 'three';

type Three = typeof import('three');

export const RAIN_COUNT = 3200;
/** The width of the box of rain round the camera, and how tall it is, in metres. */
export const RAIN_BOX = 70;
export const RAIN_HEIGHT = 28;

const vertex = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform float uIntensity;
uniform vec2 uWind;
attribute float aEnd;
attribute float aSeed;
varying float vAlpha;
const float BOX = ${RAIN_BOX.toFixed(1)};
const float HEIGHT = ${RAIN_HEIGHT.toFixed(1)};
void main() {
  float speed = 17.0 + aSeed * 9.0;
  float y = mod(position.y - uTime * speed, HEIGHT);
  vec2 xz = mod(position.xz - uCam.xz + BOX * 0.5, BOX) - BOX * 0.5 + uCam.xz;
  vec3 world = vec3(xz.x, y, xz.y);
  float len = 0.8 + aSeed * 0.6;
  world += aEnd * vec3(uWind.x * 0.5, 1.0, uWind.y * 0.5) * len;
  float shown = step(aSeed, uIntensity);
  float fade = 1.0 - smoothstep(24.0, 35.0, length(world - uCam));
  vAlpha = shown * fade * mix(0.5, 0.06, aEnd);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const fragment = /* glsl */ `
uniform vec3 uColour;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColour, vAlpha);
  #include <colorspace_fragment>
}`;

/** Two points per streak: a random place in the box, the same seed for both, and a 0 or 1 saying which end. */
export function rainGeometry(three: Three, count = RAIN_COUNT, random: () => number = Math.random): T.BufferGeometry {
  const pos = new Float32Array(count * 6);
  const end = new Float32Array(count * 2);
  const seed = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = random() * RAIN_BOX;
    const y = random() * RAIN_HEIGHT;
    const z = random() * RAIN_BOX;
    const s = random();
    for (let k = 0; k < 2; k++) {
      pos.set([x, y, z], (i * 2 + k) * 3);
      end[i * 2 + k] = k;
      seed[i * 2 + k] = s;
    }
  }
  const g = new three.BufferGeometry();
  g.setAttribute('position', new three.BufferAttribute(pos, 3));
  g.setAttribute('aEnd', new three.BufferAttribute(end, 1));
  g.setAttribute('aSeed', new three.BufferAttribute(seed, 1));
  return g;
}

export interface Rain {
  object: T.LineSegments;
  /** Call every frame: time in seconds, the camera's position, how hard it rains (0 to 1) and the wind (x, z; roughly -1 to 1). */
  update(seconds: number, camera: T.Vector3, intensity: number, windX: number, windZ: number): void;
  dispose(): void;
}

export function makeRain(three: Three, count = RAIN_COUNT, colour = '#c9d6e6'): Rain {
  const geometry = rainGeometry(three, count);
  const material = new three.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uCam: { value: new three.Vector3() },
      uIntensity: { value: 0 },
      uWind: { value: new three.Vector2() },
      uColour: { value: new three.Color(colour) },
    },
  });
  const object = new three.LineSegments(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = 7;
  object.visible = false;
  return {
    object,
    update(seconds, camera, intensity, windX, windZ) {
      const u = material.uniforms;
      u.uTime!.value = seconds;
      (u.uCam!.value as T.Vector3).copy(camera);
      u.uIntensity!.value = Math.max(0, Math.min(1, intensity));
      (u.uWind!.value as T.Vector2).set(windX, windZ);
      object.visible = intensity > 0.01; // no cost at all when it is dry
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
