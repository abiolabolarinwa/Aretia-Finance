import { beforeEach, describe, expect, it } from 'vitest';
import { CHUNK, decodeResults, encodeBalanceCalls, MULTICALL3, resetScanLists, scanKnownTokens } from './walletHoldingsScan';

const HOLDER = '0xd366c0000000000000000000000000000007ec2a'.slice(0, 42);
const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');

/** What Multicall3 answers: for each call, success and (for a success) one 32-byte value. */
function encodeAnswer(values: (bigint | null)[]): string {
  const structs = values.map((v) => (v === null ? word(0) + word(0x40) + word(0) : word(1) + word(0x40) + word(32) + word(v)));
  let off = values.length * 32;
  const offsets = structs.map((s) => {
    const o = off;
    off += s.length / 2;
    return word(o);
  });
  return '0x' + word(0x20) + word(values.length) + offsets.join('') + structs.join('');
}

/** The target addresses packed into an `aggregate3` request, read back the way the contract reads them. */
function targetsOf(data: string): string[] {
  const body = data.slice(10);
  const n = Number(BigInt('0x' + body.slice(64, 128)));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const off = Number(BigInt('0x' + body.slice(128 + i * 64, 192 + i * 64)));
    const s = 64 + 64 + off * 2; // the elements start after the offset word and the length word
    out.push('0x' + body.slice(s + 24, s + 64));
  }
  return out;
}

describe('the balance request', () => {
  it('is an aggregate3 call with one struct per token, each asking balanceOf(holder) of its token', () => {
    const tokens = [addr(1), addr(2), addr(3)];
    const data = encodeBalanceCalls(HOLDER, tokens);
    expect(data.startsWith('0x82ad56cb')).toBe(true);
    expect(targetsOf(data)).toEqual(tokens);
    // Each struct: target, allowFailure = true, bytes offset 0x60, length 0x24, then the call padded to 64 bytes.
    const call = '70a08231' + HOLDER.slice(2).padStart(64, '0');
    expect(data).toContain(word(1) + word(0x60) + word(36) + call.padEnd(128, '0'));
    expect((data.length - 10) / 2).toBe(32 + 32 + 3 * 32 + 3 * 192);
  });
});

describe('the answer', () => {
  it('gives each call\'s success and value, and nothing for a call that failed', () => {
    const out = decodeResults(encodeAnswer([5n, null, 0n, 123456789012345678901234567890n]));
    expect(out).toEqual([
      { ok: true, value: 5n },
      { ok: false, value: 0n },
      { ok: true, value: 0n },
      { ok: true, value: 123456789012345678901234567890n },
    ]);
  });
  it('rejects anything that is not a well-formed answer', () => {
    for (const bad of [null, undefined, 12, '', '0x', 'zz', '0x1234', '0x' + word(0x20) + word(5)]) expect(decodeResults(bad), String(bad)).toBeNull();
  });
});

describe('scanning a wallet against the index', () => {
  beforeEach(() => resetScanLists());
  const universe = Array.from({ length: CHUNK * 2 + 50 }, (_, i) => addr(i + 1));
  const heldTokens = new Set([addr(7), addr(CHUNK + 5), addr(CHUNK * 2 + 40)]);

  const fetchImpl = (async (url: string) => {
    if (!url.startsWith('/api/v1/tokens/')) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ data: { addresses: url.includes('/bnb') ? universe : [] } }));
  }) as unknown as typeof fetch;
  const node = (calls: string[][]) => (() => async (method: string, params: unknown[]) => {
    expect(method).toBe('eth_call');
    const { to, data } = params[0] as { to: string; data: string };
    expect(to).toBe(MULTICALL3);
    const targets = targetsOf(data);
    calls.push(targets);
    return encodeAnswer(targets.map((t) => (heldTokens.has(t) ? 10n ** 18n : 0n)));
  });

  it('finds the held tokens across every chunk, and asks only for the networks it has a list for', async () => {
    const calls: string[][] = [];
    const found = await scanKnownTokens(HOLDER, ['bnb', 'ethereum', 'solana'], { fetchImpl, read: node(calls) as never });
    expect(found.map((f) => f.address).sort()).toEqual([...heldTokens].sort());
    expect(found.every((f) => f.chain === 'bnb')).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.length <= CHUNK)).toBe(true);
  });

  it('keeps the list for a while instead of fetching it for every scan', async () => {
    let fetched = 0;
    const counting = (async (u: string) => ((fetched++), fetchImpl(u))) as unknown as typeof fetch;
    await scanKnownTokens(HOLDER, ['bnb'], { fetchImpl: counting, read: node([]) as never });
    await scanKnownTokens(HOLDER, ['bnb'], { fetchImpl: counting, read: node([]) as never });
    expect(fetched).toBe(1);
  });

  it('skips a chunk the node will not answer and still reports the others', async () => {
    let n = 0;
    const flaky = () => async (_m: string, params: unknown[]) => {
      if (n++ === 1) throw new Error('node down');
      return encodeAnswer(targetsOf((params[0] as { data: string }).data).map((t) => (heldTokens.has(t) ? 1n : 0n)));
    };
    const found = await scanKnownTokens(HOLDER, ['bnb'], { fetchImpl, read: flaky as never });
    expect(found.length).toBe(2);
  });

  it('returns what it has when the time runs out, and nothing for a bad address or an unreachable list', async () => {
    let clock = 0;
    const slow = (() => async (_m: string, params: unknown[]) => {
      clock += 20_000;
      return encodeAnswer(targetsOf((params[0] as { data: string }).data).map(() => 0n));
    }) as never;
    const calls = await scanKnownTokens(HOLDER, ['bnb'], { fetchImpl, read: slow, now: () => clock, budgetMs: 25_000 });
    expect(calls).toEqual([]);
    expect(await scanKnownTokens('not-an-address', ['bnb'], { fetchImpl, read: node([]) as never })).toEqual([]);
    resetScanLists();
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await scanKnownTokens(HOLDER, ['bnb'], { fetchImpl: down, read: node([]) as never })).toEqual([]);
  });
});
