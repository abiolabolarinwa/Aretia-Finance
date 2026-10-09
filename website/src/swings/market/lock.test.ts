import { describe, expect, it } from 'vitest';
import { AMM_V4_PROGRAM } from '../solana/raydiumAmmV4.js';
import { burnedShare, checkLock, evmLock, solanaLock, type LockRead, type SolRead } from './lock.js';
import { marketFromAttributes } from './snapshot.js';
import { rowNumbers } from './snapshot.js';

const NOW = 1_800_000_000_000;
const MINT = 'So11111111111111111111111111111111111111112';

describe('burned liquidity', () => {
  it('does not count the 1,000 units every V2 pair parks at the zero address', () => {
    expect(burnedShare(1_000_000n, 0n, 1000n)).toBe(0);
    expect(burnedShare(1_000_000n, 500_000n, 1000n)).toBe(50);
    expect(burnedShare(1_000_000n, 0n, 501_000n)).toBe(50);
    expect(burnedShare(0n, 0n, 0n)).toBe(0);
  });

  it('gives nothing for an address that is not a pair, or when the node fails', async () => {
    expect(await evmLock((async () => '0x') as LockRead, '0x' + '1'.repeat(40), NOW)).toBeNull();
    expect(await evmLock((async () => { throw new Error('down'); }) as LockRead, '0x' + '1'.repeat(40), NOW)).toBeNull();
    expect(await evmLock((async () => '0x') as LockRead, 'not an address', NOW)).toBeNull();
    expect(await checkLock('base', '0x' + '1'.repeat(40), {}, NOW)).toBeNull();
  });

  it('reads a Raydium AMM v4 pool: burned share is what was minted minus what exists', async () => {
    const data = new Uint8Array(752);
    new DataView(data.buffer).setBigUint64(720, 1000n, true);
    const rpc = (async (method: string) => {
      if (method === 'getAccountInfo') return { value: { owner: AMM_V4_PROGRAM, data: [btoa(String.fromCharCode(...data)), 'base64'] } };
      return { value: { amount: '250' } };
    }) as SolRead;
    expect(await solanaLock(rpc, MINT, NOW)).toEqual({ pct: 75, kind: 'burned', at: NOW });
    const other = (async () => ({ value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } })) as SolRead;
    expect(await solanaLock(other, MINT, NOW)).toBeNull();
  });

  it('a row shows the padlock only from half burned', () => {
    const m = marketFromAttributes({ base_token_price_usd: '1' }, 'p'.repeat(30), NOW)!;
    expect(rowNumbers({ ...m, lock: { pct: 99.9, kind: 'burned', at: NOW } }, null, NOW).lockedPct).toBe(99.9);
    expect(rowNumbers({ ...m, lock: { pct: 10, kind: 'burned', at: NOW } }, null, NOW).lockedPct).toBeNull();
    expect(rowNumbers(m, null, NOW).lockedPct).toBeNull();
  });
});
