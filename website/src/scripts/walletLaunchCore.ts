/**
 * Aretia Launch on the web wallet: the rules for creating a token on Solana, with no network access and no keys.
 *
 * This is a port of the token-creation rules from the Aretia Launch code in the Aretia Wallet repository
 * (packages/launch-core). It creates ONE thing: a fixed-supply Token-2022 token with its name, symbol and link stored on
 * the token itself. It does not start a sale or open a pool: neither exists on this page yet. The only Aretia charge is the flat
 * creation fee below, paid in SOL in the first transaction.
 *
 * Choices made here, on purpose:
 *  - The mint and freeze powers are always given up. A token made here has a fixed supply and nobody can freeze a holder.
 *    There is no setting to keep them.
 *  - The name, symbol and link can be left changeable, but the default is that they cannot be changed.
 *  - The creator's own share and a treasury share are capped (20% and 10%). Everything else is "held back": it is minted to
 *    the creator's wallet and stays there until the creator does something with it. Nothing here locks it.
 *  - Amounts are whole numbers in the token's smallest unit. No floating point touches an amount.
 */
import { isSolanaAddress, toSmallestUnit } from './walletTools.js';

export const LAUNCH_LIMITS = {
  nameMax: 32,
  symbolMax: 10,
  decimalsMax: 9,
  /** The largest supply a Solana token can hold, in its smallest unit. */
  supplyMax: 2n ** 64n - 1n,
  uriMax: 200,
  /** Provisional product limits, the same as the Aretia Wallet extension. */
  creatorMaxBps: 2000,
  treasuryMaxBps: 1000,
} as const;

const BPS = 10_000n;
/** True if the text has a control character (a line break, a tab, an escape). Names and links may not. */
const hasControl = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const SYMBOL = /^[A-Za-z0-9]+$/;

export interface LaunchForm {
  name: string;
  symbol: string;
  decimals: string;
  /** A whole-token amount, commas allowed: "1,000,000". */
  supply: string;
  /** Percentages like "10" or "12.5". */
  creatorPct: string;
  treasuryPct: string;
  treasuryAddress: string;
  metadataUri: string;
  metadataMutable: boolean;
}

export const DEFAULT_FORM: LaunchForm = {
  name: '',
  symbol: '',
  decimals: '6',
  supply: '1,000,000,000',
  creatorPct: '10',
  treasuryPct: '0',
  treasuryAddress: '',
  metadataUri: '',
  metadataMutable: false,
};

/** What will be created. Everything the review screen shows and the transactions contain comes from this. */
export interface LaunchConfig {
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyRaw: bigint;
  creatorBps: number;
  treasury: { address: string; bps: number } | null;
  /** The share held back for a future sale or pool. Minted to the creator's wallet. */
  reservedBps: number;
  metadataUri: string;
  metadataMutable: boolean;
}

export interface FieldIssue {
  field: keyof LaunchForm | 'form';
  message: string;
}

/** "12.5" -> 1250. Null unless it is a plain percentage with at most two decimals. */
export function pctToBps(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

export function bpsText(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2).replace(/(\.\d)0$/, '$1')}%`;
}

function checkUri(value: string): boolean {
  if (value.length > LAUNCH_LIMITS.uriMax || hasControl(value)) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'ipfs:';
  } catch {
    return false;
  }
}

/** The amount an allocation earmarks. Exact: validation rejects any share that does not divide the supply into whole units. */
export const shareOf = (totalSupplyRaw: bigint, bps: number): bigint => (totalSupplyRaw * BigInt(bps)) / BPS;

export type LaunchValidation = { ok: true; config: LaunchConfig } | { ok: false; issues: FieldIssue[] };

export function validateLaunch(form: LaunchForm, creator: string): LaunchValidation {
  const issues: FieldIssue[] = [];
  const add = (field: FieldIssue['field'], message: string) => issues.push({ field, message });

  if (!isSolanaAddress(creator)) add('form', 'Connect a wallet first.');

  const name = form.name.trim();
  if (name === '' || name.length > LAUNCH_LIMITS.nameMax || hasControl(name))
    add('name', `Required, at most ${LAUNCH_LIMITS.nameMax} characters.`);
  const symbol = form.symbol.trim();
  if (!SYMBOL.test(symbol) || symbol.length > LAUNCH_LIMITS.symbolMax)
    add('symbol', `Letters and digits only, 1 to ${LAUNCH_LIMITS.symbolMax} characters.`);

  let decimals = Number.NaN;
  if (/^\d{1,2}$/.test(form.decimals.trim())) decimals = Number(form.decimals.trim());
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > LAUNCH_LIMITS.decimalsMax)
    add('decimals', `A whole number from 0 to ${LAUNCH_LIMITS.decimalsMax}.`);

  let totalSupplyRaw = 0n;
  if (Number.isInteger(decimals) && decimals >= 0 && decimals <= LAUNCH_LIMITS.decimalsMax) {
    const raw = toSmallestUnit(form.supply.replace(/,/g, '').trim(), decimals);
    if (raw === null || BigInt(raw) <= 0n)
      add('supply', 'A number above zero, with no more decimal places than the token has.');
    else {
      totalSupplyRaw = BigInt(raw);
      if (totalSupplyRaw > LAUNCH_LIMITS.supplyMax)
        add('supply', 'Too large: a Solana token cannot hold more than 18,446,744,073,709,551,615 of its smallest unit.');
    }
  }

  const creatorBps = pctToBps(form.creatorPct);
  if (creatorBps === null) add('creatorPct', 'A percentage like 10 or 12.5.');
  else if (creatorBps > LAUNCH_LIMITS.creatorMaxBps)
    add('creatorPct', `At most ${LAUNCH_LIMITS.creatorMaxBps / 100}%. The rest is held back and stays in your wallet.`);
  const treasuryBps = pctToBps(form.treasuryPct);
  if (treasuryBps === null) add('treasuryPct', 'A percentage like 0 or 5.');
  else if (treasuryBps > LAUNCH_LIMITS.treasuryMaxBps) add('treasuryPct', `At most ${LAUNCH_LIMITS.treasuryMaxBps / 100}%.`);

  const treasuryAddress = form.treasuryAddress.trim();
  if (treasuryBps !== null && treasuryBps > 0) {
    if (!isSolanaAddress(treasuryAddress)) add('treasuryAddress', 'A valid Solana address is required for the treasury share.');
  } else if (treasuryAddress !== '' && !isSolanaAddress(treasuryAddress)) {
    add('treasuryAddress', 'Not a valid Solana address.');
  }

  const metadataUri = form.metadataUri.trim();
  if (metadataUri !== '' && !checkUri(metadataUri))
    add('metadataUri', `An https: or ipfs: link of at most ${LAUNCH_LIMITS.uriMax} characters.`);

  let reservedBps = 0;
  if (creatorBps !== null && treasuryBps !== null) {
    reservedBps = 10_000 - creatorBps - treasuryBps;
    if (reservedBps <= 0) add('form', 'The shares you keep must leave something held back for a sale or pool.');
    if (totalSupplyRaw > 0n) {
      for (const [label, bps] of [['Your share', creatorBps], ['The treasury share', treasuryBps], ['The held-back share', reservedBps]] as const) {
        if (bps > 0 && (totalSupplyRaw * BigInt(bps)) % BPS !== 0n)
          add('form', `${label} does not divide the supply into whole units. Adjust the supply or the percentages.`);
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  const config: LaunchConfig = {
    creator,
    name,
    symbol,
    decimals,
    totalSupplyRaw,
    creatorBps: creatorBps as number,
    treasury: (treasuryBps as number) > 0 ? { address: treasuryAddress, bps: treasuryBps as number } : null,
    reservedBps,
    metadataUri,
    metadataMutable: form.metadataMutable,
  };
  return { ok: true, config };
}

export interface DistributionLine {
  owner: string;
  amount: bigint;
  /** What the amount is, for the review screen. */
  labels: string[];
}

/**
 * Who receives what. The creator receives their own share and the held-back share; a treasury share goes to its address. If the
 * treasury address is the creator's own, the two are one line.
 */
export function distributionOf(config: LaunchConfig): DistributionLine[] {
  const lines = new Map<string, DistributionLine>();
  const put = (owner: string, amount: bigint, label: string) => {
    const prev = lines.get(owner);
    lines.set(owner, { owner, amount: (prev?.amount ?? 0n) + amount, labels: [...(prev?.labels ?? []), label] });
  };
  if (config.creatorBps > 0) put(config.creator, shareOf(config.totalSupplyRaw, config.creatorBps), `your ${bpsText(config.creatorBps)}`);
  if (config.treasury) put(config.treasury.address, shareOf(config.totalSupplyRaw, config.treasury.bps), `treasury ${bpsText(config.treasury.bps)}`);
  put(config.creator, shareOf(config.totalSupplyRaw, config.reservedBps), `${bpsText(config.reservedBps)} held back for a future sale or pool`);
  return [...lines.values()];
}

export interface Disclosure {
  severity: 'info' | 'caution';
  text: string;
}

/** Plain-language consequences, shown before signing. Never says a token is safe. */
export function disclosuresOf(config: LaunchConfig): Disclosure[] {
  const out: Disclosure[] = [
    { severity: 'info', text: 'Nobody can ever create more of this token. The supply is fixed at launch.' },
    { severity: 'info', text: "Nobody can freeze a holder's tokens." },
    config.metadataMutable
      ? { severity: 'caution', text: 'The name, symbol and link can be changed after launch by you, including in ways that mislead holders.' }
      : { severity: 'info', text: 'The name, symbol and link cannot be changed after launch.' },
    {
      severity: 'caution',
      text: `${bpsText(config.reservedBps)} of the supply is held back in your wallet. Nothing locks it. Anyone who holds a token can see that you hold it, and you could send or sell it at any time.`,
    },
    {
      severity: 'caution',
      text: 'Creating a token does not create a market. Nobody can buy it until a sale or a liquidity pool exists, and this page does not make one.',
    },
    {
      severity: 'caution',
      text: 'This is on Solana mainnet. The transactions are real, the network fee and deposits are paid in your SOL, and a created token cannot be deleted.',
    },
  ];
  return out;
}

export const BASE_FEE_LAMPORTS = 5_000n;

/**
 * Aretia's flat fee for creating a token: 0.05 SOL, paid from the creator's wallet in the first transaction. It goes to the
 * management-fee wallet recorded in MANAGEMENT_FEE.md, which is separate from the treasury multisig. The fee is fixed in code, not
 * read from the network or from the form, so the check before signing can refuse any other amount or recipient.
 */
export const LAUNCH_FEE_LAMPORTS = 50_000_000n;
export const LAUNCH_FEE_ADDRESS = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';

export interface CostEstimate {
  /** Network fees: two transactions, the first signed twice (you and the new token's key). */
  networkFee: bigint;
  /** Aretia's flat creation fee. */
  aretiaFee: bigint;
  /** Deposit that keeps the token's own account alive. Not refundable in practice: the token stays. */
  mintDeposit: bigint;
  /** One deposit per wallet that receives tokens. */
  tokenAccountDeposits: bigint;
  accountCount: number;
  total: bigint;
}

export function estimateCost(args: { mintDeposit: bigint; tokenAccountDeposit: bigint; accountCount: number }): CostEstimate {
  const networkFee = BASE_FEE_LAMPORTS * 3n; // 2 signatures + 1 signature
  const accountDeposits = args.tokenAccountDeposit * BigInt(args.accountCount);
  return {
    networkFee,
    aretiaFee: LAUNCH_FEE_LAMPORTS,
    mintDeposit: args.mintDeposit,
    tokenAccountDeposits: accountDeposits,
    accountCount: args.accountCount,
    total: networkFee + LAUNCH_FEE_LAMPORTS + args.mintDeposit + accountDeposits,
  };
}

/** JSON-safe form for storage. */
export type LaunchConfigJson = Omit<LaunchConfig, 'totalSupplyRaw'> & { totalSupplyRaw: string };
export const configToJson = (c: LaunchConfig): LaunchConfigJson => ({ ...c, totalSupplyRaw: c.totalSupplyRaw.toString() });

/** Rebuilds a config from stored JSON, checking every field. Returns null for anything malformed. */
export function configFromJson(input: unknown): LaunchConfig | null {
  if (typeof input !== 'object' || input === null) return null;
  const c = input as Record<string, unknown>;
  if (typeof c.creator !== 'string' || !isSolanaAddress(c.creator)) return null;
  if (typeof c.name !== 'string' || typeof c.symbol !== 'string' || typeof c.metadataUri !== 'string') return null;
  if (typeof c.decimals !== 'number' || !Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > LAUNCH_LIMITS.decimalsMax) return null;
  if (typeof c.totalSupplyRaw !== 'string' || !/^[1-9]\d*$/.test(c.totalSupplyRaw)) return null;
  const supply = BigInt(c.totalSupplyRaw);
  if (supply > LAUNCH_LIMITS.supplyMax) return null;
  if (typeof c.creatorBps !== 'number' || typeof c.reservedBps !== 'number' || typeof c.metadataMutable !== 'boolean') return null;
  let treasury: LaunchConfig['treasury'] = null;
  if (c.treasury !== null) {
    const t = c.treasury as Record<string, unknown> | undefined;
    if (!t || typeof t.address !== 'string' || !isSolanaAddress(t.address) || typeof t.bps !== 'number') return null;
    treasury = { address: t.address, bps: t.bps };
  }
  const config: LaunchConfig = {
    creator: c.creator,
    name: c.name,
    symbol: c.symbol,
    decimals: c.decimals,
    totalSupplyRaw: supply,
    creatorBps: c.creatorBps,
    treasury,
    reservedBps: c.reservedBps,
    metadataUri: c.metadataUri,
    metadataMutable: c.metadataMutable,
  };
  // The shares must be a complete, exact division of the supply, whatever was stored.
  const total = config.creatorBps + config.reservedBps + (treasury?.bps ?? 0);
  if (total !== 10_000 || config.reservedBps <= 0) return null;
  for (const bps of [config.creatorBps, config.reservedBps, treasury?.bps ?? 0]) {
    if (!Number.isInteger(bps) || bps < 0 || (supply * BigInt(bps)) % BPS !== 0n) return null;
  }
  return config;
}
