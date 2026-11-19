import { describe, expect, it, vi } from 'vitest';
import { BLOCK_M, BLOCK_SQUARES, FeatureStore, blockBox, blockKeyOf, classify, parseFeatures } from './mapillaryFeatures.js';
import { fromLocal, toLocal, type Origin } from './worldData.js';

const TOKEN = 'MLY|1234567890|abcdef0123456789';
const origin: Origin = { lng: 2.3522, lat: 48.8566 };
const at = (x: number, z: number, value: string, id = String(Math.round(x * 1000 + z))) => {
  const [lng, lat] = fromLocal(origin, x, z);
  return { id, object_value: value, geometry: { type: 'Point', coordinates: [lng, lat] } };
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe('reading Mapillary\'s names for things', () => {
  it('turns the names the game uses into its kinds, and ignores the rest', () => {
    expect(classify('object--traffic-light--general-upright')).toBe('traffic-light');
    expect(classify('object--traffic-light--pedestrians')).toBe('traffic-light');
    expect(classify('object--street-light')).toBe('street-light');
    expect(classify('object--support--utility-pole')).toBe('utility-pole');
    expect(classify('object--trash-can')).toBe('bin');
    expect(classify('object--bench')).toBe('bench');
    expect(classify('object--fire-hydrant')).toBe('hydrant');
    expect(classify('marking--discrete--crosswalk-zebra')).toBe('crosswalk');
    expect(classify('marking--discrete--crosswalk-plain')).toBe('crosswalk');
    expect(classify('regulatory--no-entry--g1')).toBe('sign');
    expect(classify('warning--curve-left--g1')).toBe('sign');
    expect(classify('information--general-directions--g1')).toBe('sign');
    expect(classify('object--traffic-sign--front')).toBe('sign');
    for (const ignored of ['object--sign--advertisement', 'object--sign--store', 'object--manhole', 'marking--discrete--symbol--bicycle', 'object--banner', '', 'x']) expect(classify(ignored), ignored).toBeNull();
  });
});

describe('reading the service\'s answer', () => {
  it('puts each feature in metres from the city centre, in the right 200 m square', () => {
    const m = parseFeatures({ data: [at(50, 60, 'object--street-light'), at(250, 60, 'object--trash-can'), at(-30, -30, 'object--bench')] }, origin);
    const flat = [...m.entries()].flatMap(([k, list]) => list.map((f) => ({ k, ...f })));
    expect(flat).toHaveLength(3);
    const light = flat.find((f) => f.kind === 'street-light')!;
    expect(light.x).toBeCloseTo(50, 0);
    expect(light.z).toBeCloseTo(60, 0);
    expect(light.k).toBe('0,0');
    expect(flat.find((f) => f.kind === 'bin')!.k).toBe('1,0'); // 250 m east is the next square
    expect(flat.find((f) => f.kind === 'bench')!.k).toBe('-1,-1'); // north-west of the centre
    const [x, z] = toLocal(origin, ...(at(50, 60, 'object--bench').geometry.coordinates as [number, number]));
    expect([Math.round(x), Math.round(z)]).toEqual([50, 60]);
  });

  it('keeps one of the same kind found twice on the same spot, but not two different things or things further apart', () => {
    const m = parseFeatures({ data: [at(10, 10, 'object--street-light', 'a'), at(10.6, 10.4, 'object--street-light', 'b'), at(10.5, 10.5, 'object--bench', 'c'), at(14, 10, 'object--street-light', 'd')] }, origin);
    const flat = [...m.values()].flat();
    expect(flat.filter((f) => f.kind === 'street-light')).toHaveLength(2); // a and b are one; d is a different lamp
    expect(flat.filter((f) => f.kind === 'bench')).toHaveLength(1); // a different kind on the same spot is kept
  });

  it('ignores anything malformed without failing', () => {
    expect([...parseFeatures(null, origin).values()]).toEqual([]);
    expect([...parseFeatures({ data: 5 }, origin).values()]).toEqual([]);
    const bad = [{ object_value: 'object--bench' }, { object_value: 'object--bench', geometry: { coordinates: ['x', 'y'] } }, { object_value: 7, geometry: { coordinates: [2.35, 48.85] } }, null, 'nope', at(0, 0, 'object--bench')];
    expect([...parseFeatures({ data: bad }, origin).values()].flat()).toHaveLength(1);
  });
});

describe('blocks', () => {
  it('groups three by three squares, and gives the box Mapillary asks for in longitude and latitude', () => {
    expect(BLOCK_SQUARES).toBe(3);
    expect(blockKeyOf('0,0')).toBe('0,0');
    expect(blockKeyOf('2,2')).toBe('0,0');
    expect(blockKeyOf('3,0')).toBe('1,0');
    expect(blockKeyOf('-1,-3')).toBe('-1,-1');
    const [w, s, e, n] = blockBox(origin, '0,0');
    expect(e).toBeGreaterThan(w);
    expect(n).toBeGreaterThan(s);
    // 600 m across: about 0.0054 degrees either way at this latitude.
    expect(n - s).toBeCloseTo(BLOCK_M / 110_540, 4);
    // The block's north-west corner is the centre of the city for block 0,0, so the box starts there.
    expect(w).toBeCloseTo(origin.lng, 6);
    expect(n).toBeCloseTo(origin.lat, 6);
  });
});

describe('the feature store', () => {
  const answer = (data: unknown[]) => vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })) as unknown as typeof fetch;

  it('asks for nothing without a valid key, and reports nothing', () => {
    const f = vi.fn() as unknown as typeof fetch;
    const s = new FeatureStore({ token: '', origin, fetchImpl: f });
    s.request('0,0');
    expect(s.enabled).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(s.get('0,0')).toBeUndefined();
  });

  it('fetches the block for a square once, then serves every square in it, telling the game which squares are now known', async () => {
    const fetchImpl = answer([at(50, 60, 'object--street-light'), at(450, 450, 'object--bench')]);
    const ready: string[][] = [];
    const s = new FeatureStore({ token: TOKEN, origin, fetchImpl, onBlock: (q) => ready.push(q) });
    expect(s.get('0,0')).toBeUndefined(); // not yet
    s.request('0,0');
    s.request('1,1'); // the same block: no second request
    s.request('0,0');
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://graph.mapillary.com/map_features');
    expect(url.searchParams.get('fields')).toBe('id,object_value,geometry');
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
    expect(url.searchParams.get('bbox')!.split(',')).toHaveLength(4);
    expect(s.get('0,0')!.map((f) => f.kind)).toEqual(['street-light']);
    expect(s.get('2,2')!.map((f) => f.kind)).toEqual(['bench']); // 450 m is in square 2
    expect(s.get('1,0')).toEqual([]); // in the block, nothing there
    expect(s.get('5,5')).toBeUndefined(); // another block, not asked for
    expect(ready).toHaveLength(1);
    expect(ready[0]).toHaveLength(9);
    expect(ready[0]).toContain('0,0');
    expect(ready[0]).toContain('2,2');
    expect(s.count).toBe(2);
  });

  it('runs at most two requests at a time, and the rest when those finish', async () => {
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const fetchImpl = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => releases.push(r));
      running--;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = new FeatureStore({ token: TOKEN, origin, fetchImpl });
    for (const k of ['0,0', '3,0', '6,0', '9,0']) s.request(k);
    await settle();
    expect(running).toBe(2);
    releases.splice(0).forEach((r) => r());
    await settle();
    expect(running).toBe(2); // the next two started
    releases.splice(0).forEach((r) => r());
    await settle();
    expect(peak).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(s.get('9,0')).toEqual([]);
  });

  it('retries a failed block only after a minute, and carries on working after a failure', async () => {
    let now = 1000;
    let fail = true;
    const fetchImpl = vi.fn(async () => (fail ? new Response('busy', { status: 429 }) : new Response(JSON.stringify({ data: [at(5, 5, 'object--bench')] }), { status: 200 }))) as unknown as typeof fetch;
    const s = new FeatureStore({ token: TOKEN, origin, fetchImpl, now: () => now });
    s.request('0,0');
    await settle();
    expect(s.get('0,0')).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 5_000;
    s.request('0,0'); // too soon
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fail = false;
    now += 60_000;
    s.request('0,0');
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.get('0,0')!.map((f) => f.kind)).toEqual(['bench']);
    // A network error counts as a failure too.
    const boom = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const t = new FeatureStore({ token: TOKEN, origin, fetchImpl: boom });
    t.request('0,0');
    await settle();
    expect(t.get('0,0')).toBeUndefined();
  });
});
