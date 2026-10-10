/**
 * Direct sponsorships. A sponsor is a hand-approved card (a headline, a line of copy, one link) that Aretia agrees with
 * the advertiser and lists in src/data/sponsors.ts. There is no ad network, no script from anyone else, and no tracking:
 * a card is plain text and a link. Every one is labelled "Ad", sits away from the rating and the swap button, and never
 * changes a token's rating.
 */
import type { ChainId } from '../swings/core/types.js';

/** Where a card can appear: beside a token in the Markets panel, or under the Markets list. */
export type SlotId = 'token-panel' | 'market-footer';
export const SLOTS: readonly SlotId[] = ['token-panel', 'market-footer'];

export interface Sponsor {
  id: string;
  advertiser: string;
  headline: string;
  body: string;
  cta: string;
  /** https only. */
  href: string;
  /** A small logo: https, or a file under /assets/sponsors/. Optional. */
  image?: string;
  slots: readonly SlotId[];
  /** Only shown beside tokens on these chains. Leave out to show on all. */
  chains?: readonly ChainId[];
  /** The run, as ISO dates (YYYY-MM-DD). The last day is included. */
  from: string;
  to: string;
}

export const LIMITS = { advertiser: 40, headline: 60, body: 140, cta: 24 } as const;

const DAY_MS = 86_400_000;
const day = (iso: string): number | null => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : null);

const httpsUrl = (v: string): boolean => {
  try {
    const u = new URL(v);
    // A real hostname: not an address typed in numbers, not localhost.
    return u.protocol === 'https:' && u.hostname.includes('.') && !/^[\d.]+$/.test(u.hostname) && u.hostname !== 'localhost';
  } catch {
    return false;
  }
};

/** Why a sponsor cannot be shown, or null when it is fine. Anything that fails is simply not shown. */
export function problemWith(s: Sponsor): string | null {
  if (!s.id || !s.advertiser || !s.headline || !s.body || !s.cta) return 'a field is empty';
  if (s.advertiser.length > LIMITS.advertiser || s.headline.length > LIMITS.headline || s.body.length > LIMITS.body || s.cta.length > LIMITS.cta) return 'a field is too long';
  if (!httpsUrl(s.href)) return 'the link is not an https address';
  if (s.image !== undefined && !(httpsUrl(s.image) || /^\/assets\/sponsors\/[\w.-]+$/.test(s.image))) return 'the image is not https or under /assets/sponsors/';
  if (s.slots.length === 0 || s.slots.some((x) => !SLOTS.includes(x))) return 'it names no valid slot';
  const from = day(s.from);
  const to = day(s.to);
  if (from === null || to === null || to < from) return 'the dates are not a valid run';
  return null;
}

export const isRunning = (s: Sponsor, now: number): boolean => {
  const from = day(s.from);
  const to = day(s.to);
  return from !== null && to !== null && now >= from && now < to + DAY_MS;
};

/** The sponsors that may be shown in a slot right now, for this context. */
export function sponsorsFor(all: readonly Sponsor[], slot: SlotId, now: number, ctx: { chain?: ChainId } = {}): Sponsor[] {
  return all.filter((s) => problemWith(s) === null && isRunning(s, now) && s.slots.includes(slot) && (!s.chains || s.chains.length === 0 || (ctx.chain !== undefined && s.chains.includes(ctx.chain))));
}

const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * One sponsor from those available. The same seed (for example a token) always gets the same card, so a card does not
 * flicker as the page redraws, and different tokens share the slot out evenly.
 */
export function pickSponsor(list: readonly Sponsor[], seed: string): Sponsor | null {
  if (list.length === 0) return null;
  return list[hash(seed) % list.length]!;
}
