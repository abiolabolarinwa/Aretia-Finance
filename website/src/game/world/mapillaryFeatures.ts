/**
 * Real street furniture from Mapillary's map-feature data: the traffic lights, crosswalks, street lights, utility poles, bins, benches,
 * fire hydrants and traffic signs that Mapillary's software has found in street photos, with their positions. The game uses these where
 * they exist and falls back to its own rules where they do not, because coverage is uneven (a lot in Paris, very little for traffic
 * lights in Lagos).
 *
 * The service answers slowly (a few seconds), so nothing waits for it: the game builds each map square at once, asks for the 600 m
 * block that holds it, and rebuilds the squares when the answer arrives. Answers are kept, failures are retried after a while, and at
 * most two requests run at a time. The data is © Mapillary contributors, CC BY-SA 4.0, and the game says so while it is using it.
 */
import { isMapillaryToken } from '../street.js';
import { fromLocal, toLocal, type Origin } from './worldData.js';
import { CELL_M, cellKey } from './roamBuild.js';

export type FeatureKind = 'traffic-light' | 'street-light' | 'utility-pole' | 'bin' | 'bench' | 'hydrant' | 'crosswalk' | 'sign';

export interface MapFeature {
  kind: FeatureKind;
  /** Position in metres from the city centre (x east, z south). */
  x: number;
  z: number;
}

/** What Mapillary calls a thing, as one of the kinds the game uses (or null for things it does not use). */
export function classify(value: string): FeatureKind | null {
  if (/^object--traffic-light/.test(value)) return 'traffic-light';
  if (value === 'object--street-light') return 'street-light';
  if (value === 'object--support--utility-pole') return 'utility-pole';
  if (value === 'object--trash-can') return 'bin';
  if (value === 'object--bench') return 'bench';
  if (value === 'object--fire-hydrant') return 'hydrant';
  if (/^marking--discrete--crosswalk/.test(value)) return 'crosswalk';
  if (/^object--traffic-sign/.test(value) || /^(regulatory|warning|information|complementary)--/.test(value)) return 'sign';
  return null;
}

/** The same thing is often found in several photos; keep one of any that are within this many metres of each other. */
export const SAME_SPOT_M = 1.5;
/** A block is this many map squares across (3 squares of 200 m is 600 m). */
export const BLOCK_SQUARES = 3;
export const BLOCK_M = BLOCK_SQUARES * CELL_M;
const MAX_IN_FLIGHT = 2;
const RETRY_AFTER_MS = 60_000;
const TIMEOUT_MS = 15_000;
const KEEP_BLOCKS = 40;

export const blockKeyOf = (squareKey: string): string => {
  const [cx, cz] = squareKey.split(',').map(Number) as [number, number];
  return `${Math.floor(cx / BLOCK_SQUARES)},${Math.floor(cz / BLOCK_SQUARES)}`;
};

/** The longitude and latitude box of a block, as Mapillary wants it: west, south, east, north. */
export function blockBox(origin: Origin, block: string): [number, number, number, number] {
  const [bx, bz] = block.split(',').map(Number) as [number, number];
  const nw = fromLocal(origin, bx * BLOCK_M, bz * BLOCK_M);
  const se = fromLocal(origin, (bx + 1) * BLOCK_M, (bz + 1) * BLOCK_M);
  return [nw[0], se[1], se[0], nw[1]];
}

/** Reads the service's answer into game features, one of any that are on the same spot, sorted into the squares they fall in. */
export function parseFeatures(body: unknown, origin: Origin): Map<string, MapFeature[]> {
  const out = new Map<string, MapFeature[]>();
  const data = (body as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return out;
  const kept: MapFeature[] = [];
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue;
    const f = raw as { object_value?: unknown; geometry?: { coordinates?: unknown } | null };
    const kind = typeof f.object_value === 'string' ? classify(f.object_value) : null;
    const c = f.geometry && typeof f.geometry === 'object' ? f.geometry.coordinates : undefined;
    if (!kind || !Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
    const [x, z] = toLocal(origin, c[0], c[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (kept.some((k) => k.kind === kind && Math.hypot(k.x - x, k.z - z) < SAME_SPOT_M)) continue;
    kept.push({ kind, x, z });
  }
  for (const f of kept) {
    const key = cellKey(f.x, f.z);
    const list = out.get(key) ?? [];
    list.push(f);
    out.set(key, list);
  }
  return out;
}

export interface FeatureStoreOptions {
  token: string;
  origin: Origin;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called when a block arrives, with every square it covers, so the game can rebuild any it has already drawn. */
  onBlock?: (squares: string[]) => void;
}

interface Block {
  squares: Map<string, MapFeature[]>;
}

export class FeatureStore {
  private readonly blocks = new Map<string, Block>();
  private readonly inFlight = new Set<string>();
  private readonly failed = new Map<string, number>();
  private readonly queue: string[] = [];
  private readonly o: FeatureStoreOptions;
  private total = 0;

  constructor(o: FeatureStoreOptions) {
    this.o = o;
  }

  /** Whether there is a valid key to ask with. Without one nothing is ever requested. */
  get enabled(): boolean {
    return isMapillaryToken(this.o.token);
  }

  /** How many features have been loaded so far. */
  get count(): number {
    return this.total;
  }

  /** The features in a map square, or undefined while its block has not arrived (or could not be fetched). */
  get(squareKey: string): MapFeature[] | undefined {
    const block = this.blocks.get(blockKeyOf(squareKey));
    return block ? (block.squares.get(squareKey) ?? []) : undefined;
  }

  /** Asks for the block that holds a square, unless it is already here, on its way, queued, or failed recently. */
  request(squareKey: string): void {
    if (!this.enabled) return;
    const block = blockKeyOf(squareKey);
    if (this.blocks.has(block) || this.inFlight.has(block) || this.queue.includes(block)) return;
    const failedAt = this.failed.get(block);
    if (failedAt !== undefined && (this.o.now ?? Date.now)() - failedAt < RETRY_AFTER_MS) return;
    this.queue.push(block);
    this.pump();
  }

  private pump(): void {
    while (this.inFlight.size < MAX_IN_FLIGHT && this.queue.length) {
      const block = this.queue.shift()!;
      this.inFlight.add(block);
      void this.load(block);
    }
  }

  private async load(block: string): Promise<void> {
    const [w, s, e, n] = blockBox(this.o.origin, block);
    const q = new URLSearchParams({ access_token: this.o.token, fields: 'id,object_value,geometry', bbox: `${w},${s},${e},${n}`, limit: '2000' });
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await (this.o.fetchImpl ?? ((...a) => fetch(...a)))(`https://graph.mapillary.com/map_features?${q.toString()}`, ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const squares = parseFeatures(await res.json(), this.o.origin);
      this.blocks.set(block, { squares });
      for (const list of squares.values()) this.total += list.length;
      this.failed.delete(block);
      // Keep memory bounded: forget the oldest blocks.
      while (this.blocks.size > KEEP_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
      const [bx, bz] = block.split(',').map(Number) as [number, number];
      const covered: string[] = [];
      for (let dx = 0; dx < BLOCK_SQUARES; dx++) for (let dz = 0; dz < BLOCK_SQUARES; dz++) covered.push(`${bx * BLOCK_SQUARES + dx},${bz * BLOCK_SQUARES + dz}`);
      this.o.onBlock?.(covered);
    } catch {
      this.failed.set(block, (this.o.now ?? Date.now)());
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlight.delete(block);
      this.pump();
    }
  }
}
