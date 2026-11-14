/**
 * The nine launch cities. Public facts only: nothing here is secret or tied to a treasure. Shared by the page and the server (the
 * server accepts a city id only if it is in this list and active in the database). Bounds are [west, south, east, north] in degrees.
 */
export type Transport = 'walk' | 'run' | 'taxi' | 'car' | 'bus' | 'train' | 'metro' | 'ferry' | 'flight';

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
  /** Two CSS colours for the card until real photography is licensed and added. */
  tint: [string, string];
}

const BASE: Transport[] = ['walk', 'run', 'taxi', 'car', 'bus', 'flight'];

export const CITIES: readonly City[] = [
  { id: 'lagos', name: 'Lagos', country: 'Nigeria', center: [3.3792, 6.5244], bounds: [3.0, 6.3, 3.75, 6.75], blurb: 'A lagoon megacity of islands, bridges and markets, where Victoria Island, the Mainland and the Atlantic coast all meet.', transport: [...BASE, 'ferry'], tint: ['#0b3d2e', '#c9a227'] },
  { id: 'new-york', name: 'New York', country: 'United States', center: [-74.006, 40.7128], bounds: [-74.26, 40.49, -73.7, 40.92], blurb: 'A grid of towers and boroughs on a harbour, stitched together by the subway, bridges and ferries.', transport: [...BASE, 'metro', 'train', 'ferry'], tint: ['#1b1f3a', '#8a8fb8'] },
  { id: 'nairobi', name: 'Nairobi', country: 'Kenya', center: [36.8219, -1.2921], bounds: [36.65, -1.45, 37.1, -1.15], blurb: 'A highland capital on the edge of a national park, with a busy centre, green suburbs and the Rift close by.', transport: [...BASE], tint: ['#2c3b1a', '#d9a441'] },
  { id: 'hong-kong', name: 'Hong Kong', country: 'Hong Kong', center: [114.1694, 22.3193], bounds: [113.83, 22.15, 114.45, 22.57], blurb: 'Steep hills, a deep harbour and one of the densest skylines on earth, linked by the MTR, trams and ferries.', transport: [...BASE, 'metro', 'ferry'], tint: ['#3a1022', '#e0526e'] },
  { id: 'london', name: 'London', country: 'United Kingdom', center: [-0.1276, 51.5072], bounds: [-0.51, 51.28, 0.33, 51.7], blurb: 'Two thousand years on a river: Roman walls, royal parks, the City and the Underground running beneath it all.', transport: [...BASE, 'metro', 'train', 'ferry'], tint: ['#182a44', '#b6384a'] },
  { id: 'dubai', name: 'Dubai', country: 'United Arab Emirates', center: [55.2708, 25.2048], bounds: [54.9, 24.75, 55.6, 25.4], blurb: 'A creek-side trading port turned glass skyline, with the desert at its back and the Gulf at its front.', transport: [...BASE, 'metro', 'ferry'], tint: ['#3b2a12', '#e8b94a'] },
  { id: 'paris', name: 'Paris', country: 'France', center: [2.3522, 48.8566], bounds: [2.22, 48.8, 2.47, 48.92], blurb: 'Boulevards, bridges over the Seine and a Métro that reaches almost every corner of a compact, walkable city.', transport: [...BASE, 'metro', 'train', 'ferry'], tint: ['#232a52', '#d6c58a'] },
  { id: 'miami', name: 'Miami', country: 'United States', center: [-80.1918, 25.7617], bounds: [-80.45, 25.55, -80.1, 25.95], blurb: 'Art deco beaches, causeways over Biscayne Bay, and a downtown that faces the water on both sides.', transport: [...BASE, 'train', 'ferry'], tint: ['#0f4c5c', '#ff7a59'] },
  { id: 'nicosia', name: 'Nicosia', country: 'Cyprus', center: [33.3823, 35.1856], bounds: [33.28, 35.1, 33.47, 35.25], blurb: 'A walled Venetian old town at the heart of the island, a capital that is still divided by a green line.', transport: [...BASE], tint: ['#3a2a1d', '#c8a06a'] },
];

export const CITY_IDS: readonly string[] = CITIES.map((c) => c.id);

export const cityById = (id: string): City | undefined => CITIES.find((c) => c.id === id);
