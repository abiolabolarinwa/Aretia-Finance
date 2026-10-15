import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setGeckoGap } from './geckoGate.js';
import { resetUpstreamHealth } from './upstreamHealth.js';
import { fetchTrades, formatAmount, formatTradeUsd, MAX_TRADES, parseTrades, readServerTrades, timeAgo, traderLink, txLink, type Trade } from './trades.js';

const TX = '0xca405963804bb9eb745dc1e5a5f2ed6ac249d0e23f262c01f14e6d5c700d2b39';
const WHO = '0xc18e0270177141ae65d992950e4a1d3394d08621';
const POOL = '0x124fCfd1B923485C8cCf275AFbEe4bf557B232D6';

const raw = (over: Record<string, unknown> = {}) => ({
  attributes: {
    block_timestamp: '2026-10-12T21:25:56Z',
    tx_hash: TX,
    tx_from_address: WHO,
    // A sell of the pool's first token: the first token goes in (from), the second comes out (to).
    kind: 'sell',
    from_token_amount: '34.7111',
    to_token_amount: '12.723423',
    price_from_in_usd: '0.3667',
    price_to_in_usd: '1.0006',
    volume_in_usd: '12.73',
    ...over,
  },
});
const body = (...items: unknown[]) => ({ data: items });

describe('parseTrades', () => {
  it('reads a sell of the first token, with the first token as the one being looked at', () => {
    const [t] = parseTrades(body(raw()));
    expect(t).toEqual<Trade>({ t: Date.parse('2026-10-12T21:25:56Z'), kind: 'sell', usd: 12.73, tokenAmount: 34.7111, quoteAmount: 12.723423, priceUsd: 0.3667, trader: WHO, tx: TX });
  });

  it('reads a buy of the first token: the first token comes out of the pool (the `to` side)', () => {
    const [t] = parseTrades(body(raw({ kind: 'buy', from_token_amount: '12.7', to_token_amount: '34.7', price_to_in_usd: '0.3667', price_from_in_usd: '1.0006' })));
    expect(t).toMatchObject({ kind: 'buy', tokenAmount: 34.7, quoteAmount: 12.7, priceUsd: 0.3667 });
  });

  it('flips everything when the second token is the one being looked at', () => {
    const sellOfFirst = parseTrades(body(raw()), 'quote')[0]!;
    // The first token going in is the second token coming out: a buy of the second token, at the second token's price.
    expect(sellOfFirst).toMatchObject({ kind: 'buy', tokenAmount: 12.723423, quoteAmount: 34.7111, priceUsd: 1.0006 });
    const buyOfFirst = parseTrades(body(raw({ kind: 'buy' })), 'quote')[0]!;
    expect(buyOfFirst.kind).toBe('sell');
  });

  it('lists the newest trade first, whatever order they arrive in', () => {
    const trades = parseTrades(body(raw({ block_timestamp: '2026-10-12T20:00:00Z' }), raw({ block_timestamp: '2026-10-12T22:00:00Z' }), raw({ block_timestamp: '2026-10-12T21:00:00Z' })));
    expect(trades.map((t) => new Date(t.t).getUTCHours())).toEqual([22, 21, 20]);
  });

  it('drops any row with a missing or malformed field instead of drawing a wrong one', () => {
    const bad = [
      raw({ kind: 'swap' }),
      raw({ block_timestamp: 'yesterday' }),
      raw({ block_timestamp: 5 }),
      raw({ from_token_amount: 'x' }),
      raw({ to_token_amount: null }),
      raw({ volume_in_usd: '-1' }),
      raw({ from_token_amount: '-3' }),
      raw({ tx_hash: 'short' }),
      raw({ tx_hash: `${TX}"><script>` }),
      raw({ tx_from_address: '../../etc' }),
      raw({ tx_from_address: 42 }),
      { attributes: null },
      null,
      'nope',
    ];
    expect(parseTrades(body(...bad))).toEqual([]);
  });

  it('treats a missing or non-positive price as unknown, not zero', () => {
    expect(parseTrades(body(raw({ price_from_in_usd: null })))[0]!.priceUsd).toBeNull();
    expect(parseTrades(body(raw({ price_from_in_usd: '0' })))[0]!.priceUsd).toBeNull();
  });

  it('keeps at most 300 rows and tolerates an answer of the wrong shape', () => {
    const many = Array.from({ length: 450 }, (_, i) => raw({ block_timestamp: new Date(Date.UTC(2026, 9, 12, 0, 0, i)).toISOString() }));
    expect(parseTrades(body(...many))).toHaveLength(MAX_TRADES);
    expect(parseTrades(null)).toEqual([]);
    expect(parseTrades({ data: 'x' })).toEqual([]);
    expect(parseTrades({})).toEqual([]);
  });
});

describe('readServerTrades', () => {
  const row: Trade = { t: 1, kind: 'buy', usd: 5, tokenAmount: 2, quoteAmount: 3, priceUsd: 2.5, trader: WHO, tx: TX };

  it('accepts well-formed rows and rejects the rest, so an odd answer cannot put anything unexpected on the page', () => {
    const rows = readServerTrades({ trades: [row, { ...row, kind: 'x' }, { ...row, tx: 'javascript:alert(1)' }, { ...row, usd: 'five' }, { ...row, priceUsd: 'n/a' }, null] });
    expect(rows).toHaveLength(2);
    expect(rows![1]!.priceUsd).toBeNull();
  });

  it('says it could not read the answer when it is not a list', () => {
    expect(readServerTrades({})).toBeNull();
    expect(readServerTrades(null)).toBeNull();
    expect(readServerTrades({ trades: 'x' })).toBeNull();
  });
});

describe('links', () => {
  it('builds explorer links for every chain from a safe hash or address', () => {
    expect(txLink('solana', '5'.repeat(88))).toBe(`https://solscan.io/tx/${'5'.repeat(88)}`);
    expect(txLink('bnb', TX)).toBe(`https://bscscan.com/tx/${TX}`);
    expect(traderLink('polygon', WHO)).toBe(`https://polygonscan.com/address/${WHO}`);
    expect(traderLink('robinhood', WHO)).toBe(`https://robinhoodchain.blockscout.com/address/${WHO}`);
    expect(traderLink('solana', 'A'.repeat(44))).toBe(`https://solscan.io/account/${'A'.repeat(44)}`);
  });

  it('never builds a link from anything that is not a plain hash or address', () => {
    for (const bad of ['', 'abc', '../../x', 'https://evil.example', `${TX}?x=1`, 'a b'.repeat(10)]) {
      expect(txLink('ethereum', bad)).toBeNull();
      expect(traderLink('ethereum', bad)).toBeNull();
    }
  });
});

describe('formatting', () => {
  it('says how long ago in the shape DexScreener uses', () => {
    const now = 1_800_000_000_000;
    expect(timeAgo(now - 6_000, now)).toBe('6s ago');
    expect(timeAgo(now - 12 * 60_000, now)).toBe('12m ago');
    expect(timeAgo(now - (3 * 3600 + 20 * 60) * 1000, now)).toBe('3h 20m ago');
    expect(timeAgo(now - (25 * 3600) * 1000, now)).toBe('1d 1h ago');
    expect(timeAgo(now + 5_000, now)).toBe('0s ago');
  });

  it('keeps big amounts whole and small ones to a few digits', () => {
    expect(formatAmount(247_809_125.4)).toBe('247,809,125');
    expect(formatAmount(1.2)).toBe('1.2');
    expect(formatAmount(0.0123456)).toBe('0.0123');
    expect(formatAmount(0)).toBe('0');
    expect(formatAmount(Number.NaN)).toBe('–');
    expect(formatTradeUsd(1356.2)).toBe('1,356.20');
    expect(formatTradeUsd(0.5)).toBe('0.50');
  });
});

describe('fetchTrades', () => {
  beforeEach(() => {
    resetUpstreamHealth();
    setGeckoGap(0);
  });
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const serverRow: Trade = { t: 1, kind: 'buy', usd: 5, tokenAmount: 2, quoteAmount: 3, priceUsd: 2.5, trader: WHO, tx: TX };

  it("asks Aretia's own route first, so the visitor's allowance is not spent", async () => {
    const f = vi.fn(async () => ok({ trades: [serverRow], stale: false })) as unknown as typeof fetch;
    const rows = await fetchTrades('polygon', POOL, 'quote', f);
    expect(rows).toEqual([serverRow]);
    expect(f).toHaveBeenCalledTimes(1);
    const u = new URL(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]), 'https://x.test');
    expect(u.pathname).toBe('/api/swings-trades');
    expect(Object.fromEntries(u.searchParams)).toEqual({ chain: 'polygon', pool: POOL, token: 'quote' });
  });

  it('goes to GeckoTerminal directly when the route is missing, refused or unreadable', async () => {
    for (const broken of [() => ok({}, 404), () => ok({}, 502), () => { throw new Error('offline'); }, () => ok({ nope: true })]) {
      resetUpstreamHealth();
      const f = vi.fn(async (url: unknown) => (String(url).startsWith('/api/swings-trades') ? broken() : ok(body(raw())))) as unknown as typeof fetch;
      const rows = await fetchTrades('polygon', POOL, 'base', f);
      expect(rows).toHaveLength(1);
      const last = String((f as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
      expect(last).toBe(`https://api.geckoterminal.com/api/v2/networks/polygon_pos/pools/${POOL}/trades`);
    }
  });

  it('says plainly when nothing can be loaded, and treats an unknown pool as an empty list', async () => {
    const down = (status: number) => vi.fn(async () => ok({}, status)) as unknown as typeof fetch;
    // Each case is a fresh visit, so the earlier ones' rationing does not carry over.
    await expect(fetchTrades('solana', POOL, 'base', down(503))).rejects.toThrow('The trades could not be loaded.');
    resetUpstreamHealth();
    await expect(fetchTrades('solana', POOL, 'base', down(429))).rejects.toThrow(/busy/);
    resetUpstreamHealth();
    await expect(fetchTrades('solana', POOL, 'base', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).rejects.toThrow('The trades could not be loaded.');
    resetUpstreamHealth();
    expect(await fetchTrades('solana', POOL, 'base', down(404))).toEqual([]);
  });

  describe('when the route is failing', () => {
    const route = (f: (url: string) => Response | Promise<Response>) => vi.fn(async (url: unknown) => f(String(url))) as unknown as typeof fetch;
    const serverCalls = (f: typeof fetch) => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).startsWith('/api/swings-trades')).length;
    const directCalls = (f: typeof fetch) => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).startsWith('https://api.geckoterminal.com')).length;

    it('stops asking the route for a minute after it fails, and asks again once the minute is up', async () => {
      let clock = 1_000_000;
      const f = route((u) => (u.startsWith('/api/swings-trades') ? ok({}, 502) : ok(body(raw()))));
      await fetchTrades('polygon', POOL, 'base', f, undefined, () => clock);
      expect(serverCalls(f)).toBe(1);
      // Later checks go straight to the fallback without waiting on the route.
      clock += 20_000;
      await fetchTrades('polygon', POOL, 'base', f, undefined, () => clock);
      clock += 20_000;
      await fetchTrades('polygon', POOL, 'base', f, undefined, () => clock);
      expect(serverCalls(f)).toBe(1);
      // After a minute it gets another chance.
      clock += 30_000;
      await fetchTrades('polygon', POOL, 'base', f, undefined, () => clock);
      expect(serverCalls(f)).toBe(2);
    });

    it('goes back to the route as soon as it answers again', async () => {
      let clock = 5_000_000;
      let healthy = false;
      const f = route((u) => (u.startsWith('/api/swings-trades') ? (healthy ? ok({ trades: [serverRow] }) : ok({}, 502)) : ok(body(raw()))));
      await fetchTrades('polygon', POOL, 'base', f, undefined, () => clock);
      healthy = true;
      clock += 61_000;
      expect(await fetchTrades('polygon', POOL, 'base', f, undefined, () => clock)).toEqual([serverRow]);
      // And it stays in use: the next check asks it again, not the fallback.
      clock += 1_000;
      const before = directCalls(f);
      await fetchTrades('polygon', POOL, 'base', f, undefined, () => clock);
      expect(directCalls(f)).toBe(before);
    });

    it("rations reads of GeckoTerminal itself to one every 15 seconds per pool, so the table cannot use up the visitor's allowance", async () => {
      let clock = 9_000_000;
      const f = route((u) => (u.startsWith('/api/swings-trades') ? ok({}, 502) : ok(body(raw()))));
      await fetchTrades('polygon', POOL, 'base', f, undefined, () => clock);
      expect(directCalls(f)).toBe(1);
      // The table checks every second; nothing more is read until 15 seconds have passed.
      for (let i = 0; i < 10; i++) {
        clock += 1_000;
        await expect(fetchTrades('polygon', POOL, 'base', f, undefined, () => clock)).rejects.toThrow('The trades will refresh shortly.');
      }
      expect(directCalls(f)).toBe(1);
      clock += 6_000;
      await fetchTrades('polygon', POOL, 'base', f, undefined, () => clock);
      expect(directCalls(f)).toBe(2);
      // Another pool has its own allowance.
      await fetchTrades('polygon', '0x9999999999999999999999999999999999999999', 'base', f, undefined, () => clock);
      expect(directCalls(f)).toBe(3);
    });
  });

  it('stops quietly when the table was closed while it was loading', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const f = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch;
    await expect(fetchTrades('solana', POOL, 'base', f, ctl.signal)).rejects.toThrow('cancelled');
  });
});
