/**
 * Draws the 3D scenes with three.js: a diorama of the city (its water, hills, buildings and real landmarks, with the player and any
 * unlocked treasure zone marked) and the chambers a mission can send a player into. Loaded only when a player opens one. The shape of
 * every scene is decided in sceneModel.ts; this only turns that data into pictures. Drag to turn, scroll or pinch to zoom.
 */
import type * as T from 'three';
import type { City } from './cities.js';
import { buildChamberModel, buildCityModel, type ChamberKind, type ChamberModel } from './sceneModel.js';

type Three = typeof import('three');
export interface SceneHandle {
  destroy(): void;
  setPlayer(pos: [number, number] | null): void;
  setZone(zone: { lng: number; lat: number } | null): void;
}

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function canvasLabel(three: Three, text: string): T.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d');
  if (g) {
    g.font = '600 38px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 8;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.strokeText(text, 256, 48);
    g.fillStyle = '#ffffff';
    g.fillText(text, 256, 48);
  }
  const tex = new three.CanvasTexture(c);
  const sprite = new three.Sprite(new three.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(16, 3, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function disposeTree(root: T.Object3D): void {
  root.traverse((o) => {
    const m = o as T.Mesh;
    m.geometry?.dispose();
    const mat = m.material as T.Material | T.Material[] | undefined;
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      (x as T.MeshBasicMaterial).map?.dispose();
      x.dispose();
    }
  });
}

/** Sets up a renderer, camera, orbit controls and a render loop; the caller fills the scene and may animate. */
async function stage(host: HTMLElement, height: number, background: string, animate: (t: number) => void) {
  const three = await import('three');
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
  let renderer: T.WebGLRenderer;
  try {
    renderer = new three.WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
  const w = Math.max(280, host.clientWidth || 640);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(w, height);
  renderer.domElement.style.cssText = 'width:100%;height:' + height + 'px;border-radius:12px;display:block;touch-action:none';
  host.append(renderer.domElement);
  const scene = new three.Scene();
  scene.background = new three.Color(background);
  const camera = new three.PerspectiveCamera(50, w / height, 0.1, 600);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !reducedMotion();
  controls.maxPolarAngle = Math.PI / 2.02;
  const still = reducedMotion();
  let raf = 0;
  let stopped = false;
  const render = (): void => renderer.render(scene, camera);
  const loop = (ms: number): void => {
    if (stopped) return;
    animate(ms / 1000);
    controls.update();
    render();
    raf = requestAnimationFrame(loop);
  };
  if (still) {
    // No continuous motion: draw when something changes.
    controls.addEventListener('change', render);
    render();
  } else raf = requestAnimationFrame(loop);
  const resize = new ResizeObserver(() => {
    const nw = Math.max(280, host.clientWidth || w);
    renderer.setSize(nw, height);
    camera.aspect = nw / height;
    camera.updateProjectionMatrix();
    render();
  });
  resize.observe(host);
  return {
    three, scene, camera, controls, render, still,
    destroy() {
      stopped = true;
      cancelAnimationFrame(raf);
      resize.disconnect();
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** The diorama of a city. Returns null if this device cannot draw 3D. */
export async function mountCityScene(host: HTMLElement, city: City, start: { player: [number, number] | null; zone: { lng: number; lat: number } | null }): Promise<SceneHandle | null> {
  const model = buildCityModel(city);
  let pulse: T.Mesh | null = null;
  const s = await stage(host, 420, model.sky, (t) => {
    if (pulse) pulse.scale.setScalar(1 + Math.sin(t * 3) * 0.18);
  });
  if (!s) return null;
  const { three, scene, camera, controls, render } = s;
  camera.position.set(0, model.width * 0.55, model.depth * 0.8);
  controls.target.set(0, 0, 0);
  controls.minDistance = 25;
  controls.maxDistance = 220;
  scene.fog = new three.Fog(model.sky, 160, 380);
  scene.add(new three.HemisphereLight('#ffffff', '#556655', 1.0));
  const sun = new three.DirectionalLight('#fff4dd', 1.4);
  sun.position.set(-60, 90, 40);
  scene.add(sun);

  const ground = new three.Mesh(new three.PlaneGeometry(model.width * 1.5, model.depth * 1.5), new three.MeshLambertMaterial({ color: model.ground }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const waterMat = new three.MeshPhongMaterial({ color: '#2b7fb5', transparent: true, opacity: 0.88, shininess: 90 });
  for (const r of model.water) {
    const m = new three.Mesh(new three.BoxGeometry(r.w, 0.3, r.d), waterMat);
    m.position.set(r.x, 0.12, r.z);
    scene.add(m);
  }
  const hillMat = new three.MeshLambertMaterial({ color: new three.Color(model.ground).multiplyScalar(0.8) });
  for (const h of model.hills) {
    const m = new three.Mesh(new three.ConeGeometry(h.r, h.h, 20), hillMat);
    m.position.set(h.x, h.h / 2, h.z);
    scene.add(m);
  }
  const boxes = new three.InstancedMesh(new three.BoxGeometry(1, 1, 1), new three.MeshLambertMaterial(), model.boxes.length);
  const dummy = new three.Object3D();
  model.boxes.forEach((b, i) => {
    dummy.position.set(b.x, b.h / 2, b.z);
    dummy.scale.set(b.w, b.h, b.d);
    dummy.updateMatrix();
    boxes.setMatrixAt(i, dummy.matrix);
    boxes.setColorAt(i, new three.Color(b.color));
  });
  boxes.instanceMatrix.needsUpdate = true;
  scene.add(boxes);
  const trees = new three.InstancedMesh(new three.ConeGeometry(0.7, 2.2, 7), new three.MeshLambertMaterial({ color: '#2f6b3a' }), model.trees.length);
  model.trees.forEach((t, i) => {
    dummy.position.set(t.x, 1.1 * t.s, t.z);
    dummy.scale.setScalar(t.s);
    dummy.updateMatrix();
    trees.setMatrixAt(i, dummy.matrix);
  });
  trees.instanceMatrix.needsUpdate = true;
  scene.add(trees);

  const accent = new three.Color(city.tint[1]);
  for (const m of model.marks) {
    const pillar = new three.Mesh(new three.CylinderGeometry(0.5, 0.9, m.h, 10), new three.MeshLambertMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.5 }));
    pillar.position.set(m.x, m.h / 2, m.z);
    scene.add(pillar);
    const label = canvasLabel(three, m.name);
    label.position.set(m.x, m.h + 2.4, m.z);
    scene.add(label);
  }

  const playerMesh = new three.Mesh(new three.SphereGeometry(1.1, 18, 14), new three.MeshLambertMaterial({ color: '#ffd23f', emissive: '#c9a227', emissiveIntensity: 0.8 }));
  pulse = playerMesh;
  playerMesh.visible = false;
  scene.add(playerMesh);
  const zoneMesh = new three.Mesh(new three.TorusGeometry(2.4, 0.3, 10, 32), new three.MeshBasicMaterial({ color: '#2dd36f' }));
  zoneMesh.rotation.x = Math.PI / 2;
  zoneMesh.position.y = 0.6;
  zoneMesh.visible = false;
  scene.add(zoneMesh);

  const handle: SceneHandle = {
    setPlayer(pos) {
      playerMesh.visible = Boolean(pos);
      if (pos) {
        const [x, z] = model.project(pos[0], pos[1]);
        playerMesh.position.set(x, 1.6, z);
      }
      render();
    },
    setZone(zone) {
      zoneMesh.visible = Boolean(zone);
      if (zone) {
        const [x, z] = model.project(zone.lng, zone.lat);
        zoneMesh.position.set(x, 0.6, z);
      }
      render();
    },
    destroy: s.destroy,
  };
  handle.setPlayer(start.player);
  handle.setZone(start.zone);
  return handle;
}

/** One of the chambers a mission can send a player into. Returns null if this device cannot draw 3D. */
export async function mountChamber(host: HTMLElement, kind: ChamberKind, seed: string): Promise<{ destroy(): void; model: ChamberModel } | null> {
  const model = buildChamberModel(kind, seed);
  const swayers: { m: T.Mesh; phase: number }[] = [];
  let flicker: T.PointLight | null = null;
  let specks: T.Points | null = null;
  const s = await stage(host, 380, model.fog, (t) => {
    for (const k of swayers) k.m.rotation.z = Math.sin(t * 0.9 + k.phase) * 0.08;
    if (flicker) flicker.intensity = model.light.intensity * (0.85 + Math.sin(t * 11) * 0.08 + Math.sin(t * 7.3) * 0.06);
    if (specks) {
      const pos = specks.geometry.getAttribute('position') as T.BufferAttribute;
      const rise = kind === 'underwater' ? 1 : 0.05;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) + 0.012 * rise + 0.002;
        if (y > 12) y = 0;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
    }
  });
  if (!s) return null;
  const { three, scene, camera, controls } = s;
  scene.fog = new three.FogExp2(model.fog, model.fogDensity);
  camera.position.set(0, 7, 20);
  controls.target.set(0, 2, 0);
  controls.minDistance = 8;
  controls.maxDistance = 38;
  controls.autoRotate = !s.still;
  controls.autoRotateSpeed = 0.6;
  scene.add(new three.AmbientLight(model.light.color, 0.35));
  const light = new three.PointLight(model.light.color, model.light.intensity, 60, 1.2);
  light.position.set(0, 7, 0);
  scene.add(light);
  if (kind === 'underground' || kind === 'vault') flicker = light;
  const floor = new three.Mesh(new three.CircleGeometry(32, 48), new three.MeshLambertMaterial({ color: model.floor }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  for (const p of model.props) {
    let mesh: T.Mesh;
    const mat = new three.MeshStandardMaterial({ color: p.color, roughness: p.type === 'coin' ? 0.3 : 0.85, metalness: p.type === 'coin' ? 0.9 : 0.05, emissive: p.type === 'crystal' ? p.color : '#000000', emissiveIntensity: p.type === 'crystal' ? 0.9 : 0 });
    if (p.type === 'kelp') {
      mesh = new three.Mesh(new three.CylinderGeometry(p.r * 0.5, p.r, p.h, 6), mat);
      mesh.position.set(p.x, p.h / 2, p.z);
      swayers.push({ m: mesh, phase: p.x + p.z });
    } else if (p.type === 'rock') {
      mesh = new three.Mesh(new three.DodecahedronGeometry(p.r, 0), mat);
      mesh.position.set(p.x, p.h / 2, p.z);
      mesh.scale.y = p.h / (p.r * 2);
    } else if (p.type === 'crystal') {
      mesh = new three.Mesh(new three.ConeGeometry(p.r, p.h, 6), mat);
      mesh.position.set(p.x, p.h / 2, p.z);
    } else if (p.type === 'stalactite') {
      mesh = new three.Mesh(new three.ConeGeometry(p.r, p.h, 7), mat);
      mesh.rotation.x = Math.PI;
      mesh.position.set(p.x, 12 - p.h / 2, p.z);
    } else if (p.type === 'column') {
      mesh = new three.Mesh(new three.CylinderGeometry(p.r, p.r * 1.1, p.h, 12), mat);
      mesh.position.set(p.x, p.h / 2, p.z);
    } else {
      mesh = new three.Mesh(new three.CylinderGeometry(p.r, p.r, p.h, 24), mat);
      mesh.position.set(p.x, p.h / 2 + 0.05, p.z);
    }
    scene.add(mesh);
  }
  const n = model.particles;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 40 - 20;
    arr[i * 3 + 1] = (Math.abs(Math.sin(i * 78.233) * 43758.5453) % 1) * 12;
    arr[i * 3 + 2] = (Math.sin(i * 39.346) * 43758.5453 % 1) * 40 - 20;
  }
  const geo = new three.BufferGeometry();
  geo.setAttribute('position', new three.BufferAttribute(arr, 3));
  specks = new three.Points(geo, new three.PointsMaterial({ color: kind === 'underwater' ? '#d8f6ff' : '#e8d8b8', size: kind === 'underwater' ? 0.35 : 0.18, transparent: true, opacity: 0.7 }));
  scene.add(specks);
  s.render();
  return { destroy: s.destroy, model };
}
