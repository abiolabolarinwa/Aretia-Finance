/**
 * Aretia Launch, Ethereum-style chains: opening a liquidity pool for a token, with no network access and no keys.
 *
 * It uses each network's established Uniswap V2-style exchange (Uniswap V2 on Ethereum, PancakeSwap V2 on BNB Chain, QuickSwap on Polygon): the
 * creator puts some of their tokens and some of the network's coin into a new pool, which sets the starting price. Two transactions, both signed
 * by the person's own wallet: an approval for EXACTLY the tokens going in, then `addLiquidityETH`. The router addresses below were checked on each
 * chain (code present, `WETH()` and `factory()` as the exchange documents them) but a wrong entry would be caught again before signing, because
 * the flow reads both back from the chain and refuses a mismatch.
 *
 * Choices made on purpose:
 *  - The pool pair is always the network's coin (wrapped by the exchange), never another token.
 *  - The minimum amounts equal the amounts, so if anyone creates the pool at another price first, the transaction reverts instead of filling at it.
 *  - "Lock" sends the pool's liquidity tokens to the dead address, so nobody, including you, can ever take the liquidity out. Trading fees then
 *    accrue to the pool and are not claimable. Not locking gives the liquidity tokens to your wallet.
 *  - Aretia's fee for opening a pool is a flat 10 USDC or 10 USDT (the person's choice), sent from their wallet to the Aretia fee address as the LAST
 *    transaction, once the pool exists and has been read back. If it is not paid then, the result screen keeps asking for it. The stablecoin contracts and their decimals below were read from each chain; the flow reads the decimals again before signing.
 */
import { toSmallestUnit } from './walletTools';
import { FEE_ADDRESS, isEvmAddress, type LaunchEvmChainKey } from './walletLaunchEvmCore';

export interface PoolDex {
  key: LaunchEvmChainKey;
  chainId: number;
  /** The exchange, for the review screen. */
  name: string;
  /** Lower-case. */
  router: string;
  /** What `router.factory()` must return. Lower-case. */
  factory: string;
  /** What `router.WETH()` must return (the wrapped native coin). Lower-case. */
  wrapped: string;
  symbol: string;
  /** The stablecoins the pool fee can be paid in on this network (lower-case contract, decimals as the chain reports them). */
  stables: Record<FeeAsset, { address: string; decimals: number }>;
}

export type FeeAsset = 'USDC' | 'USDT';
/** Aretia's flat fee for opening an EVM pool, in whole USDC or USDT. */
export const POOL_FEE_UNITS = 10n;
export const POOL_FEE_ADDRESS = FEE_ADDRESS;

export const POOL_DEXES: readonly PoolDex[] = [
  { key: 'ethereum', chainId: 1, name: 'Uniswap V2', router: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', factory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', wrapped: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'ETH', stables: { USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 }, USDT: { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 } } },
  { key: 'bnb', chainId: 56, name: 'PancakeSwap V2', router: '0x10ed43c718714eb63d5aa57b78b54704e256024e', factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', wrapped: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'BNB', stables: { USDC: { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 }, USDT: { address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 } } },
  { key: 'polygon', chainId: 137, name: 'QuickSwap', router: '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff', factory: '0x5757371414417b8c6caad45baef941abc7d3ab32', wrapped: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', symbol: 'POL', stables: { USDC: { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 }, USDT: { address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6 } } },
];

export const dexFor = (key: string, table: readonly PoolDex[] = POOL_DEXES): PoolDex | undefined => table.find((d) => d.key === key);

/** Where locked liquidity goes: an address nobody holds a key for. */
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

export interface PoolForm {
  chain: LaunchEvmChainKey;
  token: string;
  /** Whole tokens, commas allowed. */
  tokenAmount: string;
  /** The network's coin going in, as a decimal ("0.5"). */
  coinAmount: string;
  feeAsset: FeeAsset;
}

export const DEFAULT_POOL_FORM: PoolForm = { chain: 'bnb', token: '', tokenAmount: '', coinAmount: '', feeAsset: 'USDC' };

export interface PoolConfig {
  dex: PoolDex;
  /** Lower-case. */
  creator: string;
  token: string;
  /** From the chain: the token's own symbol and decimals. */
  tokenSymbol: string;
  tokenDecimals: number;
  tokenRaw: bigint;
  coinWei: bigint;
  lock: boolean;
  /** Aretia's flat pool fee: which stablecoin, its contract and decimals, and the raw amount (10 whole units). */
  fee: { asset: FeeAsset; token: string; decimals: number; raw: bigint };
  /** Who receives the pool's liquidity tokens: the dead address when locked, otherwise the creator. */
  lpTo: string;
}

export interface PoolIssue {
  field: keyof PoolForm | 'form';
  message: string;
}

export type PoolValidation = { ok: true; token: string; tokenAmountText: string; coinWei: bigint; dex: PoolDex; feeAsset: FeeAsset } | { ok: false; issues: PoolIssue[] };

/** Checks the form as typed. The token's decimals are not known yet, so the token amount is converted after the chain is read (see `poolConfigOf`). */
export function validatePoolForm(form: PoolForm, creator: string, enabledKeys: readonly string[], table: readonly PoolDex[] = POOL_DEXES): PoolValidation {
  const issues: PoolIssue[] = [];
  const add = (field: PoolIssue['field'], message: string) => issues.push({ field, message });
  const dex = dexFor(form.chain, table);
  if (!dex || !enabledKeys.includes(form.chain)) add('form', 'Opening a pool is not available on this network.');
  if (!isEvmAddress(creator)) add('form', 'Connect an Ethereum-style wallet first.');
  const token = form.token.trim();
  if (!isEvmAddress(token)) add('token', 'A token address starting with 0x, 42 characters.');
  const tokenAmountText = form.tokenAmount.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(tokenAmountText) || Number(tokenAmountText) <= 0) add('tokenAmount', 'A number above zero.');
  const coin = toSmallestUnit(form.coinAmount.trim(), 18);
  if (coin === null || BigInt(coin) <= 0n) add('coinAmount', 'A number above zero, such as 0.5.');
  if (form.feeAsset !== 'USDC' && form.feeAsset !== 'USDT') add('feeAsset', 'Choose USDC or USDT for the fee.');
  if (issues.length > 0 || !dex) return { ok: false, issues };
  return { ok: true, token: token.toLowerCase(), tokenAmountText, coinWei: BigInt(coin as string), dex, feeAsset: form.feeAsset };
}

/** Builds the config once the token's decimals and symbol have been read from the chain. Null if the token amount has too many decimals. */
export function poolConfigOf(v: Extract<PoolValidation, { ok: true }>, creator: string, lock: boolean, facts: { symbol: string; decimals: number }): PoolConfig | null {
  const raw = toSmallestUnit(v.tokenAmountText, facts.decimals);
  if (raw === null || BigInt(raw) <= 0n) return null;
  return {
    dex: v.dex,
    creator: creator.toLowerCase(),
    token: v.token,
    tokenSymbol: facts.symbol,
    tokenDecimals: facts.decimals,
    tokenRaw: BigInt(raw),
    coinWei: v.coinWei,
    lock,
    fee: { asset: v.feeAsset, token: v.dex.stables[v.feeAsset].address, decimals: v.dex.stables[v.feeAsset].decimals, raw: POOL_FEE_UNITS * 10n ** BigInt(v.dex.stables[v.feeAsset].decimals) },
    lpTo: lock ? DEAD_ADDRESS : creator.toLowerCase(),
  };
}

/** Plain-language consequences, shown before signing. Never says a pool is safe. */
export function poolDisclosuresOf(c: PoolConfig): { severity: 'info' | 'caution'; text: string }[] {
  return [
    { severity: 'info', text: `The pool is on ${c.dex.name}. Your tokens and your ${c.dex.symbol} go in together, and the starting price is simply the ratio between them.` },
    c.lock
      ? { severity: 'caution', text: 'The liquidity is locked for good, as it is for every pool opened on Aretia. Nobody, including you, can ever take the tokens or the coins back out, and the trading fees stay in the pool. The starting price cannot be changed. This cannot be undone.' }
      : { severity: 'caution', text: 'The liquidity is not locked. You hold the pool’s liquidity tokens and could take the pool out at any time, which buyers may treat as a risk.' },
    { severity: 'caution', text: 'Anyone can buy or sell against the pool once it exists. A price set too low or too high can be traded away quickly. Nothing here checks the price against any market.' },
    { severity: 'caution', text: `Aretia’s fee of ${POOL_FEE_UNITS} ${c.fee.asset} is the last transaction, after the pool exists. If you do not pay it, the pool still exists but the fee stays owed, and this page keeps asking for it.` },
    { severity: 'caution', text: 'The transactions are real: the coins, tokens and fee, plus the network gas, are paid from your wallet and cannot be recovered except by trading.' },
  ];
}
