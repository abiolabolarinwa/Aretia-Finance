import { describe, expect, it } from 'vitest';
import { checkEvm, checkSite, checkSolana, checkToken, runCheck, type ShieldDeps } from './check.js';
import { assessEvmToken } from '../tokens/risk.js';
import { EVM_DEXES } from '../dex/entries.js';
import { findLookalikes } from './lookalike.js';
import type { KnownAddress } from './types.js';

const NOW = Date.UTC(2026, 9, 11);
const DAY = 86_400_000;
const WALLET = 'GkXn6PUubyYHHE1h7tVd9bGswwSKoLaGBdBr4eDUdaWa';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const EVM = '0x1234567890abcdef1234567890abcdef12345678';

function deps(over: Partial<ShieldDeps> = {}): ShieldDeps {
  return {
    now: () => NOW,
    sol: async () => {
      throw new Error('no network');
    },
    evm: () => async () => {
      throw new Error('no network');
    },
    fetchJson: async () => {
      throw new Error('no network');
    },
    known: [],
    own: null,
    assessToken: async () => null,
    findPool: async () => null,
    pairAgeMs: async () => null,
    lock: async () => null,
    resolveName: async () => {
      throw new Error('nope');
    },
    ...over,
  };
}

/** A Solana node holding the accounts given, and the signature lists given. */
const solNode = (accounts: Record<string, unknown>, sigs: Record<string, { blockTime: number }[]> = {}): ShieldDeps['sol'] =>
  (async (method: string, params: unknown[]) => {
    const a = params[0] as string;
    if (method === 'getAccountInfo') return { value: accounts[a] ?? null };
    if (method === 'getSignaturesForAddress') return (sigs[a] ?? []).map((s, i) => ({ signature: `s${i}`, blockTime: s.blockTime, err: null }));
    throw new Error(`unexpected ${method}`);
  }) as ShieldDeps['sol'];

const wallet = { lamports: 2_500_000_000, owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'] };
const three = [{ blockTime: 5 }, { blockTime: 6 }, { blockTime: 7 }];

describe('checking a Solana address', () => {
  it('warns about an address that has never been used', async () => {
    const v = await checkSolana(WALLET, deps({ sol: solNode({}) }));
    expect(v.band).toBe('orange');
    expect(v.findings[0]).toMatchObject({ id: 'unused', severity: 'warn' });
    expect(v.couldNot.join(' ')).toMatch(/Who owns it/);
  });
  it('checks a second node before believing an empty history, and says so when neither shows any', async () => {
    const empty = deps({ sol: solNode({ [WALLET]: wallet }, {}), solHistory: (async () => three.map((s) => ({ signature: 's', blockTime: s.blockTime, err: null }))) as ShieldDeps['solHistory'] });
    const found = await checkSolana(WALLET, empty);
    expect(found.findings.some((f) => f.id === 'no-history')).toBe(false);
    expect(found.facts.find((f) => f.label === 'Transactions seen')?.value).toBe('3');
    const none = await checkSolana(WALLET, deps({ sol: solNode({ [WALLET]: wallet }, {}), solHistory: (async () => []) as ShieldDeps['solHistory'] }));
    expect(none.findings.find((f) => f.id === 'no-history')).toMatchObject({ severity: 'note' });
    expect(none.findings.find((f) => f.id === 'no-history')!.detail).toMatch(/Do not read this as a sign/);
  });
  it('is green for an old, busy wallet, and still lists what it could not see', async () => {
    const sigs = Array.from({ length: 1000 }, (_, i) => ({ blockTime: Math.floor((NOW - (i * 3 + 10) * DAY) / 1000) }));
    const v = await checkSolana(WALLET, deps({ sol: solNode({ [WALLET]: wallet }, { [WALLET]: sigs }) }));
    expect(v.band).toBe('green');
    expect(v.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['age', 'busy']));
    expect(v.couldNot.length).toBeGreaterThan(0);
    expect(v.facts.find((f) => f.label === 'SOL balance')?.value).toBe('2.500 SOL');
  });
  it('flags a wallet whose first transaction was in the last day', async () => {
    const recent = [{ blockTime: Math.floor((NOW - 3_600_000) / 1000) }, { blockTime: Math.floor((NOW - 7_000_000) / 1000) }, { blockTime: Math.floor((NOW - 8_000_000) / 1000) }];
    const v = await checkSolana(WALLET, deps({ sol: solNode({ [WALLET]: wallet }, { [WALLET]: recent }) }));
    expect(v.band).toBe('orange');
    expect(v.findings.some((f) => f.id === 'age' && f.severity === 'warn')).toBe(true);
  });
  it('says a token account is not a wallet', async () => {
    const acct = { lamports: 2_039_280, owner: TOKEN_PROGRAM, executable: false, data: { program: 'spl-token', parsed: { type: 'account', info: { owner: WALLET, mint: 'So11111111111111111111111111111111111111112' } } } };
    const key = '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT';
    const v = await checkSolana(key, deps({ sol: solNode({ [key]: acct }) }));
    expect(v.subject.kind).toBe('solana-token-account');
    expect(v.findings[0]!.title).toMatch(/token account, not a wallet/);
    expect(v.facts.find((f) => f.label === 'Belongs to wallet')?.value).toBe(WALLET);
  });
  it('names a known program, and warns about an unknown one', async () => {
    const program = { lamports: 1, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: ['', 'base64'] };
    const jup = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const known = await checkSolana(jup, deps({ sol: solNode({ [jup]: program }) }));
    expect(known.subject.kind).toBe('solana-program');
    expect(known.findings[0]!.title).toMatch(/Jupiter/);
    const unknown = await checkSolana(WALLET, deps({ sol: solNode({ [WALLET]: program }) }));
    expect(unknown.band).toBe('orange');
  });
  it('is red for the incinerator, where money is destroyed', async () => {
    const v = await checkSolana('1nc1nerator11111111111111111111111111111111', deps());
    expect(v.band).toBe('red');
    expect(v.headline).toMatch(/destroyed/);
  });
  it('is red for an address that imitates one the person has sent to', async () => {
    const known: KnownAddress[] = [{ address: WALLET, label: 'Mum', trusted: true, lastUsed: 1 }];
    const fake = WALLET.slice(0, 4) + 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' + WALLET.slice(-4);
    expect(findLookalikes(fake, known)).toHaveLength(1);
    const v = await checkSolana(fake, deps({ known, sol: solNode({ [fake]: wallet }, { [fake]: [{ blockTime: Math.floor((NOW - 5 * DAY) / 1000) }, { blockTime: 1 }, { blockTime: 2 }] }) }));
    expect(v.band).toBe('red');
    expect(v.findings[0]).toMatchObject({ id: 'lookalike', severity: 'bad' });
    expect(v.findings[0]!.title).toMatch(/Mum/);
  });
  it('recognises a saved address and the wallet the person has connected', async () => {
    const known: KnownAddress[] = [{ address: WALLET, label: 'Mum', trusted: true, lastUsed: 1 }];
    const saved = await checkSolana(WALLET, deps({ known, sol: solNode({ [WALLET]: wallet }, { [WALLET]: three }) }));
    expect(saved.findings.some((f) => f.id === 'trusted')).toBe(true);
    const own = await checkSolana(WALLET, deps({ own: WALLET, sol: solNode({ [WALLET]: wallet }, {}) }));
    expect(own.findings.some((f) => f.id === 'own')).toBe(true);
  });
  it('is grey, and says why, when the network cannot be reached', async () => {
    const v = await checkSolana(WALLET, deps());
    expect(v.band).toBe('grey');
    expect(v.couldNot.join(' ')).toMatch(/did not complete/);
  });
});

describe('checking an EVM address', () => {
  const node =
    (byChain: Record<string, { code?: string; nonce?: number; balance?: bigint }>): ShieldDeps['evm'] =>
    (chain) =>
    async (method) => {
      const c = byChain[chain] ?? {};
      if (method === 'eth_getCode') return c.code ?? '0x';
      if (method === 'eth_getTransactionCount') return '0x' + (c.nonce ?? 0).toString(16);
      if (method === 'eth_getBalance') return '0x' + (c.balance ?? 0n).toString(16);
      if (method === 'eth_getStorageAt') return '0x' + '0'.repeat(64);
      throw new Error('unexpected ' + method);
    };

  it('is red for a checksum that fails: the address was mistyped or changed', async () => {
    const v = await checkEvm(EVM, deps(), true);
    expect(v.band).toBe('red');
    expect(v.findings[0]!.id).toBe('checksum');
  });
  it('warns about an address with no activity anywhere', async () => {
    const v = await checkEvm(EVM, deps({ evm: node({}) }));
    expect(v.band).toBe('orange');
    expect(v.findings[0]).toMatchObject({ id: 'unused', severity: 'warn' });
  });
  it('is green for a wallet that has sent many transactions, and says it could not tell its age', async () => {
    const v = await checkEvm(EVM, deps({ evm: node({ ethereum: { nonce: 340, balance: 10n ** 18n }, base: { nonce: 12 } }) }));
    expect(v.band).toBe('green');
    expect(v.couldNot.join(' ')).toMatch(/How old/);
    expect(v.facts[0]!.value).toMatch(/352.*Ethereum, Base/);
  });
  it('says it counted fewer networks when some did not answer', async () => {
    const partial: ShieldDeps['evm'] = (chain) => async (method) => {
      if (chain === 'polygon') throw new Error('down');
      return method === 'eth_getCode' ? '0x' : '0x0';
    };
    const v = await checkEvm(EVM, deps({ evm: partial }));
    expect(v.couldNot.join(' ')).toMatch(/1 of \d+ networks did not answer/);
  });
  it('knows a router Aretia routes through, and warns about an unknown contract', async () => {
    const router = EVM_DEXES.find((d) => d.router && d.chain === 'ethereum')!;
    const known = await checkEvm(router.router!, deps({ evm: node({ ethereum: { code: '0x6080', nonce: 1 } }) }));
    expect(known.subject.kind).toBe('evm-contract');
    expect(known.findings[0]!.id).toBe('known-router');
    const unknown = await checkEvm(EVM, deps({ evm: node({ ethereum: { code: '0x6080', nonce: 1 } }) }));
    expect(unknown.band).toBe('orange');
    expect(unknown.findings[0]!.id).toBe('contract');
  });
});

describe('checking a token', () => {
  const pool = { network: 'eth', pool: '0xpool', poolName: 'ABC / WETH', priceUsd: 0.5, change24h: 1, volume24hUsd: 20_000, liquidityUsd: 80_000, trades24h: 40, baseSymbol: 'ABC', quoteSymbol: 'WETH', targetIsBase: true, icon: null };
  it('uses the rating engine, so the colour matches the Markets list', async () => {
    const risk = assessEvmToken({ owner: 'set', canMint: true, liquidityUsd: 3_000, volume24hUsd: 0, poolCount: 1, ageHours: 5, top10Pct: 90, sourceVerified: false }, { now: NOW });
    const v = await checkToken('base', EVM, deps({ findPool: async () => ({ ...pool, liquidityUsd: 3_000 }), assessToken: async () => risk }));
    expect(['orange', 'red']).toContain(v.band);
    expect(v.subject).toMatchObject({ kind: 'evm-token', label: 'ABC' });
    expect(v.ratingLabel).toBeTruthy();
    expect(v.findings.some((f) => f.severity === 'bad' || f.severity === 'warn')).toBe(true);
  });
  it('is no better than its rating, even when every check it could make passed', async () => {
    const risk = assessEvmToken({ owner: 'renounced', canMint: false, canBlacklist: false, canPause: false, transferRestrictions: false, buyTaxPct: 0, sellTaxPct: 0, sourceVerified: true, top10Pct: 20, liquidityUsd: 500_000, volume24hUsd: 100_000, poolCount: 3, ageHours: 24 * 30 }, { now: NOW });
    const v = await checkToken('base', EVM, deps({ findPool: async () => pool, assessToken: async () => risk, lock: async () => ({ pct: 100, kind: 'burned', at: NOW }) }));
    expect(v.findings.some((f) => f.id === 'lock' && f.severity === 'ok')).toBe(true);
    expect(v.headline).toMatch(/not a promise of safety|Worth a second look/);
  });
  it('treats the admin powers of a stablecoin as notes, not warnings, so USDC is not called dangerous', async () => {
    const usdcBase = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const risk = assessEvmToken({ owner: 'set', canMint: true, canBlacklist: true, canPause: true, isProxy: true, sourceVerified: true, top10Pct: 60, liquidityUsd: 1_000_000, volume24hUsd: 500_000, poolCount: 5, ageHours: 24 * 800 }, { now: NOW });
    const plain = await checkToken('base', EVM, deps({ findPool: async () => pool, assessToken: async () => risk }));
    expect(['orange', 'red']).toContain(plain.band);
    const usdc = await checkToken('base', usdcBase, deps({ findPool: async () => pool, assessToken: async () => risk }));
    expect(usdc.band).toBe('yellow');
    expect(usdc.findings.some((f) => f.severity === 'bad' || f.severity === 'warn')).toBe(false);
    expect(usdc.findings.some((f) => f.id === 'major')).toBe(true);
    expect(usdc.findings.filter((f) => f.severity === 'note').length).toBeGreaterThan(0);
    expect(usdc.ratingLabel).toBe('Major asset');
  });
  it('warns when there is no trading pool, and says there is no rating when the token cannot be read', async () => {
    const v = await checkToken('solana', WALLET, deps());
    expect(v.findings.some((f) => f.id === 'no-market' && f.severity === 'warn')).toBe(true);
    expect(v.couldNot.join(' ')).toMatch(/no rating/);
  });
  it('notes a lock that ends soon, and the absence of any lock for an unproven token', async () => {
    const risk = assessEvmToken({ liquidityUsd: 80_000, volume24hUsd: 20_000, poolCount: 1, ageHours: 100, owner: 'renounced', canMint: false, sourceVerified: true }, { now: NOW });
    const soon = await checkToken('base', EVM, deps({ findPool: async () => pool, assessToken: async () => risk, lock: async () => ({ pct: 90, kind: 'time-locked', until: NOW + 3 * DAY, by: 'UNCX', at: NOW }) }));
    expect(soon.findings.find((f) => f.id === 'lock')).toMatchObject({ severity: 'note' });
    const none = await checkToken('base', EVM, deps({ findPool: async () => pool, assessToken: async () => risk, lock: async () => null }));
    expect(none.findings.find((f) => f.id === 'no-lock')).toMatchObject({ severity: 'note' });
  });
});

describe('checking a link and the entry point', () => {
  it('reads the domain age from the registry when it answers, and says so when it does not', async () => {
    const answers = deps({ fetchJson: async () => ({ events: [{ eventAction: 'registration', eventDate: new Date(NOW - 2 * DAY).toISOString() }] }) });
    const young = await checkSite('https://claim-airdrop.xyz', answers);
    expect(young.findings.some((f) => f.id === 'age' && f.severity === 'warn')).toBe(true);
    expect(young.band).toBe('orange');
    expect(young.subject.label).toBeNull();
    const imitation = await checkSite('https://phantom-app.xyz', deps());
    expect(imitation.subject.label).toBeNull();
    const real = await checkSite('https://phantom.app', deps());
    expect(real.subject.label).toBe('Phantom');
    const silent = await checkSite('https://example.com', deps());
    expect(silent.couldNot.join(' ')).toMatch(/registration record could not be read/);
    expect(silent.couldNot.join(' ')).toMatch(/does not open it/);
  });
  it('sends each kind of paste to the right check', async () => {
    expect((await runCheck('hello there', deps())).findings[0]!.id).toBe('unknown');
    expect((await runCheck('0x' + 'ab'.repeat(32), deps())).findings[0]!.id).toBe('tx');
    expect((await runCheck('https://phantom.app', deps())).subject.kind).toBe('site');
    expect((await runCheck(WALLET, deps({ sol: solNode({}) }))).subject.kind).toBe('solana-wallet');
    const named = await runCheck('bob.sns', deps({ resolveName: async () => WALLET, sol: solNode({ [WALLET]: wallet }, { [WALLET]: three }) }));
    expect(named.facts[0]).toEqual({ label: 'Name resolves to', value: WALLET });
    const missing = await runCheck('nobody.sns', deps());
    expect(missing.band).toBe('orange');
  });
});
