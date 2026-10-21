import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import orderFixture from './__fixtures__/orders/order.json';
import { CURVE_FEE_BPS as CURVE_PAGE_FEE_BPS } from './walletCurveCore';
import { CURVE_FEE_BPS, KEEPER_SHARE_BPS, ORDERS_PROGRAM_ID_DEVNET, ORDERS_PROGRAM_ID_MAINNET, ORDER_BUY_FEE_BPS, ORDER_CANCEL_FEE_BPS, ORDER_SELL_FEE_BPS } from './walletOrdersCore';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the page keeps limit orders off mainnet', () => {
  it('only contains the card when built with PUBLIC_ORDERS_ENABLED=1', () => {
    const page = read('../pages/wallet/index.astro');
    const at = page.indexOf('data-orders-root');
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(page.lastIndexOf('{ordersOn', at), at)).toContain('{ordersOn && (');
    expect(page).toContain("import.meta.env.PUBLIC_ORDERS_ENABLED === '1'");
  });

  it('shows a notice and sends nothing while there is no program', () => {
    const card = read('./walletOrders.ts');
    expect(ORDERS_PROGRAM_ID_MAINNET).toBeNull();
    expect(ORDERS_PROGRAM_ID_DEVNET).toBeNull();
    expect(card).toContain("ordersProgramFor('mainnet')");
    const at = card.indexOf('if (!program || !curveProgram) {', card.indexOf('function draw()'));
    expect(at).toBeGreaterThan(-1);
    // The notice returns before any form or button is drawn.
    expect(card.slice(at, at + 700)).toContain('return;');
    // The flow refuses to start without a program too.
    expect(card).toMatch(/if \(!program \|\| !curveProgram\) throw new Error/);
  });

  it('is wired into the page once, and only through the card file', () => {
    const app = read('./walletApp.ts');
    expect(app.match(/initOrders\(/g)).toHaveLength(1);
    expect(app).toContain("from './walletOrders'");
  });

  it('draws what it reads from the network and what the person types with textContent only', () => {
    for (const file of ['./walletOrders.ts', './walletOrdersFlow.ts']) expect(read(file)).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('asks the network for the connected wallet’s orders only', () => {
    const card = read('./walletOrders.ts');
    expect(card).toContain('{ memcmp: { offset: 8, bytes: owner } }');
    expect(card).toContain('dataSize: 235');
  });
});

describe('the fees shown are the fees the program charges', () => {
  // The program’s own config account, as its compiled binary wrote it in the Rust tests.
  const config = Buffer.from(orderFixture.configDataHex, 'hex');
  const u16 = (offset: number) => config.readUInt16LE(8 + offset);

  it('matches the fees stored in the program’s config', () => {
    expect(BigInt(u16(96))).toBe(ORDER_CANCEL_FEE_BPS);
    expect(BigInt(u16(98))).toBe(ORDER_BUY_FEE_BPS);
    expect(BigInt(u16(100))).toBe(ORDER_SELL_FEE_BPS);
    expect(BigInt(u16(102))).toBe(KEEPER_SHARE_BPS);
  });

  it('uses the curve fee the curve card already shows', () => {
    expect(CURVE_FEE_BPS).toBe(BigInt(CURVE_PAGE_FEE_BPS));
  });
});
