import { describe, expect, it } from 'vitest';
import { decodeAggregate3, describeApprovals, encodeAggregate3, MULTICALL3, PERMIT2, readApprovals, revokeCall, spendersFor, tokensFor, UNLIMITED } from './approvals.js';

const OWNER = '0xd366cf21ca17487fab4734a32a53c7a155d7ec2a';

describe('which tokens and spenders are asked about', () => {
  it('asks about the router of each venue on the network, and Permit2, once each', () => {
    const s = spendersFor('bnb');
    expect(s.some((x) => /PancakeSwap/.test(x.label))).toBe(true);
    expect(s.find((x) => x.address === PERMIT2)).toBeTruthy();
    expect(new Set(s.map((x) => x.address)).size).toBe(s.length);
  });
  it('asks about the wrapped coin and the stablecoins, plus any the caller adds', () => {
    const t = tokensFor('bnb', [{ address: '0xAbC0000000000000000000000000000000000001', symbol: 'ARK', decimals: 18 }]);
    expect(t.map((x) => x.symbol)).toEqual(expect.arrayContaining(['WBNB', 'USDT', 'USDC', 'ARK']));
    expect(t.every((x) => x.address === x.address.toLowerCase())).toBe(true);
  });
});

describe('Multicall3 by hand', () => {
  it('encodes calls the way Multicall3 expects, with the right selector and layout', () => {
    const data = encodeAggregate3([{ target: '0x' + '11'.repeat(20), data: '0xdd62ed3e' + '00'.repeat(64) }]);
    // aggregate3((address,bool,bytes)[])
    expect(data.startsWith('0x82ad56cb')).toBe(true);
    const words = data.slice(10).match(/.{64}/g)!;
    expect(BigInt('0x' + words[0]!)).toBe(0x20n); // the array starts after one head word
    expect(BigInt('0x' + words[1]!)).toBe(1n); // one call
    expect(BigInt('0x' + words[2]!)).toBe(0x20n); // its element starts 32 bytes in
    expect(words[3]).toBe('000000000000000000000000' + '11'.repeat(20)); // target
    expect(BigInt('0x' + words[4]!)).toBe(1n); // allowFailure
    expect(BigInt('0x' + words[5]!)).toBe(0x60n); // bytes start after three head words
    expect(BigInt('0x' + words[6]!)).toBe(68n); // 4-byte selector + two 32-byte arguments
  });
  it('decodes results: success flag and the first word, or nothing when a call failed or returned nothing', () => {
    const w = (n: bigint): string => n.toString(16).padStart(64, '0');
    const item = (ok: boolean, ret: string): string => w(ok ? 1n : 0n) + w(0x40n) + w(BigInt(ret.length / 2)) + ret.padEnd(Math.ceil(ret.length / 64) * 64, '0');
    const a = item(true, w(7n));
    const b = item(false, '');
    const c = item(true, '');
    const bodies = [a, b, c];
    let offset = 0x60;
    const offsets = bodies.map((x) => {
      const o = offset;
      offset += x.length / 2;
      return w(BigInt(o));
    });
    const hex = '0x' + w(0x20n) + w(3n) + offsets.join('') + bodies.join('');
    expect(decodeAggregate3(hex)).toEqual([{ success: true, first: 7n }, { success: false, first: null }, { success: true, first: null }]);
  });
  it('reads only the non-zero allowances, and flags an unlimited one', async () => {
    const tokens = [{ address: '0x' + 'aa'.repeat(20), symbol: 'AAA', decimals: 6 }, { address: '0x' + 'bb'.repeat(20), symbol: 'BBB', decimals: 18 }];
    const spenders = [{ address: '0x' + '01'.repeat(20), label: 'One' }, { address: '0x' + '02'.repeat(20), label: 'Two' }];
    const w = (n: bigint): string => n.toString(16).padStart(64, '0');
    // pairs in order: AAA/One, AAA/Two, BBB/One, BBB/Two  ->  0, 5 AAA, unlimited BBB, 0
    const answers = [0n, 5_000_000n, UNLIMITED, 0n];
    const bodies = answers.map((n) => w(1n) + w(0x40n) + w(32n) + w(n));
    let offset = 0x20 * 4;
    const offsets = bodies.map((b) => {
      const o = offset;
      offset += b.length / 2;
      return w(BigInt(o));
    });
    const reply = '0x' + w(0x20n) + w(4n) + offsets.join('') + bodies.join('');
    let sent: { to: string } | null = null;
    const read = (async (_m: string, p: unknown[]) => {
      sent = p[0] as { to: string };
      return reply;
    }) as Parameters<typeof readApprovals>[2];
    const found = await readApprovals('bnb', OWNER, read, tokens, spenders);
    expect(sent!.to).toBe(MULTICALL3);
    expect(found.map((f) => `${f.token.symbol}/${f.spender.label}/${f.unlimited}`)).toEqual(['AAA/Two/false', 'BBB/One/true']);
    const text = describeApprovals(found);
    expect(text[0]).toMatchObject({ severity: 'note' });
    expect(text[0]!.title).toMatch(/Two can spend 5 AAA/);
    expect(text[1]).toMatchObject({ severity: 'warn' });
    expect(text[1]!.title).toMatch(/can spend unlimited BBB/);
  });
  it('builds the call that takes a permission back: approve(spender, 0)', () => {
    const c = revokeCall('0x' + '01'.repeat(20));
    expect(c.startsWith('0x095ea7b3')).toBe(true);
    expect(c.length).toBe(2 + 8 + 64 + 64);
    expect(c.endsWith('0'.repeat(64))).toBe(true);
  });
});
