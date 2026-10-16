import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import mints from './__fixtures__/launchMints.json';
import { configToJson, distributionOf, type LaunchConfig } from './walletLaunchCore';
import {
  assessPending,
  clearPending,
  compareBalances,
  compareMint,
  loadPending,
  parseMintAccount,
  readBalances,
  savePending,
  type MintFacts,
  type PendingCreation,
} from './walletLaunchChain';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress } from './walletTools';

const PAYER = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const TREASURY = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const config = (over: Partial<LaunchConfig> = {}): LaunchConfig => ({
  creator: PAYER,
  name: 'Aretia Test Token',
  symbol: 'ATEST',
  decimals: 6,
  totalSupplyRaw: 1_000_000_000n * 10n ** 6n,
  creatorBps: 1000,
  treasury: { address: TREASURY, bps: 500 },
  reservedBps: 8500,
  metadataUri: 'https://example.com/m.json',
  metadataMutable: false,
  ...over,
});
/** Real Token-2022 mint accounts written by the official client, stored as 32-byte hex rows. */
const bytes = (rows: string[]) => Uint8Array.from(Buffer.from(rows.join(''), 'hex'));
const real = mints as Record<string, string[]>;
const parse = (rows: string[], owner = TOKEN_2022_PROGRAM_ID) => parseMintAccount(web3, owner, bytes(rows));

describe('parseMintAccount reads real Token-2022 accounts, as written by the official client', () => {
  it('a finished token', () => {
    expect(parse(real.final!)).toMatchObject({
      decimals: 6,
      supply: 1_000_000_000_000_000n,
      mintAuthority: null,
      freezeAuthority: null,
      extensions: [18, 19],
      metadataPointer: { authority: null, address: MINT },
      metadata: { updateAuthority: null, mint: MINT, name: 'Aretia Test Token', symbol: 'ATEST', uri: 'https://example.com/m.json', additionalFields: 0 },
    });
  });
  it('a token after the first transaction', () => {
    expect(parse(real.afterStep1!)).toMatchObject({ supply: 0n, mintAuthority: PAYER, freezeAuthority: null });
  });
  it('a token that keeps its powers', () => {
    expect(parse(real.mutable!)).toMatchObject({ supply: 5n, mintAuthority: PAYER, freezeAuthority: PAYER, metadata: { updateAuthority: PAYER, uri: '' } });
  });
});

describe('parseMintAccount refuses what it cannot describe exactly', () => {
  const good = bytes(real.final!);
  it('other programs, uninitialised or short data', () => {
    expect(parseMintAccount(web3, TOKEN_PROGRAM_ID, good)).toBeNull();
    expect(parseMintAccount(web3, TOKEN_2022_PROGRAM_ID, good.subarray(0, 60))).toBeNull();
    const u = Uint8Array.from(good);
    u[45] = 0;
    expect(parseMintAccount(web3, TOKEN_2022_PROGRAM_ID, u)).toBeNull();
  });
  it('a wrong account type, a bad authority flag, a truncated extension, invalid text', () => {
    const t = Uint8Array.from(good);
    t[165] = 2;
    expect(parseMintAccount(web3, TOKEN_2022_PROGRAM_ID, t)).toBeNull();
    const f = Uint8Array.from(good);
    f[0] = 7;
    expect(parseMintAccount(web3, TOKEN_2022_PROGRAM_ID, f)).toBeNull();
    expect(parseMintAccount(web3, TOKEN_2022_PROGRAM_ID, good.subarray(0, 300))).toBeNull();
    const bad = Uint8Array.from(good);
    // corrupt the first byte of the name into an invalid UTF-8 start byte
    const nameAt = 166 + 68 + 4 + 64 + 4;
    bad[nameAt] = 0xff;
    expect(parseMintAccount(web3, TOKEN_2022_PROGRAM_ID, bad)).toBeNull();
  });
});

const facts = (rows: string[]) => parse(rows) as MintFacts;

describe('compareMint', () => {
  it('accepts the finished token that was approved, and the half-finished one', () => {
    expect(compareMint(facts(real.final!), config(), MINT, 'complete')).toEqual([]);
    expect(compareMint(facts(real.afterStep1!), config(), MINT, 'created')).toEqual([]);
  });
  it('reports each way the chain can differ from the approval', () => {
    const f = facts(real.final!);
    expect(compareMint({ ...f, decimals: 9 }, config(), MINT, 'complete').join(' ')).toMatch(/Decimals/);
    expect(compareMint({ ...f, supply: f.supply + 1n }, config(), MINT, 'complete').join(' ')).toMatch(/Supply/);
    expect(compareMint({ ...f, mintAuthority: PAYER }, config(), MINT, 'complete').join(' ')).toMatch(/create more/);
    expect(compareMint({ ...f, freezeAuthority: PAYER }, config(), MINT, 'complete').join(' ')).toMatch(/freeze/);
    expect(compareMint({ ...f, extensions: [18, 19, 1] }, config(), MINT, 'complete').join(' ')).toMatch(/extensions that were not approved/);
    expect(compareMint({ ...f, metadata: { ...f.metadata!, name: 'Other' } }, config(), MINT, 'complete').join(' ')).toMatch(/Name/);
    expect(compareMint({ ...f, metadata: { ...f.metadata!, updateAuthority: PAYER } }, config(), MINT, 'complete').join(' ')).toMatch(/Someone can change/);
    expect(compareMint({ ...f, metadata: { ...f.metadata!, additionalFields: 2 } }, config(), MINT, 'complete').join(' ')).toMatch(/Extra metadata/);
    expect(compareMint({ ...f, metadataPointer: null }, config(), MINT, 'complete').join(' ')).toMatch(/metadata link/);
    expect(compareMint({ ...f, metadata: null }, config(), MINT, 'complete').join(' ')).toMatch(/No name/);
    expect(compareMint(f, config(), 'GBSXCpRGXLhbmmjUz2cpFYwUzHdxBdDQRxsoTuazW8gP', 'complete').length).toBeGreaterThan(0);
  });
  it('wants the supply to be zero and the authority to be the creator after the first transaction', () => {
    const f = facts(real.afterStep1!);
    expect(compareMint({ ...f, supply: 1n }, config(), MINT, 'created').join(' ')).toMatch(/Supply/);
    expect(compareMint({ ...f, mintAuthority: null }, config(), MINT, 'created').join(' ')).toMatch(/not the creator/);
  });
  it('treats changeable metadata as approved only when the creator was approved to change it', () => {
    const m = facts(real.mutable!);
    const diffs = compareMint({ ...m, supply: 0n, freezeAuthority: null }, config({ metadataMutable: true, metadataUri: '' }), MINT, 'created');
    expect(diffs).toEqual([]);
  });
});

describe('compareBalances / readBalances', () => {
  const c = config();
  const holds = (amounts: (bigint | null)[]) => {
    const m = new Map<string, bigint | null>();
    distributionOf(c).forEach((l, i) => m.set(ataAddress(web3, l.owner, MINT, TOKEN_2022_PROGRAM_ID), amounts[i]!));
    return m;
  };
  it('match when every wallet holds exactly its share', () => {
    expect(compareBalances(web3, c, MINT, holds(distributionOf(c).map((l) => l.amount)))).toEqual([]);
  });
  it('report a missing account and a different amount', () => {
    const d = distributionOf(c);
    expect(compareBalances(web3, c, MINT, holds([null, d[1]!.amount])).join(' ')).toMatch(/no token account/);
    expect(compareBalances(web3, c, MINT, holds([d[0]!.amount + 1n, d[1]!.amount])).join(' ')).toMatch(/approved/);
  });
  it('are read from the token accounts of each wallet', async () => {
    const d = distributionOf(c);
    const accounts = new Map<string, { owner: string; data: Uint8Array }>();
    d.forEach((l) => {
      const data = new Uint8Array(170);
      new DataView(data.buffer).setBigUint64(64, l.amount, true);
      data[108] = 1;
      accounts.set(ataAddress(web3, l.owner, MINT, TOKEN_2022_PROGRAM_ID), { owner: TOKEN_2022_PROGRAM_ID, data });
    });
    const held = await readBalances(web3, async (a) => accounts.get(a) ?? null, c, MINT);
    expect(compareBalances(web3, c, MINT, held)).toEqual([]);
    // an account owned by another program is not a token account of this token
    const wrong = await readBalances(web3, async (a) => ({ owner: TOKEN_PROGRAM_ID, data: accounts.get(a)!.data }), c, MINT);
    expect(compareBalances(web3, c, MINT, wrong).length).toBe(2);
  });
});

describe('a creation in progress', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
  };
  const pending = (over: Partial<PendingCreation> = {}): PendingCreation => ({ mint: MINT, config: config(), stage: 'created', step1: 'sig1', step2: null, at: 1_000, ...over });

  it('is stored per wallet and read back exactly', () => {
    const s = memory();
    savePending(s, pending());
    expect(loadPending(s, PAYER)).toEqual(pending());
    expect(loadPending(s, TREASURY)).toBeNull();
    clearPending(s, PAYER);
    expect(loadPending(s, PAYER)).toBeNull();
  });
  it('is ignored if what is stored was tampered with or belongs to another wallet', () => {
    const s = memory();
    savePending(s, pending());
    const raw = JSON.parse(s.raw.get('aretia-launch-pending-v1')!);
    raw[PAYER].config.creatorBps = 5000; // shares no longer add up
    s.raw.set('aretia-launch-pending-v1', JSON.stringify(raw));
    expect(loadPending(s, PAYER)).toBeNull();
    s.raw.set('aretia-launch-pending-v1', '{"x":');
    expect(loadPending(s, PAYER)).toBeNull();
    const other = memory();
    other.raw.set('aretia-launch-pending-v1', JSON.stringify({ [TREASURY]: { mint: MINT, config: configToJson(config()), stage: 'created', step1: null, step2: null, at: 1 } }));
    expect(loadPending(other, TREASURY)).toBeNull(); // stored under a wallet that is not the config's creator
  });
  it('survives storage that refuses writes', () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error('full'); } };
    expect(() => savePending(refusing, pending())).not.toThrow();
    expect(() => clearPending(refusing, PAYER)).not.toThrow();
  });

  it('says to finish only when the token has no supply and the creator holds the authority', () => {
    expect(assessPending(pending(), facts(real.afterStep1!)).action).toBe('finish');
  });
  it('says to just verify when the supply exists and the authority is gone', () => {
    expect(assessPending(pending({ stage: 'minted' }), facts(real.final!)).action).toBe('verify');
  });
  it('says nothing was created when the token is not on chain', () => {
    expect(assessPending(pending({ stage: 'started' }), null).action).toBe('none');
  });
  it('refuses to touch any other state, so it can never mint twice', () => {
    const f = facts(real.afterStep1!);
    expect(assessPending(pending(), { ...f, supply: 1n }).action).toBe('stop');
    expect(assessPending(pending(), { ...f, mintAuthority: TREASURY }).action).toBe('stop');
    expect(assessPending(pending(), facts(real.mutable!)).action).toBe('stop');
  });
  it('refuses to finish a token whose stored details differ from what was approved', () => {
    const f = facts(real.afterStep1!);
    const r = assessPending(pending(), { ...f, metadata: { ...f.metadata!, name: 'Switched' } });
    expect(r.action).toBe('stop');
    expect(r.reason).toMatch(/differs/);
  });
});
