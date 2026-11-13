import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { receiveChoices } from './walletReceive';

const SOL = '8s2TyD4Zr2kGdm3u1fCgZ7vJ3mB6Z4Cw6bX3pYv9DRHz';
const EVM = '0x1234567890abcdef1234567890abcdef12345678';

describe('what can be received on', () => {
  it('offers nothing without a wallet', () => {
    expect(receiveChoices(null, null)).toEqual([]);
  });
  it('offers Solana alone with a Solana wallet, and says what not to send to it', () => {
    const c = receiveChoices(SOL, null);
    expect(c.map((x) => x.chain)).toEqual(['solana']);
    expect(c[0]!.address).toBe(SOL);
    expect(c[0]!.note).toContain('another network');
  });
  it('offers every Ethereum-style network with the one shared address, and names the network to send on', () => {
    const c = receiveChoices(SOL, EVM);
    expect(c[0]!.chain).toBe('solana');
    const evm = c.slice(1);
    expect(evm.length).toBeGreaterThanOrEqual(4);
    expect(evm.every((x) => x.address === EVM)).toBe(true);
    const bnb = evm.find((x) => x.chain === 'bnb')!;
    expect(bnb.note).toContain('Send only assets on BNB Chain');
  });
});

describe('the page', () => {
  const read = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r/g, '');
  it('has a Receive card and panel in Pay, wired to the swings page', () => {
    const page = read('../pages/wallet/index.astro');
    expect(page).toContain('data-pay-tab="receive"');
    expect(page).toContain('data-pay-panel="receive"');
    const sw = read('./walletSwings.ts');
    expect(sw).toContain("if (name === 'receive') receive.draw();");
  });
  it('draws the QR code with the qrcode package, a direct dependency', () => {
    expect(read('./walletReceive.ts')).toContain("import('qrcode')");
    expect(JSON.parse(read('../../package.json')).dependencies.qrcode).toBeTruthy();
  });
});
