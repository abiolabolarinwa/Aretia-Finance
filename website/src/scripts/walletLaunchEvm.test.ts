import { describe, expect, it } from 'vitest';
import artifact from '../../../contracts-evm/AretiaLaunchFactory.artifact.json';
import { keccak256 } from '../swings/core/keccak.js';
import { SwingsError } from '../swings/core/types.js';
import { DEFAULT_EVM_FORM, LAUNCH_EVM_CHAINS, MIN_POOL_BPS, chainEnabled, launchEnabled, launchValueOf, poolTokensOf, validateEvmLaunch, type EvmLaunchConfig, type EvmLaunchForm, type LaunchEvmChain } from './walletLaunchEvmCore.js';
import {
  DEX_FACTORY_SELECTOR,
  FEE_RECIPIENT_SELECTOR,
  FEE_SELECTOR,
  LAUNCH_SELECTOR,
  MIN_LIQUIDITY_SELECTOR,
  MIN_POOL_BPS_SELECTOR,
  TOKEN_LAUNCHED_TOPIC,
  WRAPPED_SELECTOR,
  buildLaunchTx,
  decodeLaunch,
  encodeLaunch,
  findLaunchedToken,
  inspectLaunchTx,
} from './walletLaunchEvmTx.js';
import { EvmLaunchError, EvmLaunchFlow, shortfallMessage, type EvmFlowDeps } from './walletLaunchEvmFlow.js';

const CREATOR = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x2222222222222222222222222222222222222222';
const FEE_TO = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const PAIR = '0x5555555555555555555555555555555555555555';
const OTHER = '0x9999999999999999999999999999999999999999';
const DEAD = '0x000000000000000000000000000000000000dead';
const FEE = 28_000_000_000_000_000n; // 0.028
const MIN = 70_000_000_000_000_000n; // 0.07
const COIN = 500_000_000_000_000_000n; // 0.5
const SUPPLY = 1_000_000n * 10n ** 18n;

const bnb = LAUNCH_EVM_CHAINS.find((c) => c.key === 'bnb')!;
const chain: LaunchEvmChain = { ...bnb, feeAddress: FEE_TO, launch: { ...bnb.launch!, factory: FACTORY, feeWei: FEE, minLiquidityWei: MIN } };
const config = (over: Partial<EvmLaunchConfig> = {}): EvmLaunchConfig => ({ chain, creator: CREATOR, name: 'Aretia Test', symbol: 'ATEST', decimals: 18, totalSupplyRaw: SUPPLY, poolBps: 7000, poolCoinWei: COIN, ...over });
const form = (over: Partial<EvmLaunchForm> = {}): EvmLaunchForm => ({ ...DEFAULT_EVM_FORM, name: 'Aretia Test', symbol: 'ATEST', poolPct: '70', poolCoin: '0.5', ...over });
const table = [chain];

describe('the chain table', () => {
  it('has the three networks in use; each has a locked-launch entry, switched off until its factory is deployed', () => {
    expect(LAUNCH_EVM_CHAINS.filter((c) => !c.testnet).map((c) => [c.name, c.chainId])).toEqual([['BNB Chain', 56], ['Ethereum', 1], ['Polygon', 137]]);
    for (const c of LAUNCH_EVM_CHAINS.filter((x) => !x.testnet)) {
      expect(c.launch).toBeDefined();
      for (const a of [c.launch!.dexFactory, c.launch!.wrapped]) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    }
    expect(LAUNCH_EVM_CHAINS.filter((c) => launchEnabled(c)).map((c) => c.key)).toEqual([]);
    // The token-only factories stay in the table because Aretia Pool and the curve recognise tokens by them, but the page no longer creates through them.
    expect(LAUNCH_EVM_CHAINS.filter((c) => chainEnabled(c)).map((c) => c.key)).toEqual(['bnb', 'ethereum', 'polygon']);
  });
  it('the exchange addresses match the ones the pool page uses, and the fees are the owner-approved ones', async () => {
    const { POOL_DEXES } = await import('./walletPoolEvmCore.js');
    for (const d of POOL_DEXES) {
      const c = LAUNCH_EVM_CHAINS.find((x) => x.key === d.key)!;
      expect(c.launch!.dexFactory).toBe(d.factory);
      expect(c.launch!.wrapped).toBe(d.wrapped);
    }
    const fee = (k: string) => LAUNCH_EVM_CHAINS.find((c) => c.key === k)!.launch!.feeWei;
    expect(fee('bnb')).toBe(28n * 10n ** 15n);
    expect(fee('ethereum')).toBe(84n * 10n ** 14n);
    expect(fee('polygon')).toBe(210n * 10n ** 18n);
  });
  it('is enabled only with a lower-case factory, a fee address, a positive fee and minimum', () => {
    expect(launchEnabled(chain)).toBe(true);
    expect(launchEnabled({ ...chain, launch: { ...chain.launch!, factory: null } })).toBe(false);
    expect(launchEnabled({ ...chain, feeAddress: null })).toBe(false);
    expect(launchEnabled({ ...chain, launch: { ...chain.launch!, feeWei: 0n } })).toBe(false);
    expect(launchEnabled({ ...chain, launch: { ...chain.launch!, minLiquidityWei: 0n } })).toBe(false);
    expect(launchEnabled({ ...chain, launch: { ...chain.launch!, factory: FACTORY.replace(/2/g, 'A') } })).toBe(false);
    expect(launchEnabled({ ...chain, launch: undefined })).toBe(false);
  });
});

describe('validateEvmLaunch', () => {
  it('accepts a good form, lower-cases the creator and reads the pool share and coin', () => {
    const v = validateEvmLaunch(form(), CREATOR.toUpperCase().replace('0X', '0x'), table);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.config.creator).toBe(CREATOR);
      expect(v.config.totalSupplyRaw).toBe(1_000_000_000n * 10n ** 18n);
      expect(v.config.poolBps).toBe(7000);
      expect(v.config.poolCoinWei).toBe(COIN);
      expect(launchValueOf(v.config)).toBe(FEE + COIN);
      expect(poolTokensOf(v.config)).toBe((1_000_000_000n * 10n ** 18n * 7000n) / 10000n);
    }
  });
  it('reads 85.5 % as 8550 and 100 as 10000', () => {
    for (const [pct, bps] of [['85.5', 8550], ['100', 10000], ['70.01', 7001], ['99.99', 9999]] as const) {
      const v = validateEvmLaunch(form({ poolPct: pct }), CREATOR, table);
      expect(v.ok && v.config.poolBps).toBe(bps);
    }
  });
  it('refuses a network with no launch factory yet', () => {
    const v = validateEvmLaunch(form({ chain: 'bnb' }), CREATOR);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.find((i) => i.field === 'chain')?.message).toMatch(/locked liquidity.*not available yet/);
  });
  it('checks name, symbol, decimals, supply, the pool share, the pool coin and the connected account', () => {
    const bad = (over: Partial<EvmLaunchForm>, field: string, creator = CREATOR) => {
      const v = validateEvmLaunch(form(over), creator, table);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.issues.map((i) => i.field)).toContain(field);
    };
    bad({ name: '' }, 'name');
    bad({ name: 'x'.repeat(33) }, 'name');
    bad({ name: 'two\nlines' }, 'name');
    bad({ name: 'é'.repeat(17) }, 'name');
    bad({ symbol: 'A B' }, 'symbol');
    bad({ symbol: 'A'.repeat(12) }, 'symbol');
    bad({ decimals: '19' }, 'decimals');
    bad({ supply: '0' }, 'supply');
    bad({ supply: '1.5', decimals: '0' }, 'supply');
    bad({ supply: '9'.repeat(70), decimals: '18' }, 'supply');
    bad({ poolPct: '69.99' }, 'poolPct');
    bad({ poolPct: '50' }, 'poolPct');
    bad({ poolPct: '100.01' }, 'poolPct');
    bad({ poolPct: '101' }, 'poolPct');
    bad({ poolPct: '' }, 'poolPct');
    bad({ poolPct: 'abc' }, 'poolPct');
    bad({ poolCoin: '' }, 'poolCoin');
    bad({ poolCoin: '0' }, 'poolCoin');
    bad({ poolCoin: '0.0699' }, 'poolCoin');
    bad({ poolCoin: '-1' }, 'poolCoin');
    bad({}, 'form', '');
    bad({ chain: 'nowhere' as never }, 'chain');
  });
  it('accepts exactly the minimum coin and a leading-dot decimal', () => {
    expect(validateEvmLaunch(form({ poolCoin: '0.07' }), CREATOR, table).ok).toBe(true);
    expect(validateEvmLaunch(form({ poolCoin: '.5' }), CREATOR, table).ok).toBe(true);
  });
});

describe('encodeLaunch / decodeLaunch', () => {
  const args = { name: 'Aretia Test', symbol: 'ATEST', decimals: 18, supply: 12345n, poolBps: 7000 };
  it('round-trips, including non-ASCII text and a name that fills more than one word', () => {
    for (const a of [args, { ...args, name: 'Ünï Тoken 日本', symbol: 'U' }, { ...args, name: 'x'.repeat(32) }, { ...args, supply: 2n ** 256n - 1n }, { ...args, poolBps: 10000 }]) {
      expect(decodeLaunch(encodeLaunch(a))).toEqual(a);
    }
  });
  it('writes the known layout for the selector, offsets and words', () => {
    const d = encodeLaunch({ name: 'A', symbol: 'B', decimals: 6, supply: 7n, poolBps: 7000 });
    expect(d.slice(0, 10)).toBe(LAUNCH_SELECTOR);
    const words = d.slice(10).match(/.{64}/g)!;
    expect(BigInt('0x' + words[0])).toBe(0xa0n);
    expect(BigInt('0x' + words[1])).toBe(0xe0n);
    expect(BigInt('0x' + words[2])).toBe(6n);
    expect(BigInt('0x' + words[3])).toBe(7n);
    expect(BigInt('0x' + words[4])).toBe(7000n);
    expect(words).toHaveLength(9);
  });
  it('rejects another selector, trailing data, short data, bad padding and invalid UTF-8', () => {
    const d = encodeLaunch(args);
    expect(decodeLaunch('0xa9059cbb' + d.slice(10))).toBeNull();
    expect(decodeLaunch(d + '00')).toBeNull();
    expect(decodeLaunch(d.slice(0, -2))).toBeNull();
    expect(decodeLaunch(d + '0'.repeat(64))).toBeNull();
    expect(decodeLaunch('0x')).toBeNull();
    expect(decodeLaunch('not hex')).toBeNull();
    const i = d.indexOf(Buffer.from('Aretia Test').toString('hex')) + 22;
    expect(decodeLaunch(d.slice(0, i) + 'ff' + d.slice(i + 2))).toBeNull();
    expect(decodeLaunch(encodeLaunch({ ...args, symbol: 'A' }).replace(Buffer.from('A').toString('hex') + '0'.repeat(62), '80' + '0'.repeat(62)))).toBeNull();
  });
  it('uses the selector, event topic and getters the compiled factory has', () => {
    const sel = artifact.launch.selectors as Record<string, string>;
    expect(sel['launch(string,string,uint8,uint256,uint256)']).toBe(LAUNCH_SELECTOR.slice(2));
    expect(sel['fee()']).toBe(FEE_SELECTOR.slice(2));
    expect(sel['feeRecipient()']).toBe(FEE_RECIPIENT_SELECTOR.slice(2));
    expect(sel['dexFactory()']).toBe(DEX_FACTORY_SELECTOR.slice(2));
    expect(sel['wrapped()']).toBe(WRAPPED_SELECTOR.slice(2));
    expect(sel['minLiquidity()']).toBe(MIN_LIQUIDITY_SELECTOR.slice(2));
    expect(sel['MIN_POOL_BPS()']).toBe(MIN_POOL_BPS_SELECTOR.slice(2));
    const ev = (artifact.launch.abi as { type: string; name: string; inputs: { type: string }[] }[]).find((x) => x.type === 'event' && x.name === 'TokenLaunched')!;
    const sig = `${ev.name}(${ev.inputs.map((x) => x.type).join(',')})`;
    const hex = [...keccak256(new TextEncoder().encode(sig))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(TOKEN_LAUNCHED_TOPIC).toBe('0x' + hex);
    expect(MIN_POOL_BPS).toBe(7000);
  });
});

describe('inspectLaunchTx', () => {
  const good = () => buildLaunchTx(config());
  const check = (tx: ReturnType<typeof good>, over: Partial<EvmLaunchConfig> = {}, chainId = chain.chainId) => inspectLaunchTx(tx, config(over), chainId);

  it('passes the transaction the builder writes, with or without a gas limit', () => {
    expect(check(good())).toEqual([]);
    expect(check({ ...good(), gas: '0x30d40' })).toEqual([]);
    expect(good().value).toBe('0x' + (FEE + COIN).toString(16));
  });
  it('refuses the wrong network, and a transaction not bound to this one', () => {
    expect(check(good(), {}, 1).join(' ')).toMatch(/network 1, not BNB Chain/);
    expect(check({ ...good(), chainId: '0x1' }).join(' ')).toMatch(/not bound to BNB Chain/);
    const { chainId: _c, ...unbound } = good();
    void _c;
    expect(check(unbound).join(' ')).toMatch(/not bound to BNB Chain/);
  });
  it('refuses a different target, sender, or a value that is not exactly the fee plus the pool coin', () => {
    expect(check({ ...good(), to: TOKEN }).join(' ')).toMatch(/not sent to Aretia’s launch factory/);
    expect(check({ ...good(), from: TOKEN }).join(' ')).toMatch(/not from the account/);
    for (const v of ['0x0', '0x' + FEE.toString(16), '0x' + COIN.toString(16), '0x' + (FEE + COIN + 1n).toString(16), '0x' + (FEE + COIN - 1n).toString(16), undefined, 'abc']) {
      expect(check({ ...good(), value: v as string }).join(' ')).toMatch(/not exactly the fee plus the coin for the pool/);
    }
  });
  it('refuses calldata that differs from the approval in any field, or is not a launch at all', () => {
    const tx = good();
    expect(check(tx, { name: 'Other' }).join(' ')).toMatch(/name/);
    expect(check(tx, { symbol: 'OTHER' }).join(' ')).toMatch(/symbol/);
    expect(check(tx, { decimals: 6 }).join(' ')).toMatch(/decimals/);
    expect(check(tx, { totalSupplyRaw: 5n }).join(' ')).toMatch(/supply/);
    expect(check(tx, { poolBps: 7500 }).join(' ')).toMatch(/share of the supply going into the pool/);
    expect(check({ ...tx, data: '0xa9059cbb' + '0'.repeat(128) }).join(' ')).toMatch(/not a plain token launch/);
    expect(check({ ...tx, data: undefined }).join(' ')).toMatch(/not a plain token launch/);
    expect(check({ ...tx, data: tx.data + '00' }).join(' ')).toMatch(/not a plain token launch/);
  });
  it('a launch that would put less than the approved share in the pool is refused even if everything else matches', () => {
    const lower = { ...good(), data: encodeLaunch({ name: 'Aretia Test', symbol: 'ATEST', decimals: 18, supply: SUPPLY, poolBps: 1000 }) };
    expect(check(lower).join(' ')).toMatch(/share of the supply going into the pool/);
  });
  it('refuses unexpected fields, a bad gas limit and a chain with no launch factory', () => {
    expect(check({ ...good(), nonce: '0x1' } as never).join(' ')).toMatch(/unexpected field \(nonce\)/);
    expect(check({ ...good(), gas: 'lots' }).join(' ')).toMatch(/gas limit/);
    expect(check(good(), { chain: { ...chain, launch: { ...chain.launch!, factory: null } } }).join(' ')).toMatch(/no launch factory/);
  });
  it('compares addresses without regard to letter case', () => {
    expect(check({ ...good(), to: FACTORY.toUpperCase().replace('0X', '0x').replace(/2/g, 'A') }, {}).join(' ')).toMatch(/not sent to Aretia/);
    const upper = FACTORY.replace(/[a-f]/g, (c) => c.toUpperCase());
    expect(check({ ...good(), to: upper })).toEqual([]);
  });
});

describe('findLaunchedToken', () => {
  const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0');
  const log = (over: Record<string, unknown> = {}) => ({ address: FACTORY, topics: [TOKEN_LAUNCHED_TOPIC, pad(TOKEN), pad(CREATOR), pad(PAIR)], data: '0x', ...over });
  it('takes the token and pool from the approved factory for the approved creator, and nothing else', () => {
    expect(findLaunchedToken([log()], FACTORY, CREATOR)).toEqual({ token: TOKEN, creator: CREATOR, pair: PAIR });
    expect(findLaunchedToken([log({ address: TOKEN })], FACTORY, CREATOR)).toBeNull();
    expect(findLaunchedToken([log({ topics: [TOKEN_LAUNCHED_TOPIC, pad(TOKEN), pad(FEE_TO), pad(PAIR)] })], FACTORY, CREATOR)).toBeNull();
    expect(findLaunchedToken([log({ topics: ['0x' + '1'.repeat(64), pad(TOKEN), pad(CREATOR), pad(PAIR)] })], FACTORY, CREATOR)).toBeNull();
    expect(findLaunchedToken([log({ topics: [TOKEN_LAUNCHED_TOPIC, pad(TOKEN), pad(CREATOR)] })], FACTORY, CREATOR)).toBeNull();
    expect(findLaunchedToken([log(), log()], FACTORY, CREATOR)).toBeNull();
    expect(findLaunchedToken('nope', FACTORY, CREATOR)).toBeNull();
  });
});

// ---------------------------------------------------------------- the flow, with a scripted chain

const strWord = (s: string) => {
  const hex = Buffer.from(s).toString('hex');
  return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
};
const uintWord = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const addrWord = (a: string) => '0x' + a.slice(2).padStart(64, '0');

interface Script {
  feeOnChain?: bigint;
  recipient?: string;
  dex?: string;
  wrapped?: string;
  minLiq?: bigint;
  minBps?: bigint;
  code?: string;
  balance?: bigint;
  callFails?: boolean;
  receipt?: 'ok' | 'fail' | 'none';
  tokenName?: string;
  held?: bigint;
  sendError?: unknown;
  account?: string;
  chainId?: number;
  twoLogs?: boolean;
  estimateError?: string;
  tokenReserve?: bigint;
  coinReserve?: bigint;
  locked?: bigint;
  mine?: bigint;
  swapOrder?: boolean;
}

function world(s: Script = {}) {
  const sent: unknown[] = [];
  let switched = 0;
  const cfg = config();
  const poolTokens = poolTokensOf(cfg);
  const read: EvmFlowDeps['read'] = async (method, params) => {
    const p = params as { to?: string; data?: string }[] & string[];
    if (method === 'eth_chainId') return '0x' + chain.chainId.toString(16);
    if (method === 'eth_getCode') return p[0] === TOKEN || p[0] === PAIR ? '0x6080' : (s.code ?? '0x6080');
    if (method === 'eth_getBalance') return '0x' + (s.balance ?? 10n ** 19n).toString(16);
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_estimateGas') {
      if (s.estimateError) throw new SwingsError('invalid', s.estimateError);
      return '0x2dc6c0';
    }
    if (method === 'eth_call') {
      const c = p[0] as { to?: string; data?: string };
      const d = c.data ?? '';
      if (c.to === FACTORY) {
        if (d === FEE_SELECTOR) return uintWord(s.feeOnChain ?? FEE);
        if (d === FEE_RECIPIENT_SELECTOR) return addrWord(s.recipient ?? FEE_TO);
        if (d === DEX_FACTORY_SELECTOR) return addrWord(s.dex ?? chain.launch!.dexFactory);
        if (d === WRAPPED_SELECTOR) return addrWord(s.wrapped ?? chain.launch!.wrapped);
        if (d === MIN_LIQUIDITY_SELECTOR) return uintWord(s.minLiq ?? MIN);
        if (d === MIN_POOL_BPS_SELECTOR) return uintWord(s.minBps ?? 7000n);
        if (s.callFails) throw new Error('execution reverted: value');
        return '0x';
      }
      if (c.to === TOKEN) {
        if (d === '0x06fdde03') return strWord(s.tokenName ?? cfg.name);
        if (d === '0x95d89b41') return strWord(cfg.symbol);
        if (d === '0x313ce567') return uintWord(BigInt(cfg.decimals));
        if (d === '0x18160ddd') return uintWord(cfg.totalSupplyRaw);
        if (d.startsWith('0x70a08231')) return uintWord(s.held ?? cfg.totalSupplyRaw - poolTokens);
      }
      if (c.to === PAIR) {
        if (d === '0x0dfe1681') return addrWord(s.swapOrder ? chain.launch!.wrapped : TOKEN);
        if (d === '0x0902f1ac') {
          const t = s.tokenReserve ?? poolTokens;
          const k = s.coinReserve ?? COIN;
          return '0x' + (s.swapOrder ? [k, t] : [t, k]).map((n) => n.toString(16).padStart(64, '0')).join('') + '0'.repeat(64);
        }
        if (d === '0x70a08231' + DEAD.slice(2).padStart(64, '0')) return uintWord(s.locked ?? 1000n);
        if (d.startsWith('0x70a08231')) return uintWord(s.mine ?? 0n);
      }
    }
    if (method === 'eth_getTransactionReceipt') {
      if (s.receipt === 'none') return null;
      const one = { address: FACTORY, topics: [TOKEN_LAUNCHED_TOPIC, addrWord(TOKEN), addrWord(CREATOR), addrWord(PAIR)], data: '0x' };
      return { status: s.receipt === 'fail' ? '0x0' : '0x1', logs: s.twoLogs ? [one, one] : [one] };
    }
    throw new Error(`unexpected ${method}`);
  };
  let t = 0;
  const deps: EvmFlowDeps = {
    adapter: {
      getAccounts: async () => [s.account ?? CREATOR],
      getChainId: async () => s.chainId ?? chain.chainId,
      switchChain: async () => void (switched += 1),
      sendTransaction: async (tx) => {
        if (s.sendError) throw s.sendError;
        sent.push(tx);
        return '0x' + 'ab'.repeat(32);
      },
    },
    read,
    now: () => (t += 60_000),
    sleep: async () => undefined,
  };
  return { flow: new EvmLaunchFlow(deps), sent, switched: () => switched };
}

describe('EvmLaunchFlow', () => {
  it('prepares, sends exactly the inspected transaction, and reads the token and its locked pool back', async () => {
    const w = world();
    const review = await w.flow.prepare(config());
    expect(review.blockers).toEqual([]);
    expect(review.tx.gas).toBe('0x' + ((0x2dc6c0n * 12n) / 10n).toString(16));
    const steps: string[] = [];
    const out = await w.flow.create(review, (p) => steps.push(p));
    expect(out).toEqual({ token: TOKEN, pair: PAIR, txHash: '0x' + 'ab'.repeat(32), differences: [] });
    expect(steps).toEqual(['checking', 'signing', 'confirming', 'verifying', 'done']);
    expect(w.sent).toEqual([review.tx]);
  });
  it('reads the pool whichever side the token sits on', async () => {
    const w = world({ swapOrder: true });
    expect((await w.flow.create(await w.flow.prepare(config()))).differences).toEqual([]);
  });
  it('blocks on a factory whose fee, recipient, exchange, wrapped coin, minimum pool or minimum share differ, or that has no code', async () => {
    const reasons = async (s: Script) => (await world(s).flow.prepare(config())).blockers.join(' ');
    expect(await reasons({ feeOnChain: FEE * 2n })).toMatch(/different fee/);
    expect(await reasons({ recipient: TOKEN })).toMatch(/different address/);
    expect(await reasons({ dex: OTHER })).toMatch(/different exchange/);
    expect(await reasons({ wrapped: OTHER })).toMatch(/different exchange/);
    expect(await reasons({ minLiq: 1n })).toMatch(/different minimum pool/);
    expect(await reasons({ minBps: 1n })).toMatch(/different minimum share/);
    expect(await reasons({ code: '0x' })).toMatch(/not on BNB Chain/);
  });
  it('blocks when the balance cannot cover the fee, the pool coin and the gas, and when the network would refuse', async () => {
    expect((await world({ balance: FEE + COIN }).flow.prepare(config())).blockers.join(' ')).toMatch(/need more BNB/);
    expect((await world({ balance: COIN }).flow.prepare(config())).blockers.join(' ')).toMatch(/need more BNB/);
    expect(await world({ callFails: true }).flow.create(await world().flow.prepare(config())).catch((e: Error) => e.message)).toMatch(/refuse this transaction/);
  });
  it('says plainly how much more is needed, with the numbers, instead of the network refusal', async () => {
    const low = (await world({ balance: FEE }).flow.prepare(config())).blockers.join(' ');
    expect(low).toMatch(/You need more BNB\. You hold about/);
    expect(low).toMatch(/the fee plus the coin for the pool come to about 0\.528 BNB/);
    expect(low).toMatch(/Add at least/);
    expect(low).toMatch(/Nothing was sent/);
    expect(low).not.toMatch(/wei/);
    const raw = (await world({ estimateError: 'insufficient funds for gas * price + value: address 0xabc have 1 want 2' }).flow.prepare(config())).blockers.join(' ');
    expect(raw).toMatch(/You need more BNB/);
    expect(raw).not.toMatch(/insufficient funds for gas/);
    const gasShort = (await world({ balance: FEE + COIN }).flow.prepare(config())).blockers.join(' ');
    expect(gasShort).toMatch(/the fee and pool coin \(about .+\) plus the network gas \(about .+\) come to about/);
  });
  it('rounds the amounts for people, and rounds "add at least" up so it is never short', () => {
    const m = shortfallMessage('BNB', 12_531_773_721_576_266n, 14n * 10n ** 15n, null);
    expect(m).toContain('You hold about 0.0125 BNB');
    expect(m).toContain('come to about 0.014 BNB');
    expect(m).toContain('Add at least 0.0015 BNB');
    expect(m).not.toMatch(/\d\.\d{5,}/);
    expect(shortfallMessage('ETH', 4_199_899_990_000_000n, 4_200_000_000_000_000n, null)).toContain('Add at least 0.000001 ETH');
    const g = shortfallMessage('ETH', 1_019_650_786_838_902n, 4_200_000_000_000_000n, 1_234_567_890_123_456n);
    expect(g).not.toMatch(/\d\.\d{7,}/);
    expect(g).toContain('Add at least');
  });
  it('refuses to prepare a chain that has no launch factory', async () => {
    await expect(world().flow.prepare(config({ chain: { ...chain, launch: { ...chain.launch!, factory: null } } }))).rejects.toThrow(/locked liquidity.*not available yet/);
  });
  it('does not send when a blocker exists, the account changed, or the wallet stays on the wrong network', async () => {
    const w1 = world({ feeOnChain: 1n });
    await expect(w1.flow.create(await w1.flow.prepare(config()))).rejects.toThrow(EvmLaunchError);
    expect(w1.sent).toHaveLength(0);
    const ready = await world().flow.prepare(config());
    const w2 = world({ account: TOKEN });
    await expect(w2.flow.create(ready)).rejects.toThrow(/account selected in your wallet changed/);
    const w3 = world({ chainId: 1 });
    await expect(w3.flow.create(ready)).rejects.toThrow(/Not signing/);
    expect(w3.switched()).toBe(1);
    expect(w2.sent.length + w3.sent.length).toBe(0);
  });
  it('refuses a transaction tampered with after review: target, value, share', async () => {
    const w = world();
    const review = await w.flow.prepare(config());
    await expect(w.flow.create({ ...review, tx: { ...review.tx, to: TOKEN } })).rejects.toThrow(/Not signing.*not sent to Aretia/);
    await expect(w.flow.create({ ...review, tx: { ...review.tx, value: '0x1' } })).rejects.toThrow(/Not signing/);
    const lowShare = encodeLaunch({ name: 'Aretia Test', symbol: 'ATEST', decimals: 18, supply: SUPPLY, poolBps: 1000 });
    await expect(w.flow.create({ ...review, tx: { ...review.tx, data: lowShare } })).rejects.toThrow(/Not signing.*share of the supply/);
    expect(w.sent).toHaveLength(0);
  });
  it('reports a declined wallet as nothing sent, and other send errors plainly', async () => {
    const review = await world().flow.prepare(config());
    const declined = await world({ sendError: new SwingsError('rejected', 'x') }).flow.create(review).catch((e: EvmLaunchError) => e);
    expect(declined).toBeInstanceOf(EvmLaunchError);
    expect((declined as EvmLaunchError).nothingSent).toBe(true);
    const other = await world({ sendError: new Error('boom\nstack') }).flow.create(review).catch((e: EvmLaunchError) => e);
    expect((other as EvmLaunchError).message).toBe('The transaction was not sent: boom');
  });
  it('reports a failed or never-confirmed transaction, and a receipt without exactly one launch', async () => {
    const review = await world().flow.prepare(config());
    await expect(world({ receipt: 'fail' }).flow.create(review)).rejects.toThrow(/failed on the network.*No token or pool was created/);
    await expect(world({ receipt: 'none' }).flow.create(review)).rejects.toThrow(/not confirmed yet/);
    await expect(world({ twoLogs: true }).flow.create(review)).rejects.toThrow(/exactly one new token/);
  });
  it('lists every difference when the token or the pool read back is not what was approved', async () => {
    const review = await world().flow.prepare(config());
    const out = await world({ tokenName: 'Other', held: 5n, tokenReserve: 1n, coinReserve: 2n, locked: 0n, mine: 7n }).flow.create(review);
    expect(out.differences).toEqual([
      'The token’s name is not the one you approved.',
      'Your wallet does not hold exactly the share of the supply you kept.',
      'The pool does not hold exactly the tokens you approved.',
      'The pool does not hold exactly the BNB you approved.',
      'No liquidity reached the dead address, so the pool is not locked.',
      'You hold some of the pool’s liquidity tokens, so it is not fully locked.',
    ]);
  });
});
