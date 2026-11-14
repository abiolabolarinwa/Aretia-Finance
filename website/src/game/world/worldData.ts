/**
 * Turns a decoded map tile (real streets, buildings, water and parks from OpenStreetMap) into things the 3D world is built from, in
 * metres around the city's starting point: x is east, z is south. Pure data: nothing here draws or touches the network.
 */
import type { Pt, VFeature, VLayer } from './mvt.js';

export const TILE_ZOOM = 14;

export interface Origin {
  lng: number;
  lat: number;
}

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG = 111_320;

/** Metres east and south of the origin, for a longitude and latitude. */
export function toLocal(o: Origin, lng: number, lat: number): Pt {
  return [(lng - o.lng) * M_PER_DEG_LNG * Math.cos((o.lat * Math.PI) / 180), -(lat - o.lat) * M_PER_DEG_LAT];
}

export function fromLocal(o: Origin, x: number, z: number): [number, number] {
  return [o.lng + x / (M_PER_DEG_LNG * Math.cos((o.lat * Math.PI) / 180)), o.lat - z / M_PER_DEG_LAT];
}

export function tileOf(lng: number, lat: number, z = TILE_ZOOM): { x: number; y: number } {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: Math.floor(((lng + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
}

/** A point on a tile (its own grid, usually 4096 across) as a longitude and latitude. */
export function tilePoint(z: number, x: number, y: number, px: number, py: number, extent: number): [number, number] {
  const n = 2 ** z;
  const lng = ((x + px / extent) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / extent)) / n))) * 180) / Math.PI;
  return [lng, lat];
}

export interface Building {
  /** The outline first, then any courtyards, in metres. */
  rings: Pt[][];
  /** Height in metres, and the height of its underside for a part raised on legs. */
  h: number;
  minH: number;
  /** The wall colour the map records for this building, when it has one, as #rrggbb. */
  colour?: string;
}
export interface Road {
  pts: Pt[];
  width: number;
  cls: string;
}
export interface Named {
  pts: Pt[];
  name: string;
}
export type AreaKind = 'grass' | 'wood' | 'sand' | 'paving';
export interface Area {
  rings: Pt[][];
  kind: AreaKind;
}
export interface WaterLine {
  pts: Pt[];
  width: number;
}

export interface TileWorld {
  buildings: Building[];
  roads: Road[];
  named: Named[];
  water: Area[];
  waterLines: WaterLine[];
  areas: Area[];
}

export const ROAD_WIDTH: Record<string, number> = { motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8, minor: 6, service: 4, track: 3, path: 2.4, pier: 3 };
/** Classes a car may be driven along as a road (a car can leave the road, but these are drawn as streets). */
export const SKIPPED_ROADS = new Set(['rail', 'transit', 'aerialway', 'ferry', 'bus_guideway', 'gondola', 'mountain_pass']);
const MIN_BUILDING_M2 = 14;
const WATERWAY_WIDTH: Record<string, number> = { river: 18, canal: 10, stream: 3, drain: 2, ditch: 2 };

function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
  return Math.abs(a) / 2;
}

/** A steady pseudo-random number for a place, so the same building is always the same height. */
const NAMED_COLOURS: Record<string, string> = { white: '#f2f0ea', grey: '#a8a8a8', gray: '#a8a8a8', red: '#b5483c', brown: '#8a6a4f', beige: '#d9c9a8', cream: '#ece1c4', yellow: '#dcc46a', orange: '#d98a4a', pink: '#d9a3a0', green: '#8aa17c', blue: '#7f9bb8', black: '#4a4a4a', tan: '#c8b48e', sand: '#d6c49a' };

/** A building's wall colour from the map's colour tag ("#d2b48c", "beige"), or undefined when it is missing or unreadable. */
export function wallColour(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return NAMED_COLOURS[v];
}

function hash01(x: number, z: number): number {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

export function buildingHeight(f: VFeature, at: Pt): { h: number; minH: number } {
  const num = (k: string): number => {
    const v = f.props[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  const rh = num('render_height') || num('height');
  const levels = num('building:levels');
  const h = rh > 0 ? rh : levels > 0 ? levels * 3.3 : 8 + hash01(at[0], at[1]) * 10;
  const minH = Math.min(num('render_min_height') || num('min_height'), h - 2);
  return { h: Math.min(Math.max(h, 3), 450), minH: Math.max(minH, 0) };
}

const areaKind = (layer: string, cls: unknown): AreaKind | null => {
  const c = String(cls ?? '');
  if (layer === 'landcover') return c === 'grass' || c === 'farmland' ? 'grass' : c === 'wood' ? 'wood' : c === 'sand' ? 'sand' : null;
  if (layer === 'landuse') return c === 'park' || c === 'cemetery' || c === 'garden' || c === 'pitch' || c === 'playground' ? 'grass' : c === 'pedestrian' || c === 'plaza' ? 'paving' : null;
  return null;
};

export function buildTileWorld(layers: VLayer[], z: number, tx: number, ty: number, origin: Origin): TileWorld {
  const world: TileWorld = { buildings: [], roads: [], named: [], water: [], waterLines: [], areas: [] };
  const point = (extent: number) => (p: Pt): Pt => {
    const [lng, lat] = tilePoint(z, tx, ty, p[0], p[1], extent);
    return toLocal(origin, lng, lat);
  };
  for (const layer of layers) {
    const conv = point(layer.extent);
    const polygon = (rings: Pt[][]): Pt[][] => rings.map((r) => r.map(conv));
    for (const f of layer.features) {
      if (layer.name === 'building' && f.kind === 'polygon') {
        for (const rings of f.polygons) {
          const local = polygon(rings);
          if (ringArea(local[0]!) < MIN_BUILDING_M2) continue;
          const { h, minH } = buildingHeight(f, local[0]![0]!);
          const colour = wallColour(f.props.colour);
          world.buildings.push(colour ? { rings: local, h, minH, colour } : { rings: local, h, minH });
        }
      } else if (layer.name === 'transportation' && f.kind === 'line') {
        const cls = String(f.props.class ?? '');
        if (SKIPPED_ROADS.has(cls) || f.props.brunnel === 'tunnel') continue;
        const width = ROAD_WIDTH[cls] ?? 5;
        for (const line of f.lines) if (line.length >= 2) world.roads.push({ pts: line.map(conv), width, cls });
      } else if (layer.name === 'transportation' && f.kind === 'polygon' && String(f.props.class) === 'path') {
        for (const rings of f.polygons) world.areas.push({ rings: polygon(rings), kind: 'paving' });
      } else if (layer.name === 'transportation_name' && f.kind === 'line' && typeof f.props.name === 'string') {
        for (const line of f.lines) if (line.length >= 2) world.named.push({ pts: line.map(conv), name: f.props.name });
      } else if (layer.name === 'water' && f.kind === 'polygon') {
        for (const rings of f.polygons) world.water.push({ rings: polygon(rings), kind: 'grass' });
      } else if (layer.name === 'waterway' && f.kind === 'line') {
        const width = WATERWAY_WIDTH[String(f.props.class ?? '')];
        if (width && f.props.brunnel !== 'tunnel') for (const line of f.lines) if (line.length >= 2) world.waterLines.push({ pts: line.map(conv), width });
      } else if ((layer.name === 'landcover' || layer.name === 'landuse') && f.kind === 'polygon') {
        const kind = areaKind(layer.name, f.props.class);
        if (kind) for (const rings of f.polygons) world.areas.push({ rings: polygon(rings), kind });
      }
    }
  }
  return world;
}

/** The address of a tile on the map service, from the template it publishes. */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
