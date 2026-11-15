// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { makeStreetPanel, REFRESH_DISTANCE_M, REFRESH_EVERY_MS } from './streetPanel.js';

const TOKEN = 'MLY|1234567890|abcdef0123456789';
const image = (id: string, lng: number, lat: number) => ({ data: [{ id, computed_geometry: { type: 'Point', coordinates: [lng, lat] } }] });

function setup(responses: unknown[], position: [number, number] = [3.38, 6.52]) {
  const wrap = document.createElement('div');
  document.body.append(wrap);
  const calls: string[] = [];
  let pos = position;
  const queue = [...responses];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === 'fail') return new Response('nope', { status: 500 });
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  const panel = makeStreetPanel(wrap, { token: TOKEN, position: () => pos, fetchImpl });
  return { wrap, panel, calls, move: (p: [number, number]) => (pos = p), fetchImpl };
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe('the street photo panel', () => {
  it('refuses to open without a valid Mapillary key and says why', () => {
    const wrap = document.createElement('div');
    const p = makeStreetPanel(wrap, { token: '', position: () => [0, 0] });
    expect(p.toggle()).toMatch(/Mapillary key/);
    expect(p.open).toBe(false);
    p.destroy();
  });

  it('opens, finds the nearest photo, shows it in Mapillary\'s viewer with the credit and a link', async () => {
    const t = setup([image('111222333', 3.3801, 6.5201)]);
    expect(t.panel.toggle()).toBe('');
    expect(t.panel.open).toBe(true);
    t.panel.tick(10_000);
    await settle();
    const frame = t.wrap.querySelector('iframe')!;
    expect(frame.src).toBe('https://www.mapillary.com/embed?image_key=111222333&style=photo');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.referrerPolicy).toBe('no-referrer');
    expect(t.wrap.textContent).toContain('Mapillary contributors, CC BY-SA 4.0');
    expect(t.wrap.textContent).toMatch(/Taken about \d+ m from you/);
    expect(t.wrap.querySelector('a')!.href).toContain('pKey=111222333');
    expect(t.calls[0]).toContain('closeto=3.38%2C6.52');
    t.panel.destroy();
  });

  it('says so when there is no photo near, instead of showing one from elsewhere', async () => {
    const t = setup([{ data: [] }]);
    t.panel.toggle();
    t.panel.tick(10_000);
    await settle();
    expect(t.wrap.querySelector('iframe')).toBeNull();
    expect(t.wrap.textContent).toMatch(/no street photo within about 120 metres/);
    t.panel.destroy();
  });

  it('does not search again until the player has moved well away, and then not more often than every few seconds', async () => {
    const t = setup([image('111222333', 3.3801, 6.5201), image('444555666', 3.39, 6.53)]);
    t.panel.toggle();
    t.panel.tick(10_000);
    await settle();
    expect(t.calls).toHaveLength(1);
    t.panel.tick(10_000 + REFRESH_EVERY_MS + 1); // time has passed but the player has not moved
    await settle();
    expect(t.calls).toHaveLength(1);
    t.move([3.38 + 0.0002, 6.52]); // about 22 m: still within the threshold
    t.panel.tick(20_000);
    await settle();
    expect(t.calls).toHaveLength(1);
    t.move([3.39, 6.53]); // well over REFRESH_DISTANCE_M away
    t.panel.tick(20_001);
    await settle();
    expect(t.calls).toHaveLength(2);
    expect(t.wrap.querySelector('iframe')!.src).toContain('444555666');
    // Moving again straight away does not trigger another search inside the minimum gap.
    t.move([3.4, 6.54]);
    t.panel.tick(20_002);
    await settle();
    expect(t.calls).toHaveLength(2);
    expect(REFRESH_DISTANCE_M).toBeGreaterThan(20);
    t.panel.destroy();
  });

  it('keeps the same viewer when the nearest photo has not changed, and does not search while closed', async () => {
    const t = setup([image('111222333', 3.3801, 6.5201)]);
    t.panel.tick(10_000); // closed: nothing happens
    await settle();
    expect(t.calls).toHaveLength(0);
    t.panel.toggle();
    t.panel.tick(10_000);
    await settle();
    const first = t.wrap.querySelector('iframe');
    t.move([3.39, 6.53]);
    t.panel.tick(30_000);
    await settle();
    expect(t.calls).toHaveLength(2);
    expect(t.wrap.querySelector('iframe')).toBe(first); // same photo, same frame: no reload flicker
    t.panel.destroy();
  });

  it('retries after a failure without waiting for the player to move, and can be closed', async () => {
    const t = setup(['fail', image('111222333', 3.3801, 6.5201)]);
    t.panel.toggle();
    t.panel.tick(10_000);
    await settle();
    expect(t.wrap.textContent).toMatch(/could not be reached/);
    t.panel.tick(10_000 + REFRESH_EVERY_MS + 1);
    await settle();
    expect(t.wrap.querySelector('iframe')).not.toBeNull();
    t.wrap.querySelector<HTMLButtonElement>('button[aria-label="Close street photo"]')!.click();
    expect(t.panel.open).toBe(false);
    t.panel.destroy();
  });
});
