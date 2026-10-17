/**
 * Read-only live proof of the Solana token creation on the Launch page: the transactions the page builds are run through the real
 * Solana runtime on mainnet with `simulateTransaction`. Nothing is signed or sent. The creator is a public, richly funded address used
 * only as a stand-in (a simulation with signature checks off needs no key), and the new token's address is a fresh one.
 *
 * What this proves that the unit tests cannot: that the real Token-2022 program accepts the account size, the metadata pointer, the
 * metadata, the mint, the token accounts and the giving-up of the mint authority exactly as encoded, and that Aretia's flat fee
 * transfer is accepted, with the real rent and fee rules. It does not prove a wallet will sign these.
 */
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FORM, LAUNCH_FEE_ADDRESS, LAUNCH_FEE_LAMPORTS, validateLaunch, estimateCost } from './walletLaunchCore';
import { TOKEN_ACCOUNT_SIZE, assemble, buildStep1, buildStep2, inspectStep, mintSizes } from './walletLaunchTx';
import { distributionOf } from './walletLaunchCore';

const RPC = 'https://solana-rpc.publicnode.com';
/** A public address that holds a very large balance; used only to stand in for the creator in a simulation. */
const CREATOR = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error || body.result === undefined) throw new Error(`rpc ${method}: ${body.error?.message ?? 'no result'}`);
    return body.result;
  }
  throw new Error(`rpc ${method}: rate limited`);
}

const b64 = (tx: web3.Transaction): string => Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');

async function simulate(tx: web3.Transaction): Promise<{ err: unknown; logs: string[] }> {
  const r = await rpc<{ value: { err: unknown; logs: string[] | null } }>('simulateTransaction', [b64(tx), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
  return { err: r.value.err, logs: r.value.logs ?? [] };
}

describe('Solana token creation, on mainnet (simulated)', () => {
  const valid = validateLaunch({ ...DEFAULT_FORM, name: 'Aretia Live Check', symbol: 'ALC', metadataUri: 'https://aretiafinance.org/live-check.json' }, CREATOR);
  if (!valid.ok) throw new Error(JSON.stringify(valid.issues));
  const config = valid.config;

  it('the first transaction (fee, create the token, name and link) is accepted by the real runtime', async () => {
    const mint = web3.Keypair.generate().publicKey.toBase58();
    const [mintRent, bh] = await Promise.all([rpc<number>('getMinimumBalanceForRentExemption', [mintSizes(config).withMetadata]), rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])]);
    const tx = assemble(web3, buildStep1(web3, { config, mint, mintRentLamports: BigInt(mintRent) }), CREATOR, bh.value.blockhash, bh.value.lastValidBlockHeight);
    expect(inspectStep(web3, tx, 1, { config, mint, mintRentLamports: BigInt(mintRent) })).toEqual([]);
    const sim = await simulate(tx);
    expect(sim.err, sim.logs.join('\n')).toBeNull();
    // The flat fee transfer ran, and Token-2022 initialised the mint and wrote the metadata.
    expect(sim.logs.join('\n')).toMatch(/Program 11111111111111111111111111111111 success/);
    expect(sim.logs.join('\n')).toMatch(/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success/);
  });

  it('both steps together (one recipient, short text so it fits one transaction) are accepted: the fee, the token, the metadata made immutable, the supply minted, the mint authority given up', async () => {
    const solo = validateLaunch({ ...DEFAULT_FORM, name: 'A', symbol: 'A', creatorPct: '20' }, CREATOR);
    if (!solo.ok) throw new Error(JSON.stringify(solo.issues));
    const c = solo.config;
    const mint = web3.Keypair.generate().publicKey.toBase58();
    const [mintRent, bh] = await Promise.all([rpc<number>('getMinimumBalanceForRentExemption', [mintSizes(c).withMetadata]), rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])]);
    const ixs = [...buildStep1(web3, { config: c, mint, mintRentLamports: BigInt(mintRent) }), ...buildStep2(web3, c, mint)];
    const tx = assemble(web3, ixs, CREATOR, bh.value.blockhash, bh.value.lastValidBlockHeight);
    const sim = await simulate(tx);
    expect(sim.err, sim.logs.join('\n')).toBeNull();
    // The metadata was made immutable and the mint authority was given up, both by the real program.
    expect(sim.logs.join('\n')).toMatch(/TokenMetadataInstruction: Initialize/);
    expect(sim.logs.join('\n')).toMatch(/TokenMetadataInstruction: UpdateAuthority/);
    expect(sim.logs.join('\n')).toMatch(/Instruction: SetAuthority/);
    expect(sim.logs.join('\n')).toMatch(/Instruction: MintTo/);
  });

  it('the estimate adds up: the fee plus the deposits the real network asks for', async () => {
    const [mintRent, ataRent] = await Promise.all([rpc<number>('getMinimumBalanceForRentExemption', [mintSizes(config).withMetadata]), rpc<number>('getMinimumBalanceForRentExemption', [TOKEN_ACCOUNT_SIZE])]);
    const cost = estimateCost({ mintDeposit: BigInt(mintRent), tokenAccountDeposit: BigInt(ataRent), accountCount: distributionOf(config).length });
    expect(cost.aretiaFee).toBe(LAUNCH_FEE_LAMPORTS);
    expect(LAUNCH_FEE_ADDRESS).toBe('2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2');
    // About 0.05 SOL fee, 0.003 for the token, 0.002 per token account, plus network fees: well under 0.1 SOL.
    expect(cost.total < 100_000_000n).toBe(true);
  });

  it('the second transaction is built as the inspector expects (it cannot be simulated alone: the token does not exist yet)', () => {
    const mint = web3.Keypair.generate().publicKey.toBase58();
    const tx = assemble(web3, buildStep2(web3, config, mint), CREATOR, '11111111111111111111111111111111', 1);
    expect(inspectStep(web3, tx, 2, { config, mint, mintRentLamports: 0n })).toEqual([]);
  });
});
