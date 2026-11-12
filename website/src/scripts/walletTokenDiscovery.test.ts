import { describe, expect, it } from 'vitest';
import { discoverEvmTokens, MAX_PER_CHAIN, tokensFromList } from './walletTokenDiscovery';

const WALLET = '0xd366c00000000000000000000000000000007ec2a';
const BIG = '0x1111111111111111111111111111111111111111';
const SMALL = '0x2222222222222222222222222222222222222222';
const DUST = '0x3333333333333333333333333333333333333333';

describe('the contract addresses in a network\'s token list', () => {
  const list = [
    { id: SMALL, amount: 1000, price: 0.01 },
    { id: 'bsc', amount: 0.004, price: 650 },
    { id: BIG.toUpperCase().replace('0X', '0x'), amount: 8919, price: 0.0013 },
    { id: DUST, amount: 5 },
    { id: 'not-an-address', amount: 1, price: 1 },
    null,
  ];
  it('keeps contract addresses only, lower-cased, the most valuable first', () => {
    expect(tokensFromList(list, 'bnb')).toEqual([
      { chain: 'bnb', address: BIG },
      { chain: 'bnb', address: SMALL },
      { chain: 'bnb', address: DUST },
    ]);
  });
  it('takes no more than the limit, and nothing from an answer that is not a list', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `0x${(i + 1).toString(16).padStart(40, '0')}`, amount: 1, price: i }));
    expect(tokensFromList(many, 'ethereum')).toHaveLength(MAX_PER_CHAIN);
    expect(tokensFromList({ error: 'nope' }, 'ethereum')).toEqual([]);
    expect(tokensFromList(null, 'ethereum')).toEqual([]);
  });
});

describe('looking up an address on several networks', () => {
  it('asks once per supported network and gathers the answers, leaving out one that fails', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      if (url.includes('chain_id=bsc')) return new Response(JSON.stringify([{ id: BIG, amount: 1, price: 1 }]));
      if (url.includes('chain_id=eth')) return new Response('', { status: 500 });
      throw new Error('down');
    }) as unknown as typeof fetch;
    const out = await discoverEvmTokens(WALLET.slice(0, 42), ['bnb', 'ethereum', 'polygon', 'robinhood', 'solana'], fetchImpl);
    expect(out).toEqual([{ chain: 'bnb', address: BIG }]);
    // Robinhood Chain and Solana are not asked for: the service does not list the first and Solana has its own reader.
    expect(asked).toHaveLength(3);
    expect(asked.every((u) => u.includes(WALLET.slice(0, 42).toLowerCase()))).toBe(true);
  });
  it('does nothing for something that is not an address', async () => {
    let called = false;
    const fetchImpl = (async () => ((called = true), new Response('[]'))) as unknown as typeof fetch;
    expect(await discoverEvmTokens('8s2TcBz5e8jvFZDVx9gJqW175JK3kpVGX1a6D4WnDRHz', ['bnb'], fetchImpl)).toEqual([]);
    expect(called).toBe(false);
  });
});
