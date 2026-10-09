import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { handlePools, resetPoolCache } from './_swingsPools.js';
import { scanQueries } from '../src/swings/solana/poolScan.js';
import { aretiaPoolHints } from '../src/swings/solana/poolHints.js';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const POOL = 'Dwq4PxyBQ8dHPmP5u5H7bHsjHp46StGtkSy2gEVedDm';
const NOW = 1_800_000_000_000;
const base = (q: Record<string, string>, fetchImpl: typeof fetch, over = {}) => ({ method: 'GET', origin: 'https://aretiafinance.org', authorization: null, ip: '2.2.2.2', query: q, env: {}, fetchImpl, now: NOW, ...over });

describe('pools found from the chain', () => {
  beforeEach(() => {
    resetRateLimit();
    resetPoolCache();
  });

  it('asks five questions per token, with the mint at the right place of each pool layout', () => {
    const q = scanQueries(MINT);
    expect(q).toHaveLength(5);
    const offsets = q.map((x) => (x.filters.at(-1) as { memcmp: { offset: number } }).memcmp.offset);
    expect(offsets).toEqual([400, 432, 73, 105, 136]);
  });

  it('returns the pools the chain lists, and keeps the answer', async () => {
    let calls = 0;
    const f = (async (_u: string, init?: RequestInit) => {
      calls++;
      const m = JSON.parse(String(init?.body)) as { params: [string] };
      return new Response(JSON.stringify({ result: m.params[0] === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' ? [{ pubkey: POOL }] : [] }));
    }) as unknown as typeof fetch;
    const a = await handlePools(base({ mint: MINT }, f));
    expect(JSON.parse(a.body)).toEqual({ pools: [POOL] });
    const used = calls;
    const b = await handlePools(base({ mint: MINT }, f));
    expect(JSON.parse(b.body)).toMatchObject({ pools: [POOL], cached: true });
    expect(calls).toBe(used);
  });

  it('skips the main coins without any RPC call, and refuses bad input and foreign origins', async () => {
    const never = (async () => {
      throw new Error('no');
    }) as unknown as typeof fetch;
    expect(JSON.parse((await handlePools(base({ mint: 'So11111111111111111111111111111111111111112' }, never))).body).pools).toEqual([]);
    expect((await handlePools(base({ mint: 'x' }, never))).status).toBe(400);
    expect((await handlePools(base({ mint: MINT }, never, { origin: 'https://evil.example' }))).status).toBe(403);
  });

  it('the page asks Aretia first and DexScreener only when that gives nothing', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      return u.startsWith('/api/swings-pools') ? new Response(JSON.stringify({ pools: [POOL, 'bad'] })) : new Response('[]');
    }) as unknown as typeof fetch;
    expect(await aretiaPoolHints(f)(MINT)).toEqual([POOL]);
    expect(urls).toEqual([`/api/swings-pools?mint=${MINT}`]);
    const empty = (async (u: string) => (u.startsWith('/api/') ? new Response(JSON.stringify({ pools: [] })) : new Response(JSON.stringify([{ pairAddress: POOL }])))) as unknown as typeof fetch;
    expect(await aretiaPoolHints(empty)(MINT)).toEqual([POOL]);
  });
});
