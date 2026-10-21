import { describe, expect, it } from 'vitest';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import { evmCurveChain, evmDerive, evmQuoteBuy, evmStart, createAddress, type EvmCurveConfig } from './walletCurveEvmCore';
import {
  CURVE_SEL,
  buildAbortTx,
  buildApproveTx,
  buildBuyTx,
  buildCreateTx,
  buildGraduateTx,
  buildSellTx,
  curveReadData,
  decodeBuy,
  decodeCreate,
  decodeSell,
  inspectAbort,
  inspectApprove,
  inspectBuy,
  inspectCreate,
  inspectGraduate,
  inspectSell,
} from './walletCurveEvmTx';

const ETH = 10n ** 18n;
const CREATOR = '0x00000000000000000000000000000000000c0de1';
const OTHER = '0x00000000000000000000000000000000000b0b01';
const CURVE = '0x2222222222222222222222222222222222222222';
const chain = evmCurveChain('ethereum', { ethereum: CURVE })!;
const TOKEN = createAddress(chain.factory, 3n);
const derived = evmDerive(10n ** 27n, 3n * ETH)!;
const config = (firstBuyWei = 0n): EvmCurveConfig => ({
  chain,
  creator: CREATOR,
  token: TOKEN,
  tokenSymbol: 'TST',
  tokenDecimals: 18,
  tokenSupply: 10n ** 27n,
  factoryNonce: 3n,
  totalRaw: 10n ** 27n,
  targetWei: 3n * ETH,
  firstBuyWei,
  derived,
});
const MIN_FIRST = evmQuoteBuy(evmStart(derived), ETH)!.tokensOut;

interface Case {
  name: string;
  tx: EvmTxRequest;
  inspect(tx: EvmTxRequest, walletChainId: number): string[];
  /** Whether the call carries coins (so the value field is checked against a non-zero amount). */
  value: bigint;
}

const cases: Case[] = [
  {
    name: 'approve',
    tx: buildApproveTx(CREATOR, TOKEN, CURVE, 10n ** 27n, 1),
    inspect: (tx, id) => inspectApprove(tx, { chain, from: CREATOR, token: TOKEN, amount: 10n ** 27n }, id),
    value: 0n,
  },
  {
    name: 'create',
    tx: buildCreateTx(config(), 0n),
    inspect: (tx, id) => inspectCreate(tx, { config: config(), minFirstBuyOut: 0n }, id),
    value: 0n,
  },
  {
    name: 'create with a first buy',
    tx: buildCreateTx(config(ETH), MIN_FIRST),
    inspect: (tx, id) => inspectCreate(tx, { config: config(ETH), minFirstBuyOut: MIN_FIRST }, id),
    value: ETH,
  },
  {
    name: 'buy',
    tx: buildBuyTx(CREATOR, chain, TOKEN, 12_345n, 2n * ETH),
    inspect: (tx, id) => inspectBuy(tx, { chain, from: CREATOR, token: TOKEN, wei: 2n * ETH, minOut: 12_345n }, id),
    value: 2n * ETH,
  },
  {
    name: 'sell',
    tx: buildSellTx(CREATOR, chain, TOKEN, 5_000n, 77n),
    inspect: (tx, id) => inspectSell(tx, { chain, from: CREATOR, token: TOKEN, tokens: 5_000n, minCoinOut: 77n }, id),
    value: 0n,
  },
  {
    name: 'graduate',
    tx: buildGraduateTx(CREATOR, chain, TOKEN),
    inspect: (tx, id) => inspectGraduate(tx, { chain, from: CREATOR, token: TOKEN }, id),
    value: 0n,
  },
  {
    name: 'abort',
    tx: buildAbortTx(CREATOR, chain, TOKEN),
    inspect: (tx, id) => inspectAbort(tx, { chain, from: CREATOR, token: TOKEN }, id),
    value: 0n,
  },
];

describe.each(cases)('the $name transaction', (c) => {
  it('L-1: carries the chain id and is refused without it or with another', () => {
    expect(c.tx.chainId).toBe('0x1');
    const { chainId: _dropped, ...unbound } = c.tx;
    void _dropped;
    expect(c.inspect(unbound, 1).join(' ')).toMatch(/not bound/);
    expect(c.inspect({ ...c.tx, chainId: '0x38' }, 1).join(' ')).toMatch(/not bound/);
  });

  it('is accepted by the inspector on the right network, with a gas limit or without', () => {
    expect(c.inspect(c.tx, 1)).toEqual([]);
    expect(c.inspect({ ...c.tx, gas: '0x30d40' }, 1)).toEqual([]);
  });

  it('is refused when any single hex digit of its data changes', () => {
    const data = c.tx.data as string;
    for (let i = 2; i < data.length; i++) {
      const digit = (parseInt(data[i]!, 16) + 1) % 16;
      const mutated = data.slice(0, i) + digit.toString(16) + data.slice(i + 1);
      expect(c.inspect({ ...c.tx, data: mutated }, 1).length, `digit ${i}`).toBeGreaterThan(0);
    }
  });

  it('is refused when its data is shortened, lengthened or made of anything but hex', () => {
    const data = c.tx.data as string;
    for (const bad of [data.slice(0, -2), data + '00', data + 'zz', '0x', '', data.toUpperCase().replace('0X', '0x') + '0']) expect(c.inspect({ ...c.tx, data: bad }, 1).length).toBeGreaterThan(0);
  });

  it('is refused to another contract, from another account, with another amount of coin, or with an extra field', () => {
    expect(c.inspect({ ...c.tx, to: OTHER }, 1).length).toBeGreaterThan(0);
    expect(c.inspect({ ...c.tx, from: OTHER }, 1).length).toBeGreaterThan(0);
    expect(c.inspect({ ...c.tx, value: '0x' + (c.value + 1n).toString(16) }, 1).length).toBeGreaterThan(0);
    expect(c.inspect({ ...c.tx, value: '0x' + (c.value === 0n ? 0n : c.value - 1n).toString(16) }, 1).length).toBe(c.value === 0n ? 0 : c.inspect({ ...c.tx, value: '0x' + (c.value - 1n).toString(16) }, 1).length);
    expect(c.inspect({ ...c.tx, nonce: '0x1' } as EvmTxRequest, 1).length).toBeGreaterThan(0);
    expect(c.inspect({ ...c.tx, gas: '0x0' }, 1).length).toBeGreaterThan(0);
    expect(c.inspect({ ...c.tx, gas: 'many' }, 1).length).toBeGreaterThan(0);
  });

  it('is refused when the wallet is on another network', () => {
    for (const id of [0, 2, 56, 137, 11155111]) expect(c.inspect(c.tx, id).length).toBeGreaterThan(0);
  });

  it('is refused when the addresses are in another case or form', () => {
    const t = c.tx;
    // A checksum-cased or upper-cased address is the same address and is accepted; a 0x-less or short one is not.
    expect(c.inspect({ ...t, to: (t.to as string).toUpperCase().replace('0X', '0x') }, 1)).toEqual([]);
    expect(c.inspect({ ...t, to: (t.to as string).slice(2) }, 1).length).toBeGreaterThan(0);
    expect(c.inspect({ ...t, to: (t.to as string).slice(0, -1) }, 1).length).toBeGreaterThan(0);
  });
});

describe('details worth their own test', () => {
  it('approves exactly the tokens to the curve and never unlimited', () => {
    const tx = buildApproveTx(CREATOR, TOKEN, CURVE, 10n ** 27n, 1);
    expect(inspectApprove(tx, { chain, from: CREATOR, token: TOKEN, amount: 10n ** 27n }, 1)).toEqual([]);
    const unlimited = buildApproveTx(CREATOR, TOKEN, CURVE, (1n << 256n) - 1n, 1);
    expect(inspectApprove(unlimited, { chain, from: CREATOR, token: TOKEN, amount: 10n ** 27n }, 1).join(' ')).toMatch(/different amount/);
    const toSomeoneElse = buildApproveTx(CREATOR, TOKEN, OTHER, 10n ** 27n, 1);
    expect(inspectApprove(toSomeoneElse, { chain, from: CREATOR, token: TOKEN, amount: 10n ** 27n }, 1).join(' ')).toMatch(/someone other than the Aretia curve/);
  });

  it('does not take a create that carries a first buy when none was approved, or the reverse', () => {
    expect(inspectCreate(buildCreateTx(config(ETH), MIN_FIRST), { config: config(), minFirstBuyOut: 0n }, 1).length).toBeGreaterThan(0);
    expect(inspectCreate(buildCreateTx(config(), 0n), { config: config(ETH), minFirstBuyOut: MIN_FIRST }, 1).length).toBeGreaterThan(0);
    // With no first buy, the least-out field must be zero whatever the caller says.
    const tx = buildCreateTx(config(), 999n);
    expect(decodeCreate(tx.data as string)!.minFirstBuyOut).toBe(0n);
  });

  it('puts the proof nonce and every number where the contract reads them', () => {
    const d = decodeCreate(buildCreateTx(config(ETH), MIN_FIRST).data as string)!;
    expect(d).toEqual({ token: TOKEN, nonce: 3n, total: 10n ** 27n, target: 3n * ETH, minFirstBuyOut: MIN_FIRST });
    expect(decodeBuy(buildBuyTx(CREATOR, chain, TOKEN, 9n, 1n).data as string)).toEqual({ token: TOKEN, minOut: 9n });
    expect(decodeSell(buildSellTx(CREATOR, chain, TOKEN, 4n, 5n).data as string)).toEqual({ token: TOKEN, tokens: 4n, minCoinOut: 5n });
  });

  it('uses the selectors of the contract’s real function names', () => {
    const sels = Object.values(CURVE_SEL);
    expect(new Set(sels).size).toBe(sels.length);
    for (const s of sels) expect(s).toMatch(/^0x[0-9a-f]{8}$/);
    expect(curveReadData(TOKEN).startsWith(CURVE_SEL.curves)).toBe(true);
    expect(curveReadData(TOKEN).length).toBe(10 + 64);
  });

  it('refuses to build a number that does not fit in 256 bits', () => {
    expect(() => buildBuyTx(CREATOR, chain, TOKEN, 1n << 256n, 1n)).toThrow(/256 bits/);
  });
});
