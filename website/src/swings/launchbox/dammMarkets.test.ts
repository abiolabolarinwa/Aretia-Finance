import { readFileSync } from 'node:fs';
import * as web3 from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { dammMarkets, resetDammMarkets } from './dammMarkets';

/** The real pool of a token launched on aretiafinance.org (2026-10-30), recorded from mainnet: tiny and one-sided, no price on DexScreener. */
const fx = JSON.parse(readFileSync(new URL('./fixtures/damm-launch.json', import.meta.url), 'utf8')) as {
  mint: string;
  pool: { owner: string; data: [string, string] };
  tx: unknown;
  accounts: Record<string, { owner: string; data: [string, string] }>;
};
const POOL = 'J8DxvjKHthTacb6pTNgtX1jZJJJmc1x3iEuTq5KpHi5X';

function node(calls: string[] = []) {
  return async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push(method);
    if (method === 'getSignaturesForAddress') return [{ signature: 'sig1', err: null }];
    if (method === 'getTransaction') return fx.tx;
    if (method === 'getMultipleAccounts') {
      const list = params[0] as string[];
      return { value: list.map((a) => (a === POOL ? fx.pool : (fx.accounts[a] ?? null))) };
    }
    throw new Error(`unexpected ${method}`);
  };
}

beforeEach(resetDammMarkets);

describe('a launched token whose pool the price feed does not list', () => {
  it('finds the pool from the token\'s own transaction and reads its price, holdings and supply from the chain', async () => {
    const got = await dammMarkets({ rpc: node(), web3, solUsd: async () => 100 }, [fx.mint]);
    const m = got.get(fx.mint)!;
    expect(m.pool).toMatchObject({ dex: 'meteora-damm-v2', address: POOL, quoteSymbol: 'SOL', quoteMajor: true });
    // The starting price is 0.0003 SOL per token, so $0.03 at $100 a SOL; the full 1,000,000,000 supply is worth $30,000,000.
    expect(m.priceUsd).toBeCloseTo(0.03, 6);
    expect(m.capUsd).toBeCloseTo(30_000_000, -3);
    expect(m.capKind).toBe('fdv');
    // The pool holds one token and one lamport.
    expect(m.liquidityUsd).toBeCloseTo(0.03 + 1e-7, 6);
    expect(m.volume24hUsd).toBeNull();
    expect(m.change24h).toBeNull();
  });

  it('shows no dollar figures when SOL cannot be priced, but still names the pool', async () => {
    const m = (await dammMarkets({ rpc: node(), web3, solUsd: async () => null }, [fx.mint])).get(fx.mint)!;
    expect(m.priceUsd).toBeNull();
    expect(m.liquidityUsd).toBeNull();
    expect(m.capUsd).toBeNull();
    expect(m.pool?.address).toBe(POOL);
  });

  it('remembers the pool, so a refresh does not search the history again', async () => {
    const calls: string[] = [];
    const rpc = node(calls);
    await dammMarkets({ rpc, web3, solUsd: async () => 100 }, [fx.mint]);
    const first = calls.filter((c) => c === 'getSignaturesForAddress').length;
    await dammMarkets({ rpc, web3, solUsd: async () => 100 }, [fx.mint]);
    expect(first).toBe(1);
    expect(calls.filter((c) => c === 'getSignaturesForAddress')).toHaveLength(1);
  });

  it('leaves a token out when it has no such pool or the node fails', async () => {
    const none = async (method: string) => (method === 'getSignaturesForAddress' ? [] : { value: [] });
    expect((await dammMarkets({ rpc: none, web3, solUsd: async () => 100 }, [fx.mint])).size).toBe(0);
    const broken = async () => {
      throw new Error('down');
    };
    expect((await dammMarkets({ rpc: broken, web3, solUsd: async () => 100 }, [fx.mint])).size).toBe(0);
  });
});
