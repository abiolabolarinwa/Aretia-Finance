import * as web3 from '@solana/web3.js';
import * as sdk from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import mints from './__fixtures__/launchMints.json';
import {
  DEFAULT_POOL_FORM,
  NATIVE_MINT_2022,
  POOL_FEE_ADDRESS,
  POOL_FEE_LAMPORTS,
  SOL_QUOTE,
  USDC_DECIMALS,
  USDC_MINT,
  WSOL_MINT,
  poolDisclosures,
  quoteBlockers,
  validatePool,
  type PoolConfig,
  type PoolQuote,
  type PoolToken,
  type QuoteRead,
} from './walletPoolCore';
import { PoolFlow, type PoolFlowDeps } from './walletPoolFlow';
import { assemblePool, buildPool, expectedSqrtPrice, inspectPool, poolMath, tokenBadge, type PoolLibs } from './walletPoolTx';
import { meteoraPoolAddress } from './walletCurveTx';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress } from './walletTools';

const CREATOR = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const OTHER = '3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg';
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const CUSTOM = '4Nd1mBQtrMJVYVfKGkqmKMo8WhEKUuf3fEdSm7X1E6SG';
const NFT = web3.Keypair.generate().publicKey.toBase58();
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
const libs: PoolLibs = { sdk, BN, cpAmm: new sdk.CpAmm(new web3.Connection('http://127.0.0.1:1')) };

const USDC: PoolQuote = { mint: USDC_MINT, decimals: USDC_DECIMALS, symbol: 'USDC', program: TOKEN_PROGRAM_ID, mintable: true, freezable: true };
const ODD: PoolQuote = { mint: CUSTOM, decimals: 8, symbol: '4Nd1…E6SG', program: TOKEN_PROGRAM_ID, mintable: false, freezable: false };
const ODD_2022: PoolQuote = { ...ODD, program: TOKEN_2022_PROGRAM_ID };

const config = (quote?: PoolQuote, over: Partial<PoolConfig> = {}): PoolConfig => ({
  creator: CREATOR,
  mint: MINT,
  decimals: 6,
  tokenAmountRaw: 900_000_000n * 10n ** 6n,
  price: '0.001',
  ...(quote ? { quote } : {}),
  tradingFeeBps: 25,
  lockLiquidity: true,
  ...over,
});

async function built(c: PoolConfig) {
  const b = await buildPool(web3, libs, c, NFT);
  const tx = assemblePool(web3, b.instructions, c.creator, BLOCKHASH, 1);
  return { b, tx, input: { config: c, nft: NFT, pool: b.pool, math: b.math } };
}
const other = new web3.PublicKey(OTHER);
const withKey = (ix: web3.TransactionInstruction, i: number, pubkey: web3.PublicKey) => {
  const keys = ix.keys.slice();
  keys[i] = { ...keys[i]!, pubkey };
  return new web3.TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
};

describe('the pool transaction against another pair token', () => {
  it('has no wrap and no sync step for USDC, and the inspector accepts it', async () => {
    const { b, tx, input } = await built(config(USDC));
    expect(b.instructions).toHaveLength(5);
    expect(inspectPool(web3, tx, input)).toEqual([]);
    // Nothing but the fee moves SOL.
    const transfers = tx.instructions.filter((i) => i.programId.toBase58() === web3.SystemProgram.programId.toBase58());
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.keys.map((k) => k.pubkey.toBase58())).toEqual([CREATOR, POOL_FEE_ADDRESS]);
    expect(POOL_FEE_LAMPORTS).toBe(50_000_000n);
  });
  it('is the same length without the lock, still checked', async () => {
    const { b, tx, input } = await built(config(USDC, { lockLiquidity: false }));
    expect(b.instructions).toHaveLength(4);
    expect(inspectPool(web3, tx, input)).toEqual([]);
  });
  it('keeps the SOL pool exactly as it was', async () => {
    const { b, tx, input } = await built(config());
    expect(b.instructions).toHaveLength(7);
    expect(inspectPool(web3, tx, input)).toEqual([]);
    expect(config().quote ?? SOL_QUOTE).toBe(SOL_QUOTE);
  });
  it('accepts a classic custom token and a Token-2022 one, each with its own program', async () => {
    for (const q of [ODD, ODD_2022]) {
      const { b, tx, input } = await built(config(q));
      expect(inspectPool(web3, tx, input)).toEqual([]);
      const init = b.instructions[3]!;
      expect(init.keys[8]!.pubkey.toBase58()).toBe(CUSTOM);
      expect(init.keys[14]!.pubkey.toBase58()).toBe(q.program);
      expect(init.keys[12]!.pubkey.toBase58()).toBe(ataAddress(web3, CREATOR, CUSTOM, q.program));
      expect(init.keys[20]!.pubkey.toBase58()).toBe(tokenBadge(web3, CUSTOM));
    }
  });
  it('puts the pool at the address its two tokens fix', async () => {
    const { b } = await built(config(USDC));
    expect(b.pool).toBe(meteoraPoolAddress(web3, MINT, USDC_MINT));
    expect(b.pool).not.toBe(meteoraPoolAddress(web3, MINT, WSOL_MINT));
  });
  it('works the starting price out in the pair token’s decimals', () => {
    // 0.001 USDC (6 decimals) per token of 6 decimals is 0.001 raw per raw; the same price in SOL (9 decimals) is 1000 times that.
    const usdc = expectedSqrtPrice('0.001', 6, 6)!;
    const sol = expectedSqrtPrice('0.001', 6, 9)!;
    expect(sol).toBeGreaterThan(usdc);
    const ratio = Number(sol) / Number(usdc);
    expect(ratio).toBeCloseTo(Math.sqrt(1000), 3);
    const m = poolMath(web3, libs, config(USDC));
    const diff = BigInt(m.minSqrtPrice.toString()) - usdc;
    expect(diff < 0n ? -diff : diff).toBeLessThanOrEqual(2n + usdc / 1_000_000_000_000n);
  });
  it('refuses a transaction that sends the tokens, the pair or the fee anywhere else', async () => {
    const x = await built(config(USDC));
    const run = (edit: (t: web3.Transaction) => void) => {
      const y = { ...x, tx: assemblePool(web3, x.b.instructions, CREATOR, BLOCKHASH, 1) };
      edit(y.tx);
      return inspectPool(web3, y.tx, x.input).join(' ');
    };
    expect(run((t) => void (t.instructions[3] = withKey(t.instructions[3]!, 12, other)))).toMatch(/other side source/);
    expect(run((t) => void (t.instructions[3] = withKey(t.instructions[3]!, 8, new web3.PublicKey(WSOL_MINT))))).toMatch(/other side of the pool/);
    expect(run((t) => void (t.instructions[2] = withKey(t.instructions[2]!, 2, other)))).toMatch(/USDC account would be created for an account other than yours/);
    expect(run((t) => void t.instructions.splice(2, 1))).toMatch(/not the expected set of steps/);
    expect(run((t) => void t.add(web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(CREATOR), toPubkey: other, lamports: 1 })))).toMatch(/not the expected set of steps/);
    // A SOL-shaped transaction does not pass for a USDC pool.
    const sol = await built(config());
    expect(inspectPool(web3, sol.tx, x.input).join(' ')).toMatch(/not the expected set of steps/);
  });
});

describe('quoteBlockers', () => {
  const read = (over: Partial<QuoteRead> = {}): QuoteRead => ({ mint: CUSTOM, program: TOKEN_PROGRAM_ID, decimals: 8, mintAuthority: null, freezeAuthority: null, extensions: [], ...over });
  it('needs a real read of anything but SOL', () => {
    expect(quoteBlockers(null, 'SOL', MINT)).toEqual([]);
    expect(quoteBlockers(null, 'USDC', MINT).join(' ')).toMatch(/could not be read/);
    expect(quoteBlockers(null, 'custom', MINT).join(' ')).toMatch(/could not be read/);
  });
  it('accepts USDC only as the network reports it', () => {
    expect(quoteBlockers(read({ mint: USDC_MINT, decimals: 6 }), 'USDC', MINT)).toEqual([]);
    expect(quoteBlockers(read({ mint: USDC_MINT, decimals: 9 }), 'USDC', MINT).join(' ')).toMatch(/not USDC/);
    expect(quoteBlockers(read({ mint: CUSTOM, decimals: 6 }), 'USDC', MINT).join(' ')).toMatch(/not USDC/);
  });
  it('refuses the token itself, wrapped SOL, other programs and odd decimals', () => {
    expect(quoteBlockers(read({ mint: MINT }), 'custom', MINT).join(' ')).toMatch(/the token itself/);
    expect(quoteBlockers(read({ mint: WSOL_MINT, decimals: 9 }), 'custom', MINT).join(' ')).toMatch(/choose SOL/);
    expect(quoteBlockers(read({ mint: NATIVE_MINT_2022, decimals: 9, program: TOKEN_2022_PROGRAM_ID }), 'custom', MINT).join(' ')).toMatch(/choose SOL/);
    expect(quoteBlockers(read({ program: OTHER }), 'custom', MINT).join(' ')).toMatch(/not a standard token/);
    expect(quoteBlockers(read({ decimals: 18 }), 'custom', MINT).join(' ')).toMatch(/decimals/);
  });
  it('allows a Token-2022 pair token with only the metadata extensions', () => {
    expect(quoteBlockers(read({ program: TOKEN_2022_PROGRAM_ID, extensions: [18, 19] }), 'custom', MINT)).toEqual([]);
    expect(quoteBlockers(read({ program: TOKEN_2022_PROGRAM_ID, extensions: [1] }), 'custom', MINT).join(' ')).toMatch(/transfer fee or a transfer hook/);
  });
});

describe('validatePool with a pair', () => {
  const token: PoolToken = { mint: MINT, decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, extensions: [18, 19], held: 10n ** 15n };
  const form = { ...DEFAULT_POOL_FORM, mint: MINT, tokenAmount: '500,000,000', price: '0.001' };
  const read: QuoteRead = { mint: CUSTOM, program: TOKEN_PROGRAM_ID, decimals: 8, mintAuthority: 'x', freezeAuthority: null, extensions: [] };

  it('is a SOL pool by default, with no quote written into the config', () => {
    const v = validatePool(form, CREATOR, token);
    expect(v.ok && v.config.quote).toBeUndefined();
  });
  it('turns a good USDC read into a USDC pool, always locked', () => {
    const v = validatePool({ ...form, quote: 'USDC' }, CREATOR, token, { ...read, mint: USDC_MINT, decimals: 6 });
    expect(v.ok && v.config.quote).toMatchObject({ mint: USDC_MINT, symbol: 'USDC', decimals: 6, program: TOKEN_PROGRAM_ID });
    expect(v.ok && v.config.lockLiquidity).toBe(true);
  });
  it('refuses a pair with no read, a bad address, or a read that says otherwise', () => {
    expect(validatePool({ ...form, quote: 'USDC' }, CREATOR, token, null).ok).toBe(false);
    const bad = validatePool({ ...form, quote: 'custom', quoteMint: 'nope' }, CREATOR, token, null);
    expect(bad.ok === false && bad.issues.map((i) => i.field)).toContain('quoteMint');
    const noRead = validatePool({ ...form, quote: 'custom', quoteMint: CUSTOM }, CREATOR, token, null);
    expect(noRead.ok === false && noRead.issues.map((i) => i.message).join(' ')).toMatch(/could not be read/);
    expect(validatePool({ ...form, quote: 'USDC' }, CREATOR, token, { ...read, decimals: 6 }).ok).toBe(false);
  });
  it('names the pair in the price message and the symbol of a custom token by its address', () => {
    const v = validatePool({ ...form, quote: 'custom', quoteMint: CUSTOM, price: 'x' }, CREATOR, token, read);
    expect(v.ok === false && v.issues.find((i) => i.field === 'price')?.message).toContain('4Nd1…E6SG');
  });
  it('says what the pair token’s issuer can do, and never that the pool is safe', () => {
    const text = poolDisclosures(config({ ...USDC })).map((d) => d.text).join(' ');
    expect(text).toMatch(/create more of it/);
    expect(text).toMatch(/freeze balances/);
    expect(text).toMatch(/locked for good/);
    expect(text).not.toMatch(/\bsafe\b|audited|guarantee/i);
    expect(poolDisclosures(config()).map((d) => d.text).join(' ')).not.toMatch(/other side of the pool is/);
  });
});

describe('PoolFlow.loadQuote', () => {
  const mintAccount = (decimals: number, opts: { mintAuth?: boolean; freezeAuth?: boolean; init?: number; length?: number } = {}): Uint8Array => {
    const d = new Uint8Array(opts.length ?? 82);
    const v = new DataView(d.buffer);
    if (opts.mintAuth) v.setUint32(0, 1, true);
    if (opts.freezeAuth) v.setUint32(46, 1, true);
    d[44] = decimals;
    d[45] = opts.init ?? 1;
    return d;
  };
  const flowWith = (accounts: Record<string, { owner: string; data: Uint8Array }>) =>
    new PoolFlow({ web3, libs, fetchAccount: async (a: string) => accounts[a] ?? null } as unknown as PoolFlowDeps);
  it('reads a classic mint’s decimals and powers', async () => {
    const f = flowWith({ [USDC_MINT]: { owner: TOKEN_PROGRAM_ID, data: mintAccount(6, { mintAuth: true, freezeAuth: true }) } });
    expect(await f.loadQuote(USDC_MINT)).toMatchObject({ mint: USDC_MINT, program: TOKEN_PROGRAM_ID, decimals: 6, extensions: [] });
    expect((await f.loadQuote(USDC_MINT))?.mintAuthority).not.toBeNull();
  });
  it('reads a mint without powers as having none', async () => {
    const f = flowWith({ [CUSTOM]: { owner: TOKEN_PROGRAM_ID, data: mintAccount(8) } });
    expect(await f.loadQuote(CUSTOM)).toMatchObject({ decimals: 8, mintAuthority: null, freezeAuthority: null });
  });
  it('reads a Token-2022 mint through the strict reader', async () => {
    const data = Uint8Array.from(Buffer.from((mints as Record<string, string[]>).final!.join(''), 'hex'));
    const f = flowWith({ [CUSTOM]: { owner: TOKEN_2022_PROGRAM_ID, data } });
    const q = await f.loadQuote(CUSTOM);
    expect(q).toMatchObject({ program: TOKEN_2022_PROGRAM_ID });
    expect(q?.extensions.every((e) => e === 18 || e === 19)).toBe(true);
  });
  it('refuses a missing account, a wrong owner, an uninitialised or oddly sized mint', async () => {
    const f = flowWith({
      a: { owner: OTHER, data: mintAccount(6) },
      b: { owner: TOKEN_PROGRAM_ID, data: mintAccount(6, { init: 0 }) },
      c: { owner: TOKEN_PROGRAM_ID, data: mintAccount(6, { length: 165 }) },
      d: { owner: TOKEN_PROGRAM_ID, data: (() => { const x = mintAccount(6); new DataView(x.buffer).setUint32(0, 7, true); return x; })() },
    });
    for (const k of ['missing', 'a', 'b', 'c', 'd']) expect(await f.loadQuote(k), k).toBeNull();
  });
});
