/**
 * Read-only live checks against real public services. No wallet, no key, no signing, no funds.
 * What this proves: parsers and wiring work against the real responses. What it does NOT prove:
 * anything about 0x (needs a key), real swaps, or the database.
 */
import { describe, expect, it } from 'vitest';
import { fetchQuote } from '../scripts/walletSwap';
import { SolanaJupiterProvider } from './providers/solanaJupiter.js';
import { AretiaRouter } from './router/router.js';
import { GeckoTerminalNewPoolsSource } from './tokens/sources/geckoTerminal.js';
import { EvmTokenEnricher, SolanaTokenEnricher } from './tokens/enrich.js';
import { publicRead, readBalance, readErc20 } from './chains/evmSession.js';
import { CHAIN_IDS, EVM_NATIVE_ADDRESS, type ChainId } from './core/types.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ACT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const SOL_RPC = 'https://solana-rpc.publicnode.com';

async function solRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(SOL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error || body.result === undefined) throw new Error(`rpc ${method} failed`);
  return body.result;
}

describe('live: Jupiter through the Aretia router', () => {
  it('gets an executable SOL -> USDC route and ranks it', async () => {
    const provider = new SolanaJupiterProvider({
      fetchQuote: async (i, o, a, s) => fetchQuote(i, o, a, s),
      planSwap: async () => Promise.reject(new Error('not used: read-only')),
      resolveToken: async () => null,
    });
    const router = new AretiaRouter({ providers: [provider], adapters: [] });
    const quote = await router.getQuote({ chain: 'solana', from: { chain: 'solana', address: SOL }, to: { chain: 'solana', address: USDC }, amountIn: 10_000_000n, slippageBps: 50, account: { chain: 'solana', address: '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2' } });
    console.log('Jupiter 0.01 SOL ->', Number(quote.expectedOut) / 1e6, 'USDC via', quote.route.legs.map((l) => l.venue).join(', '));
    expect(quote.expectedOut).toBeGreaterThan(0n);
    expect(quote.minOut).toBeLessThanOrEqual(quote.expectedOut);
    expect(quote.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('live: GeckoTerminal new pools on every chain', () => {
  for (const chain of CHAIN_IDS) {
    it(`parses the ${chain} feed`, async () => {
      // GeckoTerminal's free tier allows about 30 requests a minute: space the five chains out.
      await new Promise((r) => setTimeout(r, 3_000));
      const batch = await new GeckoTerminalNewPoolsSource(chain).poll(null);
      console.log(chain, 'candidates:', batch.candidates.length, 'sample:', batch.candidates[0] && `${batch.candidates[0].symbol} ${batch.candidates[0].ref.address.slice(0, 10)}… pool ${new Date(batch.candidates[0].firstPoolAt ?? 0).toISOString()} liq ${batch.candidates[0].liquidityUsd}`);
      expect(batch.candidates.length).toBeGreaterThan(0);
      for (const c of batch.candidates) {
        expect(c.ref.chain).toBe(chain);
        expect(c.firstPoolAt).not.toBeNull();
      }
    });
  }
});

describe('live: Solana on-chain enrichment', () => {
  it('reads ACT (Token-2022, mint authority revoked) and USDC', async () => {
    const enricher = new SolanaTokenEnricher(solRpc);
    const act = await enricher.enrich({ ref: { chain: 'solana', address: ACT }, source: 'live', liquidityUsd: 50_000, pool: { venue: 'meteora', address: 'x' }, firstPoolAt: Date.now() - 4 * 86_400_000 });
    console.log('ACT risk:', act?.risk.score, act?.risk.status, act?.risk.signals.map((s) => `${s.id}:${s.state}`).join(' '));
    expect(act).not.toBeNull();
    expect(act!.decimals).toBe(9);
    expect(act!.risk.signals.find((s) => s.id === 'mint-authority')!.state).toBe('ok');
    expect(act!.risk.signals.find((s) => s.id === 'extensions')!.state).toBe('warn');
    const usdc = await enricher.enrich({ ref: { chain: 'solana', address: USDC }, source: 'live' });
    console.log('USDC concentration:', usdc?.risk.signals.find((s) => s.id === 'concentration')?.detail);
    expect(usdc!.decimals).toBe(6);
    expect(await enricher.enrich({ ref: { chain: 'solana', address: '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2' }, source: 'live' })).toBeNull();
  });
});

describe('live: EVM reads on the four chains', () => {
  const tokens: [ChainId, string, string, number][] = [
    ['ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC', 6],
    ['base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 6],
    ['polygon', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 'USDC', 6],
    ['bnb', '0x55d398326f99059ff775485246999027b3197955', 'USDT', 18],
  ];
  for (const [chain, address, symbol, decimals] of tokens) {
    it(`reads ${symbol} on ${chain} from the chain itself`, async () => {
      const read = publicRead(chain);
      const facts = await readErc20(read, address);
      console.log(chain, facts);
      expect(facts?.decimals).toBe(decimals);
      expect(facts?.symbol.toUpperCase()).toContain(symbol);
      expect(await readBalance(read, '0x' + '0'.repeat(40), EVM_NATIVE_ADDRESS)).toBeGreaterThanOrEqual(0n);
    });
  }
  it('flags USDC on Ethereum as an upgradeable proxy with blacklist and pause by bytecode', async () => {
    const out = await new EvmTokenEnricher(async <T>(m: string, p: unknown[]) => (await publicRead('ethereum')(m, p)) as T).enrich({ ref: { chain: 'ethereum', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }, source: 'live', liquidityUsd: 5e7, pool: { venue: 'uni', address: 'p' }, firstPoolAt: 0 });
    console.log('USDC eth risk:', out?.risk.score, out?.risk.status, out?.risk.signals.map((s) => `${s.id}:${s.state}`).join(' '));
    expect(out).not.toBeNull();
    expect(out!.risk.signals.find((s) => s.id === 'proxy')!.state).toBe('warn');
    expect(out!.risk.signals.find((s) => s.id === 'blacklist')!.state).toBe('warn');
  });
});
