import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVM_ORDERS_ADDRESSES, evmOrdersChain } from './walletOrdersEvmCore';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the page keeps EVM limit orders off', () => {
  it('only contains the card when built with PUBLIC_ORDERS_EVM_ENABLED=1', () => {
    const page = read('../pages/wallet/index.astro');
    const at = page.indexOf('data-evm-orders-root');
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(page.lastIndexOf('{ordersEvmOn', at), at)).toContain('{ordersEvmOn && (');
    expect(page).toContain("import.meta.env.PUBLIC_ORDERS_EVM_ENABLED === '1'");
    expect(read('./walletLaunchEvm.ts')).toContain("import.meta.env.PUBLIC_ORDERS_EVM_ENABLED === '1' ? createEvmOrders(");
  });

  it('has no deployed contract anywhere, so every network shows a notice and sends nothing', () => {
    for (const key of Object.keys(EVM_ORDERS_ADDRESSES)) {
      expect(EVM_ORDERS_ADDRESSES[key as 'ethereum']).toBeNull();
      expect(evmOrdersChain(key)).toBeNull();
    }
    const card = read('./walletOrdersEvm.ts');
    const at = card.indexOf('if (!chain) {', card.indexOf('draw(card, redraw, key)'));
    expect(at).toBeGreaterThan(-1);
    // The notice returns before any form or button is drawn.
    expect(card.slice(at, at + 600)).toContain('return;');
  });

  it('is wired in once, and only through the card file', () => {
    expect(read('./walletLaunchEvm.ts').match(/createEvmOrders\(/g)).toHaveLength(1);
  });

  it('draws what it reads from the network and what the person types with textContent only', () => {
    for (const file of ['./walletOrdersEvm.ts', './walletOrdersEvmFlow.ts', './walletOrdersEvmCore.ts']) expect(read(file)).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('sends only through the inspected path: every send goes through runTx, which checks first', () => {
    const flow = read('./walletOrdersEvmFlow.ts');
    expect(flow.match(/adapter\.sendTransaction\(/g)).toHaveLength(1);
    const send = flow.indexOf('adapter.sendTransaction(');
    const inspect = flow.lastIndexOf('const problems = inspect(', send);
    expect(inspect).toBeGreaterThan(-1);
    expect(flow.slice(inspect, send)).toContain('throw new EvmOrdersError(`Not signing');
  });
});
