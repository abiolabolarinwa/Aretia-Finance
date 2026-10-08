/**
 * GET /api/swings-quote: Aretia's routing as a public, read-only API for other apps (the "integrator" product).
 *
 * What it does: finds the best route Aretia's own router can build for a swap and, if asked, returns the unsigned
 * transaction (Solana: a base64 versioned transaction; EVM: the approval and swap requests) plus the result of
 * simulating it on the real contracts. The integrator's user signs with their own wallet. This endpoint never holds
 * a key, never signs and never sends anything.
 *
 * What it does not do: charge or split fees, or take custody of anything. `integrator` is an optional label that is
 * echoed back and nothing else; referral economics are a separate decision that needs the owner and legal review.
 *
 * Off unless SWINGS_PUBLIC_API is "on". Rate limited per caller. EVM chains follow SWINGS_EVM_CHAINS, exactly like the
 * wallet. Aggregators are never used here: the answer is Aretia's own routing only.
 */
import { overLimit, PUBLIC_FALLBACK_RPC, type ProxyEnv } from './_rpcProxy.js';
import { evmChainsFromEnv } from './_swingsStatus.js';
import { publicRead, type EvmRead } from '../src/swings/chains/evmSession.js';
import { normalizeTokenRef } from '../src/swings/core/token.js';
import { CHAINS, isChainId, SwingsError, type ChainId, type DexProvider, type Quote } from '../src/swings/core/types.js';
import { DirectEvmProvider } from '../src/swings/dex/directEvm.js';
import { EVM_DEXES, SOLANA_DEXES } from '../src/swings/dex/entries.js';
import { AretiaDexRegistry } from '../src/swings/engine/registry.js';
import { DirectSolanaProvider } from '../src/swings/solana/directSolana.js';

export interface QuoteEnv extends ProxyEnv {
  SWINGS_PUBLIC_API?: string;
  SWINGS_EVM_CHAINS?: string;
  SOLANA_RPC_URL?: string;
  EVM_RPC_ETHEREUM?: string;
  EVM_RPC_BNB?: string;
  EVM_RPC_POLYGON?: string;
  EVM_RPC_BASE?: string;
  EVM_RPC_ARBITRUM?: string;
  EVM_RPC_OPTIMISM?: string;
  EVM_RPC_AVALANCHE?: string;
}

const EVM_ENV: Readonly<Record<string, keyof QuoteEnv>> = { ethereum: 'EVM_RPC_ETHEREUM', bnb: 'EVM_RPC_BNB', polygon: 'EVM_RPC_POLYGON', base: 'EVM_RPC_BASE', arbitrum: 'EVM_RPC_ARBITRUM', optimism: 'EVM_RPC_OPTIMISM', avalanche: 'EVM_RPC_AVALANCHE' };
const INTEGRATOR = /^[a-z0-9_-]{1,32}$/;
const MAX_AMOUNT_DIGITS = 40;
const TIMEOUT_MS = 25_000;

export interface QuoteInput {
  method: string;
  query: Record<string, string | undefined>;
  ip: string;
  env: QuoteEnv;
  fetchImpl: typeof fetch;
  now: number;
}

export interface QuoteOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const bigintsToStrings = (_: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

function rpcFor(url: string, fetchImpl: typeof fetch) {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`RPC answered ${res.status}`);
    const out = (await res.json()) as { result?: T; error?: unknown };
    if (out.error !== undefined || out.result === undefined) throw new Error('RPC error');
    return out.result;
  };
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SwingsError('provider-failed', 'The router took too long to answer.')), TIMEOUT_MS);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const STATUS_FOR: Readonly<Record<string, number>> = { invalid: 400, 'no-route': 404, 'not-enabled': 403, expired: 410, 'rate-limited': 429 };

export async function handleQuote(input: QuoteInput): Promise<QuoteOutput> {
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
  const reply = (status: number, payload: unknown): QuoteOutput => ({ status, body: JSON.stringify(payload, bigintsToStrings), headers });
  if (input.method === 'OPTIONS') return { status: 204, body: '', headers };
  if (input.method !== 'GET') return reply(405, { error: 'method' });
  if (input.env.SWINGS_PUBLIC_API !== 'on') return reply(503, { error: 'not-enabled', message: 'The public quote API is not switched on.' });
  if (overLimit(`quote:${input.ip}`, input.now)) return reply(429, { error: 'rate-limit', message: 'Too many requests. Slow down.' });

  const q = input.query;
  try {
    const chain = q.chain;
    if (!isChainId(chain)) throw new SwingsError('invalid', 'Unknown chain.');
    const from = normalizeTokenRef(chain, q.from ?? '');
    const to = normalizeTokenRef(chain, q.to ?? '');
    const taker = normalizeTokenRef(chain, q.taker ?? '');
    if (!from || !to) throw new SwingsError('invalid', 'from and to must be valid token addresses on this chain (use 0xeeee…eeee for the native coin of an EVM chain).');
    if (!taker) throw new SwingsError('invalid', 'taker must be the address that will sign.');
    if (!/^[1-9][0-9]*$/.test(q.amount ?? '') || (q.amount ?? '').length > MAX_AMOUNT_DIGITS) throw new SwingsError('invalid', 'amount must be a whole number of the smallest unit, above zero.');
    const slippageBps = q.slippageBps === undefined ? 50 : Number(q.slippageBps);
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1_000) throw new SwingsError('invalid', 'slippageBps must be a whole number from 0 to 1000.');
    if (q.integrator !== undefined && !INTEGRATOR.test(q.integrator)) throw new SwingsError('invalid', 'integrator must be 1-32 characters: a-z, 0-9, _ or -.');

    const info = CHAINS[chain as ChainId];
    if (info.kind === 'evm') {
      const enabled = evmChainsFromEnv(input.env.SWINGS_EVM_CHAINS);
      if (!enabled.includes(chain)) throw new SwingsError('not-enabled', `${info.name} swaps are not enabled on this deployment.`);
    }

    const registry = new AretiaDexRegistry([...EVM_DEXES, ...SOLANA_DEXES]);
    let provider: DexProvider;
    if (info.kind === 'solana') {
      provider = new DirectSolanaProvider({ web3: () => import('@solana/web3.js'), rpc: rpcFor(input.env.SOLANA_RPC_URL?.trim() || PUBLIC_FALLBACK_RPC, input.fetchImpl), registry, now: () => input.now });
    } else {
      const custom = input.env[EVM_ENV[chain]!]?.trim();
      const read: EvmRead = custom ? (method, params) => rpcFor(custom, input.fetchImpl)<unknown>(method, params) : publicRead(chain, input.fetchImpl);
      provider = new DirectEvmProvider({ registry, read: () => read, now: () => input.now });
    }

    const request = { chain: chain as ChainId, from, to, amountIn: BigInt(q.amount!), slippageBps, account: taker };
    const quote: Quote = await withTimeout(provider.getQuote(request));
    const raw = quote.raw as { reasons?: string[] } | undefined;
    const body: Record<string, unknown> = {
      provider: provider.id,
      chain,
      integrator: q.integrator ?? null,
      from: from.address,
      to: to.address,
      amountIn: quote.inAmount,
      expectedOut: quote.expectedOut,
      minOut: quote.minOut,
      priceImpactBps: quote.priceImpactBps,
      route: quote.route.legs.map((l) => ({ venue: l.venue, from: l.from.address, to: l.to.address, shareBps: l.shareBps })),
      reasons: raw?.reasons ?? [],
      aretiaBuyback: quote.costs.aretiaBuyback.amount,
      fetchedAt: quote.fetchedAt,
      expiresAt: quote.expiresAt,
    };
    if (q.prepare === '1') {
      const prepared = await withTimeout(provider.buildTransaction(quote));
      body.simulation = prepared.simulation;
      const payload = prepared.payload as { transaction?: { serialize(): Uint8Array }; steps?: string[]; chainId?: number; approval?: unknown; swap?: unknown };
      if (info.kind === 'solana' && payload.transaction) {
        body.transaction = { encoding: 'base64', unsigned: true, data: Buffer.from(payload.transaction.serialize()).toString('base64'), steps: payload.steps ?? [] };
      } else {
        body.transaction = { chainId: payload.chainId, approval: payload.approval ?? null, swap: payload.swap };
      }
    }
    return reply(200, body);
  } catch (e) {
    if (e instanceof SwingsError) return reply(STATUS_FOR[e.code] ?? 502, { error: e.code, message: e.message });
    return reply(502, { error: 'provider-failed', message: 'The router could not answer right now.' });
  }
}
