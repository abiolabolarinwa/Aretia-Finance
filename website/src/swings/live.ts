/**
 * NON-CORE WIRING for the aggregator providers (Jupiter, 0x): benchmarking and migration only. The Aretia
 * engine (src/swings/engine) does not depend on it.
 *
 * Live wiring: connects the router to the wallet page's existing Solana code (RPC proxy, Jupiter,
 * signing through the user's own wallet). This is the only swings file that imports from scripts/,
 * and the only place providers and adapters are registered, so adding one is a one-line change here.
 */
import { liveFeeConfig } from './core/fee.js';
import { fetchAccount, loadWeb3, rpcCall } from '../scripts/walletSend';
import { fetchQuote, planSwap, signAndSubmitSwap, SOL_MINT, type Quote as JupQuote, type SwapPlan, type TokenInfo } from '../scripts/walletSwap';
import { parseMint } from '../scripts/walletTools';
import { SolanaChainAdapter } from './chains/solana.js';
import { Evm0xProvider } from './providers/evm0x.js';
import { DirectEvmProvider } from './dex/directEvm.js';
import { EVM_DEXES, SOLANA_DEXES } from './dex/entries.js';
import { DirectSolanaProvider } from './solana/directSolana.js';
import { AretiaDexRegistry } from './engine/registry.js';
import { ProviderHealth } from './engine/health.js';
import type { DexProvider } from './core/types.js';
import { SolanaJupiterProvider, type JupiterBackend } from './providers/solanaJupiter.js';
import { AretiaRouter } from './router/router.js';
import { ChainedEvmProvider } from './dex/chainedEvm.js';
import { decimalsMismatch } from './core/token.js';
import { routerEventSink, Telemetry } from './observability/telemetry.js';
import { EvmChainAdapter } from './chains/evm.js';
import { publicRead } from './chains/evmSession.js';
import type { EvmWalletAdapter } from './chains/evmWallet.js';
import { isChainEnabled, runtime } from './runtime.js';
import { BeaconSink } from './observability/beacon.js';
import { CHAINS, SwingsError, type ChainId, type TokenRisk } from './core/types.js';
import { EvmTokenEnricher, SolanaTokenEnricher } from './tokens/enrich.js';
import { normalizeTokenRef } from './core/token.js';

/** Telemetry: counters and a bounded event buffer in memory. Anonymous aggregates are sent only when the server turns analytics on. */
export const telemetry = new Telemetry([new BeaconSink(() => runtime.analytics)]);

export interface LiveDeps {
  /** Other tokens in the wallet, so the swap simulation can prove it leaves them alone. */
  heldOthers: () => { mint: string; symbol: string }[];
  /** Tokens the user picked on screen, by mint: names and symbols come from here, decimals never do. */
  knownToken: (mint: string) => TokenInfo | null;
  /** The address that receives the Aretia fee on EVM networks (a public value, set at build time). Without it EVM swaps are paused. */
  evmFeeAddress?: string;
}

/** Decimals are read from the mint itself, so a lying token list cannot change how much is swapped. */
export async function onchainDecimals(mint: string): Promise<number | null> {
  if (mint === SOL_MINT) return 9;
  const account = await fetchAccount(mint);
  return account ? (parseMint(account.owner, account.data)?.decimals ?? null) : null;
}

export function createLiveRouter(deps: LiveDeps): AretiaRouter {
  const jupiter: JupiterBackend = {
    // walletSwap's Quote already has the fields the provider reads; it is also kept as the opaque payload.
    fetchQuote: async (inMint, outMint, amount, slippageBps) => fetchQuote(inMint, outMint, amount, slippageBps),
    planSwap: async (args) => {
      const plan = await planSwap({
        user: args.user,
        from: args.from,
        to: args.to,
        amountRaw: args.amountRaw,
        slippageBps: args.slippageBps,
        heldOthers: deps.heldOthers(),
        quote: args.quote as unknown as JupQuote,
        // The old Trade-tab fee is not used here: Swings charges the Aretia fee (core/fee.ts) in the provider that builds the swap.
        feeBps: 0n,
      });
      // The plan is also the opaque payload the Solana adapter signs; the provider only reads its summary fields.
      return plan;
    },
    resolveToken: async (mint) => {
      const info = deps.knownToken(mint);
      const decimals = await onchainDecimals(mint);
      if (decimals === null) return null;
      const mismatch = info ? decimalsMismatch(info.symbol, info.decimals, decimals) : null;
      if (mismatch) throw new SwingsError('invalid', mismatch);
      return info ?? { mint, symbol: mint.slice(0, 4), name: '', decimals, icon: null, verified: null };
    },
  };

  // One fee policy for the router and every provider that collects it (core/fee.ts). The EVM fee address is public and is set
  // at build time; without it EVM swaps are paused rather than let through without the fee.
  const feeConfig = liveFeeConfig(deps.evmFeeAddress);
  const evmProvider = new Evm0xProvider({
    fee: feeConfig,
    quote: async (body, signal) => {
      const res = await fetch('/api/swings-0x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new SwingsError(res.status === 422 ? 'no-route' : 'provider-failed', data?.message ?? 'The routing provider is unavailable.');
      return data;
    },
    // Simulation reads the chain through its public node, independent of the wallet's current network.
    rpc: async (chain, method, params) => publicRead(chain)(method, params),
  });

  // Aretia's own EVM router: pools read from the venues, routing and transactions built here.
  const health = new ProviderHealth();
  const registry = new AretiaDexRegistry([...EVM_DEXES, ...SOLANA_DEXES], health);
  const direct = new DirectEvmProvider({ registry, read: (chain) => publicRead(chain), health, fee: feeConfig });
  // A launchpad token trades against the launchpad's own token (VIRTUAL, ARENA), so buying one with ETH or AVAX is two swaps. The
  // second step uses a router with no fee: the first step already took it.
  const directSecondStep = new DirectEvmProvider({ registry, read: (chain) => publicRead(chain), health });
  const chained = new ChainedEvmProvider({ first: direct, second: directSecondStep, registry, read: (chain) => publicRead(chain) });
  const directSolana = new DirectSolanaProvider({ web3: loadWeb3, rpc: rpcCall, registry, health, fee: feeConfig });
  // The aggregators (Jupiter, 0x) are NON-CORE. They take part only while the operator allows it (SWINGS_AGGREGATORS),
  // and 0x only when its key is configured. Switching them off leaves Aretia's own routing as the only source.
  const aggregator = (p: DexProvider, extra: () => boolean = () => true): DexProvider => ({
    id: p.id,
    name: p.name,
    supports: (chain) => runtime.aggregators && extra() && p.supports(chain),
    ...(p.carriesAretiaFee ? { carriesAretiaFee: true } : {}),
    getQuote: (r, s) => p.getQuote(r, s),
    buildTransaction: (q) => p.buildTransaction(q),
  });

  return new AretiaRouter({
    feeConfig,
    isChainEnabled,
    onEvent: routerEventSink(telemetry, (quoteId) => quoteId.split(':')[0] || 'unknown'),
    providers: [direct, chained, directSolana, aggregator(new SolanaJupiterProvider(jupiter)), aggregator(evmProvider, () => runtime.evmConfigured)],
    adapters: [new SolanaChainAdapter({ rpc: rpcCall, signAndSubmit: (payload) => signAndSubmitSwap(payload as SwapPlan, { protectedSubmit: (payload as { protectedSubmission?: unknown }).protectedSubmission !== undefined }) })],
  });
}

/** Once an EVM wallet is connected, gives the router an adapter for every EVM chain (reads use public nodes). */
export function registerEvmWallet(router: AretiaRouter, wallet: EvmWalletAdapter): void {
  for (const id of Object.keys(CHAINS) as ChainId[]) {
    if (CHAINS[id].kind === 'evm') router.registerAdapter(new EvmChainAdapter(id, wallet, { read: publicRead(id) }));
  }
}

/**
 * The risk assessment of one token, run in the page against the chain itself (the same engine and signals the New
 * Tokens tab uses). Returns null when the token cannot be read or the checks fail: the screen then says no
 * assessment could be made, never that the token is safe.
 */
export async function assessTokenSafety(chain: ChainId, address: string, market: { liquidityUsd: number | null; volume24hUsd: number | null; ageMs: number | null; hasPool: boolean } | null = null): Promise<TokenRisk | null> {
  try {
    const ref = normalizeTokenRef(chain, address);
    if (!ref) return null;
    // When the caller already knows the pool's numbers, they join the on-chain facts, so liquidity, activity and age are
    // scored too and the verdict matches what the market list shows.
    const candidate = {
      ref,
      source: 'swap-screen',
      ...(market ? { liquidityUsd: market.liquidityUsd, volume24hUsd: market.volume24hUsd, firstPoolAt: market.ageMs === null ? null : Date.now() - market.ageMs, pool: market.hasPool ? { venue: 'market', address: 'known' } : null } : {}),
    };
    if (chain === 'solana') {
      const out = await new SolanaTokenEnricher(rpcCall).enrich(candidate);
      return out?.risk ?? null;
    }
    const read = publicRead(chain);
    const out = await new EvmTokenEnricher(<T,>(method: string, params: unknown[]) => read(method, params) as Promise<T>).enrich(candidate);
    return out?.risk ?? null;
  } catch {
    return null;
  }
}
