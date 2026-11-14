/**
 * The rules the server holds roaming to. The page moves the player freely in the 3D world and reports where they are every moment or
 * two; the server refuses any report that is further from the last one than this way of travelling allows in the time that has passed.
 * That is what keeps a treasure collectable only by someone who actually got there, and a page that lies cannot teleport.
 */
import { distanceKm, type LngLat } from './travel.js';

export type RoamMode = 'walk' | 'run' | 'car' | 'boat';
export const ROAM_MODES: readonly RoamMode[] = ['walk', 'run', 'car', 'boat'];
export const isRoamMode = (v: unknown): v is RoamMode => typeof v === 'string' && (ROAM_MODES as readonly string[]).includes(v);

/** Fastest each way of travelling goes in the 3D world, in metres a second, with a margin for network delay and frame jitter. */
export const MAX_SPEED_MS: Record<RoamMode, number> = { walk: 3.6, run: 8.5, car: 32, boat: 20 };
/** Extra metres allowed on top, for the delay between a move and its report. */
export const SLACK_M = 40;
/** A long silence does not earn a long jump: time counts for at most this long. */
export const MAX_GAP_MS = 60_000;

export function allowedMetres(mode: RoamMode, gapMs: number): number {
  return MAX_SPEED_MS[mode] * (Math.min(Math.max(gapMs, 0), MAX_GAP_MS) / 1000) + SLACK_M;
}

export function roamAllowed(from: LngLat, to: LngLat, mode: RoamMode, gapMs: number): { ok: boolean; metres: number; limit: number } {
  const metres = distanceKm(from, to) * 1000;
  const limit = allowedMetres(mode, gapMs);
  return { ok: metres <= limit, metres, limit };
}
