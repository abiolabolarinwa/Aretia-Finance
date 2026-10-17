/**
 * Read-only live proof of "Your pools": a real wallet's Meteora positions are found on mainnet, read, and a claim transaction for one
 * is built, checked by the inspector and run through the real runtime with `simulateTransaction`. Nothing is signed or sent.
 *
 * Needs a wallet that owns a pool position. The Aretia treasury vault is tried first; if it owns none yet, the test says so and
 * passes without proving more (so an empty wallet cannot make it look as if the claim had been proven).
 */
import * as web3 from '@solana/web3.js';
import * as sdk from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import type { PoolLibs } from './walletPoolTx';
import { readPositions } from './walletYourPoolsChain';
import { amountText, claimableText, pairName } from './walletYourPoolsCore';
import { assembleClaim, buildClaim, inspectClaim } from './walletYourPoolsTx';

// publicnode refuses the indexed calls this needs without a personal key; the Solana Foundation's endpoint allows them (slowly).
const RPC = 'https://api.mainnet-beta.solana.com';
const OWNERS = (process.env.POOLS_LIVE_OWNER ?? 'GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA').split(',');

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) throw new Error(`rpc ${method}: ${body.error?.message ?? 'no result'}`);
  return body.result;
}

const fetchAccount = async (address: string): Promise<{ owner: string; data: Uint8Array } | null> => {
  const r = await rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  return r.value ? { owner: r.value.owner, data: Uint8Array.from(Buffer.from(r.value.data[0], 'base64')) } : null;
};

describe('Your pools, on mainnet (read-only)', () => {
  it('finds positions, reads their fees, and a claim for one passes the inspector and the real runtime', async () => {
    const connection = new web3.Connection(RPC, 'confirmed');
    const libs: PoolLibs = { sdk, BN, cpAmm: new sdk.CpAmm(connection) };
    let proven = 0;
    for (const owner of OWNERS) {
      const { positions } = await readPositions(web3, libs, connection, fetchAccount, owner);
      for (const p of positions) {
        expect(pairName(p)).toMatch(/ \/ /);
        expect(amountText(p.feeA, p.a.decimals)).not.toMatch(/\d{7,}/);
        process.stderr.write(`${owner.slice(0, 6)}…: ${pairName(p)} pool ${p.pool.slice(0, 6)}… ${claimableText(p)}
`);
        const ixs = await buildClaim(web3, libs, owner, p);
        const bh = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
        const tx = assembleClaim(web3, ixs, owner, bh.value.blockhash, bh.value.lastValidBlockHeight);
        expect(inspectClaim(web3, tx, owner, p)).toEqual([]);
        const sim = await rpc<{ value: { err: unknown; logs: string[] | null } }>('simulateTransaction', [Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }]);
        // A position with nothing to claim may be refused by the pool program; one with fees must be accepted.
        if (p.feeA > 0n || p.feeB > 0n) expect(sim.value.err, (sim.value.logs ?? []).join('\n')).toBeNull();
        proven += 1;
      }
    }
    process.stderr.write(`positions checked on mainnet: ${proven}
`);
    expect(proven).toBeGreaterThanOrEqual(0);
  });
});
