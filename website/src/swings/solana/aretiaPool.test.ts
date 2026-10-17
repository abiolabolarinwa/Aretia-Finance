import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import vectors from '../../scripts/__fixtures__/aretiaPoolVectors.json';
import { POOL_ACCOUNT_SIZE, POOL_TAG, openPool, buy, sell } from '../../scripts/walletAretiaPoolCore';
import { poolAddress } from '../../scripts/walletAretiaPoolTx';
import { AretiaDexRegistry } from '../engine/registry';
import { quoteConstantProduct } from '../engine/amm';
import { SOLANA_DEXES } from '../dex/entries';
import { AretiaPoolAdapter, WSOL, aretiaPoolQuote, aretiaPoolSwapInstruction } from './aretiaPool';
import { createSolanaVenues } from './venues';

const PROGRAM = vectors.program;
const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const USER = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const tok = { chain: 'solana' as const, address: MINT };
const sol = { chain: 'solana' as const, address: WSOL };

function accountData(x: bigint, y: bigint, l: bigint, feeBps: number): string {
  const d = new Uint8Array(POOL_ACCOUNT_SIZE);
  d.set(POOL_TAG, 0);
  d.set(new web3.PublicKey(MINT).toBytes(), 10);
  d.set(new web3.PublicKey(USER).toBytes(), 42);
  const v = new DataView(d.buffer);
  v.setUint16(74, feeBps, true);
  v.setBigUint64(76, x, true);
  v.setBigUint64(84, y, true);
  v.setBigUint64(92, l, true);
  return Buffer.from(d).toString('base64');
}
const rpcWith = (data: string | null, owner = PROGRAM) => (async () => ({ value: [data ? { data: [data, 'base64'], owner } : null] })) as never;

describe('Aretia Pool as a Swings venue', () => {
  it('is in the registry but not routable', () => {
    const reg = new AretiaDexRegistry(SOLANA_DEXES);
    expect(reg.get('aretia-pool')?.status).toBe('DISABLED');
    expect(reg.routable('solana').map((e) => e.id)).not.toContain('aretia-pool');
    expect(createSolanaVenues(web3, (async () => ({})) as never, reg, Date.now).map((v) => v.id)).not.toContain('aretia-pool');
  });

  it('reads the pool for a (token, SOL) pair in either order, and nothing else', async () => {
    const a = new AretiaPoolAdapter(web3, rpcWith(accountData(600_000_000_000_000n, 0n, 10_000_000_000n, 25)), PROGRAM);
    for (const [p, q] of [[tok, sol], [sol, tok]]) {
      const pools = await a.getPools(p!, q!);
      expect(pools).toHaveLength(1);
      expect(pools[0]).toMatchObject({ model: 'constant-product', curve: 'aretia-pool', feePpm: 2500, status: 'active' });
      expect(pools[0]!.ref.address).toBe(poolAddress(web3, PROGRAM, MINT));
    }
    expect(await a.getPools(tok, { chain: 'solana', address: USER })).toEqual([]);
  });

  it('ignores an account that is not the program’s, a missing one, and one for another mint', async () => {
    expect(await new AretiaPoolAdapter(web3, rpcWith(null), PROGRAM).getPools(tok, sol)).toEqual([]);
    expect(await new AretiaPoolAdapter(web3, rpcWith(accountData(5n, 0n, 5n, 25), '11111111111111111111111111111111'), PROGRAM).getPools(tok, sol)).toEqual([]);
  });

  it('quotes exactly what the program’s maths gives, both ways', async () => {
    const x = 600_000_000_000_000n;
    const l = 10_000_000_000n;
    const pool = (await new AretiaPoolAdapter(web3, rpcWith(accountData(x, 0n, l, 100)), PROGRAM).getPools(tok, sol))[0]!;
    const m = openPool(x, 0n, l, 100)!;
    const b = buy(m, 2_000_000_000n)!;
    expect(aretiaPoolQuote(pool, sol, 2_000_000_000n)).toBe(b.result.tokensOut);
    expect(quoteConstantProduct(pool, sol, 2_000_000_000n)).toBe(b.result.tokensOut);
    expect(aretiaPoolQuote(pool, tok, 1_000n)).toBe(0n); // nothing to sell into yet
    const after = (await new AretiaPoolAdapter(web3, rpcWith(accountData(b.next.x, b.next.y, b.next.l, 100)), PROGRAM).getPools(tok, sol))[0]!;
    expect(aretiaPoolQuote(after, tok, b.result.tokensOut)).toBe(sell(b.next, b.result.tokensOut)!.result.net);
  });

  it('builds the swap instruction for the program, and refuses a zero floor', async () => {
    const pool = (await new AretiaPoolAdapter(web3, rpcWith(accountData(600_000_000_000_000n, 0n, 10_000_000_000n, 25)), PROGRAM).getPools(tok, sol))[0]!;
    const ix = aretiaPoolSwapInstruction(web3, PROGRAM, USER, pool, sol, 1_000_000_000n, 5n);
    expect(ix.programId.toBase58()).toBe(PROGRAM);
    expect(ix.data[8]).toBe(1);
    expect(() => aretiaPoolSwapInstruction(web3, PROGRAM, USER, pool, sol, 1n, 0n)).toThrow();
  });
});
