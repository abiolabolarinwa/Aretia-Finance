import { beforeEach, describe, expect, it } from 'vitest';
import { FREEZE_AUTHORITY, MINT_AUTHORITY } from './buyable';
import { mintFlagReader, resetMintFlagMemory } from './mintFlags';

/** An SPL mint account's bytes: optional mint authority, supply, decimals, initialised, optional freeze authority. */
function mintAccount(opts: { mint?: boolean; freeze?: boolean }): { data: [string, string] } {
  const d = new Uint8Array(82);
  const v = new DataView(d.buffer);
  if (opts.mint) {
    v.setUint32(0, 1, true);
    d.fill(7, 4, 36);
  }
  v.setBigUint64(36, 1_000_000n, true);
  d[44] = 6;
  d[45] = 1;
  if (opts.freeze) {
    v.setUint32(46, 1, true);
    d.fill(9, 50, 82);
  }
  return { data: [btoa(String.fromCharCode(...d)), 'base64'] };
}

const A = 'A'.repeat(43) + '1';
const mints = (n: number): string[] => Array.from({ length: n }, (_, i) => `M${i}`.padEnd(44, 'x'));
const answer = (value: unknown[]) => new Response(JSON.stringify({ result: { value } }), { status: 200 });

beforeEach(() => resetMintFlagMemory());

describe('mintFlagReader', () => {
  it('reads what each mint still allows: nothing, the mint authority, the freeze authority, both', async () => {
    const f = (async () => answer([mintAccount({}), mintAccount({ mint: true }), mintAccount({ freeze: true }), mintAccount({ mint: true, freeze: true })])) as unknown as typeof fetch;
    const got = await mintFlagReader(['https://node.example'], f)(['a', 'b', 'c', 'd']);
    expect([...got.values()]).toEqual([0, MINT_AUTHORITY, FREEZE_AUTHORITY, MINT_AUTHORITY | FREEZE_AUTHORITY]);
  });

  it('asks 100 mints to a request, remembers what it read, and does not ask again for it', async () => {
    let calls = 0;
    const f = (async (_u: string, init: RequestInit) => {
      calls++;
      const n = (JSON.parse(String(init.body)).params[0] as string[]).length;
      return answer(Array.from({ length: n }, () => mintAccount({})));
    }) as unknown as typeof fetch;
    const read = mintFlagReader(['https://node.example'], f);
    const list = mints(230);
    const first = await read(list);
    expect(calls).toBe(3);
    expect(first.size).toBe(230);
    await read(list);
    expect(calls).toBe(3);
  });

  it('tries the next node when one fails, and says unknown (null), never safe, when every node fails or an account is missing', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      return u.includes('bad') ? new Response('', { status: 429 }) : answer([null, mintAccount({})]);
    }) as unknown as typeof fetch;
    const got = await mintFlagReader(['https://bad.example', 'https://good.example'], f)(['x', 'y']);
    expect(urls).toEqual(['https://bad.example', 'https://good.example']);
    expect(got.get('x')).toBeNull();
    expect(got.get('y')).toBe(0);
    resetMintFlagMemory();
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const none = await mintFlagReader(['https://a.example'], down)([A]);
    expect(none.get(A)).toBeNull();
  });
});
