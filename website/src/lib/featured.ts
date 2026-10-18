/**
 * Featured launches: a hand-agreed list of tokens shown in a clearly labelled strip on the home page (and the Launch page). Pure.
 * The list is src/data/featured.ts. An entry is shown only inside its dates, and only if it passes every rule here; a list with nothing
 * to show draws nothing at all.
 *
 * "Featured" is a placement, not an endorsement and not a rating: it says only that a token was put here by agreement. Aretia's
 * checks on a token are a separate thing (the "Verified by Aretia" badge, src/lib/verified.ts).
 */
import { addressOk, httpsUrl, normalise, VERIFY_CHAINS, type VerifyChain } from './verified';

export interface FeaturedItem {
  /** A short id, used to tell items apart. */
  id: string;
  token: string;
  chain: VerifyChain;
  title: string;
  blurb: string;
  /** A small picture: https, or a file under /assets/featured/. Optional. */
  image?: string;
  /** The run, as ISO dates (YYYY-MM-DD). The last day is included. */
  from: string;
  to: string;
}

export const FEATURED_LIMITS = { title: 60, blurb: 140, max: 6 } as const;

/** The words that sit on every featured item. */
export const FEATURED_LABEL = 'Featured';
export const FEATURED_NOTE = 'Featured places are agreed with the project. They are not a rating, a check or an endorsement.';

const DAY_MS = 86_400_000;
const day = (iso: string): number | null => (/^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? Date.parse(`${iso}T00:00:00Z`) : null);

/** Why an item cannot be shown, or null when it is fine. */
export function problemWith(i: FeaturedItem): string | null {
  if (!i.id || !i.title.trim() || !i.blurb.trim()) return 'a field is empty';
  if (i.title.length > FEATURED_LIMITS.title || i.blurb.length > FEATURED_LIMITS.blurb) return 'a field is too long';
  if (!VERIFY_CHAINS.includes(i.chain)) return 'the chain is not supported';
  if (!addressOk(i.chain, i.token)) return 'the token address is not valid for its chain';
  if (i.image !== undefined && !(httpsUrl(i.image) || /^\/assets\/featured\/[\w.-]+$/.test(i.image))) return 'the image is not https or under /assets/featured/';
  const from = day(i.from);
  const to = day(i.to);
  if (from === null || to === null || to < from) return 'the dates are not a valid run';
  return null;
}

export const isRunning = (i: Pick<FeaturedItem, 'from' | 'to'>, now: number): boolean => {
  const from = day(i.from);
  const to = day(i.to);
  return from !== null && to !== null && now >= from && now < to + DAY_MS;
};

/** True while the item's run has not finished yet (it may be running now or start later). Used to keep expired items out of the page. */
export const notOver = (i: Pick<FeaturedItem, 'to'>, now: number): boolean => {
  const to = day(i.to);
  return to !== null && now < to + DAY_MS;
};

/** The items to show right now: valid, inside their dates, one per token (the latest start wins), earliest start first, at most FEATURED_LIMITS.max. */
export function featuredNow(list: readonly FeaturedItem[], now: number): FeaturedItem[] {
  const byToken = new Map<string, FeaturedItem>();
  for (const i of list) {
    if (problemWith(i) !== null || !isRunning(i, now)) continue;
    const k = `${i.chain}:${normalise(i.chain, i.token)}`;
    const prev = byToken.get(k);
    if (!prev || i.from > prev.from) byToken.set(k, i);
  }
  return [...byToken.values()].sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id)).slice(0, FEATURED_LIMITS.max);
}

/** The page of a token. The public token page reads this hash route: #/<chain>/<address>. */
export const tokenHref = (i: Pick<FeaturedItem, 'chain' | 'token'>): string => `/token#/${i.chain}/${i.token}`;
