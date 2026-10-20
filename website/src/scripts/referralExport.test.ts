import { describe, expect, it } from 'vitest';
import { assetInfo, fromUnits, owedByReferrer, paymentKey, recheckRows, renderCsv, renderExport } from '../../scripts/referralExportCore.mjs';

const row = (referrer: string, chain: string, asset: string, share: string, over: Record<string, unknown> = {}) => ({ referrer, chain, asset, fee_raw: String(BigInt(share) * 5n), share_raw: share, status: 'credited', paid_at: null, ...over });
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

describe('the owner export', () => {
  it('totals what is owed per referrer, chain and coin, leaving out capped, flagged, paid and revoked amounts', () => {
    const g = owedByReferrer(
      [row('evm:0xaa', 'ethereum', USDC, '1160000'), row('evm:0xaa', 'ethereum', USDC, '1160000'), row('evm:0xaa', 'ethereum', USDC, '500', { status: 'capped' }), row('evm:0xaa', 'ethereum', USDC, '700000', { paid_at: 5 }), row('evm:0xbb', 'bnb', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '2000000000000000'), row('evm:0xcc', 'ethereum', USDC, '9000000')],
      ['evm:0xcc'],
    );
    expect(g.find((x: { referrer: string }) => x.referrer === 'evm:0xaa')).toMatchObject({ swaps: 3, owed: 2_320_000n, paid: 700_000n, void: 0n });
    expect(g.find((x: { referrer: string }) => x.referrer === 'evm:0xcc')).toMatchObject({ owed: 0n, void: 9_000_000n });
    const text = renderExport(g, new Date('2026-10-18T00:00:00Z'));
    expect(text).toContain('0xaa  [ethereum]  owed 2.32 USDC');
    expect(text).toContain('0xbb  [bnb]  owed 0.002 BNB');
    expect(text).toContain('Void (referrer revoked)');
    expect(text).not.toMatch(/0xcc {2}\[ethereum\] {2}owed/);
    expect(renderCsv(g).split('\n')[0]).toBe('referrer,chain,asset,symbol,swaps,fee_raw,owed_raw,paid_raw,void_raw');
  });
  it('says so when nothing is owed, and prints raw units for a coin it does not know', () => {
    expect(renderExport([])).toContain('Nothing is owed.');
    expect(renderExport(owedByReferrer([row('evm:0xaa', 'ethereum', '0x' + 'd'.repeat(40), '5')]))).toContain('5 raw units of 0x' + 'd'.repeat(40));
    expect(assetInfo('solana', 'So11111111111111111111111111111111111111112')).toEqual({ symbol: 'SOL', decimals: 9 });
    expect(fromUnits('1500000000', 9)).toBe('1.5');
  });

  it('M-1: pays an EVM payment once whatever the case of its hash, keeping the earliest credited row; Solana stays case-sensitive', () => {
    const h = '0x' + 'ab'.repeat(32);
    const rows = [
      row('evm:0xaa', 'ethereum', USDC, '100', { tx: h.toUpperCase().replace('0X', '0x'), created_at: 2 }),
      row('evm:0xaa', 'ethereum', USDC, '100', { tx: h, created_at: 1 }),
      row('evm:0xaa', 'ethereum', USDC, '100', { tx: h, status: 'flagged', created_at: 0 }),
      row('solana:S', 'solana', 'So11111111111111111111111111111111111111112', '7', { tx: 'abcDEF'.repeat(12), created_at: 3 }),
      row('solana:S', 'solana', 'So11111111111111111111111111111111111111112', '7', { tx: 'ABCdef'.repeat(12), created_at: 4 }),
    ];
    const g = owedByReferrer(rows);
    expect(g.find((x: { referrer: string }) => x.referrer === 'evm:0xaa')).toMatchObject({ swaps: 1, owed: 100n });
    expect(g.find((x: { referrer: string }) => x.referrer === 'solana:S')).toMatchObject({ swaps: 2, owed: 14n });
  });

  it('L-6: re-reads unpaid payments before payout and leaves out what is not final, failed or missing', async () => {
    const ok = '0x' + '01'.repeat(32);
    const shallow = '0x' + '02'.repeat(32);
    const reverted = '0x' + '03'.repeat(32);
    const rows = [ok, shallow, reverted].map((tx, i) => row('evm:0xaa', 'ethereum', USDC, '10', { tx, created_at: i }));
    rows.push(row('solana:S', 'solana', 'So11111111111111111111111111111111111111112', '7', { tx: 'sigConfirmed', created_at: 9 }));
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      if (req.method === 'eth_blockNumber') return reply('0x' + (1000).toString(16));
      if (req.method === 'getSignatureStatuses') return reply({ value: [{ err: null, confirmationStatus: 'confirmed' }] });
      const tx = String(req.params[0]);
      if (tx === ok) return reply({ status: '0x1', blockNumber: '0x10' });
      if (tx === shallow) return reply({ status: '0x1', blockNumber: '0x' + (990).toString(16) });
      return reply({ status: '0x0', blockNumber: '0x10' });
    }) as unknown as typeof fetch;
    const bad = await recheckRows(rows, fetchImpl);
    expect([...bad].sort()).toEqual([paymentKey(rows[1]), paymentKey(rows[2]), paymentKey(rows[3])].sort());
    expect(owedByReferrer(rows, [], bad).find((x: { referrer: string }) => x.referrer === 'evm:0xaa')).toMatchObject({ swaps: 1, owed: 10n });
  });
});
