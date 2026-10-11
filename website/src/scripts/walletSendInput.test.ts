import { describe, expect, it } from 'vitest';
import { checkSendInput, sendAssetLabel } from './walletSendInput';

const FROM = '8s2TcBz5e8jvFZDVx9gJqW175JK3kpVGX1a6D4WnDRHz';
const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const base = { from: FROM, target: OTHER, amountText: '1', decimals: 6, balanceRaw: '5049600', symbol: 'USDC' };

describe('checkSendInput', () => {
  it('passes a good request', () => expect(checkSendInput(base)).toBeNull());
  it('accepts a .sns name', () => expect(checkSendInput({ ...base, target: 'alice.sol' })).toBeNull());
  it('asks for a recipient and an amount', () => {
    expect(checkSendInput({ ...base, target: ' ' })).toMatch(/who to send to/);
    expect(checkSendInput({ ...base, amountText: '' })).toMatch(/Enter an amount/);
  });
  it('explains an Ethereum-style address and a mistyped one', () => {
    expect(checkSendInput({ ...base, target: '0x' + 'a'.repeat(40) })).toMatch(/Ethereum-style/);
    expect(checkSendInput({ ...base, target: OTHER.slice(0, -1) + 'l' })).toMatch(/not a Solana address/);
  });
  it('stops a send to yourself', () => expect(checkSendInput({ ...base, target: FROM })).toMatch(/your own address/));
  it('rejects bad amounts before any lookup', () => {
    expect(checkSendInput({ ...base, amountText: '1,5' })).toMatch(/not an amount/);
    expect(checkSendInput({ ...base, amountText: '.' })).toMatch(/not an amount/);
    expect(checkSendInput({ ...base, amountText: '0' })).toMatch(/more than zero/);
    expect(checkSendInput({ ...base, amountText: '0.0000001' })).toMatch(/at most 6 decimal/);
    expect(checkSendInput({ ...base, amountText: '5.0497' })).toMatch(/less USDC/);
  });
  it('allows ".5" and "5." and skips balance checks when unknown', () => {
    expect(checkSendInput({ ...base, amountText: '.5' })).toBeNull();
    expect(checkSendInput({ ...base, amountText: '5.' })).toBeNull();
    expect(checkSendInput({ ...base, amountText: '999', balanceRaw: null })).toBeNull();
  });
});

describe('sendAssetLabel', () => {
  const short = (m: string) => m.slice(0, 4);
  const all = [{ mint: 'A', symbol: 'USDC' }, { mint: 'B', symbol: 'USDC' }, { mint: 'C', symbol: 'SOL' }];
  it('shows the name and balance, and the address only for lookalike symbols', () => {
    expect(sendAssetLabel({ mint: 'C', symbol: 'SOL', name: 'Solana', amount: 1 }, all, '1', 'C', short)).toBe('SOL (Solana) · 1');
    expect(sendAssetLabel({ mint: 'A', symbol: 'USDC', name: 'USD Coin', amount: 1 }, all, '5', 'C', short)).toBe('USDC (USD Coin) · 5 · A');
    expect(sendAssetLabel({ mint: 'Z', symbol: 'ZED', name: '', amount: 1 }, [{ mint: 'Z', symbol: 'ZED' }], '2', 'C', short)).toBe('ZED · 2 · Z');
  });
});
