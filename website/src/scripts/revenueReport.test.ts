/* The pure part of the private revenue report (scripts/revenueReportCore.mjs). It is plain JavaScript so the command-line script can use it
 * without a build step; it is loaded here by a computed path, so the type checker treats it as untyped. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const spec = '../../scripts/revenueReportCore.mjs';
const core: any = await import(/* @vite-ignore */ spec);
const { EVM_CHAINS, EVM_CURVE, EVM_FEE_ADDRESS, SOLANA_FEE_WALLET, SOLANA_FLAT_FEE_LAMPORTS, addressTopic, buildReport, classifySolana, coinText, creationRevenue, decodeTradedFee, decodeTransferValue, fromUnits, ledgerLine, money, renderHtml, renderText, summariseSolana } = core;

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('the fee addresses and chain table match the ones the site uses', () => {
  it('the addresses are the site\'s', () => {
    expect(read('./walletLaunchEvmCore.ts')).toContain(`FEE_ADDRESS = '${EVM_FEE_ADDRESS}'`);
    expect(read('./walletCurveEvmCore.ts')).toContain(EVM_CURVE);
    expect(read('./walletPoolCore.ts')).toContain('LAUNCH_FEE_ADDRESS');
    expect(read('./walletLaunchCore.ts')).toContain(`LAUNCH_FEE_ADDRESS = '${SOLANA_FEE_WALLET}'`);
    expect(read('./walletLaunchCore.ts')).toContain(`LAUNCH_FEE_LAMPORTS = ${SOLANA_FLAT_FEE_LAMPORTS.toString().replace(/(\d)(?=(\d{3})+$)/g, '$1_')}n`);
  });
  it('each chain\'s factory, creation fee and stablecoins are the site\'s', () => {
    const launch = read('./walletLaunchEvmCore.ts');
    const pool = read('./walletPoolEvmCore.ts');
    for (const c of EVM_CHAINS as any[]) {
      expect(launch, c.name).toContain(`factory: '${c.factory}'`);
      expect(launch, c.name).toContain(`chainId: ${c.chainId}`);
      expect(pool, c.name).toContain(`address: '${c.stables.USDC.address}', decimals: ${c.stables.USDC.decimals}`);
      expect(pool, c.name).toContain(`address: '${c.stables.USDT.address}', decimals: ${c.stables.USDT.decimals}`);
    }
    // The creation fees as written in the site table: BNB 0.014, Ethereum 0.0042, Polygon 105.
    expect(launch).toContain("feeWei: coin('0.014')");
    expect(launch).toContain("feeWei: coin('0.0042')");
    expect(launch).toContain("feeWei: coin('105')");
    expect(EVM_CHAINS.find((c: any) => c.key === 'bnb').creationFeeWei).toBe(14_000_000_000_000_000n);
    expect(EVM_CHAINS.find((c: any) => c.key === 'ethereum').creationFeeWei).toBe(4_200_000_000_000_000n);
    expect(EVM_CHAINS.find((c: any) => c.key === 'polygon').creationFeeWei).toBe(105n * 10n ** 18n);
  });
});

describe('classifying and totalling', () => {
  it('counts exactly the flat fee as a launch fee, anything else positive as other, and money out as out', () => {
    expect(classifySolana(50_000_000n)).toBe('launch-fee');
    expect(classifySolana(50_000_001n)).toBe('other-in');
    expect(classifySolana(-5n)).toBe('out');
    expect(classifySolana(0n)).toBe('none');
    const s = summariseSolana([{ deltaLamports: 50_000_000n }, { deltaLamports: 50_000_000n, usdcDelta: 0n }, { deltaLamports: 7_000n, usdcDelta: 10_000_000n }, { deltaLamports: -3n, usdcDelta: -2_000_000n }]);
    expect(s.launchFees).toEqual({ count: 2, lamports: 100_000_000n });
    expect(s.otherIn).toEqual({ count: 1, lamports: 7_000n });
    expect(s.out).toEqual({ count: 1, lamports: 3n });
    expect(s.usdcIn).toBe(10_000_000n);
    expect(s.usdcOut).toBe(2_000_000n);
  });
  it('reads the fee out of a curve trade and the amount out of a transfer', () => {
    const w = (n: bigint | number): string => n.toString(16).padStart(64, '0');
    const traded = '0x' + w(1) + w(5_000n) + w(29_000n) + w(1n);
    expect(decodeTradedFee({ data: traded })).toBe(29_000n);
    expect(decodeTransferValue({ data: '0x' + w(10_000_000n) })).toBe(10_000_000n);
    expect(addressTopic(EVM_FEE_ADDRESS)).toBe('0x000000000000000000000000' + EVM_FEE_ADDRESS.slice(2));
    expect(creationRevenue(3, 4_200_000_000_000_000n)).toBe(12_600_000_000_000_000n);
  });
  it('formats amounts for people', () => {
    expect(fromUnits(1_500_000n, 6)).toBe('1.500000');
    expect(coinText(12_531_773_721_576_266n, 18, 'BNB')).toBe('0.012532 BNB');
    expect(coinText(2n * 10n ** 18n, 18, 'ETH')).toBe('2 ETH');
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(NaN)).toBe('n/a');
  });
});

const sample = () => {
  const chain = EVM_CHAINS.find((c: any) => c.key === 'bnb');
  return {
    generatedAt: '2026-10-18 12:00',
    days: 30,
    prices: { SOL: 150, BNB: 600 },
    solana: { balanceLamports: 2_000_000_000n, usdcBalance: 5_000_000n, summary: summariseSolana([{ deltaLamports: 50_000_000n }, { deltaLamports: 50_000_000n }]) },
    evm: [{ chain, creations: 2, curveTrades: 1, curveFees: 10n ** 16n, stableIn: { USDC: 10n * 10n ** 18n, USDT: 0n }, nativeBalance: 10n ** 18n, stableBalance: { USDC: 10n * 10n ** 18n, USDT: 0n } }],
  };
};

describe('the report', () => {
  it('adds the streams up in dollars and keeps income apart from what is held', () => {
    const r = buildReport(sample());
    // Solana: 2 x 0.05 SOL = 0.1 SOL = $15. BNB: 2 x 0.014 = 0.028 BNB = $16.80; curve 0.01 BNB = $6; USDC 10 = $10.
    expect(r.total).toBeCloseTo(15 + 16.8 + 6 + 10, 5);
    // Held: 2 SOL = $300, 5 USDC, 1 BNB = $600, 10 USDC.
    expect(r.held).toBeCloseTo(300 + 5 + 600 + 10, 5);
  });
  it('shows n/a, not zero, when a price is missing, and says so in the limits', () => {
    const d: any = sample();
    d.prices = {};
    d.notes = ['Prices could not be fetched.'];
    const r = buildReport(d);
    expect(renderText(r)).toContain('n/a');
    expect(renderText(r)).toContain('Prices could not be fetched.');
  });
  it('renders a page that is marked private, needs nothing external, and one ledger line', () => {
    const r = buildReport(sample());
    const html = renderHtml(r);
    expect(html).toContain('noindex');
    expect(html).not.toMatch(/<script|https?:\/\/(?!www\.w3)/);
    expect(html).toContain('Aretia revenue');
    expect(ledgerLine(r)).toMatch(/^2026-10-18 12:00,30,\d+\.\d{2},\d+\.\d{2}\n$/);
  });
  it('escapes anything that is not a number', () => {
    const d: any = sample();
    d.notes = ['<img src=x onerror=alert(1)>'];
    expect(renderHtml(buildReport(d))).not.toContain('<img src=x');
  });
});
