import { describe, expect, it } from 'vitest';
import { coverageTiles, embedUrl, imageSearchUrl, isMapillaryToken, nearestImage, pageUrl, parseImages, MAPILLARY_CREDIT } from './street.js';

const TOKEN = 'MLY|1234567890|abcdef0123456789';
const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('street-level imagery', () => {
  it('knows a Mapillary client token when it sees one', () => {
    expect(isMapillaryToken(TOKEN)).toBe(true);
    for (const bad of ['', 'MLY|x|y', 'abc', 'MLY|12|', undefined, 5]) expect(isMapillaryToken(bad), String(bad)).toBe(false);
  });

  it('asks for the nearest photograph to a point, with the token only in the query', () => {
    const u = new URL(imageSearchUrl(TOKEN, 2.3522, 48.8566));
    expect(u.origin + u.pathname).toBe('https://graph.mapillary.com/images');
    expect(u.searchParams.get('closeto')).toBe('2.3522,48.8566');
    expect(u.searchParams.get('limit')).toBe('1');
    expect(u.searchParams.get('access_token')).toBe(TOKEN);
  });

  it('builds the viewer and page addresses safely', () => {
    expect(embedUrl('123456789')).toBe('https://www.mapillary.com/embed?image_key=123456789&style=photo');
    expect(embedUrl('1&x=<script>')).not.toContain('<');
    expect(pageUrl('123456789', 2.35, 48.85)).toContain('pKey=123456789');
    expect(coverageTiles(TOKEN)).toContain('{z}/{x}/{y}');
    expect(MAPILLARY_CREDIT).toMatch(/Mapillary contributors, CC BY-SA/);
  });

  it('reads one photograph out of an answer, and nothing from a malformed one', () => {
    expect(parseImages({ data: [{ id: '1234567890', computed_geometry: { type: 'Point', coordinates: [2.35, 48.85] } }] })).toEqual({ id: '1234567890', lng: 2.35, lat: 48.85 });
    expect(parseImages({ data: [{ id: 1234567890, computed_geometry: { coordinates: [2.35, 48.85] } }] })?.id).toBe('1234567890');
    for (const bad of [null, {}, { data: [] }, { data: [{ id: 'abc', computed_geometry: { coordinates: [1, 2] } }] }, { data: [{ id: '12345678' }] }, { data: [{ id: '12345678', computed_geometry: { coordinates: ['a', 'b'] } }] }]) {
      expect(parseImages(bad)).toBeNull();
    }
  });

  it('finds a photograph, reports when there is none, and reports a failure honestly', async () => {
    const hit = await nearestImage(TOKEN, 2.35, 48.85, reply({ data: [{ id: '987654321', computed_geometry: { coordinates: [2.351, 48.851] } }] }));
    expect(hit).toEqual({ image: { id: '987654321', lng: 2.351, lat: 48.851 }, failed: false });
    expect(await nearestImage(TOKEN, 2.35, 48.85, reply({ data: [] }))).toEqual({ image: null, failed: false });
    expect(await nearestImage(TOKEN, 2.35, 48.85, reply({ error: 'bad token' }, 400))).toEqual({ image: null, failed: true });
    expect(await nearestImage(TOKEN, 2.35, 48.85, (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual({ image: null, failed: true });
  });
});
