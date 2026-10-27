/**
 * Aretia Pool on Ethereum-style chains: the rules for opening and trading a pool on Aretia's own swap contract, with no network access and
 * no keys.
 *
 * The contract is contracts-evm/AretiaPool.sol (design record: docs/ARETIA_POOL_EVM.md). It is UNAUDITED and not deployed on any mainnet.
 * This file follows the build after the October 2026 review: deadlines on every trade and liquidity call, the protocol share owed and
 * withdrawn separately (never sent inside a trade), the creator's liquidity always locked, `pools()` reporting how much is locked, and
 * LP-fee rounding carried (`accRemainder`).
 * This file is its web side. The maths is the contract's, in BigInt, written to match it exactly and checked against the compiled
 * contract by walletAretiaPoolEvmContract.test.ts.
 *
 * Two things keep this off until the contract has been audited and deployed: the build flag PUBLIC_ARETIA_POOL_EVM_ENABLED, and a table
 * of contract addresses (EVM_POOL_ADDRESSES) in which every mainnet entry is null.
 */
import { fromSmallestUnit, toSmallestUnit } from './walletTools';
import { chainByKey, FEE_ADDRESS, isEvmAddress, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { coinToWei } from './walletCurveEvmCore';

/** The deployed AretiaPool on each chain, lower-case. Null until deployed. Nothing works for a chain whose entry is null. */
export const EVM_POOL_ADDRESSES: Readonly<Partial<Record<LaunchEvmChainKey, string | null>>> = {
  // BNB Chain mainnet: deployed 2026-10-27 in tx 0xaa02c544c6ea6f9f46a384462f56bf4eb30a8c036743cd6a8015fbb901f73f2d, and checked byte for byte
  // against the committed build by `scripts/pool-evm.mjs verify --chain bnb`. UNAUDITED. The Launch card stays off unless the build sets
  // PUBLIC_ARETIA_POOL_EVM_ENABLED=1.
  bnb: '0x195fa7d999f567c8e198e961da8270911905753c',
  ethereum: null,
  polygon: null,
  bscTestnet: null,
  // The Sepolia deployment 0x5e93e9023e8891ffbe7bfac6e989d64fe49a3421 is the OLD build (pre October 2026 review: no deadlines, fee pushed
  // inside trades, optional lock). This page now speaks the NEW build's ABI, so it is off until the new build is deployed with
  // website/scripts/pool-evm.mjs and its address (and deploy block below) written here.
  sepolia: null,
  polygonAmoy: null,
};

/**
 * The block each pool was deployed in (a number), set together with its address, or null. "Your pools" reads the contract's event logs from
 * here, so it never has to scan a whole chain. A chain with an address and no block is not listed.
 */
export const EVM_POOL_DEPLOY_BLOCKS: Readonly<Partial<Record<LaunchEvmChainKey, number | null>>> = {
  bnb: 130024337,
  ethereum: null,
  polygon: null,
  bscTestnet: null,
  // Set with the new build's address (the old build's block was 11939451).
  sepolia: null,
  polygonAmoy: null,
};

/**
 * Token factories on test networks that LAUNCH_EVM_CHAINS does not list yet, deployed by scripts/pool-evm.mjs deploy with the test fee. Same
 * bytecode as the mainnet factories. The pool accepts tokens only from the factory named here.
 */
export const EVM_POOL_TEST_FACTORIES: Readonly<Partial<Record<LaunchEvmChainKey, string>>> = {
  sepolia: '0xac1b5010eab26f6d5e53e0ee9c246376a914891e',
};

export const POOL_PROTOCOL_SHARE_BPS = 2000n;
export const POOL_FEE_TIERS = [25, 100] as const;
export type PoolFeeTier = (typeof POOL_FEE_TIERS)[number];
export const POOL_MIN_X = 1000n;
export const POOL_MIN_L = 10n ** 12n;
export const POOL_MIN_DL = 1000n;
export const POOL_MAX = 1n << 112n;
export const POOL_SCALE_BITS = 64n;
export const POOL_SLIPPAGE_BPS_DEFAULT = 100;
/** Every trade and liquidity call carries a deadline this far ahead of when it is built. The inspector accepts at most an hour. */
export const POOL_DEADLINE_SECS = 20 * 60;

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n);

export interface EvmPoolChain {
  key: LaunchEvmChainKey;
  chainId: number;
  name: string;
  symbol: string;
  testnet: boolean;
  explorer: string;
  /** The AretiaPool contract, lower-case. */
  pool: string;
  /** The token factory the pool accepts tokens from, lower-case. */
  factory: string;
  /** The flat creation fee, wei. The pool's own `creationFee()` must equal it. */
  creationFee: bigint;
  /** Where the creation fee and the protocol share go. */
  feeAddress: string;
}

/**
 * The chain's pool setup, or null when there is no deployed contract, or the chain lacks a factory. `factories` overrides the factory
 * addresses (tests, and testnets before their factory is written into LAUNCH_EVM_CHAINS).
 */
export function evmPoolChain(
  key: string,
  addresses: Readonly<Partial<Record<LaunchEvmChainKey, string | null>>> = EVM_POOL_ADDRESSES,
  factories: Readonly<Partial<Record<LaunchEvmChainKey, string>>> = EVM_POOL_TEST_FACTORIES,
): EvmPoolChain | null {
  const k = key as LaunchEvmChainKey;
  const chain = chainByKey(k);
  const pool = addresses[k];
  const factory = factories[k] ?? chain?.factory;
  if (!chain || !pool || !factory || !chain.feeAddress || !isEvmAddress(pool) || !isEvmAddress(factory)) return null;
  return { key: k, chainId: chain.chainId, name: chain.name, symbol: chain.symbol, testnet: chain.testnet, explorer: chain.explorer, pool: pool.toLowerCase(), factory: factory.toLowerCase(), creationFee: chain.feeWei, feeAddress: chain.feeAddress };
}

// ---------------------------------------------------------------- the maths (the contract's, in BigInt)

export interface EvmPoolMath {
  feeBps: bigint;
  x: bigint;
  y: bigint;
  l: bigint;
  acc: bigint;
  feeReserve: bigint;
  /** LP fee (scaled by 2^64) not yet spread into `acc`; carried to the next fee. Missing means zero. */
  accRemainder?: bigint;
}

/** The fee, and how it splits: protocol is taken at once, lp is credited to positions. protocol + lp === fee exactly. */
export function splitFee(fee: bigint): { protocol: bigint; lp: bigint } {
  const protocol = (fee * POOL_PROTOCOL_SHARE_BPS) / BPS;
  return { protocol, lp: fee - protocol };
}

/** The contract's `_creditFees`: the LP part is spread into `acc`, the remainder carried. */
const credit = (m: EvmPoolMath, lp: bigint): { acc: bigint; feeReserve: bigint; accRemainder: bigint } => {
  const scaled = (lp << POOL_SCALE_BITS) + (m.accRemainder ?? 0n);
  return { acc: m.acc + scaled / m.l, feeReserve: m.feeReserve + lp, accRemainder: scaled % m.l };
};

export interface EvmPoolBuyQuote {
  gross: bigint;
  fee: bigint;
  protocol: bigint;
  lp: bigint;
  net: bigint;
  tokensOut: bigint;
  next: EvmPoolMath;
}

/** What the contract's `buy` does for a payment of `offered`. */
export function poolQuoteBuy(m: EvmPoolMath, offered: bigint): EvmPoolBuyQuote | null {
  if (offered <= 0n || offered >= POOL_MAX) return null;
  const fee = ceilDiv(offered * m.feeBps, BPS);
  const net = offered - fee;
  if (net === 0n) return null;
  const yy = m.y + m.l;
  const out = m.x - ceilDiv(m.x * yy, yy + net);
  if (out <= 0n) return null;
  const { protocol, lp } = splitFee(fee);
  const next: EvmPoolMath = { ...m, x: m.x - out, y: m.y + net, ...credit(m, lp) };
  if (next.y + next.l >= POOL_MAX) return null;
  return { gross: offered, fee, protocol, lp, net, tokensOut: out, next };
}

export interface EvmPoolSellQuote {
  gross: bigint;
  fee: bigint;
  protocol: bigint;
  lp: bigint;
  net: bigint;
  next: EvmPoolMath;
}

/** What the contract's `sell` does for `tokens` handed back. */
export function poolQuoteSell(m: EvmPoolMath, tokens: bigint): EvmPoolSellQuote | null {
  if (tokens <= 0n || m.x + tokens >= POOL_MAX) return null;
  const yy = m.y + m.l;
  const gross = yy - ceilDiv(m.x * yy, m.x + tokens);
  if (gross === 0n || gross > m.y) return null;
  const fee = ceilDiv(gross * m.feeBps, BPS);
  const { protocol, lp } = splitFee(fee);
  return { gross, fee, protocol, lp, net: gross - fee, next: { ...m, x: m.x + tokens, y: m.y - gross, ...credit(m, lp) } };
}

export interface EvmPoolAddQuote {
  tokens: bigint;
  coin: bigint;
  next: EvmPoolMath;
}

/** What `addLiquidity(dl)` costs: both sides rounded up. */
export function poolQuoteAdd(m: EvmPoolMath, dl: bigint): EvmPoolAddQuote | null {
  if (dl < POOL_MIN_DL) return null;
  const tokens = ceilDiv(m.x * dl, m.l);
  const coin = ceilDiv(m.y * dl, m.l);
  const next = { ...m, x: m.x + tokens, y: m.y + coin, l: m.l + dl };
  if (next.x >= POOL_MAX || next.y + next.l >= POOL_MAX) return null;
  return { tokens, coin, next };
}

export interface EvmPoolRemoveQuote {
  tokens: bigint;
  coin: bigint;
  next: EvmPoolMath;
}

/** What `removeLiquidity(dl)` pays: both sides rounded down. Null when it would leave less than the minimum liquidity. */
export function poolQuoteRemove(m: EvmPoolMath, dl: bigint): EvmPoolRemoveQuote | null {
  if (dl <= 0n || dl > m.l || m.l - dl < POOL_MIN_L) return null;
  const tokens = (m.x * dl) / m.l;
  const coin = (m.y * dl) / m.l;
  return { tokens, coin, next: { ...m, x: m.x - tokens, y: m.y - coin, l: m.l - dl } };
}

export interface EvmPosition {
  open: boolean;
  shares: bigint;
  locked: bigint;
  checkpoint: bigint;
  pending: bigint;
  /** Lower-case, or null when fees go to the owner. */
  recipient: string | null;
}

/** Fees a position could claim now: settled plus accrued, rounded down. */
export const poolClaimable = (m: Pick<EvmPoolMath, 'acc'>, p: EvmPosition): bigint => (p.open ? p.pending + ((p.shares * (m.acc - p.checkpoint)) >> POOL_SCALE_BITS) : 0n);

export const evmMinOut = (quoted: bigint, slippageBps: number): bigint => (quoted * (BPS - BigInt(slippageBps))) / BPS;
export const evmMaxIn = (quoted: bigint, slippageBps: number): bigint => ceilDiv(quoted * (BPS + BigInt(slippageBps)), BPS);

/** Coin per whole token at the pool's current marginal price, as text with up to 18 places. */
export function poolPriceText(m: Pick<EvmPoolMath, 'x' | 'y' | 'l'>, decimals: number): string {
  if (m.x === 0n) return '0';
  return fromSmallestUnit(((m.y + m.l) * 10n ** BigInt(decimals)) / m.x, 18);
}

// ---------------------------------------------------------------- reading a pool from the chain

export interface EvmPoolState extends EvmPoolMath {
  creator: string;
  createdAt: bigint;
  /** Liquidity locked for good across every position. Never falls; at least the creator's starting liquidity. */
  locked: bigint;
  accRemainder: bigint;
}

/** Decodes the answer of `pools(address)`: ten 32-byte words. Null for anything else, or for a pool that does not exist. */
export function parsePoolReturn(hex: unknown): EvmPoolState | null {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{640}$/.test(hex)) return null;
  const w = (i: number): bigint => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  if (w(0) === 0n || w(1) >> 160n !== 0n || w(2) >> 64n !== 0n || w(8) > w(5)) return null;
  return { feeBps: w(0), creator: '0x' + hex.slice(2 + 64 + 24, 2 + 128).toLowerCase(), createdAt: w(2), x: w(3), y: w(4), l: w(5), acc: w(6), feeReserve: w(7), locked: w(8), accRemainder: w(9) };
}

/** The share of the pool's liquidity that is locked for good, in basis points (rounded down), or null for an empty pool. */
export const lockedShareBps = (p: Pick<EvmPoolState, 'locked' | 'l'>): number | null => (p.l === 0n ? null : Number((p.locked * BPS) / p.l));

/** "x% of liquidity locked", with a warning when anything can be withdrawn. */
export function lockedShareText(p: Pick<EvmPoolState, 'locked' | 'l'>): { text: string; warn: boolean } {
  const bps = lockedShareBps(p);
  if (bps === null) return { text: 'No liquidity', warn: true };
  const pct = bps === 10_000 ? '100' : (bps / 100).toFixed(2).replace(/\.?0+$/, '');
  const text = `${pct}% of liquidity locked for good`;
  return bps === 10_000 ? { text, warn: false } : { text: `${text}. The other ${((10_000 - bps) / 100).toFixed(2).replace(/\.?0+$/, '')}% can be withdrawn by whoever added it, taking coin out of the pool.`, warn: true };
}

/** Decodes the answer of `positions(address,address)`: six words. */
export function parsePositionReturn(hex: unknown): EvmPosition | null {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{384}$/.test(hex)) return null;
  const w = (i: number): bigint => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  if (w(0) > 1n || w(5) >> 160n !== 0n) return null;
  const recipient = w(5) === 0n ? null : '0x' + hex.slice(2 + 5 * 64 + 24, 2 + 6 * 64).toLowerCase();
  return { open: w(0) === 1n, shares: w(1), locked: w(2), checkpoint: w(3), pending: w(4), recipient };
}

/** The rules every pool must satisfy. A pool read back that breaks one is not shown as healthy. */
export function poolProblems(p: EvmPoolMath): string[] {
  const out: string[] = [];
  if (p.feeBps !== 25n && p.feeBps !== 100n) out.push(`This pool charges ${Number(p.feeBps) / 100}%, not 0.25% or 1%.`);
  if (p.l < POOL_MIN_L) out.push('The pool’s liquidity is below the minimum.');
  if (p.x >= POOL_MAX || p.y + p.l >= POOL_MAX) out.push('The pool’s reserves are out of range.');
  return out;
}

export const lockTextOf = (p: EvmPosition): string => {
  if (!p.open || p.shares === 0n) return 'Empty';
  if (p.locked === p.shares) return 'Locked for good';
  if (p.locked === 0n) return 'Not locked: you can remove it';
  return 'Partly locked';
};

// ---------------------------------------------------------------- creating a pool

export interface EvmPoolForm {
  chain: LaunchEvmChainKey;
  token: string;
  /** Whole tokens, commas allowed. */
  tokenAmount: string;
  /** Coin per whole token, plain decimal. */
  startPrice: string;
  /** '0.25' or '1'. */
  feeTier: string;
  /** Optional coin for the creator's own first buy, made in the same transaction. */
  firstBuy: string;
}

export const DEFAULT_EVM_POOL_FORM: EvmPoolForm = { chain: 'ethereum', token: '', tokenAmount: '', startPrice: '', feeTier: '0.25', firstBuy: '' };

/** What is known about the token before a pool is opened. */
export interface EvmPoolToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: bigint;
  /** The creator's balance, smallest unit. */
  held: bigint;
  /** The factory nonce that made it, or null if the factory did not (then no pool can be opened). */
  factoryNonce: bigint | null;
}

export interface EvmPoolConfig {
  chain: EvmPoolChain;
  creator: string;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  factoryNonce: bigint;
  x0: bigint;
  l0: bigint;
  y0: bigint;
  feeBps: PoolFeeTier;
  lock: true;
  firstBuyWei: bigint;
}

export interface EvmPoolIssue {
  field: keyof EvmPoolForm | 'form';
  message: string;
}

export type EvmPoolValidation = { ok: true; config: EvmPoolConfig } | { ok: false; issues: EvmPoolIssue[] };

/** The virtual coin reserve for a starting price: floor(x0 * priceWei / 10^decimals), exact. */
export const startL = (x0: bigint, priceWei: bigint, decimals: number): bigint => (x0 * priceWei) / 10n ** BigInt(decimals);

export function validateEvmPool(form: EvmPoolForm, creator: string, token: EvmPoolToken | null, existingPool: boolean, addresses = EVM_POOL_ADDRESSES, factories: Readonly<Partial<Record<LaunchEvmChainKey, string>>> = EVM_POOL_TEST_FACTORIES): EvmPoolValidation {
  const issues: EvmPoolIssue[] = [];
  const add = (field: EvmPoolIssue['field'], message: string) => issues.push({ field, message });
  const chain = evmPoolChain(form.chain, addresses, factories);
  if (!chain) add('form', 'Aretia Pool is not available on this network yet.');
  if (!isEvmAddress(creator)) add('form', 'Connect a wallet first.');
  if (!isEvmAddress(form.token.trim())) add('token', 'A valid token address, starting with 0x.');
  else if (token === null) add('token', 'This token could not be read from the network.');
  else if (token.factoryNonce === null) add('token', 'This token was not made by Aretia’s token factory. Aretia Pool only takes tokens it can prove have a fixed supply and no owner, mint, pause, blacklist or fee on transfer.');
  else if (existingPool) add('token', 'A pool for this token already exists on this network. There can be only one.');

  const feeBps = form.feeTier === '0.25' ? 25 : form.feeTier === '1' ? 100 : null;
  if (feeBps === null) add('feeTier', 'Choose 0.25% or 1%.');

  let x0 = 0n;
  if (token !== null) {
    const raw = toSmallestUnit(form.tokenAmount.replace(/,/g, '').trim(), token.decimals);
    if (raw === null || BigInt(raw) <= 0n) add('tokenAmount', 'A number above zero, with no more decimal places than the token has.');
    else {
      x0 = BigInt(raw);
      if (x0 > token.held) add('tokenAmount', 'More than your wallet holds of this token.');
      else if (x0 < POOL_MIN_X) add('tokenAmount', 'Too small to open a pool.');
      else if (x0 >= POOL_MAX) add('tokenAmount', 'More than a pool can hold.');
    }
  }

  const price = coinToWei(form.startPrice);
  let l0 = 0n;
  if (price === null) add('startPrice', 'An amount above zero, with at most 18 decimal places.');
  else if (token !== null && x0 >= POOL_MIN_X && x0 < POOL_MAX) {
    l0 = startL(x0, price, token.decimals);
    if (l0 < POOL_MIN_L) add('startPrice', 'That price for that many tokens is below the smallest pool (the pool must start with a value of at least 0.000001 of the coin).');
    else if (l0 >= POOL_MAX) add('startPrice', 'The pool would be worth more than it can hold.');
  }

  let firstBuy = 0n;
  if (form.firstBuy.trim() !== '') {
    const fb = coinToWei(form.firstBuy);
    if (fb === null) add('firstBuy', 'An amount above zero, or leave it empty.');
    else if (fb >= POOL_MAX) add('firstBuy', 'Too large.');
    else firstBuy = fb;
  }

  if (issues.length > 0 || !chain || token === null || token.factoryNonce === null || feeBps === null) return { ok: false, issues };
  return {
    ok: true,
    config: { chain, creator: creator.toLowerCase(), token: token.address.toLowerCase(), tokenSymbol: token.symbol, tokenDecimals: token.decimals, factoryNonce: token.factoryNonce, x0, l0, y0: 0n, feeBps: feeBps as PoolFeeTier, lock: true, firstBuyWei: firstBuy },
  };
}

/** The pool as it will be the moment it opens (no real coin yet), for quoting a first buy and showing the start. */
export const openingMath = (c: Pick<EvmPoolConfig, 'x0' | 'l0' | 'y0' | 'feeBps'>): EvmPoolMath => ({ feeBps: BigInt(c.feeBps), x: c.x0, y: c.y0, l: c.l0, acc: 0n, feeReserve: 0n, accRemainder: 0n });

export interface EvmPoolPreview {
  startPrice: string;
  startValue: string;
  /** Coin the owner pays in total at creation: the fee plus any first buy. */
  upfront: bigint;
}

export function evmPoolPreview(form: Pick<EvmPoolForm, 'tokenAmount' | 'startPrice' | 'firstBuy'>, token: Pick<EvmPoolToken, 'decimals' | 'supply'> | null, creationFee: bigint): EvmPoolPreview | null {
  if (!token) return null;
  const raw = toSmallestUnit(form.tokenAmount.replace(/,/g, '').trim(), token.decimals);
  const price = coinToWei(form.startPrice);
  if (raw === null || BigInt(raw) <= 0n || price === null) return null;
  const fb = form.firstBuy.trim() === '' ? 0n : coinToWei(form.firstBuy);
  return { startPrice: fromSmallestUnit(price, 18), startValue: fromSmallestUnit((price * token.supply) / 10n ** BigInt(token.decimals), 18), upfront: creationFee + (fb ?? 0n) };
}

export type PoolDisclosureKind = 'create' | 'buy' | 'sell' | 'add' | 'remove' | 'claim' | 'lock';

export function evmPoolDisclosures(kind: PoolDisclosureKind, symbol: string): { severity: 'info' | 'caution'; text: string }[] {
  const unaudited = { severity: 'caution' as const, text: 'The Aretia Pool contract is new and has not been independently audited. Do not put in more than you can lose entirely.' };
  const fees = { severity: 'info' as const, text: 'Every trade pays the pool’s fee. 20% of it is owed to Aretia (kept in the contract and paid to Aretia’s fee address separately, so it can never hold up your trade), and 80% goes to the people providing liquidity. Nothing else is taken.' };
  switch (kind) {
    case 'create':
      return [
        { severity: 'info', text: `Two transactions: first you approve exactly the tokens going in, then the pool takes them. You put in tokens only, with no ${symbol}. The price you set is where buyers start.` },
        { severity: 'info', text: 'Your liquidity is locked for good. Nobody, including you and Aretia, can ever take it out. You can still claim the trading fees it earns, as often as you like, and point them at another wallet.' },
        { severity: 'caution', text: 'Aretia charges a flat creation fee in the same transaction (owed to Aretia and paid out separately). Other apps and routers do not know this pool, so nobody can find or trade it through them yet.' },
        fees,
        unaudited,
      ];
    case 'buy':
      return [{ severity: 'info', text: `You pay the ${symbol} amount above and the pool sends tokens to your wallet. The page shows the least you will accept.` }, fees, unaudited];
    case 'sell':
      return [{ severity: 'info', text: 'Two transactions: first you approve exactly the tokens you are selling, then the pool takes them and pays you its current price, less the fee. The page shows the least you will accept.' }, fees, unaudited];
    case 'add':
      return [{ severity: 'info', text: `You deposit tokens and ${symbol} in the pool’s current proportion. The page shows the most you will pay. Your share of the fees starts now.` }, { severity: 'caution', text: 'Liquidity you add is not locked unless you lock it afterwards, and leaving can return a different mix of tokens and coin than you put in.' }, unaudited];
    case 'remove':
      return [{ severity: 'info', text: 'You take back your unlocked share of the pool, in tokens and coin at the pool’s current proportion. Locked liquidity cannot be taken out by anyone.' }, unaudited];
    case 'claim':
      return [{ severity: 'info', text: 'This pays the trading fees your position has earned. It works on locked liquidity. Aretia takes nothing when you claim.' }, unaudited];
    case 'lock':
      return [{ severity: 'caution', text: 'Locking is permanent. Nothing, by anyone, ever, can take that liquidity out. The fees it earns stay claimable.' }, unaudited];
  }
}

/** The page address that opens a pool: "#/launch/pool/evm/<chain>/<token>". */
export const evmPoolShareHash = (chain: string, token: string): string => `#/launch/pool/evm/${chain}/${token.toLowerCase()}`;

export function parseEvmPoolHash(hash: string): { chain: LaunchEvmChainKey; token: string } | null {
  const m = /^#\/launch\/pool\/evm\/([a-zA-Z]+)\/(0x[0-9a-fA-F]{40})$/.exec(hash.trim());
  if (!m || !chainByKey(m[1] as LaunchEvmChainKey)) return null;
  return { chain: m[1] as LaunchEvmChainKey, token: m[2]!.toLowerCase() };
}

export { FEE_ADDRESS };
