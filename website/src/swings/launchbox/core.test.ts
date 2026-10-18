import { describe, expect, it } from 'vitest';
import { TOKEN_CREATED_TOPIC as PAGE_TOPIC } from '../../scripts/walletLaunchEvmTx';
import { createAddress as pageCreateAddress } from '../../scripts/walletCurveEvmCore';
import {
  EVM_FACTORIES,
  SOLANA_FEE_WALLET,
  TOKEN_2022_PROGRAM,
  TOKEN_CREATED_TOPIC,
  acceptSolanaLaunch,
  applyBackfill,
  applyForward,
  createAddress,
  decodeStringReturn,
  decodeTokenCreated,
  defaultSort,
  evmWindow,
  filterLaunches,
  parseSolanaState,
  planBackfill,
  planForward,
  serializeSolanaState,
  sortLaunches,
  tokenPageUrl,
  viewLaunches,
  type LaunchView,
  type ParsedTx,
  type SolanaState,
} from './core';

// ---------------------------------------------------------------- EVM event decoding

const w = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
const utf8hex = (s: string): string => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
function str(s: string): string {
  const body = utf8hex(s);
  return w(s.length === 0 ? 0 : new TextEncoder().encode(s).length) + body.padEnd(Math.ceil(body.length / 64) * 64, '0');
}
/** ABI-encodes the event data (string name, string symbol, uint8 decimals, uint256 supply). */
function eventData(name: string, symbol: string, decimals: number, supply: bigint): string {
  const a = str(name);
  const b = str(symbol);
  const offName = 4 * 32;
  const offSymbol = offName + a.length / 2;
  return '0x' + w(offName) + w(offSymbol) + w(decimals) + w(supply) + a + b;
}
const addrTopic = (a: string): string => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const TOKEN = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const log = (over: Record<string, unknown> = {}) => ({
  address: EVM_FACTORIES.bnb,
  topics: [TOKEN_CREATED_TOPIC, addrTopic(TOKEN), addrTopic(CREATOR)],
  data: eventData('Green Coin', 'GRN', 18, 1_000_000n * 10n ** 18n),
  blockNumber: '0x64',
  transactionHash: '0x' + 'ab'.repeat(32),
  logIndex: '0x3',
  ...over,
});

describe('TokenCreated decoding', () => {
  it('uses the same event topic as the Launch page', () => {
    expect(TOKEN_CREATED_TOPIC).toBe(PAGE_TOPIC);
  });

  it('reads a factory log into a record', () => {
    const d = decodeTokenCreated('bnb', log());
    expect(d).toMatchObject({ chain: 'bnb', address: TOKEN, creator: CREATOR, name: 'Green Coin', symbol: 'GRN', decimals: 18, supply: (10n ** 24n).toString(), blockNumber: 100, logIndex: 3, source: 'factory', createdAt: null });
    expect(d?.tx).toBe('0x' + 'ab'.repeat(32));
  });

  it('reads names that are not plain ASCII, and cuts and cleans what the chain gives', () => {
    expect(decodeTokenCreated('bnb', log({ data: eventData('Café Ünï', '€€', 6, 5n) }))).toMatchObject({ name: 'Café Ünï', symbol: '€€', decimals: 6 });
    expect(decodeTokenCreated('bnb', log({ data: eventData('A\u0000B‮C', 'x'.repeat(100), 0, 1n) }))).toMatchObject({ name: 'ABC', symbol: 'x'.repeat(32) });
  });

  it('refuses a log from any other contract, or another chain\'s factory', () => {
    expect(decodeTokenCreated('bnb', log({ address: '0x3333333333333333333333333333333333333333' }))).toBeNull();
    expect(decodeTokenCreated('bnb', log({ address: EVM_FACTORIES.ethereum }))).toBeNull();
    expect(decodeTokenCreated('ethereum', log({ address: EVM_FACTORIES.ethereum.toUpperCase().replace('0X', '0x') }))).not.toBeNull();
  });

  it('refuses other events, wrong topic counts and addresses that are not addresses', () => {
    expect(decodeTokenCreated('bnb', log({ topics: ['0x' + '00'.repeat(32), addrTopic(TOKEN), addrTopic(CREATOR)] }))).toBeNull();
    expect(decodeTokenCreated('bnb', log({ topics: [TOKEN_CREATED_TOPIC, addrTopic(TOKEN)] }))).toBeNull();
    expect(decodeTokenCreated('bnb', log({ topics: [TOKEN_CREATED_TOPIC, '0x' + 'ff'.repeat(32), addrTopic(CREATOR)] }))).toBeNull();
  });

  it('refuses data that does not decode', () => {
    expect(decodeTokenCreated('bnb', log({ data: '0x' }))).toBeNull();
    expect(decodeTokenCreated('bnb', log({ data: 'nonsense' }))).toBeNull();
    // decimals above 255
    expect(decodeTokenCreated('bnb', log({ data: '0x' + w(128) + w(192) + w(300) + w(1) }))).toBeNull();
    // an offset that points past the data
    expect(decodeTokenCreated('bnb', log({ data: '0x' + w(9999) + w(9999) + w(18) + w(1) }))).toBeNull();
    // a string far longer than anything real
    expect(decodeTokenCreated('bnb', log({ data: '0x' + w(128) + w(192) + w(18) + w(1) + w(100000) }))).toBeNull();
    expect(decodeTokenCreated('bnb', log({ blockNumber: undefined }))).toBeNull();
  });

  it('decodes the string a name() call returns', () => {
    expect(decodeStringReturn('0x' + w(32) + str('Hello'))).toBe('Hello');
    expect(decodeStringReturn('0x')).toBeNull();
    expect(decodeStringReturn(5)).toBeNull();
  });
});

describe('CREATE addresses', () => {
  it('matches the address maths the curve page already uses (including nonces past 127)', () => {
    for (const n of [1n, 2n, 127n, 128n, 255n, 256n, 70000n]) expect(createAddress(EVM_FACTORIES.polygon, n)).toBe(pageCreateAddress(EVM_FACTORIES.polygon, n));
  });
  it('gives the well known first contract of a deployer', () => {
    // 0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0 is the address of the first contract created by 0xcd...? Use Ethereum's documented example instead:
    expect(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 0n)).toBe('0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d');
    expect(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 1n)).toBe('0x343c43a37d37dff08ae8c4a11544c718abb4fcf8');
  });
});

// ---------------------------------------------------------------- EVM cursor

describe('EVM block windows', () => {
  it('starts a bounded look-back on the first run', () => {
    expect(evmWindow(null, 10_000, 3, 2000, 1000)).toEqual({ from: 9997 - 1000, to: 9997 });
  });
  it('continues right after the stored block, in steps', () => {
    expect(evmWindow('5000', 20_000, 3, 2000, 1000)).toEqual({ from: 5001, to: 7000 });
    expect(evmWindow('7000', 20_000, 3, 2000, 1000)).toEqual({ from: 7001, to: 9000 });
  });
  it('stops at the confirmed head', () => {
    expect(evmWindow('9997', 10_000, 3, 2000, 1000)).toBeNull();
    expect(evmWindow('9990', 10_000, 3, 2000, 1000)).toEqual({ from: 9991, to: 9997 });
  });
  it('does not trust a stored block ahead of the chain or text that is not a number', () => {
    expect(evmWindow('99999999', 10_000, 3, 2000, 1000)).toEqual({ from: 9997 - 1000, to: 9997 });
    expect(evmWindow('abc', 10_000, 3, 2000, 1000)?.from).toBe(9997 - 1000);
  });
  it('handles a chain with fewer blocks than the confirmations', () => {
    expect(evmWindow(null, 2, 3, 2000, 1000)).toBeNull();
  });
});

// ---------------------------------------------------------------- Solana acceptance

const PAYER = 'PayerPayerPayerPayerPayerPayerPayerPayer111';
const MINT = 'MintMintMintMintMintMintMintMintMintMint11';
const SIG = '5'.repeat(88);
const transfer = (over: Record<string, unknown> = {}) => ({ programId: '11111111111111111111111111111111', program: 'system', parsed: { type: 'transfer', info: { source: PAYER, destination: SOLANA_FEE_WALLET, lamports: 50_000_000, ...over } } });
const createAccount = (over: Record<string, unknown> = {}) => ({ programId: '11111111111111111111111111111111', program: 'system', parsed: { type: 'createAccount', info: { source: PAYER, newAccount: MINT, owner: TOKEN_2022_PROGRAM, lamports: 2_000_000, space: 234, ...over } } });
const initMint = (over: Record<string, unknown> = {}, type = 'initializeMint') => ({ programId: TOKEN_2022_PROGRAM, program: 'spl-token', parsed: { type, info: { mint: MINT, decimals: 9, mintAuthority: PAYER, ...over } } });
const tx = (instructions: unknown[], over: Partial<ParsedTx> = {}): ParsedTx => ({
  blockTime: 1_760_000_000,
  meta: { err: null },
  transaction: { signatures: [SIG], message: { accountKeys: [{ pubkey: PAYER, signer: true }, { pubkey: MINT, signer: true }, { pubkey: SOLANA_FEE_WALLET, signer: false }], instructions: instructions as never } },
  ...over,
});
const good = (): ParsedTx => tx([transfer(), createAccount(), initMint()]);

describe('Solana acceptance rules', () => {
  it('accepts a fee payment plus a Token-2022 mint created in the same transaction, and returns the mint and the payer', () => {
    expect(acceptSolanaLaunch(good(), SIG)).toEqual({ mint: MINT, creator: PAYER, signature: SIG, blockTime: 1_760_000_000, decimals: 9 });
  });
  it('accepts InitializeMint2 and a fee amount sent as a string', () => {
    expect(acceptSolanaLaunch(tx([transfer({ lamports: '50000000' }), createAccount(), initMint({}, 'initializeMint2')]), SIG)?.mint).toBe(MINT);
  });
  it('refuses a fee that is not exactly 0.05 SOL', () => {
    for (const lamports of [49_999_999, 50_000_001, 0, 100_000_000, 'abc', null]) expect(acceptSolanaLaunch(tx([transfer({ lamports }), createAccount(), initMint()]), SIG)).toBeNull();
  });
  it('refuses a transfer to anyone but the fee wallet', () => {
    expect(acceptSolanaLaunch(tx([transfer({ destination: PAYER }), createAccount(), initMint()]), SIG)).toBeNull();
  });
  it('refuses a fee paid from an account that did not sign', () => {
    expect(acceptSolanaLaunch(tx([transfer({ source: 'SomeoneElseSomeoneElseSomeoneElse1111111' }), createAccount(), initMint()]), SIG)).toBeNull();
  });
  it('refuses a fee payment with no new mint', () => {
    expect(acceptSolanaLaunch(tx([transfer()]), SIG)).toBeNull();
  });
  it('refuses a new mint with no fee payment', () => {
    expect(acceptSolanaLaunch(tx([createAccount(), initMint()]), SIG)).toBeNull();
  });
  it('refuses a mint that this transaction did not create (an existing mint initialised again, or one made by another program)', () => {
    expect(acceptSolanaLaunch(tx([transfer(), initMint()]), SIG)).toBeNull();
    expect(acceptSolanaLaunch(tx([transfer(), createAccount({ owner: '11111111111111111111111111111111' }), initMint()]), SIG)).toBeNull();
    expect(acceptSolanaLaunch(tx([transfer(), createAccount({ newAccount: 'anotherAccountanotherAccountanother111' }), initMint()]), SIG)).toBeNull();
  });
  it('refuses the classic Token program\'s mint: only Token-2022 counts', () => {
    expect(acceptSolanaLaunch(tx([transfer(), createAccount(), { ...initMint(), programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }]), SIG)).toBeNull();
  });
  it('refuses a transaction that made more than one mint, and one that failed', () => {
    const other = 'another1another1another1another1another1'.slice(0, 40);
    expect(acceptSolanaLaunch(tx([transfer(), createAccount(), initMint(), createAccount({ newAccount: other }), initMint({ mint: other })]), SIG)).toBeNull();
    expect(acceptSolanaLaunch(tx([transfer(), createAccount(), initMint()], { meta: { err: { InstructionError: [2, 'Custom'] } } }), SIG)).toBeNull();
  });
  it('ignores instructions hidden in a nested position: only top-level ones count', () => {
    const t = tx([createAccount(), initMint()]);
    (t.meta as Record<string, unknown>).innerInstructions = [{ index: 0, instructions: [transfer()] }];
    expect(acceptSolanaLaunch(t, SIG)).toBeNull();
  });
  it('refuses missing or malformed data without throwing', () => {
    for (const bad of [null, undefined, {}, { meta: null }, { meta: { err: null } }, { meta: { err: null }, transaction: { message: { accountKeys: [], instructions: [] } } }]) expect(acceptSolanaLaunch(bad as never, SIG)).toBeNull();
  });
  it('does not read a name from the transaction: nothing but addresses, the creator and the time come out', () => {
    expect(Object.keys(acceptSolanaLaunch(good(), SIG)!).sort()).toEqual(['blockTime', 'creator', 'decimals', 'mint', 'signature']);
  });
});

// ---------------------------------------------------------------- Solana cursor

const sig = (c: string): string => c.repeat(88);
const page = (...cs: string[]) => cs.map((c) => ({ signature: sig(c) }));

describe('Solana cursor', () => {
  it('survives a round trip and ignores damage', () => {
    const s = { head: sig('2'), tail: sig('3'), done: true, fwd: { newest: sig('4'), before: sig('5') } };
    expect(parseSolanaState(serializeSolanaState(s))).toEqual(s);
    expect(parseSolanaState(null)).toEqual({ head: null, tail: null, done: false, fwd: null });
    expect(parseSolanaState('{not json')).toEqual({ head: null, tail: null, done: false, fwd: null });
    expect(parseSolanaState(JSON.stringify({ head: 'x', tail: 12, done: 'yes' }))).toEqual({ head: null, tail: null, done: false, fwd: null });
  });

  it('starts with the backwards read at the newest signature, then walks back a page at a time until a short page', () => {
    let s = parseSolanaState(null);
    expect(planForward(s)).toBeNull();
    expect(planBackfill(s)).toEqual({});
    s = applyBackfill(s, page('a', 'b', 'c'), 3);
    expect(s).toMatchObject({ head: sig('a'), tail: sig('c'), done: false });
    expect(planBackfill(s)).toEqual({ before: sig('c') });
    s = applyBackfill(s, page('d', 'e'), 3);
    expect(s).toMatchObject({ head: sig('a'), tail: sig('e'), done: true });
    expect(planBackfill(s)).toBeNull();
  });

  it('an empty wallet stays ready and finishes', () => {
    const s = applyBackfill(parseSolanaState(null), [], 100);
    expect(s).toEqual({ head: null, tail: null, done: true, fwd: null });
  });

  it('reads new activity up to the head and moves the head only when it has reached it', () => {
    let s: SolanaState = { head: sig('a'), tail: sig('z'), done: true, fwd: null };
    expect(planForward(s)).toEqual({ until: sig('a') });
    // a full page: more may sit between this page and the head
    s = applyForward(s, page('h', 'g', 'f'), 3);
    expect(s.head).toBe(sig('a'));
    expect(s.fwd).toEqual({ newest: sig('h'), before: sig('f') });
    expect(planForward(s)).toEqual({ before: sig('f'), until: sig('a') });
    // a short page: the head catches up to the newest ever seen in this pass
    s = applyForward(s, page('e', 'd'), 3);
    expect(s.head).toBe(sig('h'));
    expect(s.fwd).toBeNull();
  });

  it('no new signatures leaves the head alone', () => {
    const s = { head: sig('a'), tail: sig('z'), done: true, fwd: null };
    expect(applyForward(s, [], 100)).toEqual(s);
  });
});

// ---------------------------------------------------------------- filter and sort

const row = (over: Partial<LaunchView>): LaunchView => ({
  chain: 'solana', address: 'AddrAddrAddrAddrAddrAddrAddrAddrAddrAddr1', name: 'Token', symbol: 'TKN', decimals: 9, supply: '1', creator: null, createdAt: 1000, tx: null,
  priceUsd: null, change24h: null, volume24hUsd: null, liquidityUsd: null, capUsd: null, capKind: null, pool: null, curve: null, market: 'none', curveRead: true, ...over,
});
const rows: LaunchView[] = [
  row({ symbol: 'AAA', name: 'Alpha Green', address: 'A1', createdAt: 3000, volume24hUsd: 100, priceUsd: 0.5, change24h: -4, pool: { dex: 'raydium', address: 'p1', url: 'https://x' }, liquidityUsd: 900, chain: 'solana', market: 'ok' }),
  row({ symbol: 'BBB', name: 'Beta', address: '0xBBB0000000000000000000000000000000000001', createdAt: 5000, chain: 'bnb', curve: { status: 'trading', progressPct: 40 } }),
  row({ symbol: 'CCC', name: 'Gamma', address: '0xccc0000000000000000000000000000000000002', createdAt: null, chain: 'ethereum', volume24hUsd: 900, priceUsd: 2, change24h: 12, curve: { status: 'migrated', progressPct: 100 }, creator: '0xcreator' }),
  row({ symbol: 'DDD', name: 'Delta', address: '0xddd0000000000000000000000000000000000003', createdAt: 4000, chain: 'polygon', volume24hUsd: 5, curve: { status: 'soldOut', progressPct: 100 } }),
];

describe('filtering', () => {
  const f = (over: Partial<{ tab: 'new' | 'trending' | 'curve' | 'pool'; chain: '' | 'solana' | 'bnb' | 'ethereum' | 'polygon'; query: string }> = {}) => filterLaunches(rows, { tab: 'new', chain: '', query: '', ...over }).map((r) => r.symbol);
  it('shows everything on New and Trending', () => {
    expect(f()).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    expect(f({ tab: 'trending' })).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
  });
  it('On a curve keeps tokens still sold on a curve (trading or full), not ones that left it', () => {
    expect(f({ tab: 'curve' })).toEqual(['BBB', 'DDD']);
  });
  it('On a pool keeps tokens with a pool', () => {
    expect(f({ tab: 'pool' })).toEqual(['AAA']);
  });
  it('filters by chain', () => {
    expect(f({ chain: 'bnb' })).toEqual(['BBB']);
    expect(f({ chain: 'solana', tab: 'curve' })).toEqual([]);
  });
  it('searches name, symbol and address without regard to case, and an exact creator', () => {
    expect(f({ query: 'green' })).toEqual(['AAA']);
    expect(f({ query: ' ddd ' })).toEqual(['DDD']);
    expect(f({ query: '0XBBB0000000000000000000000000000000000001' })).toEqual(['BBB']);
    expect(f({ query: '0xcreator' })).toEqual(['CCC']);
    expect(f({ query: 'nothing here' })).toEqual([]);
  });
});

describe('sorting', () => {
  const s = (key: Parameters<typeof sortLaunches>[1], dir: 'asc' | 'desc') => sortLaunches(rows, key, dir).map((r) => r.symbol);
  it('sorts by age, newest first, with unknown ages last either way', () => {
    expect(s('age', 'desc')).toEqual(['BBB', 'DDD', 'AAA', 'CCC']);
    expect(s('age', 'asc')).toEqual(['AAA', 'DDD', 'BBB', 'CCC']);
  });
  it('sorts by volume with missing values last either way', () => {
    expect(s('volume', 'desc')).toEqual(['CCC', 'AAA', 'DDD', 'BBB']);
    expect(s('volume', 'asc')).toEqual(['DDD', 'AAA', 'CCC', 'BBB']);
  });
  it('sorts price and change, keeping order among equals', () => {
    expect(s('price', 'desc')).toEqual(['CCC', 'AAA', 'BBB', 'DDD']);
    expect(s('change', 'asc')).toEqual(['AAA', 'CCC', 'BBB', 'DDD']);
  });
  it('sorts liquidity by pool liquidity, falling back to curve progress', () => {
    expect(s('liquidity', 'desc')).toEqual(['AAA', 'CCC', 'DDD', 'BBB']);
  });
  it('does not change the list it was given', () => {
    const before = rows.map((r) => r.symbol);
    sortLaunches(rows, 'volume', 'desc');
    expect(rows.map((r) => r.symbol)).toEqual(before);
  });
  it('Trending defaults to volume and the others to newest', () => {
    expect(defaultSort('trending')).toEqual({ key: 'volume', dir: 'desc' });
    expect(defaultSort('new')).toEqual({ key: 'age', dir: 'desc' });
    expect(viewLaunches(rows, { tab: 'trending', chain: '', query: '' }, null).map((r) => r.symbol)).toEqual(['CCC', 'AAA', 'DDD', 'BBB']);
    expect(viewLaunches(rows, { tab: 'trending', chain: '', query: '' }, { key: 'age', dir: 'asc' }).map((r) => r.symbol)[0]).toBe('AAA');
  });
});

describe('token page links', () => {
  it('uses the public token page scheme, lower-casing EVM addresses and keeping Solana ones exact', () => {
    expect(tokenPageUrl('bnb', '0xABCDEF0000000000000000000000000000000001')).toBe('https://aretiafinance.org/token#/bnb/0xabcdef0000000000000000000000000000000001');
    expect(tokenPageUrl('solana', 'AbCdEfGh')).toBe('https://aretiafinance.org/token#/solana/AbCdEfGh');
  });
});
