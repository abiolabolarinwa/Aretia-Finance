/**
 * Close-up surface detail from real photographed textures (CC0, from Poly Haven): asphalt grit, concrete, plaster. The map-drawn colours
 * stay as they are; the photograph only adds the fine variation (grain, stains, cracks) on top, and fades out with distance so far
 * away surfaces stay clean and do not shimmer. If a texture cannot be loaded the surface simply stays as it was.
 */
import type * as T from 'three';

type Three = typeof import('three');

export interface DetailTexture {
  texture: T.Texture;
  /** The picture's average colour in linear light, so the detail can be centred on 1 and not change overall brightness. */
  mean: [number, number, number];
}

export type DetailMode = 'world' | 'uv';

export interface DetailOptions {
  detail: DetailTexture;
  /** 'world' lays the picture on the ground plane by position; 'uv' tiles it on the surface's own picture coordinates (walls). */
  mode: DetailMode;
  /** Pictures per metre (world) or per repeat (uv). */
  scale: number;
  /** 0 is no effect, 1 is the full photograph. */
  strength: number;
  /** Distance in metres where the effect starts to fade, and where it is gone. */
  near: number;
  far: number;
}

const toLinear = (v: number): number => Math.pow(v / 255, 2.2);

/** Loads a texture and works out its average colour. Resolves to null if the picture cannot be loaded. */
export async function loadDetail(three: Three, url: string, renderer?: T.WebGLRenderer): Promise<DetailTexture | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('texture not found'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(img, 0, 0, 16, 16);
    const px = g.getImageData(0, 0, 16, 16).data;
    let r = 0;
    let gr = 0;
    let b = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += toLinear(px[i]!);
      gr += toLinear(px[i + 1]!);
      b += toLinear(px[i + 2]!);
    }
    const n = px.length / 4;
    const texture = new three.Texture(img);
    texture.wrapS = three.RepeatWrapping;
    texture.wrapT = three.RepeatWrapping;
    texture.colorSpace = three.SRGBColorSpace;
    texture.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
    texture.needsUpdate = true;
    return { texture, mean: [Math.max(r / n, 0.02), Math.max(gr / n, 0.02), Math.max(b / n, 0.02)] };
  } catch {
    return null;
  }
}

/**
 * The extra shader code, as strings so it can be checked without a screen. It is added to a standard three.js surface: a varying for
 * the position in the world, and one line after the surface's own colour is worked out.
 */
export function detailShader(mode: DetailMode): { vertexDeclare: string; vertexBody: string; fragmentDeclare: string; fragmentBody: string } {
  const sample = mode === 'world' ? 'vDetailWorld.xz * detailParams.x' : 'vMapUv * detailParams.x';
  return {
    vertexDeclare: 'varying vec3 vDetailWorld;',
    vertexBody: 'vDetailWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    fragmentDeclare: 'uniform sampler2D detailMap;\nuniform vec3 detailMean;\nuniform vec4 detailParams;\nvarying vec3 vDetailWorld;',
    fragmentBody: `{
  vec3 dt = texture2D(detailMap, ${sample}).rgb / detailMean;
  float fade = 1.0 - smoothstep(detailParams.y, detailParams.z, length(vDetailWorld - cameraPosition));
  diffuseColor.rgb *= mix(vec3(1.0), dt, detailParams.w * fade);
}`,
  };
}

/** Adds the photographed detail to a material (Lambert or Standard). Returns the same material. */
export function applyDetail<M extends T.Material>(three: Three, material: M, o: DetailOptions): M {
  const code = detailShader(o.mode);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: o.detail.texture };
    shader.uniforms.detailMean = { value: new three.Vector3(...o.detail.mean) };
    shader.uniforms.detailParams = { value: new three.Vector4(o.scale, o.near, o.far, o.strength) };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${code.vertexDeclare}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${code.vertexBody}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${code.fragmentDeclare}`).replace('#include <map_fragment>', `#include <map_fragment>\n${code.fragmentBody}`);
  };
  // Surfaces that share this key share one compiled program, even though each has its own picture.
  material.customProgramCacheKey = () => `detail-${o.mode}`;
  return material;
}
