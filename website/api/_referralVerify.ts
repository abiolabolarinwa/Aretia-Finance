/**
 * Reads a swap's fee payment back from the chain, so a referral is credited for what Aretia really received and never for what a
 * browser says. Read-only: it asks a public node about a transaction that is already final.
 *
 *  - Solana: the transaction's signer must be the trader, and the fee wallet's balance must have gone up in that transaction (SOL, or
 *    USDC / USDT held by the fee wallet). The amount credited is that rise.
 *  - EVM: a native-coin payment (the transaction is from the trader, to the fee address, with a value), and/or ERC-20 `Transfer` logs
 *    from the trader to the fee address, in a transaction that succeeded.
 *
 * Only assets that carry the Aretia fee are counted (`isFeeAsset`), so odd tokens sent to the fee wallet earn nobody anything.
 * Not verified against a real swap yet: see docs/referrals.md.
 */
import { SWAP_FEE_WALLET } from '../src/scripts/walletTools.js';
import { POOL_DEXES, POOL_FEE_ADDRESS, POOL_FEE_UNITS } from '../src/scripts/walletPoolEvmCore.js';
import { CURVE_PROGRAM_ID_DEVNET, CURVE_PROGRAM_ID_MAINNET, CURVE_PROGRAM_ID_MAINNET_PLANNED } from '../src/scripts/walletCurveCore.js';
import { ARETIA_POOL_PROGRAM_ID_DEVNET, ARETIA_POOL_PROGRAM_ID_MAINNET } from '../src/scripts/walletAretiaPoolCore.js';
import { isFeeAsset } from '../src/swings/core/feeAssets.js';
import { CHAINS, EVM_NATIVE_ADDRESS, type ChainId } from '../src/swings/core/types.js';

/** The same address on every EVM chain (walletLaunchEvmCore.ts FEE_ADDRESS); the build-time setting wins when it is a valid address, as it does for the fee itself. */
export const DEFAULT_EVM_FEE_ADDRESS = '0xeb8725e16e504036c2166aa47804d88ecc4d0945';
export const SOLANA_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Public read nodes, the same as the page uses (chains/evmSession.ts PUBLIC_EVM_RPC; a test keeps them equal). */
export const EVM_READ_RPC: Readonly<Record<Exclude<ChainId, 'solana'>, string>> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://optimism-rpc.publicnode.com',
  avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
  robinhood: 'https://robinhood-rpc.publicnode.com',
};

export interface VerifyEnv {
  SOLANA_RPC_URL?: string;
  PUBLIC_ARETIA_EVM_FEE_ADDRESS?: string;
}

export interface FeePayment {
  /** EVM_NATIVE_ADDRESS, the SOL mint, or a token address (EVM lower-case; Solana as written). */
  asset: string;
  amount: bigint;
}

export type Verified = { ok: true; payments: FeePayment[]; at: number } | { ok: false; reason: 'pending' | 'failed' | 'not-trader' | 'no-fee' | 'not-swap' | 'unreadable' };

/**
 * The fee wallets also receive Aretia's flat fees for creating a token, opening a pool and the curve's own trading fee. Those are not swap
 * fees, so a referrer earns nothing from them:
 *  - Solana: a transaction that creates a token mint (a launch, or a pool's position NFT) or runs Aretia's own curve or pool program;
 *  - EVM: the flat pool fee, exactly 10 USDC or USDT to the fee address (a launch fee is paid through the factory, so it is never a payment
 *    from the trader to the fee address and is not counted anyway).
 */
const ARETIA_PROGRAMS = new Set([CURVE_PROGRAM_ID_DEVNET, CURVE_PROGRAM_ID_MAINNET_PLANNED, CURVE_PROGRAM_ID_MAINNET, ARETIA_POOL_PROGRAM_ID_DEVNET, ARETIA_POOL_PROGRAM_ID_MAINNET].filter((p): p is string => typeof p === 'string'));
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

/** The flat EVM pool fee on this chain: each stablecoin it may be paid in (lower-case) and its exact raw amount. */
function flatPoolFees(chain: ChainId): Map<string, bigint> {
  const dex = POOL_DEXES.find((d) => d.key === chain);
  const out = new Map<string, bigint>();
  if (dex) for (const s of Object.values(dex.stables)) out.set(s.address.toLowerCase(), POOL_FEE_UNITS * 10n ** BigInt(s.decimals));
  return out;
}

export function evmFeeAddress(env: VerifyEnv): string {
  const v = env.PUBLIC_ARETIA_EVM_FEE_ADDRESS?.trim();
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : DEFAULT_EVM_FEE_ADDRESS;
}

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`node ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error('node error');
  return body.result ?? null;
}

const word = (hex: string): bigint => (/^0x[0-9a-fA-F]+$/.test(hex) ? BigInt(hex) : 0n);
const topicAddress = (t: unknown): string => (typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t) ? '0x' + t.slice(26).toLowerCase() : '');

interface EvmTx { from?: string; to?: string | null; value?: string }
interface EvmLog { address?: string; topics?: string[]; data?: string }
interface EvmReceipt { status?: string; blockNumber?: string; logs?: EvmLog[] }

export async function verifyEvmFee(input: { chain: ChainId; hash: string; trader: string; env: VerifyEnv; fetchImpl: typeof fetch }): Promise<Verified> {
  const url = (EVM_READ_RPC as Record<string, string>)[input.chain];
  if (!url || CHAINS[input.chain].kind !== 'evm' || !/^0x[0-9a-fA-F]{64}$/.test(input.hash)) return { ok: false, reason: 'unreadable' };
  const treasury = evmFeeAddress(input.env);
  const trader = input.trader.toLowerCase();
  try {
    const [tx, receipt] = (await Promise.all([rpc(input.fetchImpl, url, 'eth_getTransactionByHash', [input.hash]), rpc(input.fetchImpl, url, 'eth_getTransactionReceipt', [input.hash])])) as [EvmTx | null, EvmReceipt | null];
    if (!tx || !receipt || !receipt.blockNumber) return { ok: false, reason: 'pending' };
    if (receipt.status !== '0x1') return { ok: false, reason: 'failed' };
    const block = (await rpc(input.fetchImpl, url, 'eth_getBlockByNumber', [receipt.blockNumber, false])) as { timestamp?: string } | null;
    if (!block?.timestamp) return { ok: false, reason: 'unreadable' };
    const at = Number(word(block.timestamp)) * 1000;
    const payments: FeePayment[] = [];
    const poolFees = treasury === POOL_FEE_ADDRESS.toLowerCase() ? flatPoolFees(input.chain) : new Map<string, bigint>();
    let flatFee = false;
    if (tx.from?.toLowerCase() === trader && tx.to?.toLowerCase() === treasury && word(tx.value ?? '0x0') > 0n && isFeeAsset(input.chain, EVM_NATIVE_ADDRESS)) payments.push({ asset: EVM_NATIVE_ADDRESS, amount: word(tx.value!) });
    for (const log of receipt.logs ?? []) {
      if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length !== 3 || !log.address) continue;
      if (topicAddress(log.topics[1]) !== trader || topicAddress(log.topics[2]) !== treasury) continue;
      const asset = log.address.toLowerCase();
      const amount = word(log.data ?? '0x0');
      if (poolFees.get(asset) === amount) {
        flatFee = true;
        continue;
      }
      if (amount > 0n && isFeeAsset(input.chain, asset)) payments.push({ asset, amount });
    }
    if (payments.length === 0 && flatFee) return { ok: false, reason: 'not-swap' };
    return payments.length > 0 ? { ok: true, payments, at } : { ok: false, reason: 'no-fee' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

interface SolTokenBalance { accountIndex?: number; mint?: string; owner?: string; uiTokenAmount?: { amount?: string } }
interface SolIx { programId?: string; parsed?: { type?: string } | string }
interface SolTx {
  blockTime?: number | null;
  meta?: { err?: unknown; innerInstructions?: { instructions?: SolIx[] }[]; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: SolTokenBalance[]; postTokenBalances?: SolTokenBalance[] } | null;
  transaction?: { message?: { accountKeys?: ({ pubkey?: string; signer?: boolean } | string)[]; instructions?: SolIx[] } };
}

export async function verifySolanaFee(input: { signature: string; trader: string; env: VerifyEnv; fetchImpl: typeof fetch }): Promise<Verified> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(input.signature)) return { ok: false, reason: 'unreadable' };
  const url = input.env.SOLANA_RPC_URL?.trim() || 'https://solana-rpc.publicnode.com';
  try {
    const tx = (await rpc(input.fetchImpl, url, 'getTransaction', [input.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }])) as SolTx | null;
    if (!tx || !tx.meta) return { ok: false, reason: 'pending' };
    if (tx.meta.err) return { ok: false, reason: 'failed' };
    const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? { pubkey: k, signer: false } : { pubkey: k.pubkey ?? '', signer: k.signer === true }));
    if (!keys.some((k) => k.signer && k.pubkey === input.trader)) return { ok: false, reason: 'not-trader' };
    if (typeof tx.blockTime !== 'number') return { ok: false, reason: 'unreadable' };
    // A swap never creates a token mint and never runs Aretia's own curve or pool: those transactions pay a flat fee, not a swap fee.
    const all = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions ?? [])];
    const notSwap = all.some((ix) => {
      const program = ix.programId ?? '';
      if (ARETIA_PROGRAMS.has(program)) return true;
      const type = typeof ix.parsed === 'object' && ix.parsed ? ix.parsed.type : undefined;
      return TOKEN_PROGRAMS.has(program) && (type === 'initializeMint' || type === 'initializeMint2');
    });
    if (notSwap) return { ok: false, reason: 'not-swap' };
    const payments: FeePayment[] = [];
    const i = keys.findIndex((k) => k.pubkey === SWAP_FEE_WALLET);
    if (i >= 0) {
      const delta = BigInt(tx.meta.postBalances?.[i] ?? 0) - BigInt(tx.meta.preBalances?.[i] ?? 0);
      if (delta > 0n && isFeeAsset('solana', SOLANA_NATIVE_MINT)) payments.push({ asset: SOLANA_NATIVE_MINT, amount: delta });
    }
    const pre = new Map<string, bigint>();
    for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === SWAP_FEE_WALLET && b.mint) pre.set(b.mint, (pre.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount?.amount ?? '0'));
    const post = new Map<string, bigint>();
    for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === SWAP_FEE_WALLET && b.mint) post.set(b.mint, (post.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount?.amount ?? '0'));
    for (const [mint, amount] of post) {
      const delta = amount - (pre.get(mint) ?? 0n);
      if (delta > 0n && isFeeAsset('solana', mint)) payments.push({ asset: mint, amount: delta });
    }
    return payments.length > 0 ? { ok: true, payments, at: tx.blockTime * 1000 } : { ok: false, reason: 'no-fee' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

export function verifyFee(input: { chain: ChainId; tx: string; trader: string; env: VerifyEnv; fetchImpl: typeof fetch }): Promise<Verified> {
  return input.chain === 'solana' ? verifySolanaFee({ signature: input.tx, trader: input.trader, env: input.env, fetchImpl: input.fetchImpl }) : verifyEvmFee({ chain: input.chain, hash: input.tx, trader: input.trader, env: input.env, fetchImpl: input.fetchImpl });
}
