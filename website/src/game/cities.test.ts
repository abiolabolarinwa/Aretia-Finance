import { afterEach, describe, expect, it } from 'vitest';
import { allCities, CITIES, cityById, parseCity, setCatalogue } from './cities.js';
import { inBounds } from './travel.js';

const accra = { id: 'accra', name: 'Accra', country: 'Ghana', bounds: [-0.4, 5.45, 0.1, 5.75], center: [-0.187, 5.603], blurb: 'x', transport: ['walk', 'taxi', 'bus', 'flight'], tint: ['#112233', '#ccaa22'], landmarks: [{ name: 'Independence Arch', lng: -0.1969, lat: 5.5486 }], scene: 'beach-bay' };

describe('the city catalogue', () => {
  afterEach(() => setCatalogue(CITIES));

  it('has the nine launch cities, each sound, each with landmarks inside its own bounds', () => {
    expect(CITIES.map((c) => c.id)).toEqual(['lagos', 'new-york', 'nairobi', 'hong-kong', 'london', 'dubai', 'paris', 'miami', 'nicosia']);
    for (const c of CITIES) {
      expect(parseCity(c), c.id).not.toBeNull();
      expect(inBounds(c, c.center), c.id).toBe(true);
      expect(c.landmarks.length, c.id).toBeGreaterThanOrEqual(3);
      for (const m of c.landmarks) expect(inBounds(c, [m.lng, m.lat]), `${c.id}: ${m.name}`).toBe(true);
      expect(c.transport).toContain('flight');
    }
  });

  it('reads a city from a database row or an API answer', () => {
    const row = { id: 'accra', city_name: 'Accra', country: 'Ghana', bounds: '[-0.4,5.45,0.1,5.75]', center_lng: -0.187, center_lat: 5.603, blurb: '', transport: '["walk","flight"]', tint: '["#112233","#ccaa22"]', landmarks: '[]', scene: 'nonsense', status: 'coming_soon', image_url: null, image_credit: null };
    expect(parseCity(row)).toMatchObject({ id: 'accra', name: 'Accra', center: [-0.187, 5.603], bounds: [-0.4, 5.45, 0.1, 5.75], scene: 'skyline', status: 'coming_soon', imageUrl: null });
    expect(parseCity(accra)).toMatchObject({ id: 'accra', status: 'active', scene: 'beach-bay' });
  });

  it('refuses what is not a sound city', () => {
    const bad = (over: object) => parseCity({ ...accra, ...over });
    expect(bad({ id: 'Accra' })).toBeNull();
    expect(bad({ id: 'a' })).toBeNull();
    expect(bad({ name: '' })).toBeNull();
    expect(bad({ bounds: [0, 0, 10, 10] })).toBeNull(); // far too wide
    expect(bad({ bounds: [1, 1, 0, 0] })).toBeNull();
    expect(bad({ bounds: [-0.4, 5.45, 0.1] })).toBeNull();
    expect(bad({ center: [5, 5] })).toBeNull(); // outside the bounds
    expect(bad({ transport: ['walk', 'taxi'] })).toBeNull(); // no flight
    expect(bad({ transport: ['flight'] })).toBeNull(); // no walking
    expect(bad({ transport: ['walk', 'flight', 'teleport'] })).toBeNull();
    expect(bad({ tint: ['red', 'blue'] })).toBeNull();
    expect(bad({ landmarks: [{ name: 'Far', lng: 50, lat: 50 }] })).toBeNull();
    expect(bad({ landmarks: Array.from({ length: 21 }, () => ({ name: 'x', lng: 0, lat: 5.5 })) })).toBeNull();
    expect(parseCity(null)).toBeNull();
  });

  it('keeps a photograph only with an https address and a credit', () => {
    expect(parseCity({ ...accra, imageUrl: 'https://upload.wikimedia.org/x.jpg', imageCredit: 'Jane Doe, CC BY-SA 4.0' })).toMatchObject({ imageUrl: 'https://upload.wikimedia.org/x.jpg', imageCredit: 'Jane Doe, CC BY-SA 4.0' });
    expect(parseCity({ ...accra, imageUrl: 'https://upload.wikimedia.org/x.jpg' })).toMatchObject({ imageUrl: null, imageCredit: null });
    expect(parseCity({ ...accra, imageUrl: 'http://example.com/x.jpg', imageCredit: 'c' })).toMatchObject({ imageUrl: null });
    expect(parseCity({ ...accra, imageUrl: 'javascript:alert(1)', imageCredit: 'c' })).toMatchObject({ imageUrl: null });
  });

  it('looks cities up in the current list, and ignores an empty replacement', () => {
    const accraCity = parseCity(accra)!;
    setCatalogue([...CITIES, accraCity]);
    expect(allCities()).toHaveLength(10);
    expect(cityById('accra')?.name).toBe('Accra');
    setCatalogue([]);
    expect(allCities()).toHaveLength(10);
  });
});
