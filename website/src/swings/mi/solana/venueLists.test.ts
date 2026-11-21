import { describe, expect, it } from 'vitest';
import { encodeBase58 } from './accounts.js';
import { findCandidates, meteoraDlmmList, orcaList, raydiumList, type ListOptions, type ListSource } from './venueLists.js';
import { PROGRAMS } from './track.js';

const addr = (n: number): string => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0) + (i === 30 ? n >> 8 : 0) + (i === 31 ? n & 255 : 0)));
const raydiumProgram = Object.entries(PROGRAMS).find(([, p]) => p.id === 'raydium-cpmm-solana')![0];

/** A fetch that answers each venue's address from a table of handlers and records the addresses asked. */
function web(handlers: Record<string, (url: URL) => unknown | Response>) {
  const asked: string[] = [];
  const impl = (async (input: string) => {
    asked.push(input);
    const url = new URL(input);
    const h = handlers[url.host];
    if (!h) return new Response('no', { status: 404 });
    const out = h(url);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, asked };
}
const opts = (impl: typeof fetch, over: Partial<ListOptions> = {}): ListOptions => ({ fetchImpl: impl, minTvlUsd: 1_000, maxPerSource: 1_000, ...over });

describe('the venue lists', () => {
  it("Raydium: pages of its pools deepest first, stopping below the floor, keeping only programs Aretia reads", async () => {
    const pages: Record<number, unknown> = {
      1: { data: { hasNextPage: true, data: [{ id: addr(1), programId: raydiumProgram, tvl: 900_000 }, { id: addr(2), programId: 'StableSwapProgram11111111111111111111111111', tvl: 800_000 }, { id: addr(3), programId: raydiumProgram, tvl: 5_000 }] } },
      2: { data: { hasNextPage: true, data: [{ id: addr(4), programId: raydiumProgram, tvl: 400 }] } },
      3: { data: { hasNextPage: true, data: [{ id: addr(5), programId: raydiumProgram, tvl: 300 }] } },
    };
    const { impl, asked } = web({ 'api-v3.raydium.io': (u) => pages[Number(u.searchParams.get('page'))] });
    const got = await raydiumList.list(opts(impl));
    expect(got.map((c) => c.address)).toEqual([addr(1), addr(3)]);
    expect(asked).toHaveLength(2); // the page that went below the floor was the last one asked
    expect(asked[0]).toContain('poolSortField=liquidity');
  });

  it('Orca: follows the cursor until the pools get shallow or it runs out', async () => {
    const { impl, asked } = web({
      'api.orca.so': (u) =>
        u.searchParams.get('next') === null
          ? { data: [{ address: addr(1), tvlUsdc: '2000000.5' }, { address: addr(2), tvlUsdc: '80000' }], meta: { cursor: { next: 'abc' } } }
          : { data: [{ address: addr(3), tvlUsdc: '1500' }, { address: addr(4), tvlUsdc: '10' }], meta: { cursor: { next: 'def' } } },
    });
    const got = await orcaList.list(opts(impl));
    expect(got.map((c) => c.address)).toEqual([addr(1), addr(2), addr(3)]);
    expect(got[0]!.tvlUsd).toBe(2_000_000.5);
    expect(asked[1]).toContain('next=abc');
    expect(asked).toHaveLength(2);
  });

  it('Meteora DLMM: pages by number and respects the most one venue may give', async () => {
    const page = (start: number) => ({ data: Array.from({ length: 100 }, (_, i) => ({ address: addr(start + i), tvl: 1_000_000 - (start + i) })) });
    const { impl, asked } = web({ 'dlmm.datapi.meteora.ag': (u) => page((Number(u.searchParams.get('page')) - 1) * 100) });
    const got = await meteoraDlmmList.list(opts(impl, { maxPerSource: 250 }));
    expect(got).toHaveLength(250);
    expect(asked).toHaveLength(3);
  });

  it('ignores rows with no usable address or number', async () => {
    const { impl } = web({ 'api.orca.so': () => ({ data: [{ address: 'not an address', tvlUsdc: '9999999' }, { address: addr(1) }, { address: addr(2), tvlUsdc: 'abc' }, { address: addr(3), tvlUsdc: 50_000 }], meta: { cursor: { next: null } } }) });
    expect((await orcaList.list(opts(impl))).map((c) => c.address)).toEqual([addr(3)]);
  });
});

describe('all the venues together', () => {
  const source = (id: string, rows: [number, number][], fail = false): ListSource => ({
    id,
    async list() {
      if (fail) throw new Error('down');
      return rows.map(([n, tvl]) => ({ address: addr(n), tvlUsd: tvl, source: id }));
    },
  });

  it('merges by depth, one entry per address, and reports a venue that failed without losing the others', async () => {
    const o = opts(web({}).impl);
    const found = await findCandidates(o, [source('a', [[1, 500_000], [2, 3_000]]), source('b', [[3, 900_000], [2, 3_000]]), source('c', [], true)]);
    expect(found.candidates.map((c) => c.address)).toEqual([addr(3), addr(1), addr(2)]);
    expect(found.failed).toEqual(['c']);
    expect(found.perSource).toEqual({ a: 2, b: 2, c: 0 });
  });
});
