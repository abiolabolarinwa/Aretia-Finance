import { describe, expect, it } from 'vitest';
import { SwingsError } from '../swings/core/types.js';
import { DEFAULT_EVM_FORM, LAUNCH_EVM_CHAINS, chainEnabled, validateEvmLaunch, type EvmLaunchConfig, type EvmLaunchForm, type LaunchEvmChain } from './walletLaunchEvmCore';
import { CREATE_SELECTOR, TOKEN_CREATED_TOPIC, buildCreateTx, decodeCreate, encodeCreate, findCreatedToken, inspectCreateTx } from './walletLaunchEvmTx';
import { EvmLaunchError, EvmLaunchFlow, shortfallMessage, type EvmFlowDeps } from './walletLaunchEvmFlow';

const CREATOR = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x2222222222222222222222222222222222222222';
const FEE_TO = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const FEE = 3_000_000_000_000_000n;

const chain: LaunchEvmChain = { ...LAUNCH_EVM_CHAINS.find((c) => c.key === 'bnb')!, feeWei: FEE, factory: FACTORY, feeAddress: FEE_TO };
const config = (over: Partial<EvmLaunchConfig> = {}): EvmLaunchConfig => ({ chain, creator: CREATOR, name: 'Aretia Test', symbol: 'ATEST', decimals: 18, totalSupplyRaw: 1_000_000n * 10n ** 18n, ...over });
const form = (over: Partial<EvmLaunchForm> = {}): EvmLaunchForm => ({ ...DEFAULT_EVM_FORM, name: 'Aretia Test', symbol: 'ATEST', ...over });
const table = [chain];

describe('the chain table', () => {
  it('has the three networks in use and their test networks, all off until a factory and fee address are set', () => {
    expect(LAUNCH_EVM_CHAINS.filter((c) => !c.testnet).map((c) => [c.name, c.chainId])).toEqual([['BNB Chain', 56], ['Ethereum', 1], ['Polygon', 137]]);
    expect(LAUNCH_EVM_CHAINS.filter((c) => c.testnet)).toHaveLength(3);
    // Only networks whose factory has been deployed and its address written into the table are on.
    expect(LAUNCH_EVM_CHAINS.filter(chainEnabled).map((c) => c.key)).toEqual(['bnb', 'ethereum', 'polygon']);
  });
  it('is enabled only with both lower-case addresses and a positive fee', () => {
    expect(chainEnabled(chain)).toBe(true);
    expect(chainEnabled({ ...chain, factory: null })).toBe(false);
    expect(chainEnabled({ ...chain, feeAddress: null })).toBe(false);
    expect(chainEnabled({ ...chain, feeWei: 0n })).toBe(false);
    expect(chainEnabled({ ...chain, factory: FACTORY.toUpperCase().replace('0X', '0x').replace(/[0-9]/g, 'A') })).toBe(false);
  });
});

describe('validateEvmLaunch', () => {
  it('accepts a good form and lower-cases the creator', () => {
    const v = validateEvmLaunch(form(), CREATOR.toUpperCase().replace('0X', '0x'), table);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.config.creator).toBe(CREATOR);
      expect(v.config.totalSupplyRaw).toBe(1_000_000_000n * 10n ** 18n);
    }
  });
  it('refuses a chain with no factory yet', () => {
    const v = validateEvmLaunch(form({ chain: 'sepolia' }), CREATOR);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.find((i) => i.field === 'chain')?.message).toMatch(/not available yet/);
  });
  it('checks name, symbol, decimals, supply and the connected account', () => {
    const bad = (over: Partial<EvmLaunchForm>, field: string, creator = CREATOR) => {
      const v = validateEvmLaunch(form(over), creator, table);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.issues.map((i) => i.field)).toContain(field);
    };
    bad({ name: '' }, 'name');
    bad({ name: 'x'.repeat(33) }, 'name');
    bad({ name: 'two\nlines' }, 'name');
    bad({ name: 'é'.repeat(17) }, 'name'); // 34 bytes
    bad({ symbol: 'A B' }, 'symbol');
    bad({ symbol: 'A'.repeat(12) }, 'symbol');
    bad({ decimals: '19' }, 'decimals');
    bad({ decimals: '-1' }, 'decimals');
    bad({ supply: '0' }, 'supply');
    bad({ supply: '1.5', decimals: '0' }, 'supply');
    bad({ supply: '9'.repeat(70), decimals: '18' }, 'supply');
    bad({}, 'form', '');
    bad({ chain: 'nowhere' as never }, 'chain');
  });
});

describe('encodeCreate / decodeCreate', () => {
  const args = { name: 'Aretia Test', symbol: 'ATEST', decimals: 18, supply: 12345n };
  it('round-trips, including non-ASCII text and a name that fills more than one word', () => {
    for (const a of [args, { ...args, name: 'Ünï Тoken 日本', symbol: 'U' }, { ...args, name: 'x'.repeat(32) }, { ...args, supply: 2n ** 256n - 1n }]) {
      expect(decodeCreate(encodeCreate(a))).toEqual(a);
    }
  });
  it('writes the known layout for the selector, offsets and words', () => {
    const d = encodeCreate({ name: 'A', symbol: 'B', decimals: 6, supply: 7n });
    expect(d.slice(0, 10)).toBe(CREATE_SELECTOR);
    const words = d.slice(10).match(/.{64}/g)!;
    expect(BigInt('0x' + words[0])).toBe(0x80n);
    expect(BigInt('0x' + words[1])).toBe(0xc0n);
    expect(BigInt('0x' + words[2])).toBe(6n);
    expect(BigInt('0x' + words[3])).toBe(7n);
    expect(words).toHaveLength(8);
  });
  it('rejects another selector, trailing data, short data, bad padding and invalid UTF-8', () => {
    const d = encodeCreate(args);
    expect(decodeCreate('0xa9059cbb' + d.slice(10))).toBeNull();
    expect(decodeCreate(d + '00')).toBeNull();
    expect(decodeCreate(d.slice(0, -2))).toBeNull();
    expect(decodeCreate(d + '0'.repeat(64))).toBeNull();
    expect(decodeCreate('0x')).toBeNull();
    expect(decodeCreate('not hex')).toBeNull();
    // padding of the name word made non-zero
    const i = d.indexOf(Buffer.from('Aretia Test').toString('hex')) + 22;
    expect(decodeCreate(d.slice(0, i) + 'ff' + d.slice(i + 2))).toBeNull();
    // invalid UTF-8 (a lone continuation byte) in the symbol
    expect(decodeCreate(encodeCreate({ ...args, symbol: 'A' }).replace(Buffer.from('A').toString('hex') + '0'.repeat(62), '80' + '0'.repeat(62)))).toBeNull();
  });
});

describe('inspectCreateTx', () => {
  const good = () => buildCreateTx(config());
  const check = (tx: ReturnType<typeof good>, over: Partial<EvmLaunchConfig> = {}, chainId = chain.chainId) => inspectCreateTx(tx, config(over), chainId);

  it('passes the transaction the builder writes, with or without a gas limit', () => {
    expect(check(good())).toEqual([]);
    expect(check({ ...good(), gas: '0x30d40' })).toEqual([]);
  });
  it('refuses the wrong network', () => {
    expect(check(good(), {}, 1).join(' ')).toMatch(/network 1, not BNB Chain/);
  });
  it('refuses a different target, sender, fee amount, or a changed field', () => {
    expect(check({ ...good(), to: TOKEN }).join(' ')).toMatch(/not sent to Aretia/);
    expect(check({ ...good(), from: TOKEN }).join(' ')).toMatch(/not from the account/);
    expect(check({ ...good(), value: '0x0' }).join(' ')).toMatch(/exactly the BNB creation fee/);
    expect(check({ ...good(), value: '0x' + (FEE + 1n).toString(16) }).join(' ')).toMatch(/exactly/);
    expect(check({ ...good(), value: undefined }).join(' ')).toMatch(/exactly/);
    expect(check({ ...good(), value: '3000000000000000' }).join(' ')).toMatch(/exactly/);
  });
  it('refuses calldata that differs from the approval in any field, or is not a creation at all', () => {
    const tx = good();
    expect(check(tx, { name: 'Other' }).join(' ')).toMatch(/name/);
    expect(check(tx, { symbol: 'OTHER' }).join(' ')).toMatch(/symbol/);
    expect(check(tx, { decimals: 6 }).join(' ')).toMatch(/decimals/);
    expect(check(tx, { totalSupplyRaw: 5n }).join(' ')).toMatch(/supply/);
    expect(check({ ...tx, data: '0xa9059cbb' + '0'.repeat(128) }).join(' ')).toMatch(/not a plain token creation/);
    expect(check({ ...tx, data: undefined }).join(' ')).toMatch(/not a plain token creation/);
    expect(check({ ...tx, data: tx.data + '00' }).join(' ')).toMatch(/not a plain token creation/);
  });
  it('refuses unexpected fields (such as a delegated gas price or nonce) and a chain with no factory', () => {
    expect(check({ ...good(), nonce: '0x1' } as never).join(' ')).toMatch(/unexpected field \(nonce\)/);
    expect(check({ ...good(), gas: 'lots' }).join(' ')).toMatch(/gas limit/);
    expect(check(good(), { chain: { ...chain, factory: null } }).join(' ')).toMatch(/no factory/);
  });
  it('compares addresses without regard to letter case', () => {
    expect(check({ ...good(), to: '0x' + 'AB'.repeat(20) }, { chain: { ...chain, factory: '0x' + 'ab'.repeat(20) } })).toEqual([]);
  });
});

describe('findCreatedToken', () => {
  const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0');
  const log = (over: Record<string, unknown> = {}) => ({ address: FACTORY, topics: [TOKEN_CREATED_TOPIC, pad(TOKEN), pad(CREATOR)], data: '0x', ...over });
  it('takes the token from the approved factory for the approved creator, and nothing else', () => {
    expect(findCreatedToken([log()], FACTORY, CREATOR)).toEqual({ token: TOKEN, creator: CREATOR });
    expect(findCreatedToken([log({ address: TOKEN })], FACTORY, CREATOR)).toBeNull();
    expect(findCreatedToken([log({ topics: [TOKEN_CREATED_TOPIC, pad(TOKEN), pad(FEE_TO)] })], FACTORY, CREATOR)).toBeNull();
    expect(findCreatedToken([log({ topics: ['0x' + '1'.repeat(64), pad(TOKEN), pad(CREATOR)] })], FACTORY, CREATOR)).toBeNull();
    expect(findCreatedToken([log(), log()], FACTORY, CREATOR)).toBeNull();
    expect(findCreatedToken('nope', FACTORY, CREATOR)).toBeNull();
  });
});

// ---------------------------------------------------------------- the flow, with a scripted chain

const strWord = (s: string) => {
  const hex = Buffer.from(s).toString('hex');
  return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
};
const uintWord = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

function world(script: { feeOnChain?: bigint; recipient?: string; code?: string; balance?: bigint; callFails?: boolean; receipt?: 'ok' | 'fail' | 'none'; tokenName?: string; held?: bigint; sendError?: unknown; account?: string; chainId?: number; twoLogs?: boolean; estimateError?: string } = {}) {
  const sent: unknown[] = [];
  let switched = 0;
  const cfg = config();
  const read: EvmFlowDeps['read'] = async (method, params) => {
    const p = params as { to?: string; data?: string }[] & string[];
    if (method === 'eth_chainId') return '0x' + chain.chainId.toString(16);
    if (method === 'eth_getCode') return p[0] === TOKEN ? '0x6080' : (script.code ?? '0x6080');
    if (method === 'eth_getBalance') return '0x' + (script.balance ?? 10n ** 18n).toString(16);
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_estimateGas') {
      if (script.estimateError) throw new SwingsError('failed', script.estimateError);
      return '0x7a120';
    }
    if (method === 'eth_call') {
      const c = p[0] as { to?: string; data?: string };
      if (c.to === FACTORY && c.data === '0xddca3f43') return uintWord(script.feeOnChain ?? FEE);
      if (c.to === FACTORY && c.data === '0x46904840') return '0x' + (script.recipient ?? FEE_TO).slice(2).padStart(64, '0');
      if (c.to === FACTORY) {
        if (script.callFails) throw new Error('execution reverted: fee');
        return '0x';
      }
      if (c.data === '0x06fdde03') return strWord(script.tokenName ?? cfg.name);
      if (c.data === '0x95d89b41') return strWord(cfg.symbol);
      if (c.data === '0x313ce567') return uintWord(BigInt(cfg.decimals));
      if (c.data === '0x18160ddd') return uintWord(cfg.totalSupplyRaw);
      if (c.data?.startsWith('0x70a08231')) return uintWord(script.held ?? cfg.totalSupplyRaw);
    }
    if (method === 'eth_getTransactionReceipt') {
      if (script.receipt === 'none') return null;
      const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0');
      const one = { address: FACTORY, topics: [TOKEN_CREATED_TOPIC, pad(TOKEN), pad(CREATOR)], data: '0x' };
      return { status: script.receipt === 'fail' ? '0x0' : '0x1', logs: script.twoLogs ? [one, one] : [one] };
    }
    throw new Error(`unexpected ${method}`);
  };
  let t = 0;
  const deps: EvmFlowDeps = {
    adapter: {
      getAccounts: async () => [script.account ?? CREATOR],
      getChainId: async () => (script.chainId ?? chain.chainId),
      switchChain: async () => void (switched += 1),
      sendTransaction: async (tx) => {
        if (script.sendError) throw script.sendError;
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
  it('prepares, sends exactly the inspected transaction, and reads the token back', async () => {
    const w = world();
    const review = await w.flow.prepare(config());
    expect(review.blockers).toEqual([]);
    expect(review.tx.gas).toBe('0x' + ((0x7a120n * 12n) / 10n).toString(16));
    const steps: string[] = [];
    const out = await w.flow.create(review, (p) => steps.push(p));
    expect(out).toEqual({ token: TOKEN, txHash: '0x' + 'ab'.repeat(32), differences: [] });
    expect(steps).toEqual(['checking', 'signing', 'confirming', 'verifying', 'done']);
    expect(w.sent).toEqual([review.tx]);
  });
  it('blocks on a factory with a different fee, a different fee address, or no code', async () => {
    expect((await world({ feeOnChain: FEE * 2n }).flow.prepare(config())).blockers.join(' ')).toMatch(/different fee/);
    expect((await world({ recipient: TOKEN }).flow.prepare(config())).blockers.join(' ')).toMatch(/different address/);
    expect((await world({ code: '0x' }).flow.prepare(config())).blockers.join(' ')).toMatch(/not on BNB Chain/);
  });
  it('blocks when the balance cannot cover the fee and gas, and when the network would refuse', async () => {
    expect((await world({ balance: FEE }).flow.prepare(config())).blockers.join(' ')).toMatch(/need more BNB/);
    expect((await world({ callFails: true }).flow.create(await world().flow.prepare(config())).catch((e: Error) => e.message))).toMatch(/refuse this transaction/);
  });
  it('says plainly how much more is needed, with the numbers, instead of the network refusal', async () => {
    // Below the fee itself: the network cannot price the gas, so the page does not ask it to.
    const low = (await world({ balance: FEE / 4n }).flow.prepare(config())).blockers.join(' ');
    expect(low).toMatch(/You need more BNB\. You hold about/);
    expect(low).toMatch(/Add at least/);
    expect(low).toMatch(/Nothing was sent/);
    expect(low).not.toMatch(/wei/);
    // The network itself says there are not enough funds: the same plain message, not its raw text.
    const raw = (await world({ estimateError: 'insufficient funds for gas * price + value: address 0xabc have 1 want 2' }).flow.prepare(config())).blockers.join(' ');
    expect(raw).toMatch(/You need more BNB/);
    expect(raw).not.toMatch(/insufficient funds for gas/);
    // Enough for the fee but not the gas: the fee, the gas and the total are all named.
    const gasShort = (await world({ balance: FEE }).flow.prepare(config())).blockers.join(' ');
    expect(gasShort).toMatch(/the fee \(.+\) plus the network gas \(about .+\) comes to about/);
  });
  it('rounds the amounts for people, and rounds "add at least" up so it is never short', () => {
    // The case seen on BNB Chain: 0.012531773721576266 held, 0.014 fee.
    const m = shortfallMessage('BNB', 12_531_773_721_576_266n, 14n * 10n ** 15n, null);
    expect(m).toContain('You hold about 0.0125 BNB');
    expect(m).toContain("Aretia's fee alone is about 0.014 BNB");
    expect(m).toContain('Add at least 0.0015 BNB');
    expect(m).not.toMatch(/\d\.\d{5,}/);
    // Rounding up: a shortfall of 0.00000010001 is shown as 0.000001, never rounded down to nothing.
    expect(shortfallMessage('ETH', 4_199_899_990_000_000n, 4_200_000_000_000_000n, null)).toContain('Add at least 0.000001 ETH');
    expect(shortfallMessage('ETH', 4_199_899_990_000_000n, 4_200_000_000_000_000n, null)).not.toContain('0.0001 ETH');
    // With the gas known, every figure is rounded.
    const g = shortfallMessage('ETH', 1_019_650_786_838_902n, 4_200_000_000_000_000n, 1_234_567_890_123_456n);
    expect(g).not.toMatch(/\d\.\d{7,}/);
    expect(g).toContain('Add at least');
  });
  it('refuses to prepare a chain that is not enabled', async () => {
    await expect(world().flow.prepare(config({ chain: { ...chain, factory: null } }))).rejects.toThrow(/not available yet/);
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
  it('refuses a transaction tampered with after review', async () => {
    const w = world();
    const review = await w.flow.prepare(config());
    await expect(w.flow.create({ ...review, tx: { ...review.tx, to: TOKEN } })).rejects.toThrow(/Not signing.*not sent to Aretia/);
    await expect(w.flow.create({ ...review, tx: { ...review.tx, value: '0x1' } })).rejects.toThrow(/Not signing/);
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
  it('reports a failed or never-confirmed transaction, and a receipt without exactly one creation', async () => {
    const review = await world().flow.prepare(config());
    await expect(world({ receipt: 'fail' }).flow.create(review)).rejects.toThrow(/failed on the network/);
    await expect(world({ receipt: 'none' }).flow.create(review)).rejects.toThrow(/not confirmed yet/);
    await expect(world({ twoLogs: true }).flow.create(review)).rejects.toThrow(/exactly one new token/);
  });
  it('lists every difference when the token read back is not what was approved', async () => {
    const review = await world().flow.prepare(config());
    const out = await world({ tokenName: 'Other', held: 5n }).flow.create(review);
    expect(out.differences).toEqual(['The token’s name is not the one you approved.', 'Your wallet does not hold the whole supply.']);
  });
});
