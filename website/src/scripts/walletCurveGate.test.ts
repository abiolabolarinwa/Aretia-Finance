import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CURVE_ABORT_AFTER_SECS,
  CURVE_FEE_ADDRESS,
  CURVE_FEE_BPS,
  CURVE_MAX_RENT_BUDGET,
  CURVE_MIN_TARGET_LAMPORTS,
  CURVE_PROGRAM_ID_DEVNET,
  CURVE_PROGRAM_ID_MAINNET,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
} from './walletCurveCore';
import { METEORA_POOL_AUTHORITY, METEORA_PROGRAM_ID } from './walletPoolTx';
import { WSOL_MINT } from './walletPoolCore';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const program = () => read('../../../program/aretia-curve/programs/aretia-curve/src/lib.rs');
const constant = (src: string, name: string): string => {
  const m = new RegExp(`pub const ${name}[^=]*=\\s*([^;]+);`).exec(src);
  if (!m) throw new Error(`${name} not found in the program`);
  return m[1]!.trim();
};
const pubkey = (src: string, name: string): string => /pubkey!\("([^"]+)"\)/.exec(constant(src, name))![1]!;

describe('the page keeps the curve off mainnet', () => {
  it('only contains the card when built with PUBLIC_CURVE_ENABLED=1', () => {
    const page = read('../pages/wallet/index.astro');
    const at = page.indexOf('data-curve-root');
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(page.lastIndexOf('{curveOn', at), at)).toContain('{curveOn && (');
    expect(page).toContain("import.meta.env.PUBLIC_CURVE_ENABLED === '1'");
  });

  it('shows a notice and sends nothing while there is no mainnet program', () => {
    const card = read('./walletCurve.ts');
    expect(CURVE_PROGRAM_ID_MAINNET).toBeNull();
    expect(card).toContain("curveProgramFor('mainnet')");
    const at = card.indexOf('if (!program) {', card.indexOf('function draw()'));
    expect(at).toBeGreaterThan(-1);
    // The notice returns before any form or button is drawn.
    expect(card.slice(at, at + 700)).toContain('return;');
    // The flow refuses to start without a program too.
    expect(card).toMatch(/if \(!program\) throw new Error/);
  });

  it('is wired into the page once, and only through the card file', () => {
    const app = read('./walletApp.ts');
    expect(app.match(/initCurve\(/g)).toHaveLength(1);
    expect(app).toContain("from './walletCurve'");
  });
});

describe('the Launch page offers the curve only where the card exists', () => {
  it('shows the button only when the host supplies offerCurve, and the page supplies it only when the card is present', () => {
    const launch = read('./walletLaunch.ts');
    const at = launch.indexOf('Sell it on a bonding curve');
    expect(at).toBeGreaterThan(-1);
    expect(launch.slice(launch.lastIndexOf('if (host.offerCurve)', at), at)).toContain('if (host.offerCurve) {');
    expect(read('./walletApp.ts')).toContain('offerCurve: curve.present ? (mint) => curve.offer(mint) : undefined');
    const card = read('./walletCurve.ts');
    expect(card).toContain('const noop: CurveCard = { present: false');
    expect(card).toContain('present: true,');
  });
});

describe('the web constants are the program’s constants', () => {
  it('has the same fee rate, fee wallet, minimum target, wait and rent cap', () => {
    const src = program();
    expect(Number(constant(src, 'FEE_BPS'))).toBe(CURVE_FEE_BPS);
    expect(pubkey(src, 'FEE_WALLET')).toBe(CURVE_FEE_ADDRESS);
    expect(BigInt(constant(src, 'MIN_TARGET_LAMPORTS').replace(/_/g, ''))).toBe(CURVE_MIN_TARGET_LAMPORTS);
    expect(eval(constant(src, 'ABORT_AFTER_SECS').replace(/_/g, ''))).toBe(CURVE_ABORT_AFTER_SECS);
    expect(BigInt(constant(src, 'MAX_RENT_BUDGET').replace(/_/g, ''))).toBe(CURVE_MAX_RENT_BUDGET);
  });

  it('has the same program id and the same Meteora addresses and price bounds', () => {
    const src = program();
    expect(/declare_id!\("([^"]+)"\)/.exec(src)![1]).toBe(CURVE_PROGRAM_ID_DEVNET);
    expect(pubkey(src, 'METEORA_PROGRAM')).toBe(METEORA_PROGRAM_ID);
    expect(pubkey(src, 'METEORA_POOL_AUTHORITY')).toBe(METEORA_POOL_AUTHORITY);
    expect(pubkey(src, 'WSOL_MINT')).toBe(WSOL_MINT);
    expect(BigInt(constant(src, 'MIN_SQRT_PRICE').replace(/_/g, ''))).toBe(MIN_SQRT_PRICE);
    expect(BigInt(constant(src, 'MAX_SQRT_PRICE').replace(/_/g, ''))).toBe(MAX_SQRT_PRICE);
  });

  it('has the same extension allow-list as the pool card', () => {
    expect(/ALLOWED_EXTENSIONS: \[u16; 2\] = \[(\d+), (\d+)\]/.exec(program())!.slice(1).map(Number)).toEqual([18, 19]);
  });

  it('has the design doc’s fee rate', () => {
    const doc = read('../../../docs/BONDING_CURVE.md');
    expect(doc).toContain(`${(CURVE_FEE_BPS / 100).toFixed(2)}% (${CURVE_FEE_BPS} bps)`);
  });
});
