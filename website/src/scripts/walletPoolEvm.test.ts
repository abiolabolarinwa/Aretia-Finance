import { describe, expect, it } from 'vitest';
import { SwingsError } from '../swings/core/types.js';
import { DEAD_ADDRESS, DEFAULT_POOL_FORM, POOL_DEXES, POOL_FEE_ADDRESS, poolConfigOf, validatePoolForm, type PoolConfig, type PoolForm } from './walletPoolEvmCore';
import { ADD_LIQUIDITY_ETH_SELECTOR, APPROVE_SELECTOR, SEL, buildAddTx, buildApproveTx, buildFeeTx, encodeTransfer, inspectFeeTx, decodeAddLiquidityEth, decodeApprove, encodeAddLiquidityEth, encodeApprove, inspectAddTx, inspectApproveTx, buildSeedTx, inspectSeedTx, SEEDER_SEL } from './walletPoolEvmTx';
import { PoolError, PoolFlow, type PoolFlowDeps } from './walletPoolEvmFlow';

const CREATOR = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x4444444444444444444444444444444444444444';
const PAIR = '0x5555555555555555555555555555555555555555';
const OTHER = '0x9999999999999999999999999999999999999999';
const dex = POOL_DEXES.find((d) => d.key === 'bnb')!;
const TOKENS = 1_000_000n * 10n ** 18n;
const COIN = 5n * 10n ** 17n;
const NOW = 1_800_000_000;

const config = (over: Partial<PoolConfig> = {}): PoolConfig => ({ dex, creator: CREATOR, token: TOKEN, tokenSymbol: 'ATEST', tokenDecimals: 18, tokenRaw: TOKENS, coinWei: COIN, lock: true, fee: { asset: 'USDC', token: dex.stables.USDC.address, decimals: 18, raw: 10n * 10n ** 18n }, lpTo: DEAD_ADDRESS, ...over });

describe('the exchange table', () => {
  it('has the three live networks, all lower-case', () => {
    expect(POOL_DEXES.map((d) => [d.key, d.chainId])).toEqual([['ethereum', 1], ['bnb', 56], ['polygon', 137]]);
    for (const d of POOL_DEXES) for (const a of [d.router, d.factory, d.wrapped]) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe('validatePoolForm / poolConfigOf', () => {
  const form = (over: Partial<PoolForm> = {}): PoolForm => ({ ...DEFAULT_POOL_FORM, token: TOKEN, tokenAmount: '1,000,000', coinAmount: '0.5', ...over });
  it('accepts a good form, then converts with the token’s decimals', () => {
    const v = validatePoolForm(form(), CREATOR, ['bnb']);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const c = poolConfigOf(v, CREATOR.toUpperCase().replace('0X', '0x'), true, { symbol: 'ATEST', decimals: 18 })!;
      expect(c.tokenRaw).toBe(TOKENS);
      expect(c.coinWei).toBe(COIN);
      expect(c.lpTo).toBe(DEAD_ADDRESS);
      expect(c.creator).toBe(CREATOR);
      expect(poolConfigOf(v, CREATOR, false, { symbol: 'A', decimals: 18 })!.lpTo).toBe(CREATOR);
      expect(poolConfigOf({ ...v, tokenAmountText: '1.5' }, CREATOR, true, { symbol: 'A', decimals: 0 })).toBeNull();
    }
  });
  it('refuses bad input and networks that are not enabled', () => {
    const bad = (over: Partial<PoolForm>, field: string, creator = CREATOR, enabled = ['bnb']) => {
      const v = validatePoolForm(form(over), creator, enabled);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.issues.map((i) => i.field)).toContain(field);
    };
    bad({ token: '0x123' }, 'token');
    bad({ tokenAmount: '0' }, 'tokenAmount');
    bad({ tokenAmount: 'abc' }, 'tokenAmount');
    bad({ coinAmount: '0' }, 'coinAmount');
    bad({ coinAmount: '1.0000000000000000001' }, 'coinAmount');
    bad({}, 'form', '');
    bad({}, 'form', CREATOR, []);
  });
});

describe('calldata', () => {
  it('round-trips and rejects the wrong selector, length or padding', () => {
    const a = { token: TOKEN, tokenRaw: TOKENS, tokenMin: TOKENS, coinMin: COIN, to: DEAD_ADDRESS, deadline: BigInt(NOW + 1200) };
    expect(decodeAddLiquidityEth(encodeAddLiquidityEth(a))).toEqual(a);
    expect(decodeApprove(encodeApprove(dex.router, TOKENS))).toEqual({ spender: dex.router, amount: TOKENS });
    const d = encodeApprove(dex.router, TOKENS);
    expect(decodeApprove(d + '00')).toBeNull();
    expect(decodeApprove('0xa9059cbb' + d.slice(10))).toBeNull();
    expect(decodeApprove(d.slice(0, 10) + 'f'.repeat(24) + d.slice(34))).toBeNull(); // dirty address padding
    expect(APPROVE_SELECTOR).toBe('0x095ea7b3');
    expect(ADD_LIQUIDITY_ETH_SELECTOR).toBe('0xf305d719');
    expect(SEL.getPair).toBe('0xe6a43905');
    expect(SEL.getReserves).toBe('0x0902f1ac');
  });
});

describe('inspectors', () => {
  const approve = () => buildApproveTx(config());
  const add = () => buildAddTx(config(), NOW);
  it('pass what the builders write', () => {
    expect(inspectApproveTx(approve(), config(), 56)).toEqual([]);
    expect(inspectAddTx(add(), config(), 56, NOW)).toEqual([]);
    expect(inspectAddTx({ ...add(), gas: '0x7a120' }, config(), 56, NOW)).toEqual([]);
  });
  it('refuse a different network, sender or extra field', () => {
    expect(inspectApproveTx(approve(), config(), 1).join(' ')).toMatch(/network 1/);
    // Audit L-1: a transaction not bound to the pool's network, or bound to another, is refused even when the wallet looks right.
    expect(inspectApproveTx({ ...approve(), chainId: undefined } as never, config(), 56).join(' ')).toMatch(/not bound/);
    expect(inspectApproveTx({ ...approve(), chainId: '0x1' }, config(), 56).join(' ')).toMatch(/not bound/);
    expect(inspectAddTx({ ...add(), from: OTHER }, config(), 56, NOW).join(' ')).toMatch(/not from the account/);
    expect(inspectAddTx({ ...add(), nonce: '0x1' } as never, config(), 56, NOW).join(' ')).toMatch(/unexpected field/);
  });
  it('refuse an approval to another spender, of another amount, unlimited, to another contract, or carrying coins', () => {
    expect(inspectApproveTx({ ...approve(), data: encodeApprove(OTHER, TOKENS) }, config(), 56).join(' ')).toMatch(/someone other than/);
    expect(inspectApproveTx({ ...approve(), data: encodeApprove(dex.router, TOKENS + 1n) }, config(), 56).join(' ')).toMatch(/different amount/);
    expect(inspectApproveTx({ ...approve(), data: encodeApprove(dex.router, 2n ** 256n - 1n) }, config(), 56).join(' ')).toMatch(/different amount/);
    expect(inspectApproveTx({ ...approve(), to: OTHER }, config(), 56).join(' ')).toMatch(/not sent to the token/);
    expect(inspectApproveTx({ ...approve(), value: '0x1' }, config(), 56).join(' ')).toMatch(/carries coins/);
  });
  it('refuse a pool transaction to another contract, with another amount, token, receiver, minimums or deadline', () => {
    const bad = (tx: ReturnType<typeof add>, now = NOW) => inspectAddTx(tx, config(), 56, now).join(' ');
    expect(bad({ ...add(), to: OTHER })).toMatch(/not sent to PancakeSwap/);
    expect(bad({ ...add(), value: '0x1' })).toMatch(/BNB sent is not exactly/);
    const enc = (over: Partial<Parameters<typeof encodeAddLiquidityEth>[0]>) =>
      encodeAddLiquidityEth({ token: TOKEN, tokenRaw: TOKENS, tokenMin: TOKENS, coinMin: COIN, to: DEAD_ADDRESS, deadline: BigInt(NOW + 1200), ...over });
    expect(bad({ ...add(), data: enc({ token: OTHER }) })).toMatch(/different token/);
    expect(bad({ ...add(), data: enc({ tokenRaw: TOKENS + 1n }) })).toMatch(/number of tokens/);
    expect(bad({ ...add(), data: enc({ tokenMin: 0n }) })).toMatch(/minimum amounts/);
    expect(bad({ ...add(), data: enc({ coinMin: 0n }) })).toMatch(/minimum amounts/);
    expect(bad({ ...add(), data: enc({ to: OTHER }) })).toMatch(/dead address/);
    expect(inspectAddTx({ ...buildAddTx(config({ lock: false, lpTo: CREATOR }), NOW), data: enc({ to: OTHER }) }, config({ lock: false, lpTo: CREATOR }), 56, NOW).join(' ')).toMatch(/someone other than you/);
    expect(bad(add(), NOW + 1100)).toBe('');
    expect(bad(add(), NOW + 1201)).toMatch(/deadline/);
    expect(bad(add(), NOW + 5000)).toMatch(/deadline/);
    expect(bad({ ...add(), data: enc({ deadline: BigInt(NOW + 9999) }) })).toMatch(/deadline/);
    expect(bad({ ...add(), data: '0x' })).toMatch(/not a plain pool creation/);
  });
});

// ---------------------------------------------------------------- the flow, with a scripted chain

const w = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const aw = (a: string) => '0x' + a.slice(2).padStart(64, '0');

function world(s: { factory?: string; wrapped?: string; routerCode?: string; tokenBal?: bigint; coinBal?: bigint; existing?: [bigint, bigint]; approveFails?: boolean; allowance?: bigint; addEstimateFails?: boolean; receipt1?: 'ok' | 'fail' | 'none'; receipt2?: 'ok' | 'fail'; reserves?: [bigint, bigint]; lp?: bigint; feeBal?: bigint; feeDecimals?: bigint; feeReceipt?: 'ok' | 'fail'; account?: string; chainId?: number; rejectAt?: 1 | 2 | 3; feeRejectOnce?: boolean; lpSupply?: bigint; seeder?: string; seederQuote?: [boolean, bigint, bigint]; seederRouter?: string } = {}) {
  const sent: { to?: string; data?: string; value?: string; gas?: string }[] = [];
  let approved = false;
  let opened = false;
  let t = 0;
  const read: PoolFlowDeps['read'] = async (method, params) => {
    const p = params as { to?: string; data?: string }[] & string[];
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getCode') return p[0] === dex.router ? (s.routerCode ?? '0x6080') : '0x6080';
    if (method === 'eth_getBalance') return '0x' + (s.coinBal ?? 10n ** 19n).toString(16);
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_estimateGas') {
      const c = p[0] as { to?: string };
      if (c.to === dex.router && s.addEstimateFails) throw new Error('reverted');
      if (c.to === TOKEN && s.approveFails) throw new Error('reverted');
      return '0x30d40';
    }
    if (method === 'eth_call') {
      const c = p[0] as { to?: string; data?: string };
      const d = c.data ?? '';
      if (c.to === dex.stables.USDC.address && d === '0x313ce567') return w(s.feeDecimals ?? 18n);
      if (c.to === dex.stables.USDC.address && d.startsWith(SEL.balanceOf)) return w(s.feeBal ?? 100n * 10n ** 18n);
      if (c.to === dex.router && d === SEL.routerFactory) return aw(s.factory ?? dex.factory);
      if (c.to === dex.router && d === SEL.routerWeth) return aw(s.wrapped ?? dex.wrapped);
      if (c.to === TOKEN && d.startsWith(SEL.balanceOf) && d.toLowerCase().endsWith(PAIR.slice(2).toLowerCase())) return w(s.existing?.[0] ?? 0n);
      if (c.to === TOKEN && d.startsWith(SEL.balanceOf)) return w(s.tokenBal ?? TOKENS);
      if (c.to === TOKEN && d.startsWith(SEL.allowance)) return w(s.allowance ?? (approved ? TOKENS : 0n));
      if (c.to === dex.factory && d.startsWith(SEL.getPair)) return aw(s.existing || opened ? PAIR : '0x' + '0'.repeat(40));
      if (c.to === PAIR && d === SEL.getReserves) return '0x' + (opened ? (s.reserves ?? [TOKENS, COIN])[0] : (s.existing?.[0] ?? 0n)).toString(16).padStart(64, '0') + (opened ? (s.reserves ?? [TOKENS, COIN])[1] : (s.existing?.[1] ?? 0n)).toString(16).padStart(64, '0') + '0'.repeat(64);
      if (c.to === PAIR && d === SEL.token0) return aw(TOKEN);
      if (c.to === PAIR && d === SEL.totalSupply) return w(s.lpSupply ?? (s.existing && (s.existing[0] > 0n || s.existing[1] > 0n) ? 1000n : 0n));
      if (s.seeder && c.to === s.seeder && d.startsWith(SEEDER_SEL.router)) return '0x' + '0'.repeat(24) + (s.seederRouter ?? dex.router).slice(2);
      if (s.seeder && c.to === s.seeder && d.startsWith(SEEDER_SEL.quote)) {
        const q = s.seederQuote ?? [true, TOKENS, COIN];
        return '0x' + [q[0] ? 1n : 0n, BigInt(PAIR), q[1], q[2]].map((v) => v.toString(16).padStart(64, '0')).join('');
      }
      if (c.to === PAIR && d.startsWith(SEL.balanceOf)) return w(s.lp ?? 1000n);
      return '0x';
    }
    if (method === 'eth_getTransactionReceipt') {
      const hash = p[0] as string;
      if (hash.endsWith('03')) return s.feeReceipt === 'fail' ? { status: '0x0' } : { status: '0x1' };
      if (hash.endsWith('01')) return s.receipt1 === 'none' ? null : { status: s.receipt1 === 'fail' ? '0x0' : '0x1' };
      return { status: s.receipt2 === 'fail' ? '0x0' : '0x1' };
    }
    throw new Error(`unexpected ${method}`);
  };
  const deps: PoolFlowDeps = {
    adapter: {
      getAccounts: async () => [s.account ?? CREATOR],
      getChainId: async () => s.chainId ?? 56,
      switchChain: async () => undefined,
      sendTransaction: async (tx) => {
        if (s.rejectAt === sent.length + 1) throw new SwingsError('rejected', 'no');
        sent.push(tx);
        if (tx.to === TOKEN) approved = true;
        else if (tx.to === dex.router || (s.seeder && tx.to === s.seeder)) opened = true;
        return '0x' + String(sent.length).padStart(2, '0').padStart(64, '0');
      },
    },
    read,
    now: () => (t += 60_000),
    nowSeconds: () => NOW,
    sleep: async () => undefined,
  };
  return { flow: new PoolFlow(deps, s.seeder ? { bnb: s.seeder } : {}), sent };
}

describe('PoolFlow', () => {
  it('approves exactly the tokens, opens the pool, and reads it back', async () => {
    const x = world();
    const review = await x.flow.prepare(config());
    expect(review.blockers).toEqual([]);
    const steps: string[] = [];
    const out = await x.flow.create(review, (p) => steps.push(p));
    expect(out.differences).toEqual([]);
    expect(out.pair).toBe(PAIR);
    expect(steps).toEqual(['checking', 'approving', 'confirming-approve', 'adding', 'confirming', 'verifying', 'paying-fee', 'confirming-fee', 'done']);
    expect(out.feeHash).toMatch(/^0x/);
    expect(out.feeError).toBeNull();
    expect(x.sent).toHaveLength(3);
    expect(x.sent[0]!.to).toBe(TOKEN);
    expect(x.sent[1]!.to).toBe(dex.router);
    expect(x.sent[1]!.value).toBe('0x' + COIN.toString(16));
    expect(decodeAddLiquidityEth(x.sent[1]!.data!)!.to).toBe(DEAD_ADDRESS);
    // The fee is the last transaction.
    expect(x.sent[2]!.to).toBe(dex.stables.USDC.address);
    expect(x.sent[2]!.data).toBe(encodeTransfer(POOL_FEE_ADDRESS, 10n * 10n ** 18n));
  });
  it('blocks on a router that does not report the expected factory or wrapped coin, or has no code', async () => {
    expect((await world({ factory: OTHER }).flow.prepare(config())).blockers.join(' ')).toMatch(/does not report/);
    expect((await world({ wrapped: OTHER }).flow.prepare(config())).blockers.join(' ')).toMatch(/does not report/);
    expect((await world({ routerCode: '0x' }).flow.prepare(config())).blockers.join(' ')).toMatch(/not on this network/);
  });
  it('blocks when the tokens or the coin are not enough, or a pool with liquidity already exists', async () => {
    expect((await world({ tokenBal: TOKENS - 1n }).flow.prepare(config())).blockers.join(' ')).toMatch(/fewer ATEST/);
    expect((await world({ coinBal: COIN }).flow.prepare(config())).blockers.join(' ')).toMatch(/need more BNB/);
    expect((await world({ existing: [1n, 1n] }).flow.prepare(config())).blockers.join(' ')).toMatch(/already exists with liquidity/);
  });
  it('a pair made first with dust and no liquidity tokens (M-4): explains when no seeder is deployed', async () => {
    const msg = (await world({ existing: [0n, 1n], lpSupply: 0n }).flow.prepare(config())).blockers.join(' ');
    expect(msg).toMatch(/left a few coins or tokens in it without adding liquidity/);
    expect(msg).toMatch(/pair seeder.*not deployed/);
  });
  it('a pair made first with dust (M-4): opens it through the configured seeder, approval and call checked exactly', async () => {
    const SEEDER = '0x5eed000000000000000000000000000000005eed';
    const x = world({ existing: [0n, 1n], lpSupply: 0n, seeder: SEEDER, seederQuote: [true, TOKENS, COIN - 1n], allowance: TOKENS });
    const review = await x.flow.prepare(config());
    expect(review.blockers).toEqual([]);
    expect(review.seed).toMatchObject({ seeder: SEEDER, tokensPaid: TOKENS, coinPaid: COIN - 1n });
    expect(decodeApprove(review.approveTx.data as string)).toEqual({ spender: SEEDER, amount: TOKENS });
    // The router-approval inspector refuses the seeder approval, and the seeder inspector refuses anything else.
    expect(inspectApproveTx(review.approveTx, config(), 56).length).toBeGreaterThan(0);
    expect(inspectApproveTx(review.approveTx, config(), 56, { seeder: SEEDER, amount: TOKENS })).toEqual([]);
    const seedTx = buildSeedTx(config(), SEEDER);
    expect(inspectSeedTx(seedTx, config(), SEEDER, 56)).toEqual([]);
    expect(inspectSeedTx({ ...seedTx, to: OTHER }, config(), SEEDER, 56).length).toBeGreaterThan(0);
    expect(inspectSeedTx(buildSeedTx({ ...config(), lpTo: OTHER }, SEEDER), config(), SEEDER, 56).length).toBeGreaterThan(0);
    expect(inspectSeedTx({ ...seedTx, value: '0x1' }, config(), SEEDER, 56).length).toBeGreaterThan(0);
    await x.flow.create(review);
    expect(x.sent[1]!.to).toBe(SEEDER);
    expect(x.sent[1]!.data!.startsWith(SEEDER_SEL.seed)).toBe(true);
  });
  it('refuses a configured seeder built for another router, before approving anything to it (re-audit N-3)', async () => {
    const SEEDER = '0x5eed000000000000000000000000000000005eed';
    const x = world({ existing: [0n, 1n], lpSupply: 0n, seeder: SEEDER, seederRouter: OTHER });
    const review = await x.flow.prepare(config());
    expect(review.blockers.join(' ')).toMatch(/not set up for this exchange/);
    expect(review.seed).toBeNull();
  });
  it('a pair made first holding more than the chosen amounts cannot be seeded', async () => {
    const SEEDER = '0x5eed000000000000000000000000000000005eed';
    const msg = (await world({ existing: [0n, 1n], lpSupply: 0n, seeder: SEEDER, seederQuote: [false, 0n, 0n] }).flow.prepare(config())).blockers.join(' ');
    expect(msg).toMatch(/more in it than your amounts/);
    const none = await world({ existing: [0n, 0n] }).flow.prepare(config());
    expect(none.blockers, none.blockers.join(' ')).toEqual([]);
    expect((await world({ approveFails: true }).flow.prepare(config())).blockers.join(' ')).toMatch(/not accept the fee or the approval/);
  });
  it('sends nothing when blocked, the account changed, or the wallet stays on another network', async () => {
    const ready = await world().flow.prepare(config());
    const blocked = world({ tokenBal: 0n });
    await expect(blocked.flow.create(await blocked.flow.prepare(config()))).rejects.toThrow(PoolError);
    const a = world({ account: OTHER });
    await expect(a.flow.create(ready)).rejects.toThrow(/account selected/);
    const n = world({ chainId: 1 });
    await expect(n.flow.create(ready)).rejects.toThrow(/Not signing/);
    expect(blocked.sent.length + a.sent.length + n.sent.length).toBe(0);
  });
  it('refuses a tampered approval before the wallet sees it', async () => {
    const x = world();
    const review = await x.flow.prepare(config());
    await expect(x.flow.create({ ...review, approveTx: { ...review.approveTx, data: encodeApprove(OTHER, TOKENS) } })).rejects.toThrow(/Not signing/);
    expect(x.sent).toHaveLength(0);
  });
  it('stops if the allowance is not exactly what was approved, and says the tokens did not move', async () => {
    const x = world({ allowance: TOKENS * 2n });
    await expect(x.flow.create(await x.flow.prepare(config()))).rejects.toThrow(/allowance is not exactly/);
    expect(x.sent).toHaveLength(1);
  });
  it('says what state things are in when the pool step cannot go ahead', async () => {
    const refuse = world({ addEstimateFails: true });
    await expect(refuse.flow.create(await refuse.flow.prepare(config()))).rejects.toThrow(/refuse to open the pool.*approval is in place for exactly/);
    expect(refuse.sent).toHaveLength(1);
    const declined = world({ rejectAt: 2 });
    await expect(declined.flow.create(await declined.flow.prepare(config()))).rejects.toThrow(/closed the wallet.*approval is in place for exactly.*no fee was charged/);
    const failed = world({ receipt2: 'fail' });
    await expect(failed.flow.create(await failed.flow.prepare(config()))).rejects.toThrow(/pool transaction failed/);
  });
  it('reports a declined, failed or unconfirmed approval', async () => {
    const r = await world().flow.prepare(config());
    await expect(world({ rejectAt: 1 }).flow.create(r)).rejects.toThrow(/closed the wallet/);
    await expect(world({ receipt1: 'fail' }).flow.create(r)).rejects.toThrow(/approval failed/);
    await expect(world({ receipt1: 'none' }).flow.create(r)).rejects.toThrow(/approval was sent but has not confirmed/);
  });
  it('lists every difference when the pool read back is not what was approved', async () => {
    const x = world({ reserves: [TOKENS - 1n, COIN + 1n], lp: 0n });
    const out = await x.flow.create(await x.flow.prepare(config()));
    expect(out.differences).toEqual(['The pool does not hold exactly the tokens you put in.', 'The pool does not hold exactly the BNB you put in.', 'No liquidity tokens reached the dead address.']);
  });
});

describe('the Aretia fee', () => {
  const fee = () => buildFeeTx(config());
  it('is a plain transfer of exactly 10 whole units of the chosen stablecoin to the fee address', () => {
    expect(inspectFeeTx(fee(), config(), 56)).toEqual([]);
    expect(POOL_FEE_ADDRESS).toBe('0xeb8725e16e504036c2166aa47804d88ecc4d0945');
    expect(fee().to).toBe(dex.stables.USDC.address);
  });
  it('uses each network’s own decimals: 6 on Ethereum and Polygon, 18 on BNB Chain', () => {
    for (const d of POOL_DEXES) for (const a of ['USDC', 'USDT'] as const) expect(d.stables[a].decimals).toBe(d.key === 'bnb' ? 18 : 6);
    const v = validatePoolForm({ ...DEFAULT_POOL_FORM, chain: 'ethereum', token: TOKEN, tokenAmount: '1', coinAmount: '1', feeAsset: 'USDT' }, CREATOR, ['ethereum']);
    expect(v.ok).toBe(true);
    if (v.ok) expect(poolConfigOf(v, CREATOR, true, { symbol: 'A', decimals: 18 })!.fee).toEqual({ asset: 'USDT', token: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, raw: 10_000_000n });
  });
  it('is refused if it goes elsewhere, is a different amount, another token, or carries coins', () => {
    const bad = (tx: ReturnType<typeof fee>) => inspectFeeTx(tx, config(), 56).join(' ');
    expect(bad({ ...fee(), data: encodeTransfer(OTHER, 10n * 10n ** 18n) })).toMatch(/not Aretia’s fee address/);
    expect(bad({ ...fee(), data: encodeTransfer(POOL_FEE_ADDRESS, 10n ** 18n) })).toMatch(/not exactly the flat amount/);
    expect(bad({ ...fee(), data: encodeTransfer(POOL_FEE_ADDRESS, 100n * 10n ** 18n) })).toMatch(/not exactly the flat amount/);
    expect(bad({ ...fee(), to: dex.stables.USDT.address })).toMatch(/not sent on the USDC contract/);
    expect(bad({ ...fee(), value: '0x1' })).toMatch(/carries coins/);
    expect(inspectFeeTx(fee(), config(), 1).join(' ')).toMatch(/network 1/);
  });
  it('blocks when the stablecoin balance is too low or its decimals are not the expected ones, and an unpaid fee is reported and can be paid later', async () => {
    expect((await world({ feeBal: 9n * 10n ** 18n }).flow.prepare(config())).blockers.join(' ')).toMatch(/need 10 USDC/);
    expect((await world({ feeDecimals: 6n }).flow.prepare(config())).blockers.join(' ')).toMatch(/not the one this page expects/);
    // Declined or failed fee: the pool exists, the outcome says the fee is owed, and it can be paid afterwards.
    const declined = world({ rejectAt: 3 });
    const review = await declined.flow.prepare(config());
    const out = await declined.flow.create(review);
    expect(out.feeHash).toBeNull();
    expect(out.feeError).toMatch(/closed the wallet/);
    expect(out.differences).toEqual([]);
    expect(declined.sent).toHaveLength(2);
    const failed = world({ feeReceipt: 'fail' });
    const out2 = await failed.flow.create(await failed.flow.prepare(config()));
    expect(out2.feeHash).toBeNull();
    expect(out2.feeError).toMatch(/fee transfer failed/);
    const later = world();
    const paid = await later.flow.payFee(await later.flow.prepare(config()));
    expect(paid.error).toBeNull();
    expect(paid.hash).toMatch(/^0x/);
    expect(later.sent).toHaveLength(1);
    expect(later.sent[0]!.to).toBe(dex.stables.USDC.address);
    const tampered = world();
    const rv = await tampered.flow.prepare(config());
    expect((await tampered.flow.payFee({ ...rv, feeTx: { ...rv.feeTx, data: encodeTransfer(OTHER, 10n * 10n ** 18n) } })).error).toMatch(/not Aretia’s fee address/);
    expect(tampered.sent).toHaveLength(0);
  });
});
