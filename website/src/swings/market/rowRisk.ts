/**
 * What Aretia says about each token in the Markets list, so no row is ever left with an empty "not rated".
 *
 * Every row goes through three stages and always shows the best one it has reached:
 *  1. Registry: Aretia has already rated this token (the best answer, used as it is).
 *  2. Market reading: the pool's liquidity, trading and age, which the list already holds. Instant, and honest about
 *     being partial: it cannot see what the contract can do.
 *  3. On-chain check: the contract and holders are read from the chain, with the pool's numbers added. It replaces
 *     the market reading as soon as it finishes.
 * A token that could not be read says "Couldn't check" and why, rather than a label that means nothing.
 */
import type { TokenRisk } from '../core/types.js';
import { assessMarketData, RISK_LABELS } from '../tokens/risk.js';
import type { MarketRow } from './types.js';

export type RowRisk = NonNullable<MarketRow['risk']>;
export type CheckState = 'pending' | 'done' | 'failed';
export type Tone = 'on' | 'warn' | 'bad' | 'off';
/** The colour a rating is drawn in. Grey means "not checked yet"; it never means "fine". */
export type Band = 'green' | 'yellow' | 'orange' | 'red' | 'grey';

/** The colour guide, worst last, in the words shown to people. Green still is not a safety claim. */
export const RATING_BANDS: readonly { band: Band; name: string; meaning: string }[] = [
  { band: 'green', name: 'Green', meaning: 'Established or verified: long-lived with deep trading and no major concerns found.' },
  { band: 'yellow', name: 'Yellow', meaning: 'Unverified: nothing alarming found, but Aretia has not vouched for it.' },
  { band: 'orange', name: 'Orange', meaning: 'New or elevated risk: very little history, or concerns were found. Read them first.' },
  { band: 'red', name: 'Red', meaning: 'High risk or restricted: serious concerns, or the token can stop or tax your trades.' },
  { band: 'grey', name: 'Grey', meaning: 'Not checked yet, or Aretia could not read it. Treat it as unchecked.' },
];

export interface RatingView {
  label: string;
  tone: Tone;
  band: Band;
  /** A partial reading (market data only): drawn lighter, with its limits in the tooltip. */
  soft: boolean;
  /** The on-chain check is still running. */
  checking: boolean;
  title: string;
}

/** The facts the on-chain check gets alongside what it reads from the chain. */
export function marketFactsOf(r: MarketRow): { liquidityUsd: number | null; volume24hUsd: number | null; ageMs: number | null; hasPool: boolean } {
  return { liquidityUsd: r.liquidityUsd, volume24hUsd: r.volume24hUsd, ageMs: r.ageMs, hasPool: !!r.pool };
}

/** The first reading, from the row's own numbers. Pure. */
export function marketReading(r: MarketRow, now = Date.now()): TokenRisk {
  return assessMarketData({ liquidityUsd: r.liquidityUsd, volume24hUsd: r.volume24hUsd, poolCount: r.pool ? 1 : null, ageHours: r.ageMs === null ? null : r.ageMs / 3_600_000 }, { now });
}

export const toRowRisk = (risk: TokenRisk, basis: NonNullable<RowRisk['basis']>): RowRisk => ({ status: risk.status, label: RISK_LABELS[risk.status] ?? risk.status, score: risk.score, basis });

/** A rating that says something: it has a status other than "unknown" and a score. */
const meaningful = (risk: RowRisk | null): risk is RowRisk => risk !== null && risk.status !== 'unknown' && risk.score !== null;

/** Whether the on-chain check should still run for this row. */
export const needsCheck = (r: MarketRow): boolean => !r.risk || r.risk.basis === 'market' || !meaningful(r.risk);

/** Gives a row without a real rating its market reading. Rows that already have one are returned as they are. */
export function withMarketReading(r: MarketRow, now = Date.now()): MarketRow {
  if (meaningful(r.risk) && r.risk.basis !== 'market') return r;
  const reading = marketReading(r, now);
  return reading.score === null ? { ...r, risk: null } : { ...r, risk: toRowRisk(reading, 'market') };
}

const bandOf = (status: string): Band => (status === 'high' || status === 'restricted' ? 'red' : status === 'elevated' || status === 'new' ? 'orange' : status === 'established' || status === 'verified' ? 'green' : status === 'unverified' ? 'yellow' : 'grey');

const toneOf = (status: string): Tone => (status === 'high' || status === 'restricted' ? 'bad' : status === 'elevated' ? 'warn' : status === 'established' || status === 'verified' ? 'on' : 'off');

/** How a row's rating is drawn and explained. */
export function ratingView(r: MarketRow, state: CheckState | undefined): RatingView {
  const risk = r.risk;
  if (meaningful(risk)) {
    const label = risk.label;
    const band = bandOf(risk.status);
    if (risk.basis === 'market') {
      return {
        label,
        tone: toneOf(risk.status),
        band,
        soft: true,
        checking: state !== 'failed',
        title: `${state === 'failed' ? 'Market reading only. The on-chain check could not be made.' : 'Market reading, from liquidity, trading and age. The contract is being checked.'} Behind the colour: concern score ${risk.score}/100 (higher means more concerns). It cannot see what the contract is able to do, so it is not a safety check.`,
      };
    }
    return {
      label,
      tone: toneOf(risk.status),
      band,
      soft: false,
      checking: false,
      title: `${risk.basis === 'registry' ? 'From Aretia\'s token registry.' : 'Checked on-chain by Aretia.'} Behind the colour: concern score ${risk.score}/100 (higher means more concerns). A rating is not advice and not a guarantee.`,
    };
  }
  if (state === 'failed') return { label: 'Couldn\'t check', tone: 'off', band: 'grey', soft: true, checking: false, title: 'Aretia could not read this token just now (it may not be a standard token, or the network did not answer). Open it to try again. Until then, treat it as unchecked.' };
  return { label: 'Checking', tone: 'off', band: 'grey', soft: true, checking: true, title: 'Aretia is reading this token on-chain.' };
}

// ------------------------------------------------------------------ a shared memory of finished checks

const OK_TTL_MS = 30 * 60_000;
const FAIL_TTL_MS = 2 * 60_000;

export const riskKey = (chain: string, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;

/** Finished on-chain checks, shared by the list, the side panel and the swap screen so they always agree. */
export class RiskMemory {
  private readonly items = new Map<string, { risk: TokenRisk | null; at: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  get(chain: string, address: string): { risk: TokenRisk | null } | null {
    const k = riskKey(chain, address);
    const hit = this.items.get(k);
    if (!hit) return null;
    if (this.now() - hit.at > (hit.risk ? OK_TTL_MS : FAIL_TTL_MS)) {
      this.items.delete(k);
      return null;
    }
    return { risk: hit.risk };
  }

  set(chain: string, address: string, risk: TokenRisk | null): void {
    this.items.set(riskKey(chain, address), { risk, at: this.now() });
  }
}

export const riskMemory = new RiskMemory();
