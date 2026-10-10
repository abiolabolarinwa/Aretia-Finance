import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHoldings } from './walletApp';

const OWNER = '8s2TtestAddress1111111111111111111111111DRHz';
const SOL = 'So11111111111111111111111111111111111111112';
const ACT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const OLD_TOKEN = 'OldTokenMint11111111111111111111111111111111';

/** The host of a URL, so a request is matched on who it goes to and not on a substring anywhere in it. */
const hostOf = (url: string): string => new URL(url, 'https://aretiafinance.org').hostname;

interface Stub {
  jupiterBalances?: Record<string, unknown> | 'fail';
  spl?: unknown[] | 'fail';
  token2022?: unknown[] | 'fail';
  lamports?: number | 'fail';
  prices?: Record<string, number>;
  dexscreener?: Record<string, number>;
}
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
const tokenAccount = (mint: string, amount: string, decimals: number, ui: string) => ({
  pubkey: 'x',
  account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals, uiAmountString: ui } } } } },
});

function stubNetwork(stub: Stub) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (hostOf(url) === 'lite-api.jup.ag' && url.includes('/ultra/v1/balances')) return stub.jupiterBalances === 'fail' ? json({}, 500) : json(stub.jupiterBalances ?? {});
      if (hostOf(url) === 'lite-api.jup.ag' && url.includes('/tokens/v2/search')) {
        const wanted = new URL(url).searchParams.get('query')!.split(',');
        return json(wanted.filter((m) => stub.prices?.[m] !== undefined).map((id) => ({ id, symbol: id.slice(0, 4), name: id, usdPrice: stub.prices![id], decimals: 6 })));
      }
      if (hostOf(url) === 'api.dexscreener.com') {
        const wanted = url.split('/').pop()!.split(',');
        return json(wanted.filter((m) => stub.dexscreener?.[m] !== undefined).map((m) => ({ baseToken: { address: m }, priceUsd: String(stub.dexscreener![m]), liquidity: { usd: 50_000 } })));
      }
      if (hostOf(url) === 'api.geckoterminal.com') return json({ data: { attributes: { token_prices: {} } } });
      if (hostOf(url) === 'aretiafinance.org' && new URL(url, 'https://aretiafinance.org').pathname === '/api/rpc') {
        const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        const answer = (v: unknown) => (v === 'fail' ? json({ jsonrpc: '2.0', id: 1, error: { message: 'refused' } }) : json({ jsonrpc: '2.0', id: 1, result: v }));
        if (method === 'getBalance') return answer(stub.lamports === undefined ? { value: 0 } : stub.lamports === 'fail' ? 'fail' : { value: stub.lamports });
        if (method === 'getTokenAccountsByOwner') {
          const program = (params[1] as { programId: string }).programId;
          const list = program.startsWith('Tokenkeg') ? stub.spl : stub.token2022;
          return answer(list === 'fail' ? 'fail' : { value: list ?? [] });
        }
      }
      return json({}, 404);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('loadHoldings', () => {
  it('shows a token Jupiter does not list, read from the chain, next to the ones it does', async () => {
    stubNetwork({
      jupiterBalances: { SOL: { uiAmount: 0.5, amount: '500000000' }, [ACT]: { uiAmount: 100, amount: '100000000000' } },
      spl: [tokenAccount(OLD_TOKEN, '2500000', 6, '2.5')],
      lamports: 500_000_000,
      prices: { [SOL]: 100, [ACT]: 0.005, [OLD_TOKEN]: 2 },
    });
    const holdings = await loadHoldings(OWNER);
    expect(holdings.map((h) => h.mint).sort()).toEqual([ACT, OLD_TOKEN, SOL].sort());
    const found = holdings.find((h) => h.mint === OLD_TOKEN)!;
    expect(found).toMatchObject({ amount: 2.5, raw: '2500000', decimals: 6, price: 2, value: 5 });
  });

  it('finds Token-2022 tokens too', async () => {
    stubNetwork({ jupiterBalances: {}, token2022: [tokenAccount(ACT, '1000000000', 9, '1')], lamports: 0 });
    expect((await loadHoldings(OWNER)).map((h) => h.mint)).toEqual([ACT]);
  });

  it('still shows everything from the chain when Jupiter\'s balance list is down, including SOL', async () => {
    stubNetwork({ jupiterBalances: 'fail', spl: [tokenAccount(OLD_TOKEN, '7', 0, '7')], lamports: 2_000_000_000 });
    const holdings = await loadHoldings(OWNER);
    expect(holdings.map((h) => h.mint).sort()).toEqual([SOL, OLD_TOKEN].sort());
    expect(holdings.find((h) => h.mint === SOL)).toMatchObject({ symbol: 'SOL', amount: 2, decimals: 9 });
  });

  it('still shows Jupiter\'s list when the chain read is refused', async () => {
    stubNetwork({ jupiterBalances: { SOL: { uiAmount: 1, amount: '1000000000' } }, spl: 'fail', token2022: 'fail', lamports: 'fail' });
    expect((await loadHoldings(OWNER)).map((h) => h.mint)).toEqual([SOL]);
  });

  it('uses the other token program\'s result when only one read fails', async () => {
    stubNetwork({ jupiterBalances: 'fail', spl: 'fail', token2022: [tokenAccount(ACT, '5', 9, '0.000000005')], lamports: 0 });
    expect((await loadHoldings(OWNER)).map((h) => h.mint)).toEqual([ACT]);
  });

  it('is an error only when neither source answers', async () => {
    stubNetwork({ jupiterBalances: 'fail', spl: 'fail', token2022: 'fail', lamports: 'fail' });
    await expect(loadHoldings(OWNER)).rejects.toThrow();
  });

  it('counts a balance in more than one token account for the same mint as one holding', async () => {
    stubNetwork({
      jupiterBalances: {},
      spl: [tokenAccount(OLD_TOKEN, '1000000', 6, '1'), tokenAccount(OLD_TOKEN, '2000000', 6, '2')],
      lamports: 0,
    });
    const holdings = await loadHoldings(OWNER);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({ amount: 3, raw: '3000000' });
  });

  it('asks the price fallback about every batch of unpriced mints, not just the first thirty', async () => {
    const mints = Array.from({ length: 65 }, (_, i) => `Mint${String(i).padStart(3, '0')}${'x'.repeat(33)}`);
    const calls = stubNetwork({
      jupiterBalances: {},
      spl: mints.map((m) => tokenAccount(m, '1', 0, '1')),
      lamports: 0,
      dexscreener: { [mints[64]!]: 3 }, // priced only by DexScreener, and only in the third batch
    });
    const holdings = await loadHoldings(OWNER);
    expect(calls.filter((u) => hostOf(u) === 'api.dexscreener.com')).toHaveLength(3);
    expect(holdings.find((h) => h.mint === mints[64])).toMatchObject({ price: 3, priceSource: 'DexScreener' });
  });

  it('puts SOL first and keeps it even when the wallet has more token accounts than the lookup limit', async () => {
    const mints = Array.from({ length: 150 }, (_, i) => `Mint${String(i).padStart(3, '0')}${'x'.repeat(33)}`);
    stubNetwork({ jupiterBalances: 'fail', spl: mints.map((m) => tokenAccount(m, '1', 0, '1')), lamports: 1_000_000_000, prices: { [SOL]: 100 } });
    const holdings = await loadHoldings(OWNER);
    expect(holdings).toHaveLength(100);
    expect(holdings[0]!.mint).toBe(SOL);
  });
});
