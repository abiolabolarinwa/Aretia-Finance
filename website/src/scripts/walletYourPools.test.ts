import * as web3 from '@solana/web3.js';
import * as sdk from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './walletTools';
import { SYSTEM_PROGRAM_ID } from './walletLaunchTx';
import type { PoolLibs } from './walletPoolTx';
import { amountText, claimableText, hasClaimable, lockText, NATIVE_MINT, pairName, sortPositions, type PoolPosition } from './walletYourPoolsCore';
import { assembleClaim, buildClaim, inspectClaim } from './walletYourPoolsTx';

const libs: PoolLibs = { sdk, BN, cpAmm: new sdk.CpAmm(new web3.Connection('http://127.0.0.1:1')) };
const pk = (): string => web3.Keypair.generate().publicKey.toBase58();
const OWNER = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const OTHER = '3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg';
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';

const position = (over: Partial<PoolPosition> = {}): PoolPosition => ({
  pool: pk(),
  position: pk(),
  positionNft: pk(),
  positionNftAccount: pk(),
  a: { mint: pk(), program: TOKEN_2022_PROGRAM_ID, decimals: 6, symbol: 'ALC', vault: pk() },
  b: { mint: NATIVE_MINT, program: TOKEN_PROGRAM_ID, decimals: 9, symbol: 'SOL', vault: pk() },
  feeA: 1_500_000_000n,
  feeB: 12_531_773n,
  unlocked: 0n,
  locked: 1000n,
  vesting: 0n,
  ...over,
});

describe('how a position is described', () => {
  it('names the pair, the lock and the claimable fees in plain words', () => {
    const p = position();
    expect(pairName(p)).toBe('ALC / SOL');
    expect(lockText(p)).toBe('Locked for good');
    expect(lockText(position({ locked: 0n, unlocked: 5n }))).toMatch(/Not locked/);
    expect(lockText(position({ locked: 5n, unlocked: 5n }))).toBe('Partly locked');
    expect(lockText(position({ locked: 0n }))).toBe('Empty');
    expect(claimableText(p)).toBe('1,500 ALC and about 0.0125 SOL');
    expect(claimableText(position({ feeA: 0n, feeB: 0n }))).toBe('Nothing to claim yet');
    expect(hasClaimable(position({ feeA: 0n, feeB: 0n }))).toBe(false);
  });
  it('rounds amounts for people and never prints the raw digits', () => {
    expect(amountText(0n, 9)).toBe('0');
    expect(amountText(12_531_773_721n, 9)).toBe('about 12.5318');
    expect(amountText(1_000_000_000n, 9)).toBe('1');
    expect(amountText(1_234n, 9)).toBe('about 0.000001');
    expect(amountText(1n, 9)).toBe('under 0.000001');
    expect(amountText(1_234_567_890_123n, 9)).toBe('about 1,234.5679');
    expect(amountText(5_000_000n, 6)).toBe('5');
  });
  it('puts pools with something to claim first', () => {
    const none = position({ feeA: 0n, feeB: 0n });
    const some = position();
    expect(sortPositions([none, some])[0]).toBe(some);
  });
});

async function built(p = position()) {
  const ixs = await buildClaim(web3, libs, OWNER, p);
  return { p, tx: assembleClaim(web3, ixs, OWNER, BLOCKHASH, 1) };
}
const issues = (tx: web3.Transaction, p: PoolPosition): string => inspectClaim(web3, tx, OWNER, p).join(' ');
const withKey = (ix: web3.TransactionInstruction, i: number, address: string): web3.TransactionInstruction => {
  const keys = ix.keys.slice();
  keys[i] = { ...keys[i]!, pubkey: new web3.PublicKey(address) };
  return new web3.TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
};
const at = (tx: web3.Transaction, program: string): number => tx.instructions.findIndex((i) => i.programId.toBase58() === program);
const CLAIM_PROGRAM = sdk.CP_AMM_PROGRAM_ID.toBase58();

describe('the claim transaction', () => {
  it('is built by the SDK, passes the inspector, and is signed only by the owner', async () => {
    const { tx, p } = await built();
    expect(issues(tx, p)).toBe('');
    const signers = new Set(tx.instructions.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
    expect([...signers]).toEqual([OWNER]);
    // Nothing in it sends SOL to Aretia or anyone else.
    expect(tx.instructions.some((i) => i.programId.toBase58() === SYSTEM_PROGRAM_ID)).toBe(false);
    expect(tx.instructions.filter((i) => i.programId.toBase58() === CLAIM_PROGRAM)).toHaveLength(1);
  });
  it('also passes when the owner already has the token accounts (the account steps are optional)', async () => {
    const { tx, p } = await built();
    tx.instructions = tx.instructions.filter((i) => i.programId.toBase58() !== 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(issues(tx, p)).toBe('');
  });
  it('refuses fees paid to an account that is not the owner’s, a different position or pool, or a different vault', async () => {
    const x = await built();
    const claim = at(x.tx, CLAIM_PROGRAM);
    for (const [i, what] of [[3, 'token a'], [4, 'token b'], [2, 'position'], [1, 'pool'], [5, 'vault a'], [9, 'nft account']] as const) {
      const t = (await built(x.p)).tx;
      t.instructions[claim] = withKey(t.instructions[claim]!, i, OTHER);
      expect(issues(t, x.p), what).toMatch(/other than the ones shown/);
    }
  });
  it('refuses an extra transfer, another program, a second claim, a missing claim, an extra signer, or a different fee payer', async () => {
    const x = await built();
    const theft = web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(OWNER), toPubkey: new web3.PublicKey(OTHER), lamports: 1_000_000 });
    const t1 = (await built(x.p)).tx;
    t1.add(theft);
    expect(issues(t1, x.p)).toMatch(/did not expect/);
    const t2 = (await built(x.p)).tx;
    t2.add(t2.instructions[at(t2, CLAIM_PROGRAM)]!);
    expect(issues(t2, x.p)).toMatch(/exactly one claim/);
    const t3 = (await built(x.p)).tx;
    t3.instructions = t3.instructions.filter((i) => i.programId.toBase58() !== CLAIM_PROGRAM);
    expect(issues(t3, x.p)).toMatch(/exactly one claim/);
    const t4 = (await built(x.p)).tx;
    t4.instructions[0]!.keys.push({ pubkey: new web3.PublicKey(OTHER), isSigner: true, isWritable: false });
    expect(issues(t4, x.p)).toMatch(/unexpected account would have to sign/);
    const t5 = (await built(x.p)).tx;
    t5.feePayer = new web3.PublicKey(OTHER);
    expect(issues(t5, x.p)).toMatch(/fee would be paid/);
  });
  it('refuses closing a wrapped-SOL account to anyone but the owner, and closing any other account', async () => {
    const x = await built();
    const closeAt = at(x.tx, TOKEN_PROGRAM_ID);
    expect(closeAt).toBeGreaterThan(-1);
    const toOther = (await built(x.p)).tx;
    toOther.instructions[closeAt] = withKey(toOther.instructions[closeAt]!, 1, OTHER);
    expect(issues(toOther, x.p)).toMatch(/not your wrapped-SOL account/);
    const wrong = (await built(x.p)).tx;
    wrong.instructions[closeAt] = withKey(wrong.instructions[closeAt]!, 0, OTHER);
    expect(issues(wrong, x.p)).toMatch(/not your wrapped-SOL account/);
  });
  it('refuses a token account step for someone else’s account', async () => {
    const x = await built();
    const t = (await built(x.p)).tx;
    const ata = at(t, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    t.instructions[ata] = withKey(t.instructions[ata]!, 2, OTHER);
    expect(issues(t, x.p)).toMatch(/not a token account for you/);
  });
});

// ---------------------------------------------------------------- reading from the chain, and the flow

import { MAX_POSITIONS, lookMint, positionFromChain } from './walletYourPoolsChain';
import { YourPoolsFlow, type ClaimProgress, type YourPoolsDeps } from './walletYourPoolsFlow';

describe('positionFromChain and lookMint', () => {
  it('joins a position with its two tokens, naming wrapped SOL as SOL', () => {
    const raw = { position: 'pos', positionNft: 'nft', positionNftAccount: 'acc', pool: 'pool', tokenAMint: 'A'.repeat(32), tokenBMint: NATIVE_MINT, tokenAVault: 'va', tokenBVault: 'vb', feeA: 5n, feeB: 6n, unlocked: 0n, locked: 9n, vesting: 0n };
    const p = positionFromChain(raw, { program: TOKEN_2022_PROGRAM_ID, decimals: 6, symbol: 'ALC' }, { program: TOKEN_PROGRAM_ID, decimals: 9, symbol: 'ignored' });
    expect(p.a).toMatchObject({ mint: 'A'.repeat(32), symbol: 'ALC', decimals: 6, vault: 'va' });
    expect(p.b).toMatchObject({ mint: NATIVE_MINT, symbol: 'SOL', decimals: 9, vault: 'vb' });
    expect(pairName(p)).toBe('ALC / SOL');
    expect(MAX_POSITIONS).toBe(50);
  });
  it('reads wrapped SOL without the network and a missing mint without crashing', async () => {
    const none = async () => null;
    expect(await lookMint(web3, none, NATIVE_MINT)).toEqual({ program: TOKEN_PROGRAM_ID, decimals: 9, symbol: 'SOL' });
    expect((await lookMint(web3, none, OTHER)).symbol).toBe(`${OTHER.slice(0, 4)}…${OTHER.slice(-4)}`);
  });
});

function world(start: PoolPosition[]) {
  let positions = start.map((p) => ({ ...p }));
  const sent: web3.Transaction[] = [];
  const script: { simulate?: { ok: boolean; error: string | null }; reject?: boolean; confirm?: 'confirmed' | 'failed' | 'pending'; stale?: boolean } = {};
  const deps: YourPoolsDeps = {
    web3,
    libs,
    readPositions: async () => ({ positions: positions.map((p) => ({ ...p })), truncated: false }),
    latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    simulate: async () => script.simulate ?? { ok: true, error: null },
    signAndSubmit: async (tx) => {
      if (script.reject) throw new Error('User rejected the request.');
      sent.push(tx);
      if (!script.stale) positions = positions.map((p) => ({ ...p, feeA: 0n, feeB: 0n }));
      return 'sig1';
    },
    confirm: async () => script.confirm ?? 'confirmed',
    sleep: async () => undefined,
  };
  return { flow: new YourPoolsFlow(deps), sent, script };
}

describe('YourPoolsFlow', () => {
  it('lists positions with something to claim first', async () => {
    const empty = position({ feeA: 0n, feeB: 0n });
    const full = position();
    const w = world([empty, full]);
    const r = await w.flow.list(OWNER);
    expect(r.positions.map((p) => p.position)).toEqual([full.position, empty.position]);
  });
  it('claims: checks, signs once, sends once, and reads the fees back as claimed', async () => {
    const p = position();
    const w = world([p]);
    const steps: ClaimProgress[] = [];
    const out = await w.flow.claim(OWNER, p, (s) => steps.push(s));
    expect(steps).toEqual(['checking', 'signing', 'confirming', 'verifying', 'done']);
    expect(w.sent).toHaveLength(1);
    expect(out.differences).toEqual([]);
    expect(out.after).toMatchObject({ feeA: 0n, feeB: 0n });
    // What was sent passed the same inspector, and holds no Aretia charge.
    expect(inspectClaim(web3, w.sent[0]!, OWNER, p)).toEqual([]);
  });
  it('sends nothing when there is nothing to claim, when the network would refuse, or when the wallet is closed', async () => {
    const empty = position({ feeA: 0n, feeB: 0n });
    const w0 = world([empty]);
    await expect(w0.flow.claim(OWNER, empty)).rejects.toThrow(/no fees to claim/);
    const p = position();
    const w1 = world([p]);
    w1.script.simulate = { ok: false, error: 'custom program error: 0x1' };
    await expect(w1.flow.claim(OWNER, p)).rejects.toThrow(/trial run/);
    const w2 = world([p]);
    w2.script.reject = true;
    await expect(w2.flow.claim(OWNER, p)).rejects.toThrow(/closed the wallet/);
    expect(w0.sent.length + w1.sent.length + w2.sent.length).toBe(0);
  });
  it('reports a failed or pending transaction, and fees the network has not yet shown as claimed', async () => {
    const p = position();
    const failed = world([p]);
    failed.script.confirm = 'failed';
    await expect(failed.flow.claim(OWNER, p)).rejects.toThrow(/failed on the network/);
    const pending = world([p]);
    pending.script.confirm = 'pending';
    await expect(pending.flow.claim(OWNER, p)).rejects.toThrow(/not confirmed yet/);
    const stale = world([p]);
    stale.script.stale = true;
    const out = await stale.flow.claim(OWNER, p);
    expect(out.differences.join(' ')).toMatch(/does not show the fees as claimed/);
  });
});
