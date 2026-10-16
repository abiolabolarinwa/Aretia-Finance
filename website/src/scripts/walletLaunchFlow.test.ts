import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import mints from './__fixtures__/launchMints.json';
import { distributionOf, type LaunchConfig } from './walletLaunchCore';
import { LaunchError, LaunchFlow, friendlyError, type FlowDeps, type Progress } from './walletLaunchFlow';
import { loadPending } from './walletLaunchChain';
import { TOKEN_2022_PROGRAM_ID, ataAddress } from './walletTools';

const PAYER = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const TREASURY = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
const FIXTURE_MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const MINT_RENT = 2_700_000n;
const ATA_RENT = 2_100_000n;

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

/** The real account bytes the official client wrote, with the fixture's token address swapped for the one under test. */
function mintBytes(kind: 'afterStep1' | 'final', mint: string): Uint8Array {
  const data = Uint8Array.from(Buffer.from((mints as Record<string, string[]>)[kind]!.join(''), 'hex'));
  const from = new web3.PublicKey(FIXTURE_MINT).toBytes();
  const to = new web3.PublicKey(mint).toBytes();
  for (let i = 0; i + 32 <= data.length; i++) if (from.every((b, j) => data[i + j] === b)) data.set(to, i);
  return data;
}

interface World {
  deps: FlowDeps;
  sent: { tx: web3.Transaction; signatures: string[] }[];
  /** What the chain shows for the token. */
  chain: { mint: string | null; state: 'absent' | 'afterStep1' | 'final'; atas: Map<string, bigint> };
  script: {
    rejectAt?: 1 | 2;
    simulateFails?: boolean;
    confirm1?: 'confirmed' | 'failed' | 'pending';
    confirm2?: 'confirmed' | 'failed' | 'pending';
    /** What the chain shows after the first transaction. */
    afterStep1?: 'afterStep1' | 'final' | 'absent';
    balance?: bigint;
    balancesAfter?: 'right' | 'short';
    tamperName?: boolean;
  };
  storage: Map<string, string>;
}

function world(c: LaunchConfig = config()): World {
  const storage = new Map<string, string>();
  const w = { sent: [], chain: { mint: null, state: 'absent', atas: new Map() }, script: {}, storage } as unknown as World;
  let n = 0;
  const deps: FlowDeps = {
    web3,
    rentFor: async (size) => (size > 200 ? MINT_RENT : ATA_RENT),
    balanceOf: async () => w.script.balance ?? 1_000_000_000n,
    latestBlockhash: async () => ({ blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1 }),
    fetchAccount: async (address) => {
      if (w.chain.mint && address === w.chain.mint && w.chain.state !== 'absent') {
        const data = mintBytes(w.chain.state, w.chain.mint);
        return { owner: TOKEN_2022_PROGRAM_ID, data };
      }
      const amount = w.chain.atas.get(address);
      if (amount === undefined) return null;
      const data = new Uint8Array(170);
      new DataView(data.buffer).setBigUint64(64, amount, true);
      data[108] = 1;
      return { owner: TOKEN_2022_PROGRAM_ID, data };
    },
    simulate: async () => (w.script.simulateFails ? { ok: false, error: 'custom program error: 0x1' } : { ok: true, error: null }),
    signAndSubmit: async (tx, signers) => {
      const step = w.sent.length === 0 ? 1 : 2;
      if (w.script.rejectAt === step) throw new Error('User rejected the request.');
      for (const s of signers) tx.partialSign(s);
      w.sent.push({ tx, signatures: tx.signatures.map((x) => (x.signature ? 'signed' : 'missing')) });
      if (step === 1) {
        w.chain.mint = tx.instructions[0]!.keys[1]!.pubkey.toBase58();
        w.chain.state = w.script.afterStep1 ?? 'afterStep1';
      } else {
        w.chain.state = 'final';
        for (const l of distributionOf(c)) w.chain.atas.set(ataAddress(web3, l.owner, w.chain.mint!, TOKEN_2022_PROGRAM_ID), w.script.balancesAfter === 'short' ? l.amount - 1n : l.amount);
      }
      return `sig${++n}`;
    },
    confirm: async () => (w.sent.length === 1 ? (w.script.confirm1 ?? 'confirmed') : (w.script.confirm2 ?? 'confirmed')),
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
    now: () => 1_000,
    sleep: async () => undefined,
  };
  w.deps = deps;
  return w;
}

describe('prepare', () => {
  it('prices the creation from live rent and generates the new token’s key', async () => {
    const w = world();
    const r = await new LaunchFlow(w.deps).prepare(config());
    expect(r.cost.mintDeposit).toBe(MINT_RENT);
    expect(r.cost.tokenAccountDeposits).toBe(ATA_RENT * 2n); // creator and treasury
    expect(r.cost.networkFee).toBe(15_000n);
    expect(r.blockers).toEqual([]);
    expect(new web3.PublicKey(r.mint).toBase58()).toBe(r.signer.publicKey.toBase58());
    const again = await new LaunchFlow(w.deps).prepare(config());
    expect(again.mint).not.toBe(r.mint); // a fresh key every time
  });
  it('blocks when the wallet cannot cover the cost', async () => {
    const w = world();
    w.script.balance = 1_000_000n;
    const r = await new LaunchFlow(w.deps).prepare(config());
    expect(r.blockers.join(' ')).toMatch(/does not hold enough SOL/);
  });
});

describe('create', () => {
  it('runs both transactions in order, checks the token between them and at the end, and leaves no record behind', async () => {
    const w = world();
    const flow = new LaunchFlow(w.deps);
    const review = await flow.prepare(config());
    const steps: Progress[] = [];
    const out = await flow.create(review, (p) => steps.push(p));
    expect(steps).toEqual(['checking', 'signing-1', 'confirming-1', 'verifying-1', 'signing-2', 'confirming-2', 'verifying-2', 'done']);
    expect(out).toMatchObject({ mint: review.mint, step1: 'sig1', step2: 'sig2', differences: [] });
    expect(w.sent).toHaveLength(2);
    // The new token's key signed the first transaction (as well as the wallet) and not the second.
    expect(w.sent[0]!.tx.signatures.map((s) => s.publicKey.toBase58()).sort()).toEqual([PAYER, review.mint].sort());
    expect(w.sent[0]!.tx.signatures.find((s) => s.publicKey.toBase58() === review.mint)!.signature).not.toBeNull();
    const m2 = w.sent[1]!.tx.compileMessage();
    expect(m2.accountKeys.slice(0, m2.header.numRequiredSignatures).map((k) => k.toBase58())).toEqual([PAYER]);
    expect(loadPending(w.deps.storage, PAYER)).toBeNull();
  });

  it('does nothing when the cost cannot be covered, or when an earlier creation is unfinished', async () => {
    const w = world();
    w.script.balance = 1n;
    const poor = await new LaunchFlow(w.deps).prepare(config());
    await expect(new LaunchFlow(w.deps).create(poor)).rejects.toThrow(/does not hold enough/);
    expect(w.sent).toHaveLength(0);

    const w2 = world();
    w2.script.confirm1 = 'pending';
    const f2 = new LaunchFlow(w2.deps);
    await expect(f2.create(await f2.prepare(config()))).rejects.toThrow(/has not confirmed/);
    await expect(f2.create(await f2.prepare(config()))).rejects.toThrow(/unfinished/);
  });

  it('sends nothing and keeps no record when the wallet window is closed on the first transaction', async () => {
    const w = world();
    w.script.rejectAt = 1;
    const flow = new LaunchFlow(w.deps);
    await expect(flow.create(await flow.prepare(config()))).rejects.toThrow(/closed the wallet/);
    expect(w.sent).toHaveLength(0);
    expect(loadPending(w.deps.storage, PAYER)).toBeNull();
  });

  it('sends nothing when the network would refuse the transaction', async () => {
    const w = world();
    w.script.simulateFails = true;
    const flow = new LaunchFlow(w.deps);
    await expect(flow.create(await flow.prepare(config()))).rejects.toThrow(/would refuse/);
    expect(w.sent).toHaveLength(0);
    expect(loadPending(w.deps.storage, PAYER)).toBeNull();
  });

  it('never creates the supply if the first transaction failed or has not confirmed, and keeps a record when it might still land', async () => {
    const failed = world();
    failed.script.confirm1 = 'failed';
    const f1 = new LaunchFlow(failed.deps);
    await expect(f1.create(await f1.prepare(config()))).rejects.toThrow(/failed on the network/);
    expect(failed.sent).toHaveLength(1);

    const slow = world();
    slow.script.confirm1 = 'pending';
    const f2 = new LaunchFlow(slow.deps);
    await expect(f2.create(await f2.prepare(config()))).rejects.toThrow(/sig1/);
    expect(slow.sent).toHaveLength(1);
    expect(loadPending(slow.deps.storage, PAYER)).toMatchObject({ stage: 'started', step1: 'sig1' });
  });

  it('stops before the second transaction if the token that exists is not what was approved', async () => {
    const w = world(config({ name: 'Different' }));
    const flow = new LaunchFlow(w.deps);
    // the chain shows the fixture's name ("Aretia Test Token"), but this creation approved "Different"
    const review = await flow.prepare(config({ name: 'Different' }));
    await expect(flow.create(review)).rejects.toThrow(/not what you approved/);
    expect(w.sent).toHaveLength(1);
    expect(loadPending(w.deps.storage, PAYER)).not.toBeNull();
  });

  it('stops before the second transaction if supply already exists', async () => {
    const w = world();
    w.script.afterStep1 = 'final';
    const flow = new LaunchFlow(w.deps);
    await expect(flow.create(await flow.prepare(config()))).rejects.toThrow(/not what you approved/);
    expect(w.sent).toHaveLength(1);
  });

  it('reports a difference at the end instead of saying all is well', async () => {
    const w = world();
    w.script.balancesAfter = 'short';
    const flow = new LaunchFlow(w.deps);
    const out = await flow.create(await flow.prepare(config()));
    expect(out.differences.join(' ')).toMatch(/approved .* holds/);
  });
});

describe('finishing a creation that stopped half way', () => {
  async function stoppedAfterFirst() {
    const w = world();
    const flow = new LaunchFlow(w.deps);
    const review = await flow.prepare(config());
    w.script.rejectAt = undefined;
    // the wallet is closed on the second transaction
    const original = w.deps.signAndSubmit;
    let calls = 0;
    w.deps.signAndSubmit = async (tx, signers) => {
      calls++;
      if (calls === 2) throw new Error('User rejected the request.');
      return original(tx, signers);
    };
    await expect(flow.create(review)).rejects.toThrow(/closed the wallet/);
    w.deps.signAndSubmit = original;
    return { w, flow, review };
  }

  it('leaves a record, then finishes with only the second transaction', async () => {
    const { w, flow, review } = await stoppedAfterFirst();
    expect(w.sent).toHaveLength(1);
    expect(loadPending(w.deps.storage, PAYER)).toMatchObject({ stage: 'created', mint: review.mint });
    const a = await flow.assess(PAYER);
    expect(a?.action).toBe('finish');
    const out = await flow.finish(PAYER);
    expect(out).toMatchObject({ mint: review.mint, step2: expect.any(String), differences: [] });
    expect(w.sent).toHaveLength(2);
    expect(loadPending(w.deps.storage, PAYER)).toBeNull();
  });

  it('refuses to run a second time, so it cannot mint twice', async () => {
    const { w, flow } = await stoppedAfterFirst();
    await flow.finish(PAYER);
    await expect(flow.finish(PAYER)).rejects.toThrow(/no unfinished/);
    expect(w.sent).toHaveLength(2);
  });

  it('refuses if the token on chain is no longer the half-made one', async () => {
    const { w, flow } = await stoppedAfterFirst();
    w.chain.state = 'final'; // someone else already created the supply
    await expect(flow.finish(PAYER)).rejects.toThrow();
    expect(w.sent).toHaveLength(1);
  });

  it('can verify a creation whose supply exists, and discard a record for a token that was never made', async () => {
    const { w, flow } = await stoppedAfterFirst();
    w.chain.state = 'final';
    for (const l of distributionOf(config())) w.chain.atas.set(ataAddress(web3, l.owner, w.chain.mint!, TOKEN_2022_PROGRAM_ID), l.amount);
    const out = await flow.verifyStored(PAYER);
    expect(out.differences).toEqual([]);
    expect(loadPending(w.deps.storage, PAYER)).toBeNull();

    const w2 = world();
    const f2 = new LaunchFlow(w2.deps);
    w2.script.confirm1 = 'pending';
    await expect(f2.create(await f2.prepare(config()))).rejects.toThrow();
    w2.chain.state = 'absent'; // it never landed
    expect((await f2.assess(PAYER))?.action).toBe('none');
    f2.discard(PAYER);
    expect(loadPending(w2.deps.storage, PAYER)).toBeNull();
  });
});

describe('friendlyError', () => {
  it('turns wallet and network errors into plain sentences', () => {
    expect(friendlyError(new Error('User rejected the request.'))).toMatch(/closed the wallet/);
    expect(friendlyError(new Error('WalletSignTransactionError: Transaction cancelled'))).toMatch(/closed the wallet/);
    expect(friendlyError(new Error('Blockhash not found'))).toMatch(/moved on/);
    expect(friendlyError(new Error('Attempt to debit an account but found no record of a prior credit. insufficient lamports'))).toMatch(/enough SOL/);
    expect(friendlyError('weird')).toMatch(/not sent/);
    expect(friendlyError(new Error('x'.repeat(500))).length).toBeLessThan(220);
  });
  it('marks the errors that mean nothing was sent', () => {
    expect(new LaunchError('x', true).nothingSent).toBe(true);
    expect(new LaunchError('x').nothingSent).toBe(false);
  });
});
