/**
 * Street-level imagery from Mapillary: photographs taken on the street by people around the world, shared under CC BY-SA 4.0 (so the
 * credit "Imagery © Mapillary contributors, CC BY-SA 4.0" is always shown beside it). The page asks Mapillary's public API for the
 * photograph nearest a point and shows Mapillary's own viewer for it. Nothing is invented: where there is no photograph near a point,
 * the page says so.
 *
 * It needs a Mapillary client token, a public key made free in a Mapillary developer account, set as PUBLIC_MAPILLARY_TOKEN when the
 * site is built. Without one, the street view button explains that it is not set up.
 */
export const MAPILLARY_CREDIT = 'Imagery © Mapillary contributors, CC BY-SA 4.0';

/** A Mapillary client token looks like "MLY|<digits>|<hex>". */
export const isMapillaryToken = (v: unknown): v is string => typeof v === 'string' && /^MLY\|\d+\|[0-9a-zA-Z]+$/.test(v);

/** How near a photograph must be to count as "here", in metres. */
export const SEARCH_RADIUS_M = 120;

export interface StreetImage {
  id: string;
  lng: number;
  lat: number;
}

export function imageSearchUrl(token: string, lng: number, lat: number): string {
  const q = new URLSearchParams({ access_token: token, fields: 'id,computed_geometry', closeto: `${lng},${lat}`, radius: String(SEARCH_RADIUS_M), limit: '1' });
  return `https://graph.mapillary.com/images?${q.toString()}`;
}

/** Mapillary's embeddable viewer for one photograph. */
export function embedUrl(imageId: string): string {
  return `https://www.mapillary.com/embed?image_key=${encodeURIComponent(imageId)}&style=photo`;
}

/** Where the photograph can be opened on Mapillary itself. */
export function pageUrl(imageId: string, lng: number, lat: number): string {
  return `https://www.mapillary.com/app/?pKey=${encodeURIComponent(imageId)}&lat=${lat}&lng=${lng}&z=17&focus=photo`;
}

/** Reads the answer of the image search into at most one photograph. */
export function parseImages(body: unknown): StreetImage | null {
  const first = (body as { data?: unknown[] } | null)?.data?.[0] as { id?: unknown; computed_geometry?: { coordinates?: unknown } } | undefined;
  const id = typeof first?.id === 'string' || typeof first?.id === 'number' ? String(first.id) : '';
  const c = first?.computed_geometry?.coordinates;
  if (!/^\d{5,20}$/.test(id) || !Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
  return { id, lng: c[0], lat: c[1] };
}

/** The nearest photograph to a point, or null when there is none (or the service could not be reached). */
export async function nearestImage(token: string, lng: number, lat: number, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<{ image: StreetImage | null; failed: boolean }> {
  try {
    const res = await fetchImpl(imageSearchUrl(token, lng, lat));
    if (!res.ok) return { image: null, failed: true };
    return { image: parseImages(await res.json()), failed: false };
  } catch {
    return { image: null, failed: true };
  }
}

/** Tiles of the lines where photographs have been taken, to show on the map. */
export const coverageTiles = (token: string): string => `https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=${encodeURIComponent(token)}`;
