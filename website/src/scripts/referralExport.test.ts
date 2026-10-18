/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { assetInfo, fromUnits, owedByReferrer, renderCsv, renderExport } from '../../scripts/referralExportCore.mjs';

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
});
