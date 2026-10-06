/**
 * Aretia Token Risk Engine, first framework. A pure function from facts to an explainable result.
 *
 * Principles:
 *  - Every point of score comes from a named signal with evidence. There is no hidden number.
 *  - A signal that could not be checked is listed as unavailable. It adds nothing and is never guessed.
 *  - Too few checked signals means no score at all, not a flattering one.
 *  - The result is a risk classification, never a safety claim: there is no "safe" status.
 */
import type { RiskSignal, RiskStatus, TokenRisk } from '../core/types.js';

/** Facts about a Solana mint. `undefined`/`null` means "could not be determined". */
export interface SolanaRiskFacts {
  mintAuthoritySet?: boolean | null;
  freezeAuthoritySet?: boolean | null;
  /** Token-2022 mint with extensions (for example a transfer fee or hook). */
  hasExtensions?: boolean | null;
  /** Share of supply held by the 10 largest accounts, 0..100. Pool vaults are not excluded, so this can overstate. */
  top10Pct?: number | null;
  /** 'wallets' when program-controlled accounts (pools, vaults) were excluded; otherwise 'all'. */
  top10Basis?: 'all' | 'wallets';
  liquidityUsd?: number | null;
  volume24hUsd?: number | null;
  poolCount?: number | null;
  ageHours?: number | null;
}

export interface EvmRiskFacts {
  /** 'renounced' = owner is the zero address; 'set' = an owner can still act. */
  owner?: 'renounced' | 'set' | null;
  isProxy?: boolean | null;
  canMint?: boolean | null;
  canBlacklist?: boolean | null;
  canPause?: boolean | null;
  transferRestrictions?: boolean | null;
  buyTaxPct?: number | null;
  sellTaxPct?: number | null;
  sourceVerified?: boolean | null;
  top10Pct?: number | null;
  liquidityUsd?: number | null;
  volume24hUsd?: number | null;
  poolCount?: number | null;
  ageHours?: number | null;
}

export interface RiskOptions {
  /** Aretia's curated verification flag. Only this can produce the 'verified' status. */
  verified?: boolean;
  now?: number;
}

/** Fewer evaluated signals than this and no score is produced. */
export const MIN_SIGNALS_FOR_SCORE = 4;

const fmtUsd = (n: number): string => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}K` : `$${Math.round(n)}`);

class Builder {
  signals: RiskSignal[] = [];
  unavailable: string[] = [];
  restricted = false;

  add(id: string, label: string, state: RiskSignal['state'], detail: string, weight = 0): void {
    this.signals.push({ id, label, state, detail, weight: state === 'ok' || state === 'unavailable' ? 0 : weight });
  }
  missing(id: string, label: string, why = 'Could not be checked.'): void {
    this.unavailable.push(label);
    this.add(id, label, 'unavailable', why);
  }
  flag(id: string, label: string, v: boolean | null | undefined, okText: string, badText: string, weight: number, state: 'warn' | 'bad' = 'warn'): void {
    if (v === null || v === undefined) return this.missing(id, label);
    this.add(id, label, v ? state : 'ok', v ? badText : okText, weight);
  }

  liquidity(v: number | null | undefined, pools: number | null | undefined): void {
    if (pools === 0) this.add('pools', 'Trading pools', 'bad', 'No trading pool was found, so this token may not be tradable.', 25);
    else if (pools === null || pools === undefined) this.missing('pools', 'Trading pools');
    else this.add('pools', 'Trading pools', 'ok', `${pools} pool${pools === 1 ? '' : 's'} found.`);
    if (v === null || v === undefined) return this.missing('liquidity', 'Liquidity');
    if (v < 10_000) this.add('liquidity', 'Liquidity', 'bad', `Only ${fmtUsd(v)} of liquidity: easy to move the price, hard to exit.`, 20);
    else if (v < 50_000) this.add('liquidity', 'Liquidity', 'warn', `${fmtUsd(v)} of liquidity is thin.`, 10);
    else this.add('liquidity', 'Liquidity', 'ok', `${fmtUsd(v)} of liquidity.`);
  }

  concentration(top10: number | null | undefined, basis: 'all' | 'wallets' = 'all'): void {
    if (top10 === null || top10 === undefined) return this.missing('concentration', 'Holder concentration');
    const text = basis === 'wallets' ? `Top 10 wallets hold ${top10.toFixed(0)}% of supply (pools and other program-controlled accounts excluded).` : `Top 10 accounts hold ${top10.toFixed(0)}% of supply (liquidity pools may be included).`;
    if (top10 > 80) this.add('concentration', 'Holder concentration', 'bad', text, 25);
    else if (top10 > 50) this.add('concentration', 'Holder concentration', 'warn', text, 12);
    else this.add('concentration', 'Holder concentration', 'ok', text);
  }

  activity(volume: number | null | undefined): void {
    if (volume === null || volume === undefined) return this.missing('activity', 'Trading activity');
    if (volume <= 0) this.add('activity', 'Trading activity', 'warn', 'No trading volume in the last 24 hours.', 5);
    else this.add('activity', 'Trading activity', 'ok', `${fmtUsd(volume)} traded in 24 hours.`);
  }

  age(hours: number | null | undefined): void {
    if (hours === null || hours === undefined) return this.missing('age', 'Token age', 'No defensible creation or first-pool time is known.');
    if (hours < 1) this.add('age', 'Token age', 'warn', 'Less than 1 hour old.', 12);
    else if (hours < 24) this.add('age', 'Token age', 'warn', `About ${Math.round(hours)} hours old.`, 6);
    else this.add('age', 'Token age', 'ok', `About ${Math.round(hours / 24)} days old.`);
  }

  result(options: RiskOptions, ageHours: number | null | undefined, established = false): TokenRisk {
    const evaluated = this.signals.filter((s) => s.state !== 'unavailable').length;
    const total = this.signals.reduce((sum, s) => sum + s.weight, 0);
    const score = evaluated >= MIN_SIGNALS_FOR_SCORE ? Math.min(100, total) : null;
    const noBad = !this.signals.some((s) => s.state === 'bad');
    return { score, status: classify(score, this.restricted, options.verified === true, ageHours, established && noBad), signals: this.signals, unavailable: this.unavailable, assessedAt: options.now ?? Date.now() };
  }
}

/**
 * "Established" means long-lived (a year or more) with deep, active liquidity ($5M and $500K a day) and no
 * serious red flag. It is a description of track record, not an endorsement and not a claim of safety: the
 * score and every signal stay visible, including admin powers such as minting, blacklisting or upgrading.
 */
export const ESTABLISHED = { minAgeHours: 24 * 365, minLiquidityUsd: 5_000_000, minVolume24hUsd: 500_000 } as const;
const isEstablished = (f: { ageHours?: number | null; liquidityUsd?: number | null; volume24hUsd?: number | null }): boolean =>
  (f.ageHours ?? 0) >= ESTABLISHED.minAgeHours && (f.liquidityUsd ?? 0) >= ESTABLISHED.minLiquidityUsd && (f.volume24hUsd ?? 0) >= ESTABLISHED.minVolume24hUsd;

function classify(score: number | null, restricted: boolean, verified: boolean, ageHours: number | null | undefined, established: boolean): RiskStatus {
  if (restricted) return 'restricted';
  if (score === null) return 'unknown';
  if (established) return verified ? 'verified' : 'established';
  if (score >= 60) return 'high';
  if (score >= 30) return 'elevated';
  if (ageHours !== null && ageHours !== undefined && ageHours < 72) return 'new';
  return verified ? 'verified' : 'unverified';
}

export function assessSolanaToken(f: SolanaRiskFacts, options: RiskOptions = {}): TokenRisk {
  const b = new Builder();
  b.flag('mint-authority', 'Mint authority', f.mintAuthoritySet, 'Mint authority is revoked: no new tokens can be created.', 'Mint authority is still set: more tokens can be created at any time.', 25);
  b.flag('freeze-authority', 'Freeze authority', f.freezeAuthoritySet, 'No freeze authority.', 'A freeze authority is set: holder accounts can be frozen.', 20);
  b.flag('extensions', 'Token-2022 extensions', f.hasExtensions, 'No Token-2022 extensions.', 'Token-2022 extensions are present (for example a transfer fee or hook). Read what they do before trading.', 5);
  b.concentration(f.top10Pct, f.top10Basis);
  b.liquidity(f.liquidityUsd, f.poolCount);
  b.activity(f.volume24hUsd);
  b.age(f.ageHours);
  return b.result(options, f.ageHours, isEstablished(f));
}

export function assessEvmToken(f: EvmRiskFacts, options: RiskOptions = {}): TokenRisk {
  const b = new Builder();
  if (f.owner === null || f.owner === undefined) b.missing('owner', 'Contract ownership');
  else b.add('owner', 'Contract ownership', f.owner === 'set' ? 'warn' : 'ok', f.owner === 'set' ? 'An owner address can still call privileged functions.' : 'Ownership is renounced.', 8);
  b.flag('proxy', 'Upgradeability', f.isProxy, 'Not an upgradeable proxy.', 'This is an upgradeable proxy: its code can be changed.', 15);
  b.flag('mint', 'Mint capability', f.canMint, 'No mint function found.', 'A mint function exists: supply may be increased.', 20);
  b.flag('blacklist', 'Blacklist capability', f.canBlacklist, 'No blacklist function found.', 'A blacklist function exists: addresses can be blocked from trading.', 15);
  b.flag('pause', 'Pause capability', f.canPause, 'No pause function found.', 'A pause function exists: transfers can be halted.', 10);
  b.flag('restrictions', 'Transfer restrictions', f.transferRestrictions, 'No transfer restrictions found.', 'Transfers can be restricted by the contract.', 15);

  const tax = (id: string, label: string, pct: number | null | undefined): void => {
    if (pct === null || pct === undefined) return b.missing(id, label, 'Tax could not be measured. It needs a trade simulation.');
    if (pct >= 50) {
      b.restricted = true;
      b.add(id, label, 'bad', `${label} is ${pct.toFixed(1)}%: effectively a trap.`, 40);
    } else if (pct > 10) b.add(id, label, 'bad', `${label} is ${pct.toFixed(1)}%.`, 25);
    else if (pct > 3) b.add(id, label, 'warn', `${label} is ${pct.toFixed(1)}%.`, 10);
    else b.add(id, label, 'ok', pct === 0 ? `No ${label.toLowerCase()} detected.` : `${label} is ${pct.toFixed(1)}%.`);
  };
  tax('buy-tax', 'Buy tax', f.buyTaxPct);
  tax('sell-tax', 'Sell tax', f.sellTaxPct);
  b.flag('source', 'Contract source', f.sourceVerified === null || f.sourceVerified === undefined ? f.sourceVerified : !f.sourceVerified, 'Source code is verified on a block explorer.', 'Source code is not verified, so what the contract does cannot be read.', 8);
  b.concentration(f.top10Pct);
  b.liquidity(f.liquidityUsd, f.poolCount);
  b.activity(f.volume24hUsd);
  b.age(f.ageHours);
  return b.result(options, f.ageHours, isEstablished(f));
}

/** Plain-language label for the UI. Deliberately has no 'safe' wording. */
export const RISK_LABELS: Readonly<Record<RiskStatus, string>> = {
  established: 'Established',
  new: 'New',
  unverified: 'Unverified',
  verified: 'Verified',
  elevated: 'Elevated risk',
  high: 'High risk',
  restricted: 'Restricted',
  unknown: 'Not enough data',
};
