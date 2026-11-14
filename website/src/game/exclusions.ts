/**
 * Where a treasure zone may not be placed. Every discovery in the game is simulated: nobody has to go anywhere, enter anything or
 * dig anything. These rules are a second guard, so a zone never sits on a place that would be unsafe or unlawful to go to if a player
 * ever decided to. They are not a complete list of sensitive places: the administrator must also confirm each placement is a public,
 * safe, accessible place, and that is recorded in the audit log.
 */
import { cityById, type City } from './cities.js';
import { distanceKm, inBounds, type LngLat } from './travel.js';

export interface Exclusion { city: string; name: string; at: LngLat; radiusKm: number; why: string }

const AIRPORT_KM = 3.5;

/** Positions are approximate centres of each site; the radii leave generous room. */
export const EXCLUSIONS: readonly Exclusion[] = [
  { city: 'lagos', name: 'Murtala Muhammed International Airport', at: [3.3212, 6.5774], radiusKm: AIRPORT_KM, why: 'restricted airport area' },
  { city: 'new-york', name: 'John F. Kennedy International Airport', at: [-73.7781, 40.6413], radiusKm: AIRPORT_KM, why: 'restricted airport area' },
  { city: 'new-york', name: 'LaGuardia Airport', at: [-73.874, 40.7769], radiusKm: AIRPORT_KM, why: 'restricted airport area' },
  { city: 'new-york', name: 'Newark Liberty International Airport', at: [-74.1745, 40.6895], radiusKm: AIRPORT_KM, why: 'restricted airport area' },
  { city: 'nairobi', name: 'Jomo Kenyatta International Airport', at: [36.9278, -1.3192], radiusKm: AIRPORT_KM, why: 'restricted airport area' },
  { city: 'nairobi', name: 'Wilson Airport', at: [36.8148, -1.3217], radiusKm: 2, why: 'restricted airport area' },
  { city: 'hong-kong', name: 'Hong Kong International Airport', at: [113.9185, 22.308], radiusKm: AIRPORT_KM + 1, why: 'restricted airport area' },
  { city: 'london', name: 'Heathrow Airport', at: [-0.4543, 51.47], radiusKm: AIRPORT_KM + 1, why: 'restricted airport area' },
  { city: 'london', name: 'London City Airport', at: [0.0553, 51.5053], radiusKm: 2, why: 'restricted airport area' },
  { city: 'dubai', name: 'Dubai International Airport', at: [55.3657, 25.2532], radiusKm: AIRPORT_KM + 1, why: 'restricted airport area' },
  { city: 'dubai', name: 'Al Maktoum International Airport', at: [55.1614, 24.8963], radiusKm: AIRPORT_KM, why: 'restricted airport area' },
  { city: 'paris', name: 'Paris-Orly Airport', at: [2.3652, 48.7262], radiusKm: AIRPORT_KM, why: 'restricted airport area' },
  { city: 'miami', name: 'Miami International Airport', at: [-80.287, 25.7959], radiusKm: AIRPORT_KM, why: 'restricted airport area' },
  { city: 'miami', name: 'Homestead Air Reserve Base', at: [-80.3836, 25.4886], radiusKm: 4, why: 'military site' },
  { city: 'nicosia', name: 'Nicosia buffer zone (Green Line)', at: [33.3647, 35.1733], radiusKm: 1.2, why: 'United Nations buffer zone' },
];

export interface Placement { city: string; lng: number; lat: number; radiusM: number }

/** Why a zone may not be placed, or null when it passes the automatic checks. */
export function placementProblem(p: Placement): string | null {
  const city: City | undefined = cityById(p.city);
  if (!city) return 'Unknown city.';
  if (!inBounds(city, [p.lng, p.lat])) return `That place is outside ${city.name}.`;
  if (!Number.isInteger(p.radiusM) || p.radiusM < 10 || p.radiusM > 500) return 'A zone is 10 to 500 metres across.';
  for (const x of EXCLUSIONS) {
    if (x.city !== p.city) continue;
    if (distanceKm([p.lng, p.lat], x.at) < x.radiusKm + p.radiusM / 1000) return `Too close to ${x.name} (${x.why}).`;
  }
  return null;
}
