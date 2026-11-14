/**
 * The city catalogue. The cities live in the database (an administrator can add one without a release); this file holds the nine
 * launch cities as a built-in default, the shape of a city, and the rules for reading and checking one. Public facts only: nothing here
 * is secret or tied to a treasure. Bounds are [west, south, east, north] in degrees.
 *
 * The page and the server both keep one current list (`setCatalogue`), loaded from the database, and look cities up in it. Until it is
 * loaded, the built-in nine are used, so a visitor can see the city cards before signing in.
 */
export type Transport = 'walk' | 'run' | 'taxi' | 'car' | 'bus' | 'train' | 'metro' | 'ferry' | 'flight';
export type CityStatus = 'active' | 'inactive' | 'coming_soon';

/** A well-known public place, shown on the map and used to anchor the 3D scene. Positions are approximate. */
export interface Landmark {
  name: string;
  lng: number;
  lat: number;
  note?: string;
}

export interface City {
  id: string;
  name: string;
  country: string;
  /** [longitude, latitude] of the starting point of a visit. */
  center: [number, number];
  bounds: [number, number, number, number];
  blurb: string;
  /** What the city's own transport looks like in the game (every city also has flights between cities). */
  transport: Transport[];
  /** Two CSS colours for the card and scene. */
  tint: [string, string];
  status: CityStatus;
  /** A licensed photograph, if one has been added; always shown with its credit. */
  imageUrl: string | null;
  imageCredit: string | null;
  landmarks: Landmark[];
  /** Which 3D scene preset the city uses. */
  scene: SceneKind;
}

export const SCENES = ['lagoon', 'harbour-towers', 'savanna-edge', 'harbour-hills', 'river-city', 'desert-towers', 'boulevards', 'beach-bay', 'old-walls', 'skyline'] as const;
export type SceneKind = (typeof SCENES)[number];

const BASE: Transport[] = ['walk', 'run', 'taxi', 'car', 'bus', 'flight'];
const TRANSPORTS: readonly Transport[] = ['walk', 'run', 'taxi', 'car', 'bus', 'train', 'metro', 'ferry', 'flight'];

type Seed = Omit<City, 'status' | 'imageUrl' | 'imageCredit'>;
const nine: Seed[] = [
  { id: 'lagos', name: 'Lagos', country: 'Nigeria', center: [3.3792, 6.5244], bounds: [3.0, 6.3, 3.75, 6.75], blurb: 'A lagoon megacity of islands, bridges and markets, where Victoria Island, the Mainland and the Atlantic coast all meet.', transport: [...BASE, 'ferry'], tint: ['#0b3d2e', '#c9a227'], scene: 'lagoon', landmarks: [{ name: 'National Theatre', lng: 3.3659, lat: 6.4969 }, { name: 'Third Mainland Bridge', lng: 3.3981, lat: 6.501 }, { name: 'Lekki Conservation Centre', lng: 3.5365, lat: 6.4358 }] },
  { id: 'new-york', name: 'New York', country: 'United States', center: [-74.006, 40.7128], bounds: [-74.26, 40.49, -73.7, 40.92], blurb: 'A grid of towers and boroughs on a harbour, stitched together by the subway, bridges and ferries.', transport: [...BASE, 'metro', 'train', 'ferry'], tint: ['#1b1f3a', '#8a8fb8'], scene: 'harbour-towers', landmarks: [{ name: 'Statue of Liberty', lng: -74.0445, lat: 40.6892 }, { name: 'Empire State Building', lng: -73.9857, lat: 40.7484 }, { name: 'Brooklyn Bridge', lng: -73.9969, lat: 40.7061 }, { name: 'Central Park, Bethesda Terrace', lng: -73.9712, lat: 40.7739 }] },
  { id: 'nairobi', name: 'Nairobi', country: 'Kenya', center: [36.8219, -1.2921], bounds: [36.65, -1.45, 37.1, -1.15], blurb: 'A highland capital on the edge of a national park, with a busy centre, green suburbs and the Rift close by.', transport: [...BASE], tint: ['#2c3b1a', '#d9a441'], scene: 'savanna-edge', landmarks: [{ name: 'Kenyatta International Convention Centre', lng: 36.8219, lat: -1.2889 }, { name: 'Nairobi National Park gate', lng: 36.859, lat: -1.372 }, { name: 'Karura Forest', lng: 36.835, lat: -1.24 }] },
  { id: 'hong-kong', name: 'Hong Kong', country: 'Hong Kong', center: [114.1694, 22.3193], bounds: [113.83, 22.15, 114.45, 22.57], blurb: 'Steep hills, a deep harbour and one of the densest skylines on earth, linked by the MTR, trams and ferries.', transport: [...BASE, 'metro', 'ferry'], tint: ['#3a1022', '#e0526e'], scene: 'harbour-hills', landmarks: [{ name: 'Victoria Peak', lng: 114.1455, lat: 22.2759 }, { name: 'Star Ferry, Tsim Sha Tsui', lng: 114.1688, lat: 22.2935 }, { name: 'Tian Tan Buddha', lng: 113.9047, lat: 22.254 }, { name: 'Man Mo Temple', lng: 114.15, lat: 22.284 }] },
  { id: 'london', name: 'London', country: 'United Kingdom', center: [-0.1276, 51.5072], bounds: [-0.51, 51.28, 0.33, 51.7], blurb: 'Two thousand years on a river: Roman walls, royal parks, the City and the Underground running beneath it all.', transport: [...BASE, 'metro', 'train', 'ferry'], tint: ['#182a44', '#b6384a'], scene: 'river-city', landmarks: [{ name: 'Tower Bridge', lng: -0.0754, lat: 51.5055 }, { name: 'Big Ben', lng: -0.1246, lat: 51.5007 }, { name: 'British Museum', lng: -0.127, lat: 51.5194 }, { name: 'Tower of London', lng: -0.0759, lat: 51.5081 }] },
  { id: 'dubai', name: 'Dubai', country: 'United Arab Emirates', center: [55.2708, 25.2048], bounds: [54.9, 24.75, 55.6, 25.4], blurb: 'A creek-side trading port turned glass skyline, with the desert at its back and the Gulf at its front.', transport: [...BASE, 'metro', 'ferry'], tint: ['#3b2a12', '#e8b94a'], scene: 'desert-towers', landmarks: [{ name: 'Burj Khalifa', lng: 55.2744, lat: 25.1972 }, { name: 'Al Fahidi Fort', lng: 55.2972, lat: 25.2631 }, { name: 'Dubai Creek Park', lng: 55.334, lat: 25.2358 }, { name: 'Palm Jumeirah', lng: 55.1171, lat: 25.1304 }] },
  { id: 'paris', name: 'Paris', country: 'France', center: [2.3522, 48.8566], bounds: [2.22, 48.8, 2.47, 48.92], blurb: 'Boulevards, bridges over the Seine and a Métro that reaches almost every corner of a compact, walkable city.', transport: [...BASE, 'metro', 'train', 'ferry'], tint: ['#232a52', '#d6c58a'], scene: 'boulevards', landmarks: [{ name: 'Eiffel Tower', lng: 2.2945, lat: 48.8584 }, { name: 'Louvre', lng: 2.3376, lat: 48.8606 }, { name: 'Notre-Dame', lng: 2.3499, lat: 48.853 }, { name: 'Sacré-Cœur', lng: 2.3431, lat: 48.8867 }] },
  { id: 'miami', name: 'Miami', country: 'United States', center: [-80.1918, 25.7617], bounds: [-80.45, 25.55, -80.1, 25.95], blurb: 'Art deco beaches, causeways over Biscayne Bay, and a downtown that faces the water on both sides.', transport: [...BASE, 'train', 'ferry'], tint: ['#0f4c5c', '#ff7a59'], scene: 'beach-bay', landmarks: [{ name: 'Vizcaya Museum', lng: -80.2106, lat: 25.7444 }, { name: 'Ocean Drive, Lummus Park', lng: -80.13, lat: 25.7807 }, { name: 'Freedom Tower', lng: -80.1896, lat: 25.7787 }, { name: 'Wynwood Walls', lng: -80.1994, lat: 25.801 }] },
  { id: 'nicosia', name: 'Nicosia', country: 'Cyprus', center: [33.3823, 35.1856], bounds: [33.28, 35.1, 33.47, 35.25], blurb: 'A walled Venetian old town at the heart of the island, a capital that is still divided by a green line.', transport: [...BASE], tint: ['#3a2a1d', '#c8a06a'], scene: 'old-walls', landmarks: [{ name: 'Famagusta Gate', lng: 33.3728, lat: 35.1756 }, { name: 'Ledra Street crossing', lng: 33.3596, lat: 35.1727 }, { name: 'Cyprus Museum', lng: 33.3613, lat: 35.1714 }] },
];

/** The built-in nine, in the order they are shown. */
export const CITIES: readonly City[] = nine.map((c) => ({ ...c, status: 'active' as const, imageUrl: null, imageCredit: null }));

let current: readonly City[] = CITIES;

/** Every city in the current catalogue (loaded from the database once known; the built-in nine until then). */
export const allCities = (): readonly City[] => current;
export const cityById = (id: string): City | undefined => current.find((c) => c.id === id);

/** Replaces the current catalogue. An empty list is ignored, so a failed load never leaves the game with no cities. */
export function setCatalogue(list: readonly City[]): void {
  if (list.length > 0) current = list;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads a city from a database row or an API answer, or null if it is not a sound city. Used on both sides, and to check what an administrator sends. */
export function parseCity(raw: unknown): City | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && /^[a-z][a-z-]{1,30}$/.test(r.id) ? r.id : null;
  const name = typeof (r.name ?? r.city_name) === 'string' ? String(r.name ?? r.city_name).trim() : '';
  const country = typeof r.country === 'string' ? r.country.trim() : '';
  const b = (typeof r.bounds === 'string' ? safeJson(r.bounds) : r.bounds) as unknown;
  const center = Array.isArray(r.center) ? r.center : [r.center_lng, r.center_lat];
  if (!id || !name || name.length > 60 || !country || country.length > 60) return null;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(finite)) return null;
  const [w, s, e, n] = b as [number, number, number, number];
  if (!(w < e && s < n) || w < -180 || e > 180 || s < -85 || n > 85 || e - w > 3 || n - s > 3) return null;
  if (center.length !== 2 || !center.every(finite)) return null;
  const [lng, lat] = center as [number, number];
  if (lng < w || lng > e || lat < s || lat > n) return null;
  const transport = ((typeof r.transport === 'string' ? safeJson(r.transport) : r.transport) ?? BASE) as unknown;
  if (!Array.isArray(transport) || !transport.every((t) => TRANSPORTS.includes(t as Transport)) || !transport.includes('flight') || !transport.includes('walk')) return null;
  const tint = ((typeof r.tint === 'string' ? safeJson(r.tint) : r.tint) ?? ['#1b1f3a', '#c9a227']) as unknown;
  if (!Array.isArray(tint) || tint.length !== 2 || !tint.every((c) => typeof c === 'string' && COLOR.test(c))) return null;
  const marks = ((typeof r.landmarks === 'string' ? safeJson(r.landmarks) : r.landmarks) ?? []) as unknown;
  if (!Array.isArray(marks) || marks.length > 20) return null;
  const landmarks: Landmark[] = [];
  for (const m of marks) {
    const x = m as Record<string, unknown>;
    if (typeof x?.name !== 'string' || !x.name.trim() || x.name.length > 80 || !finite(x.lng) || !finite(x.lat) || x.lng < w || x.lng > e || x.lat < s || x.lat > n) return null;
    landmarks.push({ name: x.name.trim(), lng: x.lng, lat: x.lat, ...(typeof x.note === 'string' && x.note ? { note: x.note.slice(0, 200) } : {}) });
  }
  const scene = (SCENES as readonly string[]).includes(String(r.scene)) ? (r.scene as SceneKind) : 'skyline';
  const status: CityStatus = r.status === 'inactive' || r.status === 'coming_soon' ? r.status : 'active';
  const imageUrl = typeof (r.imageUrl ?? r.image_url) === 'string' && /^https:\/\/[^\s]+$/.test(String(r.imageUrl ?? r.image_url)) ? String(r.imageUrl ?? r.image_url) : null;
  const imageCredit = typeof (r.imageCredit ?? r.image_credit) === 'string' && String(r.imageCredit ?? r.image_credit).trim() ? String(r.imageCredit ?? r.image_credit).trim().slice(0, 300) : null;
  return { id, name, country, center: [lng, lat], bounds: [w, s, e, n], blurb: typeof r.blurb === 'string' ? r.blurb.slice(0, 500) : '', transport: transport as Transport[], tint: tint as [string, string], status, imageUrl: imageUrl && imageCredit ? imageUrl : null, imageCredit: imageUrl && imageCredit ? imageCredit : null, landmarks, scene };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
