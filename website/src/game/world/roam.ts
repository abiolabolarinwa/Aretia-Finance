/**
 * Roam the city: a third-person 3D world built from the real map (OpenStreetMap, served by OpenFreeMap), where the player walks, runs,
 * drives cars and pilots boats through the real streets, past the real buildings, rivers and parks. Streets are loaded as the player
 * gets near, so the whole city is open. Walls stop everything, water stops people and cars, and a boat stays on water.
 *
 * The page moves the player; the server decides what counts. Every second or so the page reports where the player is, and the server
 * refuses a report that is further than that way of travelling could have gone (see roamRules.ts), putting the player back. A treasure
 * can only be collected from the position the server holds, so it has to be reached by walking or driving there.
 *
 * Controls: W A S D move (relative to the camera on foot; throttle and steering in a vehicle), Shift runs, Space is the handbrake,
 * E gets in or out of a vehicle or collects a treasure, arrow keys or dragging turn the camera, F is full screen. On a touch screen:
 * a stick on the left, drag on the right to look, and buttons.
 */
import type * as T from 'three';
import type { City } from '../cities.js';
import { buildCityModel } from '../sceneModel.js';
import type { RoamMode } from '../roamRules.js';
import { decodeTile } from './mvt.js';
import { buildTileWorld, fromLocal, tileOf, tilePoint, tileUrl, toLocal, TILE_ZOOM, type Named, type Origin, type TileWorld } from './worldData.js';
import { Colliders, TileColliders, nearestOnSegment } from './colliders.js';
import { bucketTile, buildingParts, cellCentre, CELL_M, type Cell } from './roamBuild.js';
import { lampsFor, paintGround, squareOf, treesFor } from './roamDetail.js';
import { makeHuman } from './human.js';
import type { Pt } from './mvt.js';
import { BOAT, CAR, RUN_SPEED, WALK_SPEED, stepFoot, stepVehicle, type Foot, type Vehicle, type VehicleSpec } from './physics.js';

export interface RoamZone {
  id: string;
  coin: string;
  lng: number;
  lat: number;
  radiusM: number;
}
export interface RoamApi {
  sync(lng: number, lat: number, mode: RoamMode): Promise<{ ok: boolean; position?: [number, number]; message?: string }>;
  zones(): Promise<RoamZone[]>;
  collect(id: string): Promise<{ ok: boolean; message: string }>;
}
export interface RoamHandle {
  destroy(): void;
}

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const LOAD_RADIUS_M = 1100;
const UNLOAD_RADIUS_M = 3200;
const BUILD_RADIUS_M = 480;
const DROP_RADIUS_M = 760;
const SYNC_MS = 1500;

let template: Promise<string> | null = null;
const tileTemplate = (): Promise<string> => (template ??= fetch(TILEJSON).then((r) => r.json()).then((j: { tiles?: string[] }) => {
  if (!j.tiles?.[0]) throw new Error('The map service gave no tiles.');
  return j.tiles[0];
}).catch((e) => {
  template = null;
  throw e;
}));

interface LoadedTile {
  id: string;
  x: number;
  y: number;
  world: TileWorld;
  cells: Map<string, Cell>;
  named: { n: Named; box: [number, number, number, number] }[];
  group: T.Group;
  box: { minX: number; minZ: number; maxX: number; maxZ: number };
}

interface Rig {
  spec: VehicleSpec;
  kind: 'car' | 'boat';
  state: Vehicle;
  mesh: T.Group;
  name: string;
}

const KEY_NAMES = ['w', 'a', 's', 'd', 'shift', ' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'];

export async function mountRoam(host: HTMLElement, city: City, startAt: [number, number], api: RoamApi): Promise<RoamHandle | null> {
  const three = await import('three');
  const origin: Origin = { lng: city.center[0], lat: city.center[1] };
  const model = buildCityModel(city);

  // ------------------------------------------------------------ the page: a canvas with a heads-up display over it
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:100%;height:min(78vh,720px);min-height:420px;background:#000;border-radius:16px;overflow:hidden;user-select:none;touch-action:none';
  const canvasHolder = document.createElement('div');
  canvasHolder.style.cssText = 'position:absolute;inset:0';
  wrap.append(canvasHolder);
  const hud = (css: string, text = ''): HTMLDivElement => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;pointer-events:none;color:#fff;font:600 13px system-ui,sans-serif;text-shadow:0 1px 3px #000,0 0 8px #000;' + css;
    d.textContent = text;
    wrap.append(d);
    return d;
  };
  const status = hud('left:14px;top:12px;font-size:15px;line-height:1.35');
  const place = hud('left:50%;top:12px;transform:translateX(-50%);font-size:15px;text-align:center;max-width:40%');
  const prompt = hud('left:50%;bottom:84px;transform:translateX(-50%);font-size:17px;text-align:center;background:rgba(0,0,0,.55);padding:8px 16px;border-radius:999px;display:none');
  const toast = hud('left:50%;top:56px;transform:translateX(-50%);text-align:center;max-width:70%;background:rgba(0,0,0,.6);padding:8px 14px;border-radius:12px;display:none');
  const help = hud('left:14px;bottom:14px;font-size:12px;line-height:1.5;background:rgba(0,0,0,.5);padding:8px 12px;border-radius:12px;font-weight:500', 'W A S D move · Shift run · E get in or out, collect · Space handbrake · drag or ← → look · F full screen');
  const mini = document.createElement('canvas');
  mini.width = 176;
  mini.height = 176;
  mini.style.cssText = 'position:absolute;right:12px;top:12px;width:132px;height:132px;border-radius:50%;border:2px solid rgba(255,255,255,.7);background:#101010;pointer-events:none';
  wrap.append(mini);
  const button = (label: string, css: string, on: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'position:absolute;cursor:pointer;border:1px solid rgba(255,255,255,.6);background:rgba(0,0,0,.55);color:#fff;font:700 13px system-ui,sans-serif;border-radius:999px;padding:8px 14px;' + css;
    b.addEventListener('click', on);
    wrap.append(b);
    return b;
  };
  const fsButton = button('Full screen', 'right:12px;top:152px', () => toggleFullscreen());
  fsButton.setAttribute('aria-label', 'Toggle full screen');
  host.replaceChildren(wrap);

  // ------------------------------------------------------------ the 3D scene
  let renderer: T.WebGLRenderer;
  try {
    renderer = new three.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    host.textContent = '3D cannot be drawn on this device.';
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;outline:none';
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', 'The city. Use W A S D to move.');
  canvasHolder.append(renderer.domElement);
  const scene = new three.Scene();
  scene.background = new three.Color(model.sky);
  scene.fog = new three.Fog(model.sky, 220, 820);
  const camera = new three.PerspectiveCamera(62, 1, 0.3, 1400);
  scene.add(new three.HemisphereLight('#ffffff', '#6b7a66', 1.15));
  const sun = new three.DirectionalLight('#fff3dd', 1.5);
  sun.position.set(-120, 220, 90);
  scene.add(sun);
  // The plain ground under everything the map paints: dusty pavement colour, as most of a city is.
  const ground = new three.Mesh(new three.PlaneGeometry(9000, 9000), new three.MeshLambertMaterial({ color: '#a29f94' }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Walls take a window picture (one bay wide, one storey tall) multiplied by each building's tint; roofs are plain.
  const windows = document.createElement('canvas');
  windows.width = 128;
  windows.height = 128;
  const wg = windows.getContext('2d');
  if (wg) {
    wg.fillStyle = '#f4f1ea';
    wg.fillRect(0, 0, 128, 128);
    wg.fillStyle = '#dcd8cd';
    wg.fillRect(0, 118, 128, 10); // the floor slab
    wg.fillStyle = '#3b3f46';
    wg.fillRect(28, 26, 72, 70); // frame
    const glass = wg.createLinearGradient(0, 30, 0, 92);
    glass.addColorStop(0, '#9fb8cc');
    glass.addColorStop(1, '#4d6a85');
    wg.fillStyle = glass;
    wg.fillRect(32, 30, 64, 62);
    wg.fillStyle = '#3b3f46';
    wg.fillRect(62, 30, 4, 62);
    wg.fillStyle = '#e8e4da';
    wg.fillRect(24, 96, 80, 5); // sill
  }
  const windowTexture = new three.CanvasTexture(windows);
  windowTexture.wrapS = three.RepeatWrapping;
  windowTexture.wrapT = three.RepeatWrapping;
  windowTexture.colorSpace = three.SRGBColorSpace;
  windowTexture.anisotropy = 4;
  const wallMaterial = new three.MeshLambertMaterial({ vertexColors: true, map: windowTexture });
  const roofMaterial = new three.MeshLambertMaterial({ vertexColors: true, side: three.DoubleSide });

  // Trees and street lamps are drawn many at a time from one shape each.
  const trunkGeo = new three.CylinderGeometry(0.14, 0.2, 2.4, 7);
  trunkGeo.translate(0, 1.2, 0);
  const crownGeo = new three.IcosahedronGeometry(1.7, 1);
  crownGeo.translate(0, 3.9, 0);
  const poleGeo = new three.CylinderGeometry(0.06, 0.08, 7.2, 6);
  poleGeo.translate(0, 3.6, 0);
  const lampHeadGeo = new three.BoxGeometry(0.9, 0.12, 0.3);
  lampHeadGeo.translate(0.35, 7.25, 0);
  const trunkMat = new three.MeshLambertMaterial({ color: '#5b4331' });
  const crownMat = new three.MeshLambertMaterial({ color: '#ffffff' });
  const poleMat = new three.MeshLambertMaterial({ color: '#4a4d52' });
  const sharedGeos = new Set<T.BufferGeometry>([trunkGeo, crownGeo, poleGeo, lampHeadGeo]);

  // ------------------------------------------------------------ what the player is: a person, a car, a boat
  const box = (w: number, h: number, d: number, colour: string, x = 0, y = 0, z = 0): T.Mesh => {
    const m = new three.Mesh(new three.BoxGeometry(w, h, d), new three.MeshLambertMaterial({ color: colour }));
    m.position.set(x, y, z);
    return m;
  };
  const human = makeHuman(three);
  const person = human.group;
  scene.add(person);

  const carMesh = (colour: string): T.Group => {
    const g = new three.Group();
    g.add(box(2.0, 0.75, 4.3, colour, 0, 0.7, 0), box(1.7, 0.7, 2.1, '#1b2430', 0, 1.4, -0.2), box(0.3, 0.18, 0.05, '#fff6c8', -0.65, 0.8, -2.16), box(0.3, 0.18, 0.05, '#fff6c8', 0.65, 0.8, -2.16));
    for (const [x, z] of [[-0.95, -1.4], [0.95, -1.4], [-0.95, 1.4], [0.95, 1.4]] as const) {
      const w = new three.Mesh(new three.CylinderGeometry(0.4, 0.4, 0.3, 14), new three.MeshLambertMaterial({ color: '#111111' }));
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.4, z);
      g.add(w);
    }
    return g;
  };
  const boatMesh = (): T.Group => {
    const g = new three.Group();
    const bow = new three.Mesh(new three.ConeGeometry(1.1, 2.2, 4), new three.MeshLambertMaterial({ color: '#f2f2f2' }));
    bow.rotation.x = -Math.PI / 2;
    bow.rotation.y = Math.PI / 4;
    bow.position.set(0, 0.55, -3.7);
    g.add(box(2.2, 0.9, 5.2, '#f2f2f2', 0, 0.5, 0), bow, box(1.5, 0.9, 1.8, '#2b3a4a', 0, 1.35, 0.4), box(2.25, 0.18, 5.25, '#c0392b', 0, 0.78, 0));
    return g;
  };

  // ------------------------------------------------------------ state
  const colliders = new Colliders();
  const tiles = new Map<string, LoadedTile>();
  const loading = new Set<string>();
  const failed = new Map<string, number>();
  const built = new Map<string, T.Group>();
  const abort = new AbortController();
  let destroyed = false;

  const [sx, sz] = toLocal(origin, startAt[0], startAt[1]);
  const foot: Foot = { x: sx, z: sz, vx: 0, vz: 0, heading: 0 };
  const rigs: Rig[] = [];
  let driving: Rig | null = null;
  let camYaw = 0;
  let camPitch = 0.45;
  let lastLook = 0;
  const keys = new Set<string>();
  const stick = { x: 0, y: 0 };
  let touchRun = false;
  let touchBrake = false;
  let pressE = false;
  let zones: { zone: RoamZone; x: number; z: number; beacon: T.Group }[] = [];
  const zoneGroup = new three.Group();
  scene.add(zoneGroup);

  // The edge of the city, in metres, so nobody drives off the map.
  const west = toLocal(origin, city.bounds[0], origin.lat)[0];
  const east = toLocal(origin, city.bounds[2], origin.lat)[0];
  const north = toLocal(origin, origin.lng, city.bounds[3])[1];
  const south = toLocal(origin, origin.lng, city.bounds[1])[1];

  const here = (): { x: number; z: number } => (driving ? driving.state : foot);
  const mode = (): RoamMode => (driving ? (driving.kind === 'boat' ? 'boat' : 'car') : keys.has('shift') || touchRun ? 'run' : 'walk');

  function say(text: string, ms = 4500): void {
    toast.textContent = text;
    toast.style.display = 'block';
    const mine = text;
    setTimeout(() => {
      if (toast.textContent === mine) toast.style.display = 'none';
    }, ms);
  }

  // ------------------------------------------------------------ streets: loaded as the player gets near
  function tileBox(x: number, y: number): LoadedTile['box'] {
    const a = tilePoint(TILE_ZOOM, x, y, 0, 0, 4096);
    const b = tilePoint(TILE_ZOOM, x, y, 4096, 4096, 4096);
    const p = toLocal(origin, a[0], a[1]);
    const q = toLocal(origin, b[0], b[1]);
    return { minX: Math.min(p[0], q[0]), maxX: Math.max(p[0], q[0]), minZ: Math.min(p[1], q[1]), maxZ: Math.max(p[1], q[1]) };
  }
  const distToBox = (b: LoadedTile['box'], x: number, z: number): number => Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));

  async function loadTile(x: number, y: number): Promise<void> {
    const id = `${x}/${y}`;
    loading.add(id);
    try {
      const res = await fetch(tileUrl(await tileTemplate(), TILE_ZOOM, x, y), { signal: abort.signal });
      if (destroyed) return;
      let world: TileWorld = { buildings: [], roads: [], named: [], water: [], waterLines: [], areas: [] };
      if (res.ok) world = buildTileWorld(decodeTile(new Uint8Array(await res.arrayBuffer())), TILE_ZOOM, x, y, origin);
      if (destroyed) return;
      const group = new three.Group();
      const cols = new TileColliders();
      for (const b of world.buildings) cols.addBuilding(b.rings);
      for (const w of world.water) cols.addWater(w.rings);
      for (const l of world.waterLines) cols.addWaterLine(l.pts, l.width);
      colliders.set(id, cols);
      scene.add(group);
      const cells = bucketTile(world);
      // Squares that hold only a park or water still need their ground painted.
      const reach = (rings: Pt[][], pad = 0): void => {
        let minX = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxZ = -Infinity;
        for (const ring of rings) {
          for (const p of ring) {
            minX = Math.min(minX, p[0]);
            maxX = Math.max(maxX, p[0]);
            minZ = Math.min(minZ, p[1]);
            maxZ = Math.max(maxZ, p[1]);
          }
        }
        if (!Number.isFinite(minX)) return;
        for (let cx = Math.floor((minX - pad) / CELL_M); cx <= Math.floor((maxX + pad) / CELL_M); cx++) {
          for (let cz = Math.floor((minZ - pad) / CELL_M); cz <= Math.floor((maxZ + pad) / CELL_M); cz++) {
            if (cells.size < 900 && !cells.has(`${cx},${cz}`)) cells.set(`${cx},${cz}`, { buildings: [], roads: [] });
          }
        }
      };
      for (const a of world.areas) reach(a.rings);
      for (const a of world.water) reach(a.rings);
      for (const l of world.waterLines) reach([l.pts], l.width);
      const named = world.named.map((n) => {
        let minX = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxZ = -Infinity;
        for (const [px, pz] of n.pts) {
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minZ = Math.min(minZ, pz);
          maxZ = Math.max(maxZ, pz);
        }
        return { n, box: [minX - 25, minZ - 25, maxX + 25, maxZ + 25] as [number, number, number, number] };
      });
      tiles.set(id, { id, x, y, world, cells, named, group, box: tileBox(x, y) });
    } catch {
      failed.set(id, Date.now());
    } finally {
      loading.delete(id);
    }
  }

  function manageTiles(): void {
    const { x, z } = here();
    const [lng, lat] = fromLocal(origin, x, z);
    const c = tileOf(lng, lat);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tx = c.x + dx;
        const ty = c.y + dy;
        const id = `${tx}/${ty}`;
        if (tiles.has(id) || loading.has(id) || loading.size >= 2) continue;
        if ((failed.get(id) ?? 0) > Date.now() - 20_000) continue;
        if (distToBox(tileBox(tx, ty), x, z) <= LOAD_RADIUS_M) void loadTile(tx, ty);
      }
    }
    for (const t of [...tiles.values()]) {
      if (distToBox(t.box, x, z) > UNLOAD_RADIUS_M) {
        scene.remove(t.group);
        disposeGroup(t.group);
        colliders.remove(t.id);
        for (const key of [...built.keys()]) {
          if (key.startsWith(t.id + '|')) {
            const g = built.get(key)!;
            scene.remove(g);
            disposeGroup(g);
            built.delete(key);
          }
        }
        tiles.delete(t.id);
      }
    }
  }

  function manageCells(maxNew = 2): void {
    const { x, z } = here();
    let made = 0;
    for (const t of tiles.values()) {
      for (const [key, cell] of t.cells) {
        const id = `${t.id}|${key}`;
        const [cx, cz] = cellCentre(key);
        const d = Math.hypot(cx - x, cz - z);
        const have = built.get(id);
        if (!have && d < BUILD_RADIUS_M && made < maxNew) {
          const g = buildSquare(t, key, cell);
          scene.add(g);
          built.set(id, g);
          made++;
        } else if (have && d > DROP_RADIUS_M) {
          scene.remove(have);
          disposeGroup(have);
          built.delete(id);
        }
      }
    }
  }

  function disposeGroup(g: T.Object3D): void {
    g.traverse((o) => {
      const m = o as T.Mesh;
      if (m.geometry && !sharedGeos.has(m.geometry)) m.geometry.dispose();
      // A square's own ground picture is freed with it.
      if (m.userData.ownMap) {
        const mat = m.material as T.MeshLambertMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
      if ((m as T.InstancedMesh).isInstancedMesh) (m as T.InstancedMesh).dispose();
    });
  }

  /** Everything in one 200 m square: its painted ground, its buildings with windows, its trees and its lamps. */
  function buildSquare(t: LoadedTile, key: string, cell: Cell): T.Group {
    const g = new three.Group();
    const sq = squareOf(key);
    // The ground, painted like a street map seen from above (half a metre to the pixel).
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      paintGround(ctx, size, key, t.world);
      const tex = new three.CanvasTexture(canvas);
      tex.colorSpace = three.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.generateMipmaps = true;
      tex.minFilter = three.LinearMipmapLinearFilter;
      const plane = new three.Mesh(new three.PlaneGeometry(CELL_M, CELL_M), new three.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(sq.x0 + CELL_M / 2, 0.03, sq.z0 + CELL_M / 2);
      plane.renderOrder = 1;
      plane.userData.ownMap = true;
      g.add(plane);
    }
    const parts = buildingParts(three, cell.buildings, city.tint[0]);
    if (parts.walls) g.add(new three.Mesh(parts.walls, wallMaterial));
    if (parts.roofs) g.add(new three.Mesh(parts.roofs, roofMaterial));
    const blocked = (x: number, z: number): boolean => colliders.insideBuilding(x, z) || colliders.inWater(x, z);
    const trees = treesFor(key, t.world, blocked);
    if (trees.length) {
      const trunks = new three.InstancedMesh(trunkGeo, trunkMat, trees.length);
      const crowns = new three.InstancedMesh(crownGeo, crownMat, trees.length);
      const m4 = new three.Matrix4();
      const colour = new three.Color();
      trees.forEach((p, i) => {
        m4.makeScale(p.s, p.s * (0.9 + p.v * 0.3), p.s);
        m4.setPosition(p.x, 0, p.z);
        trunks.setMatrixAt(i, m4);
        crowns.setMatrixAt(i, m4);
        crowns.setColorAt(i, colour.setHSL(0.27 + p.v * 0.07, 0.45, 0.24 + p.v * 0.12));
      });
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
      for (const im of [trunks, crowns]) {
        im.instanceMatrix.needsUpdate = true;
        im.frustumCulled = false;
        g.add(im);
      }
    }
    const lamps = lampsFor(key, t.world, blocked);
    if (lamps.length) {
      const poles = new three.InstancedMesh(poleGeo, poleMat, lamps.length);
      const heads = new three.InstancedMesh(lampHeadGeo, poleMat, lamps.length);
      const m4 = new three.Matrix4();
      lamps.forEach((p, i) => {
        m4.makeRotationY(hashAngle(p.x, p.z));
        m4.setPosition(p.x, 0, p.z);
        poles.setMatrixAt(i, m4);
        heads.setMatrixAt(i, m4);
      });
      for (const im of [poles, heads]) {
        im.frustumCulled = false;
        g.add(im);
      }
    }
    return g;
  }
  const hashAngle = (x: number, z: number): number => Math.floor(Math.abs(Math.sin(x * 0.37 + z * 0.91) * 4)) * (Math.PI / 2);

  // ------------------------------------------------------------ vehicles: parked cars wherever there are streets, and boats at the water
  function nearestRoadPoint(x: number, z: number, within: number): { x: number; z: number; heading: number; width: number } | null {
    let best: { x: number; z: number; heading: number; width: number; d: number } | null = null;
    for (const t of tiles.values()) {
      if (distToBox(t.box, x, z) > within) continue;
      for (const [key, cell] of t.cells) {
        const [cx, cz] = cellCentre(key);
        if (Math.hypot(cx - x, cz - z) > within + 150) continue;
        for (const r of cell.roads) {
          if (r.cls === 'path' || r.cls === 'track' || r.cls === 'pier') continue;
          const a = r.pts[0]!;
          const b = r.pts[1]!;
          const n = nearestOnSegment(x, z, a[0], a[1], b[0], b[1]);
          if (n.d <= within && (!best || n.d < best.d)) best = { x: n.px, z: n.pz, heading: Math.atan2(b[0] - a[0], -(b[1] - a[1])), width: r.width, d: n.d };
        }
      }
    }
    return best;
  }

  const CAR_COLOURS: [string, string][] = [['#f2c200', 'Taxi'], ['#1d1d1f', 'Car'], ['#c0392b', 'Car'], ['#e8e8e8', 'Car'], ['#2e6fb7', 'Car']];
  let spawned = 0;
  function spawnCar(x: number, z: number, heading: number): Rig {
    const [colour, name] = CAR_COLOURS[spawned++ % CAR_COLOURS.length]!;
    const mesh = carMesh(colour);
    scene.add(mesh);
    const rig: Rig = { spec: CAR, kind: 'car', state: { x, z, heading, speed: 0 }, mesh, name };
    rigs.push(rig);
    return rig;
  }
  function spawnBoat(x: number, z: number, heading: number): Rig {
    const mesh = boatMesh();
    scene.add(mesh);
    const rig: Rig = { spec: BOAT, kind: 'boat', state: { x, z, heading, speed: 0 }, mesh, name: 'Boat' };
    rigs.push(rig);
    return rig;
  }
  function freeSpot(x: number, z: number, r: number): { x: number; z: number } | null {
    const p = colliders.resolve(x, z, r);
    return p.hit || colliders.inWater(p.x, p.z) ? null : p;
  }

  let lastSpawnCheck = 0;
  function manageVehicles(now: number): void {
    if (now - lastSpawnCheck < 2500) return;
    lastSpawnCheck = now;
    const { x, z } = here();
    // Keep a few vehicles near the player: a car at the nearest street, and a boat if the water is close.
    const near = (kind: 'car' | 'boat', d: number): boolean => rigs.some((r) => r.kind === kind && r !== driving && Math.hypot(r.state.x - x, r.state.z - z) < d);
    if (!near('car', 140) && !(driving && driving.kind === 'car')) {
      const road = nearestRoadPoint(x, z, 200);
      if (road) {
        const side = road.width / 2 + 1.6;
        const spot = freeSpot(road.x + Math.cos(road.heading) * side, road.z + Math.sin(road.heading) * side, CAR.radius);
        if (spot && Math.hypot(spot.x - x, spot.z - z) > 10) spawnCar(spot.x, spot.z, road.heading);
      }
    }
    if (!near('boat', 220) && !(driving && driving.kind === 'boat')) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        for (const d of [14, 26, 44]) {
          const px = x + Math.sin(ang) * d;
          const pz = z - Math.cos(ang) * d;
          if (colliders.inWater(px, pz) && !colliders.insideBuilding(px, pz) && colliders.inWater(px + 6, pz) && colliders.inWater(px, pz + 6)) {
            spawnBoat(px, pz, ang);
            a = 99;
            break;
          }
        }
      }
    }
    // Forget unused vehicles that have been left far behind.
    for (let i = rigs.length - 1; i >= 0; i--) {
      const r = rigs[i]!;
      if (r !== driving && Math.hypot(r.state.x - x, r.state.z - z) > 900) {
        scene.remove(r.mesh);
        disposeGroup(r.mesh);
        rigs.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------ treasure zones the server says this player has unlocked
  async function loadZones(): Promise<void> {
    try {
      const list = await api.zones();
      if (destroyed) return;
      zoneGroup.clear();
      zones = list.map((zone) => {
        const [x, z] = toLocal(origin, zone.lng, zone.lat);
        const beacon = new three.Group();
        const pillar = new three.Mesh(new three.CylinderGeometry(2.4, 2.4, 160, 14, 1, true), new three.MeshBasicMaterial({ color: '#2dd36f', transparent: true, opacity: 0.35, side: three.DoubleSide, depthWrite: false }));
        pillar.position.y = 80;
        const ring = new three.Mesh(new three.RingGeometry(Math.max(1, zone.radiusM - 1.2), zone.radiusM, 48), new three.MeshBasicMaterial({ color: '#2dd36f', transparent: true, opacity: 0.6, side: three.DoubleSide, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.3;
        beacon.add(pillar, ring);
        beacon.position.set(x, 0, z);
        zoneGroup.add(beacon);
        return { zone, x, z, beacon };
      });
    } catch {
      // the zones stay as they were
    }
  }

  // ------------------------------------------------------------ the city's landmarks: pale pillars with their names
  for (const m of city.landmarks) {
    const [x, z] = toLocal(origin, m.lng, m.lat);
    const pillar = new three.Mesh(new three.CylinderGeometry(1.4, 1.8, 90, 10), new three.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55 }));
    pillar.position.set(x, 45, z);
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    const g = c.getContext('2d');
    if (g) {
      g.font = '600 40px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 9;
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.strokeText(m.name, 256, 48);
      g.fillStyle = '#fff';
      g.fillText(m.name, 256, 48);
    }
    const sprite = new three.Sprite(new three.SpriteMaterial({ map: new three.CanvasTexture(c), transparent: true, depthTest: false }));
    sprite.scale.set(54, 10, 1);
    sprite.position.set(x, 100, z);
    sprite.renderOrder = 8;
    scene.add(pillar, sprite);
  }

  // ------------------------------------------------------------ input
  const onKey = (down: boolean) => (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if (!KEY_NAMES.includes(k) && k !== 'e' && k !== 'f') return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (k === 'e') {
      if (down && !e.repeat) pressE = true;
    } else if (k === 'f') {
      if (down && !e.repeat) toggleFullscreen();
    } else if (down) keys.add(k);
    else keys.delete(k);
    e.preventDefault();
  };
  const keyDown = onKey(true);
  const keyUp = onKey(false);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  const blur = (): void => keys.clear();
  window.addEventListener('blur', blur);

  let dragging: { id: number; x: number; y: number } | null = null;
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && e.clientX - dom.getBoundingClientRect().left < dom.clientWidth * 0.4) return; // that side is the stick
    dragging = { id: e.pointerId, x: e.clientX, y: e.clientY };
    dom.setPointerCapture(e.pointerId);
    dom.focus();
  });
  dom.addEventListener('pointermove', (e) => {
    if (!dragging || dragging.id !== e.pointerId) return;
    camYaw += (e.clientX - dragging.x) * 0.006;
    camPitch = Math.max(0.12, Math.min(1.15, camPitch + (e.clientY - dragging.y) * 0.004));
    dragging.x = e.clientX;
    dragging.y = e.clientY;
    lastLook = performance.now();
  });
  const endDrag = (e: PointerEvent): void => {
    if (dragging && dragging.id === e.pointerId) dragging = null;
  };
  dom.addEventListener('pointerup', endDrag);
  dom.addEventListener('pointercancel', endDrag);

  // Touch screens: a stick on the left and buttons on the right.
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (touch) {
    help.style.display = 'none';
    const pad = document.createElement('div');
    pad.style.cssText = 'position:absolute;left:18px;bottom:22px;width:132px;height:132px;border-radius:50%;background:rgba(255,255,255,.12);border:2px solid rgba(255,255,255,.5);touch-action:none';
    const knob = document.createElement('div');
    knob.style.cssText = 'position:absolute;left:41px;top:41px;width:50px;height:50px;border-radius:50%;background:rgba(255,255,255,.7)';
    pad.append(knob);
    wrap.append(pad);
    let id = -1;
    const move = (e: PointerEvent): void => {
      const r = pad.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / 50;
      const dy = (e.clientY - (r.top + r.height / 2)) / 50;
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, len);
      stick.x = (dx / len) * k;
      stick.y = (-dy / len) * k;
      knob.style.transform = `translate(${stick.x * 34}px, ${-stick.y * 34}px)`;
    };
    pad.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      pad.setPointerCapture(id);
      move(e);
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId === id) move(e);
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = -1;
      stick.x = 0;
      stick.y = 0;
      knob.style.transform = '';
    };
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    const hold = (label: string, css: string, set: (v: boolean) => void): void => {
      const b = button(label, css, () => undefined);
      b.addEventListener('pointerdown', () => set(true));
      b.addEventListener('pointerup', () => set(false));
      b.addEventListener('pointercancel', () => set(false));
    };
    button('E', 'right:22px;bottom:96px;font-size:20px;padding:16px 22px', () => (pressE = true));
    hold('Run', 'right:22px;bottom:24px;padding:12px 18px', (v) => (touchRun = v));
    hold('Brake', 'right:110px;bottom:24px;padding:12px 18px', (v) => (touchBrake = v));
  }

  // ------------------------------------------------------------ full screen
  let fakeFull = false;
  function toggleFullscreen(): void {
    const on = document.fullscreenElement === wrap || fakeFull;
    if (on) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      fakeFull = false;
      setFull(false);
    } else if (wrap.requestFullscreen) {
      void wrap.requestFullscreen().catch(() => {
        // Some phones do not allow it: fill the page instead.
        fakeFull = true;
        setFull(true);
      });
    } else {
      fakeFull = true;
      setFull(true);
    }
  }
  function setFull(full: boolean): void {
    const f = full || document.fullscreenElement === wrap;
    wrap.style.cssText = f ? 'position:fixed;inset:0;z-index:2147483000;width:100vw;height:100vh;min-height:0;background:#000;border-radius:0;overflow:hidden;user-select:none;touch-action:none' : 'position:relative;width:100%;height:min(78vh,720px);min-height:420px;background:#000;border-radius:16px;overflow:hidden;user-select:none;touch-action:none';
    fsButton.textContent = f ? 'Exit full screen' : 'Full screen';
    resize();
  }
  const onFullChange = (): void => {
    if (!document.fullscreenElement && !fakeFull) setFull(false);
    else setFull(true);
  };
  document.addEventListener('fullscreenchange', onFullChange);
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && fakeFull) {
      fakeFull = false;
      setFull(false);
    }
  };
  window.addEventListener('keydown', onEsc);

  function resize(): void {
    const w = Math.max(280, wrap.clientWidth);
    const h = Math.max(240, wrap.clientHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(wrap);
  resize();

  // ------------------------------------------------------------ the server: where the player is, and collecting
  let syncing = false;
  let lastSent = { x: foot.x, z: foot.z };
  let lastSync = 0;
  async function sync(force = false): Promise<void> {
    if (syncing) return;
    const p = here();
    if (!force && Math.hypot(p.x - lastSent.x, p.z - lastSent.z) < 0.5) return;
    syncing = true;
    const sent = { x: p.x, z: p.z };
    try {
      const [lng, lat] = fromLocal(origin, p.x, p.z);
      const r = await api.sync(lng, lat, mode());
      if (destroyed) return;
      if (r.ok) lastSent = sent;
      else if (r.position) {
        // The server put the player back: take the position it holds.
        const [x, z] = toLocal(origin, r.position[0], r.position[1]);
        const target = driving ? driving.state : foot;
        target.x = x;
        target.z = z;
        if (driving) driving.state.speed = 0;
        else {
          foot.vx = 0;
          foot.vz = 0;
        }
        lastSent = { x, z };
        say(r.message ?? 'You moved too fast, so you were put back.');
      } else if (r.message) say(r.message);
    } catch {
      // try again at the next report
    } finally {
      syncing = false;
    }
  }

  // ------------------------------------------------------------ interaction: get in and out, collect
  function interact(): void {
    if (driving) {
      const v = driving;
      for (let a = 0; a < 8; a++) {
        const ang = v.state.heading + Math.PI / 2 + (a % 2 ? 1 : -1) * Math.floor(a / 2) * 0.8;
        const d = v.kind === 'boat' ? 4 : 2.6;
        const spot = freeSpot(v.state.x + Math.sin(ang) * d, v.state.z - Math.cos(ang) * d, 0.6);
        if (spot) {
          foot.x = spot.x;
          foot.z = spot.z;
          foot.vx = 0;
          foot.vz = 0;
          driving = null;
          v.state.speed = 0;
          return;
        }
      }
      say(v.kind === 'boat' ? 'There is no shore close enough to step out onto.' : 'There is no room to get out here.');
      return;
    }
    const zone = zones.find((z) => Math.hypot(z.x - foot.x, z.z - foot.z) <= z.zone.radiusM);
    if (zone) {
      void (async () => {
        await sync(true);
        const r = await api.collect(zone.zone.id).catch(() => ({ ok: false, message: 'That did not work. Try again.' }));
        say(r.message, 7000);
        await loadZones();
      })();
      return;
    }
    let best: Rig | null = null;
    let bestD = 4.8;
    for (const r of rigs) {
      const d = Math.hypot(r.state.x - foot.x, r.state.z - foot.z);
      if (d < bestD) {
        best = r;
        bestD = d;
      }
    }
    if (best) {
      driving = best;
      camYaw = best.state.heading;
    }
  }

  function promptText(): string {
    if (driving) return `Press E to get out of the ${driving.name.toLowerCase()}`;
    const zone = zones.find((z) => Math.hypot(z.x - foot.x, z.z - foot.z) <= z.zone.radiusM);
    if (zone) return `Press E to collect the ${zone.zone.coin}`;
    let best: Rig | null = null;
    let bestD = 4.8;
    for (const r of rigs) {
      const d = Math.hypot(r.state.x - foot.x, r.state.z - foot.z);
      if (d < bestD) {
        best = r;
        bestD = d;
      }
    }
    return best ? `Press E to get in the ${best.name.toLowerCase()}` : '';
  }

  // ------------------------------------------------------------ the heads-up display
  function streetName(x: number, z: number): string {
    let best = { d: 26, name: '' };
    for (const t of tiles.values()) {
      if (distToBox(t.box, x, z) > 40) continue;
      for (const { n, box: b } of t.named) {
        if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
        for (let i = 1; i < n.pts.length; i++) {
          const d = nearestOnSegment(x, z, n.pts[i - 1]![0], n.pts[i - 1]![1], n.pts[i]![0], n.pts[i]![1]).d;
          if (d < best.d) best = { d, name: n.name };
        }
      }
    }
    return best.name;
  }

  function nearestLandmark(x: number, z: number): { name: string; d: number } | null {
    let best: { name: string; d: number } | null = null;
    for (const m of city.landmarks) {
      const [lx, lz] = toLocal(origin, m.lng, m.lat);
      const d = Math.hypot(lx - x, lz - z);
      if (!best || d < best.d) best = { name: m.name, d };
    }
    return best;
  }

  const mctx = mini.getContext('2d');
  function drawMini(): void {
    if (!mctx) return;
    const { x, z } = here();
    const S = 176;
    const scale = S / 560; // 560 m across
    const sx2 = (wx: number): number => S / 2 + (wx - x) * scale;
    const sz2 = (wz: number): number => S / 2 + (wz - z) * scale;
    mctx.fillStyle = '#121212';
    mctx.fillRect(0, 0, S, S);
    for (const t of tiles.values()) {
      if (distToBox(t.box, x, z) > 320) continue;
      mctx.fillStyle = '#1b3b52';
      for (const w of t.world.water) {
        mctx.beginPath();
        for (const ring of w.rings) ring.forEach((p, i) => (i === 0 ? mctx.moveTo(sx2(p[0]), sz2(p[1])) : mctx.lineTo(sx2(p[0]), sz2(p[1]))));
        mctx.fill('evenodd');
      }
      mctx.strokeStyle = '#1b3b52';
      for (const l of t.world.waterLines) {
        mctx.lineWidth = Math.max(1, l.width * scale);
        mctx.beginPath();
        l.pts.forEach((p, i) => (i === 0 ? mctx.moveTo(sx2(p[0]), sz2(p[1])) : mctx.lineTo(sx2(p[0]), sz2(p[1]))));
        mctx.stroke();
      }
      mctx.strokeStyle = '#8a8a8a';
      for (const [key, cell] of t.cells) {
        const [cx, cz] = cellCentre(key);
        if (Math.abs(cx - x) > 380 || Math.abs(cz - z) > 380) continue;
        for (const r of cell.roads) {
          mctx.lineWidth = Math.max(1, r.width * scale * 1.4);
          mctx.beginPath();
          mctx.moveTo(sx2(r.pts[0]![0]), sz2(r.pts[0]![1]));
          mctx.lineTo(sx2(r.pts[1]![0]), sz2(r.pts[1]![1]));
          mctx.stroke();
        }
      }
    }
    mctx.fillStyle = '#ffffff';
    for (const m of city.landmarks) {
      const [lx, lz] = toLocal(origin, m.lng, m.lat);
      if (Math.abs(lx - x) < 300 && Math.abs(lz - z) < 300) {
        mctx.beginPath();
        mctx.moveTo(sx2(lx), sz2(lz) - 4);
        mctx.lineTo(sx2(lx) + 4, sz2(lz));
        mctx.lineTo(sx2(lx), sz2(lz) + 4);
        mctx.lineTo(sx2(lx) - 4, sz2(lz));
        mctx.fill();
      }
    }
    mctx.fillStyle = '#e9c46a';
    for (const r of rigs) if (r !== driving) mctx.fillRect(sx2(r.state.x) - 2, sz2(r.state.z) - 2, 4, 4);
    for (const zn of zones) {
      let tx = sx2(zn.x);
      let tz = sz2(zn.z);
      const edge = S / 2 - 8;
      const dx = tx - S / 2;
      const dz = tz - S / 2;
      const len = Math.hypot(dx, dz);
      if (len > edge) {
        tx = S / 2 + (dx / len) * edge;
        tz = S / 2 + (dz / len) * edge;
      }
      mctx.fillStyle = '#2dd36f';
      mctx.beginPath();
      mctx.arc(tx, tz, 5, 0, Math.PI * 2);
      mctx.fill();
    }
    // The player, as an arrow pointing the way they face.
    const heading = driving ? driving.state.heading : foot.heading;
    mctx.save();
    mctx.translate(S / 2, S / 2);
    mctx.rotate(heading);
    mctx.fillStyle = '#ffffff';
    mctx.strokeStyle = '#000000';
    mctx.lineWidth = 1.5;
    mctx.beginPath();
    mctx.moveTo(0, -9);
    mctx.lineTo(6, 7);
    mctx.lineTo(0, 3);
    mctx.lineTo(-6, 7);
    mctx.closePath();
    mctx.fill();
    mctx.stroke();
    mctx.restore();
  }

  let hudAt = 0;
  function updateHud(now: number): void {
    if (now - hudAt < 120) return;
    hudAt = now;
    const p = here();
    const kmh = driving ? Math.abs(driving.state.speed) * 3.6 : Math.hypot(foot.vx, foot.vz) * 3.6;
    const m = mode();
    status.textContent = `${m === 'walk' ? 'Walking' : m === 'run' ? 'Running' : m === 'car' ? driving!.name : 'Boat'} · ${Math.round(kmh)} km/h`;
    const street = streetName(p.x, p.z);
    const lm = nearestLandmark(p.x, p.z);
    place.textContent = street || (lm && lm.d < 400 ? `Near ${lm.name}` : city.name);
    const text = promptText();
    prompt.textContent = text;
    prompt.style.display = text ? 'block' : 'none';
    const zn = zones[0];
    if (zn && !driving) {
      const d = Math.hypot(zn.x - p.x, zn.z - p.z);
      if (d > zn.zone.radiusM) status.textContent += ` · treasure ${d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'} away`;
    }
    drawMini();
  }

  // ------------------------------------------------------------ the loop
  let last = performance.now();
  let raf = 0;
  const camPos = new three.Vector3();
  const camLook = new three.Vector3();
  let started = false;
  const helpUntil = performance.now() + 14_000;
  function frame(now: number): void {
    if (destroyed) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;

    // Camera turning with the arrow keys.
    if (keys.has('arrowleft')) camYaw -= 1.8 * dt;
    if (keys.has('arrowright')) camYaw += 1.8 * dt;
    if (keys.has('arrowup')) camPitch = Math.max(0.12, camPitch - 0.9 * dt);
    if (keys.has('arrowdown')) camPitch = Math.min(1.15, camPitch + 0.9 * dt);

    const ix = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0) + stick.x;
    const iy = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0) + stick.y;
    if (pressE) {
      pressE = false;
      interact();
    }
    if (driving) {
      stepVehicle(driving.state, { throttle: Math.max(-1, Math.min(1, iy)), steer: Math.max(-1, Math.min(1, ix)), handbrake: keys.has(' ') || touchBrake }, driving.spec, dt, colliders);
      // The camera drifts round behind the vehicle unless the player has just looked around.
      if (now - lastLook > 1800) {
        let diff = driving.state.heading - camYaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        camYaw += diff * Math.min(1, 2.2 * dt);
      }
    } else {
      const fx = Math.sin(camYaw);
      const fz = -Math.cos(camYaw);
      stepFoot(foot, { dx: fx * iy + Math.cos(camYaw) * ix, dz: fz * iy + Math.sin(camYaw) * ix, run: keys.has('shift') || touchRun }, dt, colliders);
    }
    // Keep everyone inside the city.
    const p = here();
    if (p.x < west || p.x > east || p.z < north || p.z > south) {
      p.x = Math.max(west, Math.min(east, p.x));
      p.z = Math.max(north, Math.min(south, p.z));
      if (driving) driving.state.speed *= 0.3;
    }

    // Draw the person, the vehicles and the camera.
    const walking = Math.hypot(foot.vx, foot.vz);
    person.visible = !driving;
    person.position.set(foot.x, 0, foot.z);
    person.rotation.y = -foot.heading;
    human.update(dt, walking, walking > 3.6);
    for (const r of rigs) {
      r.mesh.position.set(r.state.x, r.kind === 'boat' ? 0.05 + Math.sin(now / 500 + r.state.x) * 0.06 : 0, r.state.z);
      r.mesh.rotation.y = -r.state.heading;
    }
    const target = here();
    const dist = driving ? (driving.kind === 'boat' ? 13 : 10.5) : 6.2;
    const lift = driving ? 1.8 : 1.5;
    let d = dist;
    for (let i = 0; i < 6; i++) {
      camPos.set(target.x - Math.sin(camYaw) * d * Math.cos(camPitch), lift + d * Math.sin(camPitch), target.z + Math.cos(camYaw) * d * Math.cos(camPitch));
      if (!colliders.insideBuilding(camPos.x, camPos.z) || camPos.y > 70) break;
      d *= 0.72;
    }
    camera.position.lerp(camPos, started ? Math.min(1, 12 * dt) : 1);
    camLook.set(target.x, driving ? 1.2 : 1.5, target.z);
    camera.lookAt(camLook);
    ground.position.set(target.x, 0, target.z);
    started = true;

    // Make sure the beacon pillars pulse, and keep the world loading and the server told.
    const pulse = 0.28 + Math.sin(now / 400) * 0.08;
    for (const zn of zones) ((zn.beacon.children[0] as T.Mesh).material as T.MeshBasicMaterial).opacity = pulse;
    manageTiles();
    manageCells();
    manageVehicles(now);
    if (now - lastSync > SYNC_MS) {
      lastSync = now;
      void sync();
    }
    updateHud(now);
    if (help.style.display !== 'none' && now > helpUntil) help.style.opacity = '0.35';
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  // Start: put the player on the street, in a place that is free, once the first streets are in.
  void (async () => {
    await loadZones();
    manageTiles();
    const until = Date.now() + 8000;
    while (!destroyed && Date.now() < until && !(tiles.size > 0 && loading.size === 0)) await new Promise((r) => setTimeout(r, 120));
    if (destroyed) return;
    manageCells(40);
    const free = colliders.resolve(foot.x, foot.z, 0.6);
    foot.x = free.x;
    foot.z = free.z;
    for (let i = 0; i < 8 && colliders.inWater(foot.x, foot.z); i++) {
      const road = nearestRoadPoint(foot.x, foot.z, 400 * (i + 1));
      if (road) {
        foot.x = road.x;
        foot.z = road.z;
      }
    }
    camPos.set(foot.x, 3, foot.z + 6);
    camera.position.copy(camPos);
    started = false;
  })();
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      destroyed = true;
      abort.abort();
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('keydown', onEsc);
      window.removeEventListener('blur', blur);
      document.removeEventListener('fullscreenchange', onFullChange);
      if (document.fullscreenElement === wrap) void document.exitFullscreen().catch(() => undefined);
      void sync(true);
      scene.traverse((o) => {
        const m = o as T.Mesh;
        m.geometry?.dispose();
        const mat = m.material as T.Material | T.Material[] | undefined;
        for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          (x as T.MeshBasicMaterial).map?.dispose();
          x.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      host.replaceChildren();
    },
  };
}

export { WALK_SPEED, RUN_SPEED };
