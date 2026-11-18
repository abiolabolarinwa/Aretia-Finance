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
import type { RoamMode } from '../roamRules.js';
import { decodeTile } from './mvt.js';
import { buildTileWorld, fromLocal, tileOf, tilePoint, tileUrl, toLocal, TILE_ZOOM, type Named, type Origin, type TileWorld } from './worldData.js';
import { Colliders, TileColliders, nearestOnSegment } from './colliders.js';
import { bucketTile, buildingParts, cellCentre, CELL_M, type Cell } from './roamBuild.js';
import { lampsFor, paintGround, squareOf, treesFor } from './roamDetail.js';
import { makeHuman, type Human, type Look } from './human.js';
import { applyDetail, loadDetail } from './detail.js';
import { loadCharacter, makeAnimatedHuman, seatOffset } from './characters.js';
import { makeStreetPanel } from './streetPanel.js';
import { SoundEngine, saveMuted, savedMuted } from './sound.js';
import { WEATHER_LABEL, WeatherSystem, applyWeather, fogRange, wetness, type WeatherName } from './weather.js';
import { makeRain } from './rain.js';
import { otherLook, PALETTES, saveLook, savedLook, type Palette } from './style.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeAtmosphere } from './atmosphere.js';
import { formatClock, hoursOf, makeClock, mixColours, momentAt } from './daylight.js';
import { makeCar, TRAFFIC_COLOURS, type CarKind, type CarParts } from './vehicles.js';
import { pickNext, startAgent, stepAgent, type Agent, type Seg } from './agents.js';
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
  parts?: CarParts;
}

const KEY_NAMES = ['w', 'a', 's', 'd', 'shift', ' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'];

export async function mountRoam(host: HTMLElement, city: City, startAt: [number, number], api: RoamApi): Promise<RoamHandle | null> {
  const three = await import('three');
  const origin: Origin = { lng: city.center[0], lat: city.center[1] };
  // The look the player chose (bright the first time). Changing it starts the view again with the other look.
  const look: Palette = PALETTES[savedLook()];
  const ui = look.ui;
  const card = `background:${ui.card};border:1px solid ${ui.border};box-shadow:0 2px 10px rgba(0,0,0,.18);`;

  // ------------------------------------------------------------ the page: a canvas with a heads-up display over it
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:100%;height:min(78vh,720px);min-height:420px;background:#000;border-radius:16px;overflow:hidden;user-select:none;touch-action:none';
  const canvasHolder = document.createElement('div');
  canvasHolder.style.cssText = 'position:absolute;inset:0';
  wrap.append(canvasHolder);
  const hud = (css: string, text = ''): HTMLDivElement => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;pointer-events:none;color:${ui.text};font:600 13px system-ui,sans-serif;text-shadow:${ui.shadow};` + css;
    d.textContent = text;
    wrap.append(d);
    return d;
  };
  // In the bright look every readout sits on a white rounded card; in the realistic look text floats with a shadow.
  const pill = look.id === 'bright' ? card + 'padding:7px 14px;border-radius:999px;' : '';
  const status = hud('left:14px;top:12px;font-size:15px;line-height:1.35;' + pill);
  const place = hud('left:50%;top:12px;transform:translateX(-50%);font-size:15px;text-align:center;max-width:40%;' + pill);
  const prompt = hud(`left:50%;bottom:84px;transform:translateX(-50%);font-size:17px;text-align:center;${look.id === 'bright' ? card : 'background:rgba(0,0,0,.55);'}padding:8px 16px;border-radius:999px;display:none`);
  const toast = hud(`left:50%;top:56px;transform:translateX(-50%);text-align:center;max-width:70%;${look.id === 'bright' ? card : 'background:rgba(0,0,0,.6);'}padding:8px 14px;border-radius:${look.id === 'bright' ? '18px' : '12px'};display:none`);
  const help = hud(`left:14px;bottom:14px;font-size:12px;line-height:1.5;${look.id === 'bright' ? card : 'background:rgba(0,0,0,.5);'}padding:8px 12px;border-radius:12px;font-weight:500`, 'W A S D move · Shift run · E get in or out, collect · Space handbrake · drag or ← → look · F full screen · V street photo · T time · R weather · M sound · H horn');
  const mini = document.createElement('canvas');
  mini.width = 176;
  mini.height = 176;
  mini.style.cssText = `position:absolute;right:12px;top:12px;width:132px;height:132px;border-radius:50%;border:3px solid ${look.id === 'bright' ? '#ffffff' : 'rgba(255,255,255,.7)'};box-shadow:0 2px 10px rgba(0,0,0,.25);background:#101010;pointer-events:none`;
  wrap.append(mini);
  const button = (label: string, css: string, on: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = `position:absolute;cursor:pointer;border:1px solid ${ui.border};background:${look.id === 'bright' ? ui.card : 'rgba(0,0,0,.55)'};color:${ui.text};font:700 13px system-ui,sans-serif;border-radius:999px;padding:8px 14px;${look.id === 'bright' ? 'box-shadow:0 2px 10px rgba(0,0,0,.18);' : ''}` + css;
    b.addEventListener('click', on);
    wrap.append(b);
    return b;
  };
  const fsButton = button('Full screen', 'right:12px;top:152px', () => toggleFullscreen());
  fsButton.setAttribute('aria-label', 'Toggle full screen');
  // Mapillary's real photograph of the street where the player is, in a panel (V). It needs the site's Mapillary key.
  const streetPanel = makeStreetPanel(wrap, { token: String(import.meta.env.PUBLIC_MAPILLARY_TOKEN ?? ''), position: () => fromLocal(origin, here().x, here().z) });
  const toggleStreet = (): void => {
    const why = streetPanel.toggle();
    if (why) say(why);
  };
  button('Street photo (V)', 'right:12px;top:190px', toggleStreet).setAttribute('aria-label', 'Show or hide a real street photo');
  // Sound is made in the browser; it starts after the first key press or click, and the choice to mute is remembered (M).
  const sound = new SoundEngine({ muted: savedMuted() });
  const soundLabel = (): string => `Sound: ${sound.isMuted ? 'off' : 'on'} (M)`;
  const soundButton = button(soundLabel(), 'right:12px;top:304px', () => toggleSound());
  soundButton.setAttribute('aria-label', 'Turn the sound on or off');
  function toggleSound(): void {
    sound.unlock();
    sound.setMuted(!sound.isMuted);
    saveMuted(sound.isMuted);
    soundButton.textContent = soundLabel();
  }
  wrap.addEventListener('pointerdown', () => sound.unlock());
  // Picks the weather (R): clear, cloudy, rain, storm, fog, then back to changing by itself.
  function cycleWeather(): void {
    const order: (WeatherName | 'auto')[] = ['clear', 'cloudy', 'rain', 'storm', 'fog', 'auto'];
    const now: WeatherName | 'auto' = weather.isAuto ? 'auto' : weather.name;
    const next = order[(order.indexOf(now) + 1) % order.length]!;
    weather.set(next);
    say(next === 'auto' ? 'Weather: it will change by itself' : `Weather: ${WEATHER_LABEL[next]}`, 2500);
  }
  button('Weather (R)', 'right:12px;top:342px', cycleWeather).setAttribute('aria-label', 'Change the weather');
  // Skips three game hours, to see the evening, the night or the morning (T).
  button('Time +3 h (T)', 'right:12px;top:266px', () => clock.skip(3)).setAttribute('aria-label', 'Skip three hours of game time');
  // Switches between the bright and the realistic look: remembered, and the view starts again with the new look.
  button(`Look: ${look.label} (switch)`, 'right:12px;top:228px', () => {
    saveLook(otherLook(look.id));
    host.dispatchEvent(new CustomEvent('game-roam-restyle'));
  }).setAttribute('aria-label', 'Switch between the bright and the realistic look');
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
  // Light and air for the chosen look: a tone curve so bright things glow instead of clipping, soft shadows, haze that matches the sky.
  renderer.toneMapping = look.tone.filmic ? three.ACESFilmicToneMapping : three.NoToneMapping;
  renderer.toneMappingExposure = look.tone.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = three.PCFSoftShadowMap;
  const scene = new three.Scene();
  scene.background = new three.Color(look.sky.haze);
  scene.fog = new three.Fog(look.sky.haze, look.fog[0], look.fog[1]);
  const camera = new three.PerspectiveCamera(look.camera.fov, 1, 0.3, 1500);
  const air = makeAtmosphere(three, renderer, look);
  scene.add(air.dome);
  scene.environment = air.environment;
  scene.environmentIntensity = look.light.env;
  const hemi = new three.HemisphereLight(look.light.hemiSky, look.light.hemiGround, look.light.hemi);
  scene.add(hemi);
  // The time of day: starts at the player's own local hour and runs fast (a day in about 24 minutes of play).
  const clock = makeClock(hoursOf(new Date()));
  let moment = momentAt(clock.hours(), look.sky);
  // Weather: changes by itself every few minutes (mostly clear), or held by the player (R). Rain is drawn around the camera.
  const weather = new WeatherSystem();
  let weatherNow = weather.update(0);
  let wet = 0;
  let wetApplied = -1;
  const rain = makeRain(three);
  scene.add(rain.object);
  const sun = new three.DirectionalLight(look.sky.sun, look.light.sun);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const SH = 120;
  Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 10, far: 520 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  // Headlights of the car the player drives: one soft beam, only in the dark.
  const beam = new three.SpotLight('#fff1c9', 0, 80, 0.55, 0.7, 1);
  beam.visible = false;
  scene.add(beam, beam.target);
  /** Marks a thing as casting and receiving the sun's shadows. */
  const shadowed = (o: T.Object3D, cast = true, receive = true): void => {
    o.traverse((c) => {
      const m = c as T.Mesh;
      if (m.isMesh) {
        m.castShadow = cast;
        m.receiveShadow = receive;
      }
    });
  };
  // Real photographed surfaces (free CC0 textures) add the fine grain; the map still decides the colours and where things are.
  const textureBase = String(import.meta.env.BASE_URL ?? '/').replace(/\/?$/, '/');
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 7000));
  // The rigged, animated person (free CC0 model); the hand-built figure is the fallback if it cannot be loaded.
  const characterLoading = Promise.race([loadCharacter(three, `${textureBase}game/models/man.glb`), timeout]);
  // The bright look is clean and flat-coloured, so it does not load them at all.
  const [asphaltTex, pavementTex, plasterTex, concreteTex] = look.photoDetail ? await Promise.all(['asphalt', 'pavement', 'plaster', 'concrete'].map((n) => Promise.race([loadDetail(three, `${textureBase}game/textures/${n}.jpg`, renderer), timeout]))) : [null, null, null, null];
  // The plain ground under everything the map paints: soft green in the bright look, dusty pavement in the realistic one.
  const groundMaterial = new three.MeshLambertMaterial({ color: look.ground });
  if (pavementTex) applyDetail(three, groundMaterial, { detail: pavementTex, mode: 'world', scale: 1 / 3, strength: 0.8, near: 40, far: 170 });
  const ground = new three.Mesh(new three.PlaneGeometry(9000, 9000), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Walls take a window picture (one bay wide, one storey tall) multiplied by each building's tint; roofs are plain.
  const windows = document.createElement('canvas');
  windows.width = 128;
  windows.height = 128;
  const wg = windows.getContext('2d');
  if (wg) {
    const wp = look.buildings.window;
    wg.fillStyle = wp.wall;
    wg.fillRect(0, 0, 128, 128);
    wg.fillStyle = wp.slab;
    wg.fillRect(0, 118, 128, 10); // the floor slab
    wg.fillStyle = wp.frame;
    wg.fillRect(28, 26, 72, 70); // frame
    const glass = wg.createLinearGradient(0, 30, 0, 92);
    glass.addColorStop(0, wp.glassTop);
    glass.addColorStop(1, wp.glassBottom);
    wg.fillStyle = glass;
    wg.fillRect(32, 30, 64, 62);
    wg.fillStyle = wp.frame;
    wg.fillRect(62, 30, 4, 62);
    wg.fillStyle = wp.sill;
    wg.fillRect(24, 96, 80, 5); // sill
  }
  const windowTexture = new three.CanvasTexture(windows);
  windowTexture.wrapS = three.RepeatWrapping;
  windowTexture.wrapT = three.RepeatWrapping;
  windowTexture.colorSpace = three.SRGBColorSpace;
  windowTexture.anisotropy = 4;
  // At night the windows glow: the same picture with only the glass lit, used as the wall's emission and faded in with the dark.
  const lit = document.createElement('canvas');
  lit.width = 128;
  lit.height = 128;
  const lg = lit.getContext('2d');
  if (lg) {
    lg.fillStyle = '#000000';
    lg.fillRect(0, 0, 128, 128);
    lg.fillStyle = '#ffffff';
    lg.fillRect(32, 30, 64, 62);
  }
  const litTexture = new three.CanvasTexture(lit);
  litTexture.wrapS = three.RepeatWrapping;
  litTexture.wrapT = three.RepeatWrapping;
  litTexture.colorSpace = three.SRGBColorSpace;
  const wallMaterial = new three.MeshLambertMaterial({ vertexColors: true, map: windowTexture, emissive: '#ffcf8a', emissiveMap: litTexture, emissiveIntensity: 0 });
  const roofMaterial = new three.MeshLambertMaterial({ vertexColors: true, side: three.DoubleSide });
  if (plasterTex) applyDetail(three, wallMaterial, { detail: plasterTex, mode: 'uv', scale: 0.5, strength: 0.75, near: 70, far: 320 });
  if (concreteTex) applyDetail(three, roofMaterial, { detail: concreteTex, mode: 'world', scale: 1 / 3, strength: 0.8, near: 60, far: 260 });

  // Trees and street lamps are drawn many at a time from one shape each.
  const trunkGeo = new three.CylinderGeometry(0.14, 0.2, 2.4, 7);
  trunkGeo.translate(0, 1.2, 0);
  // A crown made of several overlapping blobs, so a tree has a ragged outline instead of one round ball.
  const blob = (r: number, x: number, y: number, z: number): T.BufferGeometry => {
    const g = new three.IcosahedronGeometry(r, 1);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const k = 1 + (Math.sin(pos.getX(i) * 7.3 + pos.getY(i) * 5.1 + pos.getZ(i) * 3.7 + x * 11) * 0.5) * 0.18;
      pos.setXYZ(i, pos.getX(i) * k + x, pos.getY(i) * k + y, pos.getZ(i) * k + z);
    }
    g.computeVertexNormals();
    return g.toNonIndexed();
  };
  const crownGeo = mergeGeometries([blob(1.45, 0, 3.7, 0), blob(1.05, 1.0, 3.3, 0.3), blob(1.0, -0.9, 3.4, -0.5), blob(0.95, 0.2, 4.6, 0.6), blob(0.9, -0.3, 3.2, 1.0)])!;
  const poleGeo = new three.CylinderGeometry(0.06, 0.08, 7.2, 6);
  poleGeo.translate(0, 3.6, 0);
  const lampHeadGeo = new three.BoxGeometry(0.9, 0.12, 0.3);
  lampHeadGeo.translate(0.35, 7.25, 0);
  const trunkMat = new three.MeshLambertMaterial({ color: look.tree.trunk });
  const crownMat = new three.MeshLambertMaterial({ color: '#ffffff' });
  const poleMat = new three.MeshLambertMaterial({ color: '#4a4d52' });
  // Street lamp heads glow warmly once it is dark.
  const lampHeadMat = new three.MeshLambertMaterial({ color: '#4a4d52', emissive: '#ffc766', emissiveIntensity: 0 });
  const sharedGeos = new Set<T.BufferGeometry>([trunkGeo, crownGeo, poleGeo, lampHeadGeo]);

  // ------------------------------------------------------------ what the player is: a person, a car, a boat
  const box = (w: number, h: number, d: number, colour: string, x = 0, y = 0, z = 0): T.Mesh => {
    const m = new three.Mesh(new three.BoxGeometry(w, h, d), new three.MeshLambertMaterial({ color: colour }));
    m.position.set(x, y, z);
    return m;
  };
  const character = await characterLoading;
  const newPerson = (appearance?: Look): Human => (character ? makeAnimatedHuman(three, character, appearance) : makeHuman(three, appearance));
  const human = newPerson();
  const person = human.group;
  shadowed(person, true, false);
  scene.add(person);

  const carMesh = (colour: string, kind: CarKind = 'sedan'): CarParts => makeCar(three, colour, kind);
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
  let camPitch = look.camera.pitch;
  let lastThud = 0;
  let lastHeading = 0;
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
      paintGround(ctx, size, key, t.world, look);
      const tex = new three.CanvasTexture(canvas);
      tex.colorSpace = three.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.generateMipmaps = true;
      tex.minFilter = three.LinearMipmapLinearFilter;
      const planeMaterial = new three.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      planeMaterial.color.setScalar(1 - 0.3 * wet); // a square built while it rains starts out wet
      if (asphaltTex) applyDetail(three, planeMaterial, { detail: asphaltTex, mode: 'world', scale: 1 / 2.5, strength: 0.9, near: 35, far: 150 });
      const plane = new three.Mesh(new three.PlaneGeometry(CELL_M, CELL_M), planeMaterial);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(sq.x0 + CELL_M / 2, 0.03, sq.z0 + CELL_M / 2);
      plane.renderOrder = 1;
      plane.userData.ownMap = true;
      g.add(plane);
    }
    const parts = buildingParts(three, cell.buildings, city.tint[0], look);
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
        crowns.setColorAt(i, colour.setHSL(look.tree.hue + p.v * look.tree.hueSpread, look.tree.sat, look.tree.light + p.v * look.tree.lightSpread));
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
      const heads = new three.InstancedMesh(lampHeadGeo, lampHeadMat, lamps.length);
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
    // Everything but the painted ground and lamp heads throws shadows; everything but lamps catches them.
    for (const c of g.children) {
      const m = c as T.Mesh;
      m.castShadow = !m.userData.ownMap;
      m.receiveShadow = true;
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

  const CAR_KINDS: { colour: string; kind: CarKind; name: string }[] = [
    { colour: '#f1b900', kind: 'taxi', name: 'Taxi' },
    { colour: '#1c1c20', kind: 'suv', name: 'SUV' },
    { colour: '#9b1c1c', kind: 'sedan', name: 'Car' },
    { colour: '#e6e6ea', kind: 'sedan', name: 'Car' },
    { colour: '#27456e', kind: 'suv', name: 'SUV' },
  ];
  let spawned = 0;
  function spawnCar(x: number, z: number, heading: number): Rig {
    const spec = CAR_KINDS[spawned++ % CAR_KINDS.length]!;
    const parts = carMesh(spec.colour, spec.kind);
    const mesh = parts.group;
    shadowed(mesh);
    scene.add(mesh);
    const rig: Rig = { spec: CAR, kind: 'car', state: { x, z, heading, speed: 0 }, mesh, name: spec.name, parts };
    rigs.push(rig);
    return rig;
  }
  function spawnBoat(x: number, z: number, heading: number): Rig {
    const mesh = boatMesh();
    shadowed(mesh);
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
        if (r.parts) r.parts.dispose();
        else disposeGroup(r.mesh);
        rigs.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------ everyday life: traffic that drives the streets, and people on the pavements
  interface Npc {
    agent: Agent;
    mesh: T.Group;
    kind: 'car' | 'walker';
    cruise: number;
    human?: Human;
    car?: CarParts;
  }
  const npcs: Npc[] = [];
  const segsNear = (x: number, z: number, r: number, accept: (s: Seg) => boolean): Seg[] => {
    const out: Seg[] = [];
    for (const t of tiles.values()) {
      if (distToBox(t.box, x, z) > r) continue;
      for (const [key, cell] of t.cells) {
        const [cx, cz] = cellCentre(key);
        if (Math.hypot(cx - x, cz - z) > r + 150) continue;
        for (const rd of cell.roads) {
          const s: Seg = { a: rd.pts[0]!, b: rd.pts[1]!, width: rd.width, cls: rd.cls };
          if (accept(s)) out.push(s);
        }
      }
    }
    return out;
  };
  const drivable = (s: Seg): boolean => s.cls !== 'path' && s.cls !== 'track' && s.cls !== 'pier' && s.cls !== 'service' && Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > 0.5;
  const walkable = (s: Seg): boolean => s.cls !== 'motorway' && s.cls !== 'trunk' && s.cls !== 'pier' && Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > 0.5;
  const laneFor = (kind: Npc['kind'], s: Seg): number => (kind === 'car' ? Math.max(1.4, s.width / 4) : s.cls === 'path' || s.cls === 'track' ? 0 : s.width / 2 + 1.4);
  const LOOKS: Look[] = [
    { skin: '#7a4a2f', hair: '#120e0b', top: '#b33a3a', trousers: '#2b3350', shoes: '#e8e8e8' },
    { skin: '#c28a62', hair: '#2a1b12', top: '#e0e0dc', trousers: '#3a3f4a', shoes: '#222222' },
    { skin: '#5a3724', hair: '#0d0a08', top: '#2f6b4f', trousers: '#4a4237', shoes: '#f0f0f0' },
    { skin: '#e0b48f', hair: '#5a3b22', top: '#d9a521', trousers: '#2a2e38', shoes: '#4a3b2e' },
    { skin: '#8d5a3b', hair: '#161210', top: '#3b5b92', trousers: '#c9c2b2', shoes: '#f0f0f0' },
  ];

  function spawnNpc(kind: Npc['kind']): void {
    const p = here();
    const segs = segsNear(p.x, p.z, 260, kind === 'car' ? drivable : walkable).filter((s) => Math.hypot((s.a[0] + s.b[0]) / 2 - p.x, (s.a[1] + s.b[1]) / 2 - p.z) > 40);
    if (!segs.length) return;
    const seg = segs[Math.floor(Math.random() * segs.length)]!;
    const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
    const lane = laneFor(kind, seg);
    const along = Math.random() * len;
    if (kind === 'car') {
      const spec = CAR_KINDS[Math.floor(Math.random() * CAR_KINDS.length)]!;
      const colour = spec.kind === 'taxi' ? spec.colour : TRAFFIC_COLOURS[Math.floor(Math.random() * TRAFFIC_COLOURS.length)]!;
      const car = makeCar(three, colour, spec.kind);
      // Someone is at the wheel, seen through the glass.
      const who = LOOKS[Math.floor(Math.random() * LOOKS.length)]!;
      car.addDummyDriver({ skin: who.skin, hair: who.hair, top: who.top });
      shadowed(car.group);
      scene.add(car.group);
      const cruise = 7 + Math.random() * 6;
      npcs.push({ agent: startAgent(seg, along, cruise, lane), mesh: car.group, kind, cruise, car });
    } else {
      const h = newPerson(LOOKS[Math.floor(Math.random() * LOOKS.length)]!);
      shadowed(h.group, true, false);
      scene.add(h.group);
      const cruise = 1.1 + Math.random() * 0.5;
      npcs.push({ agent: startAgent(seg, along, cruise, lane), mesh: h.group, kind, cruise, human: h });
    }
  }

  function dropNpc(i: number): void {
    const n = npcs[i]!;
    scene.remove(n.mesh);
    n.car?.dispose();
    n.human?.dispose();
    npcs.splice(i, 1);
  }

  // Wheels, body roll and brake lights need to know how the car is turning and speeding up, which is worked out from frame to frame.
  const motion = new WeakMap<object, { h: number; v: number }>();
  function animateCar(key: object, parts: CarParts | undefined, heading: number, speed: number, dt: number): void {
    if (!parts) return;
    const prev = motion.get(key);
    let yawRate = 0;
    let accel = 0;
    if (prev && dt > 0) {
      yawRate = Math.atan2(Math.sin(heading - prev.h), Math.cos(heading - prev.h)) / dt;
      accel = (speed - prev.v) / dt;
    }
    motion.set(key, { h: heading, v: speed });
    parts.animate(dt, speed, Math.max(-4, Math.min(4, yawRate)), Math.max(-30, Math.min(30, accel)));
  }

  let lastNpcSpawn = 0;
  function manageNpcs(now: number, dt: number): void {
    const p = here();
    if (now - lastNpcSpawn > 900) {
      lastNpcSpawn = now;
      if (npcs.filter((n) => n.kind === 'car').length < 9) spawnNpc('car');
      if (npcs.filter((n) => n.kind === 'walker').length < 9) spawnNpc('walker');
    }
    for (let i = npcs.length - 1; i >= 0; i--) {
      const n = npcs[i]!;
      const ag = n.agent;
      if (Math.hypot(ag.x - p.x, ag.z - p.z) > 400) {
        dropNpc(i);
        continue;
      }
      let target = n.cruise;
      if (n.kind === 'car') {
        // Brake for anything in the way: the player, on foot or in a vehicle, ahead of the car.
        const dx = p.x - ag.x;
        const dz = p.z - ag.z;
        const d = Math.hypot(dx, dz);
        const ahead = d > 0.1 ? (dx * Math.sin(ag.heading) - dz * Math.cos(ag.heading)) / d : 0;
        if (d < 16 && ahead > 0.65) target = 0;
      }
      ag.speed += (target - ag.speed) * Math.min(1, dt * 3);
      const before = ag.seg;
      stepAgent(ag, dt, (end, from) => {
        const near = segsNear(end[0], end[1], 12, n.kind === 'car' ? drivable : walkable);
        return pickNext(near, end, from, Math.random);
      });
      if (ag.seg !== before) ag.lane = laneFor(n.kind, ag.seg);
      n.mesh.position.set(ag.x, 0, ag.z);
      n.mesh.rotation.y = -ag.heading;
      n.human?.update(dt, ag.speed, false);
      animateCar(n, n.car, ag.heading, ag.speed, dt);
    }
  }

  // ------------------------------------------------------------ treasure zones the server says this player has unlocked
  const zoneBobs: { s: T.Sprite; y: number; phase: number }[] = [];
  async function loadZones(): Promise<void> {
    try {
      const list = await api.zones();
      if (destroyed) return;
      zoneGroup.clear();
      zoneBobs.length = 0;
      zones = list.map((zone) => {
        const [x, z] = toLocal(origin, zone.lng, zone.lat);
        const beacon = new three.Group();
        const pillar = new three.Mesh(new three.CylinderGeometry(2.4, 2.4, 160, 14, 1, true), new three.MeshBasicMaterial({ color: '#2dd36f', transparent: true, opacity: 0.35, side: three.DoubleSide, depthWrite: false }));
        pillar.position.y = 80;
        const ring = new three.Mesh(new three.RingGeometry(Math.max(1, zone.radiusM - 1.2), zone.radiusM, 48), new three.MeshBasicMaterial({ color: '#2dd36f', transparent: true, opacity: 0.6, side: three.DoubleSide, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.3;
        beacon.add(pillar, ring);
        if (look.id === 'bright') {
          // A gem bubble bobbing over the spot, so it can be found from a distance.
          const gem = bubble('💎', zone.coin);
          gem.position.set(0, 12, 0);
          beacon.add(gem);
          zoneBobs.push({ s: gem, y: 12, phase: zoneBobs.length * 0.9 });
        }
        beacon.position.set(x, 0, z);
        zoneGroup.add(beacon);
        return { zone, x, z, beacon };
      });
    } catch {
      // the zones stay as they were
    }
  }

  // ------------------------------------------------------------ the city's landmarks
  // Bright look: a round white icon that floats and bobs over the place, with its name under it. Realistic look: a pale pillar and a label.
  const bobbers: { s: T.Sprite; y: number; phase: number }[] = [];
  function bubble(icon: string, label: string): T.Sprite {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const g = c.getContext('2d');
    if (g) {
      g.shadowColor = 'rgba(0,0,0,0.28)';
      g.shadowBlur = 14;
      g.shadowOffsetY = 4;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(256, 100, 78, 0, Math.PI * 2);
      g.fill();
      g.shadowColor = 'transparent';
      g.lineWidth = 10;
      g.strokeStyle = look.ui.accent;
      g.stroke();
      g.font = '84px system-ui, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#000000';
      g.fillText(icon, 256, 106);
      if (label) {
        g.font = '700 34px system-ui, sans-serif';
        const w = Math.min(490, g.measureText(label).width + 44);
        g.fillStyle = 'rgba(255,255,255,0.96)';
        g.beginPath();
        if (g.roundRect) g.roundRect(256 - w / 2, 196, w, 50, 25);
        else g.rect(256 - w / 2, 196, w, 50);
        g.fill();
        g.fillStyle = '#12301f';
        g.fillText(label, 256, 222, 440);
      }
    }
    const tex = new three.CanvasTexture(c);
    tex.colorSpace = three.SRGBColorSpace;
    const s = new three.Sprite(new three.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    s.scale.set(label ? 30 : 16, label ? 15 : 8, 1);
    s.renderOrder = 9;
    return s;
  }
  for (const m of city.landmarks) {
    const [x, z] = toLocal(origin, m.lng, m.lat);
    if (look.id === 'bright') {
      const s = bubble('⭐', m.name);
      s.position.set(x, 30, z);
      const pole = new three.Mesh(new three.CylinderGeometry(0.18, 0.18, 24, 6), new three.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 }));
      pole.position.set(x, 12, z);
      scene.add(pole, s);
      bobbers.push({ s, y: 30, phase: bobbers.length * 1.3 });
      continue;
    }
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
    if (!KEY_NAMES.includes(k) && k !== 'e' && k !== 'f' && k !== 'v' && k !== 't' && k !== 'm' && k !== 'h' && k !== 'r') return;
    if (down) sound.unlock();
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (k === 'e') {
      if (down && !e.repeat) pressE = true;
    } else if (k === 'f') {
      if (down && !e.repeat) toggleFullscreen();
    } else if (k === 'v') {
      if (down && !e.repeat) toggleStreet();
    } else if (k === 't') {
      if (down && !e.repeat) clock.skip(3);
    } else if (k === 'm') {
      if (down && !e.repeat) toggleSound();
    } else if (k === 'h') {
      if (down && !e.repeat && driving) sound.horn();
    } else if (k === 'r') {
      if (down && !e.repeat) cycleWeather();
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

  // ------------------------------------------------------------ the player at the wheel
  // The driver is a second copy of the animated person, playing the sitting animation, placed on the seat and carried by the car body.
  // Only the real model can sit; if it did not load, the car is simply driven without a visible driver.
  let playerDriver: Human | null = null;
  function seatPlayer(rig: Rig): void {
    if (!character || rig.kind !== 'car' || !rig.parts) return;
    playerDriver ??= newPerson();
    const at = seatOffset(rig.parts.seat);
    playerDriver.group.position.set(...at);
    shadowed(playerDriver.group, true, false);
    playerDriver.sit?.(true);
    rig.parts.cabin.add(playerDriver.group);
  }
  function unseatPlayer(rig: Rig): void {
    if (!playerDriver) return;
    rig.parts?.cabin.remove(playerDriver.group);
    playerDriver.sit?.(false);
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
          unseatPlayer(v);
          driving = null;
          v.state.speed = 0;
          sound.door();
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
        if (r.ok) sound.chime();
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
      seatPlayer(best);
      sound.door();
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
    status.textContent = `${m === 'walk' ? 'Walking' : m === 'run' ? 'Running' : m === 'car' ? driving!.name : 'Boat'} · ${Math.round(kmh)} km/h · ${formatClock(clock.hours())} · ${WEATHER_LABEL[weatherNow.name]}`;
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
      const drive = stepVehicle(driving.state, { throttle: Math.max(-1, Math.min(1, iy)), steer: Math.max(-1, Math.min(1, ix)), handbrake: keys.has(' ') || touchBrake }, driving.spec, dt, colliders);
      if (drive.crashed && now - lastThud > 700) {
        lastThud = now;
        sound.thud();
      }
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
    if (driving) playerDriver?.update(dt, 0, false); // the seated driver keeps breathing and shifting
    for (const r of rigs) {
      r.mesh.position.set(r.state.x, r.kind === 'boat' ? 0.05 + Math.sin(now / 500 + r.state.x) * 0.06 : 0, r.state.z);
      r.mesh.rotation.y = -r.state.heading;
      animateCar(r, r.parts, r.state.heading, r.state.speed, dt);
    }
    const target = here();
    const dist = driving ? (driving.kind === 'boat' ? look.camera.car * 1.25 : look.camera.car) : look.camera.foot;
    const lift = driving ? 1.8 : 1.5;
    let d = dist;
    for (let i = 0; i < 6; i++) {
      camPos.set(target.x - Math.sin(camYaw) * d * Math.cos(camPitch), lift + d * Math.sin(camPitch), target.z + Math.cos(camYaw) * d * Math.cos(camPitch));
      if (!colliders.insideBuilding(camPos.x, camPos.z) || camPos.y > 70) break;
      d *= 0.72;
    }
    // The camera follows with a little lag (more in a car), and the view widens with speed.
    camera.position.lerp(camPos, started ? 1 - Math.exp(-(driving ? 7 : 11) * dt) : 1);
    const wantFov = look.camera.fov + (driving ? Math.min(1, Math.abs(driving.state.speed) / 27) * 16 : Math.min(1, walking / 6.2) * 5);
    if (Math.abs(camera.fov - wantFov) > 0.05) {
      camera.fov += (wantFov - camera.fov) * (1 - Math.exp(-3 * dt));
      camera.updateProjectionMatrix();
    }
    camLook.set(target.x, driving ? 1.2 : 1.5, target.z);
    camera.lookAt(camLook);
    ground.position.set(target.x, 0, target.z);
    // The sun, its shadows and the sky stay with the player. The shadow box moves in whole metres so shadows do not shimmer.
    const gx = Math.round(target.x);
    const gz = Math.round(target.z);
    // Time of day: the sun (or the moon at night), the sky, the haze and the ambient light all follow the clock.
    clock.tick(dt);
    weatherNow = weather.update(dt);
    moment = applyWeather(momentAt(clock.hours(), look.sky), weatherNow);
    const ld = moment.lightDir;
    // Fog and heavy rain shorten the view; surfaces darken as they get wet; the rain falls round the camera; thunder follows the flash.
    const fr = fogRange(look.fog, weatherNow);
    (scene.fog as T.Fog).near = fr[0];
    (scene.fog as T.Fog).far = fr[1];
    wet = wetness(weatherNow.rain, wet, dt);
    if (Math.abs(wet - wetApplied) > 0.004) {
      wetApplied = wet;
      const dark = 1 - 0.3 * wet;
      groundMaterial.color.set(look.ground).multiplyScalar(dark);
      wallMaterial.color.setScalar(1 - 0.18 * wet);
      roofMaterial.color.setScalar(1 - 0.2 * wet);
      for (const g of built.values()) for (const c of g.children) if (c.userData.ownMap) ((c as T.Mesh).material as T.MeshLambertMaterial).color.setScalar(dark);
    }
    rain.update(now / 1000, camera.position, weatherNow.rain, weatherNow.wind * 0.6, weatherNow.wind * 0.25);
    for (const th of weather.takeThunder()) sound.thunder(th.power, th.delay);
    sun.position.set(gx + ld[0] * 260, Math.max(30, ld[1] * 260), gz + ld[2] * 260);
    sun.target.position.set(gx, 0, gz);
    sun.color.set(moment.lightColour);
    sun.intensity = look.light.sun * moment.lightStrength;
    hemi.intensity = look.light.hemi * moment.ambient;
    hemi.color.set(mixColours([[look.light.hemiSky, moment.ambient], ['#6f86d0', 1 - moment.ambient]]));
    scene.environmentIntensity = look.light.env * moment.ambient;
    renderer.toneMappingExposure = look.tone.exposure * moment.exposure;
    air.setMoment(moment);
    (scene.background as T.Color).set(moment.sky.haze);
    (scene.fog as T.Fog).color.set(moment.sky.haze);
    wallMaterial.emissiveIntensity = moment.night * 0.95;
    lampHeadMat.emissiveIntensity = moment.night * 2.6;
    for (const r of rigs) r.parts?.setNight(moment.night);
    for (const n of npcs) n.car?.setNight(moment.night);
    // The car being driven throws a beam of light ahead of it in the dark.
    if (driving && driving.kind === 'car' && moment.night > 0.05) {
      const h = driving.state.heading;
      beam.visible = true;
      beam.intensity = 38 * moment.night;
      beam.position.set(driving.state.x + Math.sin(h) * 2.2, 0.9, driving.state.z - Math.cos(h) * 2.2);
      beam.target.position.set(driving.state.x + Math.sin(h) * 24, 0.2, driving.state.z - Math.cos(h) * 24);
    } else beam.visible = false;
    air.dome.position.copy(camera.position);
    air.tick(now / 1000);
    for (const b of bobbers) b.s.position.y = b.y + Math.sin(now / 650 + b.phase) * 1.3;
    for (const b of zoneBobs) b.s.position.y = b.y + Math.sin(now / 500 + b.phase) * 0.9;
    manageNpcs(now, dt);
    streetPanel.tick(now);
    // What is heard follows what is happening: the vehicle's speed and turning, the pedal, the handbrake, and the dark.
    const heading = driving ? driving.state.heading : foot.heading;
    const yaw = Math.abs(Math.atan2(Math.sin(heading - lastHeading), Math.cos(heading - lastHeading))) / Math.max(dt, 0.001);
    lastHeading = heading;
    sound.update(
      {
        mode: driving ? (driving.kind === 'boat' ? 'boat' : 'car') : walking > 3.6 ? 'run' : 'walk',
        speed: driving ? Math.abs(driving.state.speed) : walking,
        throttle: driving ? Math.max(0, Math.min(1, iy)) : 0,
        yaw: Math.min(4, yaw),
        braking: !!driving && iy < 0 && Math.abs(driving.state.speed) > 1,
        handbrake: keys.has(' ') || touchBrake,
        night: moment.night,
        rain: weatherNow.rain,
        wind: weatherNow.wind,
      },
      dt,
    );
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
      for (let i = npcs.length - 1; i >= 0; i--) dropNpc(i);
      streetPanel.destroy();
      sound.dispose();
      rain.dispose();
      playerDriver?.dispose();
      air.dispose();
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
