import { describe, expect, it } from 'vitest';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import poolArtifact from '../../../contracts-evm/AretiaPool.artifact.json';
import { createAddress } from './walletCurveEvmCore';
import { evmPoolChain, openingMath, poolQuoteBuy, type EvmPoolConfig } from './walletAretiaPoolEvmCore';
import {
  POOL_SEL,
  buildAddTx,
  buildApproveTx,
  buildBuyTx,
  buildClaimTx,
  buildCreateTx,
  buildLockTx,
  buildRecipientTx,
  buildRemoveTx,
  buildSellTx,
  buildTransferTx,
  decodeCreate,
  inspectAdd,
  inspectApprove,
  inspectBuy,
  inspectClaim,
  inspectCreate,
  inspectLock,
  inspectRecipient,
  inspectRemove,
  inspectSell,
  inspectTransfer,
} from './walletAretiaPoolEvmTx';

const ETH = 10n ** 18n;
const CREATOR = '0x00000000000000000000000000000000000c0de1';
const OTHER = '0x00000000000000000000000000000000000b0b01';
const POOL = '0x2222222222222222222222222222222222222222';
const chain = evmPoolChain('ethereum', { ethereum: POOL })!;
const TOKEN = createAddress(chain.factory, 3n);
const config = (firstBuyWei = 0n): EvmPoolConfig => ({ chain, creator: CREATOR, token: TOKEN, tokenSymbol: 'TST', tokenDecimals: 18, factoryNonce: 3n, x0: 10n ** 27n, l0: 10n * ETH, y0: 0n, feeBps: 25, lock: true, firstBuyWei });
const MIN_FIRST = poolQuoteBuy(openingMath(config()), ETH)!.tokensOut;
const NOW = 1_700_000_000;
const DL = BigInt(NOW + 1200);
const at = { deadline: DL, nowSeconds: NOW };

interface Case {
  name: string;
  tx: EvmTxRequest;
  inspect(tx: EvmTxRequest, walletChainId: number): string[];
  value: bigint;
}

const cases: Case[] = [
  { name: 'approve', tx: buildApproveTx(CREATOR, TOKEN, POOL, 10n ** 27n), inspect: (tx, id) => inspectApprove(tx, { chain, from: CREATOR, token: TOKEN, amount: 10n ** 27n }, id), value: 0n },
  { name: 'create', tx: buildCreateTx(config(), 0n, DL), inspect: (tx, id) => inspectCreate(tx, { config: config(), minFirstBuyOut: 0n, ...at }, id), value: chain.creationFee },
  { name: 'create with first buy', tx: buildCreateTx(config(ETH), MIN_FIRST, DL), inspect: (tx, id) => inspectCreate(tx, { config: config(ETH), minFirstBuyOut: MIN_FIRST, ...at }, id), value: chain.creationFee + ETH },
  { name: 'buy', tx: buildBuyTx(CREATOR, chain, TOKEN, 5n, ETH, DL), inspect: (tx, id) => inspectBuy(tx, { chain, from: CREATOR, token: TOKEN, wei: ETH, minOut: 5n, ...at }, id), value: ETH },
  { name: 'sell', tx: buildSellTx(CREATOR, chain, TOKEN, 7n, 3n, DL), inspect: (tx, id) => inspectSell(tx, { chain, from: CREATOR, token: TOKEN, tokens: 7n, minCoinOut: 3n, ...at }, id), value: 0n },
  { name: 'add', tx: buildAddTx(CREATOR, chain, TOKEN, 5000n, 99n, 123n, DL), inspect: (tx, id) => inspectAdd(tx, { chain, from: CREATOR, token: TOKEN, dl: 5000n, maxTokens: 99n, coinWei: 123n, ...at }, id), value: 123n },
  { name: 'remove', tx: buildRemoveTx(CREATOR, chain, TOKEN, 5000n, 11n, 12n, DL), inspect: (tx, id) => inspectRemove(tx, { chain, from: CREATOR, token: TOKEN, dl: 5000n, minTokens: 11n, minCoin: 12n, ...at }, id), value: 0n },
  { name: 'claim', tx: buildClaimTx(CREATOR, chain, TOKEN), inspect: (tx, id) => inspectClaim(tx, { chain, from: CREATOR, token: TOKEN }, id), value: 0n },
  { name: 'lock', tx: buildLockTx(CREATOR, chain, TOKEN, 77n), inspect: (tx, id) => inspectLock(tx, { chain, from: CREATOR, token: TOKEN, amount: 77n }, id), value: 0n },
  { name: 'transfer', tx: buildTransferTx(CREATOR, chain, TOKEN, OTHER), inspect: (tx, id) => inspectTransfer(tx, { chain, from: CREATOR, token: TOKEN, to: OTHER }, id), value: 0n },
  { name: 'recipient', tx: buildRecipientTx(CREATOR, chain, TOKEN, OTHER), inspect: (tx, id) => inspectRecipient(tx, { chain, from: CREATOR, token: TOKEN, recipient: OTHER }, id), value: 0n },
];

describe('selectors match the compiled contract', () => {
  it('every function the page calls has the selector solc produced', () => {
    const sel = poolArtifact.pool.selectors as Record<string, string>;
    const want: Record<string, string> = {
      createPool: 'createPool((address,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,uint256,uint256))',
      buy: 'buy(address,uint256,uint256)',
      sell: 'sell(address,uint256,uint256,uint256)',
      addLiquidity: 'addLiquidity(address,uint256,uint256,uint256)',
      removeLiquidity: 'removeLiquidity(address,uint256,uint256,uint256,uint256)',
      protocolOwed: 'protocolOwed()',
      withdrawProtocolFees: 'withdrawProtocolFees()',
      claimFees: 'claimFees(address)',
      lockLiquidity: 'lockLiquidity(address,uint256)',
      transferPosition: 'transferPosition(address,address)',
      setRecipient: 'setRecipient(address,address)',
      pools: 'pools(address)',
      positions: 'positions(address,address)',
      pendingFees: 'pendingFees(address,address)',
      totalOwed: 'totalOwed()',
      creationFee: 'creationFee()',
      feeRecipient: 'feeRecipient()',
      factory: 'factory()',
    };
    for (const [name, sig] of Object.entries(want)) expect((POOL_SEL as Record<string, string>)[name], name).toBe('0x' + sel[sig]);
  });
});

describe('every builder passes its own inspector, on the right network only', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(c.inspect(c.tx, 1)).toEqual([]);
      expect(c.inspect(c.tx, 56).length).toBeGreaterThan(0);
    });
  }
  it('decodes a creation back to exactly what was built', () => {
    const d = decodeCreate(buildCreateTx(config(ETH), MIN_FIRST, DL).data as string)!;
    expect(d).toEqual({ token: TOKEN, nonce: 3n, x0: 10n ** 27n, l0: 10n * ETH, y0: 0n, feeBps: 25n, lock: true, owner: CREATOR, firstBuyWei: ETH, minFirstBuyOut: MIN_FIRST, deadline: DL });
  });
});

describe('the inspector refuses anything that is not exactly what was approved', () => {
  for (const c of cases) {
    describe(c.name, () => {
      it('a wrong destination, sender, extra field, bad gas or bad value', () => {
        expect(c.inspect({ ...c.tx, to: '0x3333333333333333333333333333333333333333' }, 1).length).toBeGreaterThan(0);
        expect(c.inspect({ ...c.tx, from: OTHER }, 1).length).toBeGreaterThan(0);
        expect(c.inspect({ ...c.tx, nonce: '0x1' } as EvmTxRequest, 1).length).toBeGreaterThan(0);
        expect(c.inspect({ ...c.tx, gas: 'lots' }, 1).length).toBeGreaterThan(0);
        expect(c.inspect({ ...c.tx, value: '0x' + (c.value + 1n).toString(16) }, 1).length).toBeGreaterThan(0);
        expect(c.inspect({ ...c.tx, value: undefined } as unknown as EvmTxRequest, 1).length).toBeGreaterThan(0);
      });
      it('changing any single hex digit of the data', () => {
        const data = c.tx.data as string;
        for (let i = 2; i < data.length; i++) {
          const flipped = data.slice(0, i) + (data[i] === 'a' ? 'b' : 'a') + data.slice(i + 1);
          expect(c.inspect({ ...c.tx, data: flipped }, 1).length, `digit ${i}`).toBeGreaterThan(0);
        }
      });
      it('truncated, extended or empty data, or another function', () => {
        const data = c.tx.data as string;
        expect(c.inspect({ ...c.tx, data: data.slice(0, -2) }, 1).length).toBeGreaterThan(0);
        expect(c.inspect({ ...c.tx, data: data + '00' }, 1).length).toBeGreaterThan(0);
        expect(c.inspect({ ...c.tx, data: data + '0'.repeat(64) }, 1).length).toBeGreaterThan(0);
        expect(c.inspect({ ...c.tx, data: '0x' }, 1).length).toBeGreaterThan(0);
        expect(c.inspect({ ...c.tx, data: '0xa9059cbb' + data.slice(10) }, 1).length).toBeGreaterThan(0);
      });
    });
  }
  it('an approval to anyone but the pool, for more than approved, or unlimited', () => {
    const ok = { chain, from: CREATOR, token: TOKEN, amount: 5n };
    expect(inspectApprove(buildApproveTx(CREATOR, TOKEN, OTHER, 5n), ok, 1).join(' ')).toMatch(/someone other/);
    expect(inspectApprove(buildApproveTx(CREATOR, TOKEN, POOL, 6n), ok, 1).join(' ')).toMatch(/different amount/);
    expect(inspectApprove(buildApproveTx(CREATOR, TOKEN, POOL, (1n << 256n) - 1n), ok, 1).join(' ')).toMatch(/different amount/);
  });
  it('a creation whose owner, lock, fee tier or price differs from what was shown', () => {
    const base = buildCreateTx(config(), 0n, DL);
    const mutate = (c: EvmPoolConfig) => inspectCreate(base, { config: c, minFirstBuyOut: 0n, ...at }, 1).length;
    expect(mutate({ ...config(), creator: OTHER })).toBeGreaterThan(0);
    expect(mutate({ ...config(), feeBps: 100 })).toBeGreaterThan(0);
    expect(mutate({ ...config(), l0: 11n * ETH })).toBeGreaterThan(0);
    expect(mutate({ ...config(), x0: 5n })).toBeGreaterThan(0);
    expect(mutate({ ...config(), y0: 1n })).toBeGreaterThan(0);
    expect(mutate({ ...config(), token: OTHER })).toBeGreaterThan(0);
  });
  it('a deadline that has passed, is more than an hour away, or differs from the one shown (L-20)', () => {
    for (const c of cases.filter((x) => ['create', 'buy', 'sell', 'add', 'remove'].includes(x.name))) {
      expect(c.inspect(c.tx, 1)).toEqual([]);
    }
    const buy = (deadline: bigint, now: number, shown = deadline) => inspectBuy(buildBuyTx(CREATOR, chain, TOKEN, 5n, ETH, deadline), { chain, from: CREATOR, token: TOKEN, wei: ETH, minOut: 5n, deadline: shown, nowSeconds: now }, 1).join(' ');
    expect(buy(BigInt(NOW), NOW)).toMatch(/within the next hour/);
    expect(buy(BigInt(NOW + 3601), NOW)).toMatch(/within the next hour/);
    expect(buy(DL, NOW, DL + 1n)).toMatch(/not the one shown/);
    expect(buy(DL, NOW + 1300)).toMatch(/within the next hour/);
  });
  it('an unlocked creation is refused even if the config asked for it (M-9)', () => {
    const unlocked = buildCreateTx({ ...config(), lock: false as unknown as true }, 0n, DL);
    expect(inspectCreate(unlocked, { config: config(), minFirstBuyOut: 0n, ...at }, 1).join(' ')).toMatch(/lock/);
  });
});
