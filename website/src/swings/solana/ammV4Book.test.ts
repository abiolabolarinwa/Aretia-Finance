import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { AMM_V4_PROGRAM, AmmV4Adapter, AmmV4BookAdapter, ammV4BookSwapInstruction, parseAmmV4Book } from './raydiumAmmV4.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'E7cw2vycqvtGcwB2W7WGPZeLHPVHAJqckyqXzHC5pump';
const USER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const key = (n: number): string => new web3.PublicKey(new Uint8Array(32).fill(n)).toBase58();
const put = (d: Uint8Array, o: number, a: string): void => d.set(new web3.PublicKey(a).toBytes(), o);
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const ref = (address: string) => ({ chain: 'solana' as const, address });
const POOL = key(20);
const MARKET_PROGRAM = new web3.Keypair().publicKey.toBase58();
const MARKET = (() => {
  // A market address whose signer can be derived with a nonce, as every real market's can.
  for (let i = 100; i < 250; i++) {
    const m = new web3.PublicKey(new Uint8Array(32).fill(i));
    for (let nonce = 0; nonce < 8; nonce++) {
      try {
        const n = new Uint8Array(8);
        n[0] = nonce;
        web3.PublicKey.createProgramAddressSync([m.toBytes(), n], new web3.PublicKey(MARKET_PROGRAM));
        return { address: m.toBase58(), nonce };
      } catch {
        // not on the curve for this nonce; try the next
      }
    }
  }
  throw new Error('no market address found');
})();
const tokenAccount = (amount: bigint): Uint8Array => {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
};

function pool(): Uint8Array {
  const d = new Uint8Array(752);
  new DataView(d.buffer).setBigUint64(0, 6n, true);
  put(d, 336, key(1));
  put(d, 368, key(2));
  put(d, 400, MINT);
  put(d, 432, SOL);
  put(d, 496, key(3));
  put(d, 528, MARKET.address);
  put(d, 560, MARKET_PROGRAM);
  put(d, 592, key(4));
  return d;
}
function market(): Uint8Array {
  const d = new Uint8Array(400);
  new DataView(d.buffer).setBigUint64(45, BigInt(MARKET.nonce), true);
  put(d, 117, key(5));
  put(d, 165, key(6));
  put(d, 253, key(7));
  put(d, 285, key(8));
  put(d, 317, key(9));
  return d;
}

describe('Raydium AMM v4 through its order book', () => {
  const rpc = async <T>(_m: string, params: unknown[]): Promise<T> =>
    ({
      value: (params[0] as string[]).map((k) =>
        k === POOL ? { owner: AMM_V4_PROGRAM, data: [b64(pool()), 'base64'] } : k === MARKET.address ? { owner: MARKET_PROGRAM, data: [b64(market()), 'base64'] } : k === key(1) || k === key(2) ? { owner: TOKEN_PROGRAM, data: [b64(tokenAccount(1000n)), 'base64'] } : null,
      ),
    }) as T;
  const amm = new AmmV4Adapter(web3, rpc, () => 3, async () => [POOL]);

  it('reads the order-book accounts from the pool and the market, and derives the signer', () => {
    const book = parseAmmV4Book(web3, pool(), market())!;
    expect(book).toMatchObject({ openOrders: key(3), targetOrders: key(4), serumProgram: MARKET_PROGRAM, market: MARKET.address, bids: key(8), asks: key(9), eventQueue: key(7), baseVault: key(5), quoteVault: key(6) });
    const n = new Uint8Array(8);
    n[0] = MARKET.nonce;
    expect(book.vaultSigner).toBe(web3.PublicKey.createProgramAddressSync([new web3.PublicKey(MARKET.address).toBytes(), n], new web3.PublicKey(MARKET_PROGRAM)).toBase58());
    expect(parseAmmV4Book(web3, pool(), new Uint8Array(10))).toBeNull();
    expect(parseAmmV4Book(web3, new Uint8Array(10), market())).toBeNull();
  });

  it('offers the same pools under its own venue, with the book attached', async () => {
    const [p] = await new AmmV4BookAdapter(web3, rpc, amm, () => 3).getPools(ref(SOL), ref(MINT));
    expect(p).toMatchObject({ status: 'active', token0: ref(MINT), token1: ref(SOL) });
    expect(p!.ref).toEqual({ chain: 'solana', dex: 'raydium-amm-v4-book', address: POOL });
    expect(p!.extra).toMatchObject({ market: MARKET.address, bids: key(8), coinVault: key(1), pcVault: key(2) });
  });

  it('offers nothing when the market is missing or is owned by another program', async () => {
    const noMarket = async <T>(m: string, params: unknown[]): Promise<T> => ({ value: (await rpc<{ value: ({ owner: string } | null)[] }>(m, params)).value.map((a, i) => ((params[0] as string[])[i] === MARKET.address ? null : a)) }) as T;
    expect(await new AmmV4BookAdapter(web3, noMarket, new AmmV4Adapter(web3, noMarket, () => 3, async () => [POOL]), () => 3).getPools(ref(SOL), ref(MINT))).toEqual([]);
    const wrongOwner = async <T>(m: string, params: unknown[]): Promise<T> => ({ value: (await rpc<{ value: ({ owner: string } | null)[] }>(m, params)).value.map((a, i) => (a && (params[0] as string[])[i] === MARKET.address ? { ...a, owner: TOKEN_PROGRAM } : a)) }) as T;
    expect(await new AmmV4BookAdapter(web3, wrongOwner, new AmmV4Adapter(web3, wrongOwner, () => 3, async () => [POOL]), () => 3).getPools(ref(SOL), ref(MINT))).toEqual([]);
    expect(await new AmmV4BookAdapter(web3, rpc, new AmmV4Adapter(web3, rpc, () => 3, async () => []), () => 3).getPools(ref(SOL), ref(MINT))).toEqual([]);
  });

  it('builds swap_base_in with the book accounts in the order the program reads them, and refuses bad input', async () => {
    const [p] = await new AmmV4BookAdapter(web3, rpc, amm, () => 3).getPools(ref(SOL), ref(MINT));
    const ix = ammV4BookSwapInstruction(web3, amm, USER, p!, ref(SOL), key(10), key(11), 100n, 5n);
    expect(ix.programId.toBase58()).toBe(AMM_V4_PROGRAM);
    expect(ix.data[0]).toBe(9);
    expect(Buffer.from(ix.data).readBigUInt64LE(1)).toBe(100n);
    expect(Buffer.from(ix.data).readBigUInt64LE(9)).toBe(5n);
    expect(ix.keys).toHaveLength(18);
    expect(ix.keys.map((k) => k.pubkey.toBase58()).slice(3, 15)).toEqual([key(3), key(4), key(1), key(2), MARKET_PROGRAM, MARKET.address, key(8), key(9), key(7), key(5), key(6), ix.keys[14]!.pubkey.toBase58()]);
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([USER]);
    expect(() => ammV4BookSwapInstruction(web3, amm, USER, p!, ref(SOL), key(10), key(11), 0n, 5n)).toThrow(/above zero/);
    expect(() => ammV4BookSwapInstruction(web3, amm, USER, p!, ref(SOL), key(10), key(11), 5n, 0n)).toThrow(/minimum/);
    expect(() => ammV4BookSwapInstruction(web3, amm, USER, p!, ref(key(12)), key(10), key(11), 5n, 1n)).toThrow(/not in this pool/);
    expect(() => ammV4BookSwapInstruction(web3, amm, USER, { ...p!, ref: { ...p!.ref, dex: 'raydium-amm-v4' } }, ref(SOL), key(10), key(11), 5n, 1n)).toThrow(/order-book builder/);
  });
});
