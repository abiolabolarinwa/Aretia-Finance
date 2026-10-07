import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildCpmmSwapTransaction, cpmmSwapInstruction, MAX_PRIORITY_MICRO_LAMPORTS, swapBaseInputDiscriminator, WSOL_MINT, type CpmmSwapStep } from './builder.js';
import { parseConfigState, parsePoolState, RAYDIUM_CPMM_PROGRAM, RaydiumCpmmAdapter, sortMints, tokenAccountAmount, type SolRpc } from './raydiumCpmm.js';
import { DirectSolanaProvider } from './directSolana.js';
import { getAmountOut, getAmountOutCpmm } from '../engine/amm.js';
import { AretiaDexRegistry } from '../engine/registry.js';
import { SOLANA_DEXES } from '../dex/entries.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import type { SwapRequest } from '../core/types.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USER = web3.Keypair.generate().publicKey.toBase58(); // a throwaway public key: no secret is ever used here
const rnd = () => web3.Keypair.generate().publicKey.toBase58();

describe('CPMM maths', () => {
  it('takes the fee from the input rounded up, then prices the rest', () => {
    // fee = ceil(1000 * 2500 / 1e6) = 3 (not 2): input after fee = 997; out = 997 * 5000 / (10000 + 997)
    expect(getAmountOutCpmm(1000n, 10_000n, 5_000n, 2500)).toBe((997n * 5000n) / (10_000n + 997n));
    // The Uniswap V2 formula would round differently on the same inputs; the venue's own rounding is the one used.
    expect(getAmountOut(1000n, 10_000n, 5_000n, 2500)).toBeGreaterThanOrEqual(getAmountOutCpmm(1000n, 10_000n, 5_000n, 2500));
  });
  it('property: never pays the whole reserve, never negative, monotonic in the input', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1_000n, max: 10n ** 20n }), fc.bigInt({ min: 10n ** 6n, max: 10n ** 24n }), fc.bigInt({ min: 10n ** 6n, max: 10n ** 24n }), fc.integer({ min: 0, max: 100_000 }), (amountIn, rIn, rOut, fee) => {
        const out = getAmountOutCpmm(amountIn, rIn, rOut, fee);
        const more = getAmountOutCpmm(amountIn + 1_000n, rIn, rOut, fee);
        return out >= 0n && out < rOut && more >= out;
      }),
    );
  });
  it('refuses empty pools, zero input and a trade the fee swallows', () => {
    expect(() => getAmountOutCpmm(0n, 1n, 1n, 100)).toThrow();
    expect(() => getAmountOutCpmm(1n, 0n, 1n, 100)).toThrow();
    expect(() => getAmountOutCpmm(1n, 10n, 10n, 1_000_000)).toThrow();
    expect(() => getAmountOutCpmm(1n, 10n, 10n, 999_999)).toThrow();
  });
});

describe('Raydium CPMM adapter', () => {
  const adapter = new RaydiumCpmmAdapter(web3, async () => ({ value: [] }) as never);
  const [m0, m1] = sortMints(web3, WSOL_MINT, USDC);

  /** Builds raw account bytes in the program's layout. */
  const poolBytes = (o: { config: string; v0: string; v1: string; program0?: string; program1?: string; status?: number; creatorFee?: boolean; open?: bigint; protocol0?: bigint; fund1?: bigint }): Uint8Array => {
    const d = new Uint8Array(637 + 8);
    const view = new DataView(d.buffer);
    const put = (offset: number, key: string) => d.set(new web3.PublicKey(key).toBytes(), offset);
    put(8, o.config);
    put(72, o.v0);
    put(104, o.v1);
    put(168, m0);
    put(200, m1);
    put(232, o.program0 ?? TOKEN_PROGRAM_ID);
    put(264, o.program1 ?? TOKEN_PROGRAM_ID);
    put(296, rnd());
    d[329] = o.status ?? 0;
    view.setBigUint64(341, o.protocol0 ?? 0n, true);
    view.setBigUint64(365, o.fund1 ?? 0n, true);
    view.setBigUint64(373, o.open ?? 0n, true);
    d[390] = o.creatorFee ? 1 : 0;
    return d;
  };
  const configBytes = (index: number, fee: bigint): Uint8Array => {
    const d = new Uint8Array(236);
    const view = new DataView(d.buffer);
    view.setUint16(10, index, true);
    view.setBigUint64(12, fee, true);
    return d;
  };
  const tokenBytes = (amount: bigint): Uint8Array => {
    const d = new Uint8Array(165);
    new DataView(d.buffer).setBigUint64(64, amount, true);
    return d;
  };
  const b64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));

  function chain(options: Parameters<typeof poolBytes>[0] extends infer T ? Partial<T> : never = {}, configIndex = 0) {
    const configAddr = adapter.configAddress(configIndex);
    const poolAddr = adapter.poolAddress(configAddr, m0, m1);
    const v0 = rnd();
    const v1 = rnd();
    const store = new Map<string, { data: [string, string]; owner: string }>();
    store.set(poolAddr, { data: [b64(poolBytes({ config: configAddr, v0, v1, ...options })), 'base64'], owner: RAYDIUM_CPMM_PROGRAM });
    store.set(configAddr, { data: [b64(configBytes(configIndex, 2500n)), 'base64'], owner: RAYDIUM_CPMM_PROGRAM });
    store.set(v0, { data: [b64(tokenBytes(1_000_000_000n)), 'base64'], owner: TOKEN_PROGRAM_ID });
    store.set(v1, { data: [b64(tokenBytes(200_000_000n)), 'base64'], owner: TOKEN_PROGRAM_ID });
    const rpc: SolRpc = (async (method: string, params: unknown[]) => {
      if (method === 'getMultipleAccounts') return { value: (params[0] as string[]).map((a) => store.get(a) ?? null) };
      throw new Error('unexpected ' + method);
    }) as SolRpc;
    return { rpc, poolAddr, configAddr, v0, v1 };
  }
  const tokens = [{ chain: 'solana' as const, address: WSOL_MINT }, { chain: 'solana' as const, address: USDC }];

  it('derives deterministic, distinct config and pool addresses, and a single shared authority', () => {
    expect(adapter.configAddress(0)).not.toBe(adapter.configAddress(1));
    expect(adapter.configAddress(0)).toBe(adapter.configAddress(0));
    expect(adapter.poolAddress(adapter.configAddress(0), m0, m1)).not.toBe(adapter.poolAddress(adapter.configAddress(1), m0, m1));
    expect(adapter.authorityAddress()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(sortMints(web3, USDC, WSOL_MINT)).toEqual(sortMints(web3, WSOL_MINT, USDC));
  });

  it('reads a pool, takes the fee from the config and nets vault balances of accrued fees', async () => {
    const c = chain({ protocol0: 5_000n, fund1: 1_000n });
    const pools = await new RaydiumCpmmAdapter(web3, c.rpc, () => 1_000_000).getPools(tokens[0]!, tokens[1]!);
    expect(pools).toHaveLength(1);
    const p = pools[0]!;
    expect(p).toMatchObject({ curve: 'raydium-cpmm', model: 'constant-product', feePpm: 2500, status: 'active', reserve0: 1_000_000_000n - 5_000n, reserve1: 200_000_000n - 1_000n });
    expect(p.ref.address).toBe(c.poolAddr);
    expect(p.extra!.vault0).toBe(c.v0);
  });

  it('refuses pools it cannot price exactly or that cannot be swapped', async () => {
    const run = async (o: Parameters<typeof chain>[0]) => {
      const c = chain(o);
      return new RaydiumCpmmAdapter(web3, c.rpc, () => 1_000_000).getPools(tokens[0]!, tokens[1]!);
    };
    expect(await run({ creatorFee: true })).toEqual([]);
    expect(await run({ program0: TOKEN_2022_PROGRAM_ID })).toEqual([]);
    expect((await run({ status: 4 }))[0]!.status).toBe('inactive');
    expect((await run({ open: 2_000_000_000n }))[0]!.status).toBe('inactive');
  });

  it('ignores accounts not owned by the program, and rejects a pool whose own fields do not match its address', async () => {
    const c = chain();
    const store = c.rpc;
    const spoof: SolRpc = (async (method: string, params: unknown[]) => {
      const r = (await store(method, params)) as { value: ({ owner: string } | null)[] };
      return { value: r.value.map((a, i) => (i === 0 && a ? { ...a, owner: '11111111111111111111111111111111' } : a)) };
    }) as SolRpc;
    expect(await new RaydiumCpmmAdapter(web3, spoof).getPools(tokens[0]!, tokens[1]!)).toEqual([]);
    await expect(adapter.getPools(tokens[0]!, tokens[0]!)).rejects.toThrow();
    await expect(adapter.getPools(tokens[0]!, { chain: 'solana', address: 'not-an-address' })).rejects.toThrow();
  });

  it('parses hostile or short account data safely', () => {
    expect(parsePoolState(web3, new Uint8Array(10))).toBeNull();
    expect(parseConfigState(new Uint8Array(3))).toBeNull();
    expect(tokenAccountAmount(new Uint8Array(10))).toBeNull();
    fc.assert(fc.property(fc.uint8Array({ maxLength: 700 }), (bytes) => {
      parsePoolState(web3, bytes);
      parseConfigState(bytes);
      tokenAccountAmount(bytes);
      return true;
    }));
  });
});

describe('transaction builder', () => {
  const pool = {
    ref: { chain: 'solana' as const, dex: 'raydium-cpmm', address: rnd() },
    model: 'constant-product' as const,
    curve: 'raydium-cpmm' as const,
    token0: { chain: 'solana' as const, address: sortMints(web3, WSOL_MINT, USDC)[0] },
    token1: { chain: 'solana' as const, address: sortMints(web3, WSOL_MINT, USDC)[1] },
    reserve0: 10n ** 12n,
    reserve1: 10n ** 12n,
    feePpm: 2500,
    updatedAt: 0,
    block: null,
    status: 'active' as const,
    extra: { ammConfig: rnd(), vault0: rnd(), vault1: rnd(), program0: TOKEN_PROGRAM_ID, program1: TOKEN_PROGRAM_ID, observation: rnd(), authority: rnd() },
  };
  const sol = { chain: 'solana' as const, address: WSOL_MINT };
  const usdc = { chain: 'solana' as const, address: USDC };
  const step = (over: Partial<CpmmSwapStep> = {}): CpmmSwapStep => ({ pool, tokenIn: sol, tokenOut: usdc, amountIn: 10_000_000n, minOut: 1_000_000n, ...over });
  const blockhash = web3.PublicKey.default.toBase58();

  it("the instruction tag is sha256('global:swap_base_input')[0..8], the value the program uses", async () => {
    expect([...(await swapBaseInputDiscriminator())]).toEqual([143, 190, 90, 218, 196, 30, 51, 222]);
  });

  it('assembles the program account list in order, with the right signer and writable flags and exact data', async () => {
    const ix = await cpmmSwapInstruction(web3, USER, step(), rnd(), rnd());
    expect(ix.programId.toBase58()).toBe(RAYDIUM_CPMM_PROGRAM);
    expect(ix.keys).toHaveLength(13);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
    expect(ix.keys[0]!.pubkey.toBase58()).toBe(USER);
    expect(ix.keys[3]!.pubkey.toBase58()).toBe(pool.ref.address);
    expect(ix.keys.map((k) => k.isWritable)).toEqual([false, false, false, true, true, true, true, true, false, false, false, false, true]);
    const data = Buffer.from(ix.data);
    expect(data.length).toBe(24);
    expect(data.readBigUInt64LE(8)).toBe(10_000_000n);
    expect(data.readBigUInt64LE(16)).toBe(1_000_000n);
    // Direction: selling token0 uses vault0 as input; selling token1 swaps them.
    const sellsToken0 = pool.token0.address === WSOL_MINT;
    const rev = await cpmmSwapInstruction(web3, USER, step({ tokenIn: usdc, tokenOut: sol }), rnd(), rnd());
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(sellsToken0 ? pool.extra.vault0 : pool.extra.vault1);
    expect(rev.keys[6]!.pubkey.toBase58()).toBe(sellsToken0 ? pool.extra.vault1 : pool.extra.vault0);
  });

  it('refuses unsafe steps', async () => {
    await expect(cpmmSwapInstruction(web3, USER, step({ minOut: 0n }), rnd(), rnd())).rejects.toThrow(/minimum/);
    await expect(cpmmSwapInstruction(web3, USER, step({ amountIn: 0n }), rnd(), rnd())).rejects.toThrow();
    await expect(cpmmSwapInstruction(web3, USER, step({ tokenOut: { chain: 'solana', address: rnd() } }), rnd(), rnd())).rejects.toThrow();
    await expect(cpmmSwapInstruction(web3, USER, step({ tokenIn: { chain: 'solana', address: rnd() } }), rnd(), rnd())).rejects.toThrow();
    await expect(cpmmSwapInstruction(web3, USER, step({ amountIn: 1n << 64n }), rnd(), rnd())).rejects.toThrow();
    await expect(cpmmSwapInstruction(web3, USER, { ...step(), pool: { ...pool, extra: undefined } }, rnd(), rnd())).rejects.toThrow();
  });

  it('wraps and unwraps SOL only around the swap, and never closes an account it should leave alone', async () => {
    const native = await buildCpmmSwapTransaction(web3, { user: USER, step: step(), nativeIn: true, nativeOut: false, closeWsol: true, recentBlockhash: blockhash });
    expect(native.steps.join(' ')).toMatch(/Wrap 10000000 lamports/);
    expect(native.steps.join(' ')).toMatch(/Close the temporary wSOL account/);
    const keep = await buildCpmmSwapTransaction(web3, { user: USER, step: step(), nativeIn: true, nativeOut: false, closeWsol: false, recentBlockhash: blockhash });
    expect(keep.steps.join(' ')).not.toMatch(/Close/);
    const out = await buildCpmmSwapTransaction(web3, { user: USER, step: step({ tokenIn: usdc, tokenOut: sol, amountIn: 5n }), nativeIn: false, nativeOut: true, closeWsol: true, recentBlockhash: blockhash });
    expect(out.steps.join(' ')).toMatch(/Unwrap/);
    expect(out.transaction.message.header.numRequiredSignatures).toBe(1);
  });

  it('caps the priority fee', async () => {
    const t = await buildCpmmSwapTransaction(web3, { user: USER, step: step(), nativeIn: true, nativeOut: false, closeWsol: true, recentBlockhash: blockhash, priorityMicroLamports: 10_000_000 });
    expect(t.steps[0]).toContain(`${MAX_PRIORITY_MICRO_LAMPORTS} micro-lamports`);
  });
});

describe('DirectSolanaProvider', () => {
  const adapterForAddresses = new RaydiumCpmmAdapter(web3, (async () => ({})) as never);
  const [m0, m1] = sortMints(web3, WSOL_MINT, USDC);
  const registry = () => new AretiaDexRegistry(SOLANA_DEXES);
  const req: SwapRequest = { chain: 'solana', from: { chain: 'solana', address: WSOL_MINT }, to: { chain: 'solana', address: USDC }, amountIn: 10_000_000n, slippageBps: 100, account: { chain: 'solana', address: USER } };

  /** A fake RPC holding one deep and one shallow pool for SOL/USDC, and a simulator whose answer is controlled. */
  function rpcWith(opts: { sim?: 'ok' | 'fail'; wsolHolds?: boolean; payoutShortfall?: bigint; second?: { fee: bigint; r0: bigint; r1: bigint } } = {}) {
    const store = new Map<string, { data: [string, string]; owner: string; lamports?: number }>();
    const b64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));
    const mk = (index: number, fee: bigint, r0: bigint, r1: bigint) => {
      const config = adapterForAddresses.configAddress(index);
      const poolAddr = adapterForAddresses.poolAddress(config, m0, m1);
      const v0 = rnd();
      const v1 = rnd();
      const d = new Uint8Array(645);
      const put = (o: number, k: string) => d.set(new web3.PublicKey(k).toBytes(), o);
      put(8, config); put(72, v0); put(104, v1); put(168, m0); put(200, m1); put(232, TOKEN_PROGRAM_ID); put(264, TOKEN_PROGRAM_ID); put(296, rnd());
      const cfg = new Uint8Array(236);
      new DataView(cfg.buffer).setUint16(10, index, true);
      new DataView(cfg.buffer).setBigUint64(12, fee, true);
      const tok = (a: bigint) => { const t = new Uint8Array(165); new DataView(t.buffer).setBigUint64(64, a, true); return b64(t); };
      store.set(poolAddr, { data: [b64(d), 'base64'], owner: RAYDIUM_CPMM_PROGRAM });
      store.set(config, { data: [b64(cfg), 'base64'], owner: RAYDIUM_CPMM_PROGRAM });
      store.set(v0, { data: [tok(r0), 'base64'], owner: TOKEN_PROGRAM_ID });
      store.set(v1, { data: [tok(r1), 'base64'], owner: TOKEN_PROGRAM_ID });
      return poolAddr;
    };
    const deep = mk(0, 2500n, 500_000_000_000n, 100_000_000_000n);
    mk(1, opts.second?.fee ?? 10_000n, opts.second?.r0 ?? 5_000_000_000n, opts.second?.r1 ?? 1_000_000_000n);
    const wsolAta = web3.PublicKey.default.toBase58();
    void wsolAta;
    let calls = 0;
    const rpc: SolRpc = (async (method: string, params: unknown[]) => {
      calls++;
      if (method === 'getMultipleAccounts') {
        const addrs = params[0] as string[];
        // Simulation pre-state: the user's lamports and (if watched) token accounts.
        if (addrs[0] === USER) return { value: addrs.map((a, i) => (i === 0 ? { lamports: 10_000_000_000, data: ['', 'base64'], owner: '11111111111111111111111111111111' } : null)) };
        return { value: addrs.map((a) => store.get(a) ?? null) };
      }
      if (method === 'getAccountInfo') {
        if (!opts.wsolHolds) return { value: null };
        const t = new Uint8Array(165);
        new DataView(t.buffer).setBigUint64(64, 5n, true);
        return { value: { data: [b64(t), 'base64'] } };
      }
      if (method === 'getLatestBlockhash') return { value: { blockhash: web3.PublicKey.default.toBase58() } };
      if (method === 'simulateTransaction') {
        if (opts.sim === 'fail') return { value: { err: { InstructionError: [4, 'Custom'] }, logs: ['Program log: Error: ExceededSlippage'], accounts: null } };
        const out = (store.get(deep) ? getAmountOutCpmm(10_000_000n, 500_000_000_000n, 100_000_000_000n, 2500) : 0n) - (opts.payoutShortfall ?? 0n);
        const t = new Uint8Array(165);
        new DataView(t.buffer).setBigUint64(64, out, true);
        t[108] = 1;
        return { value: { err: null, logs: [], unitsConsumed: 40_000, accounts: [{ lamports: 10_000_000_000 - 10_000_000 - 20_000, data: ['', 'base64'] }, { lamports: 2039280, data: [b64(t), 'base64'] }] } };
      }
      throw new Error('unexpected ' + method);
    }) as SolRpc;
    return { rpc, calls: () => calls };
  }
  const provider = (rpc: SolRpc, now = () => 1_000_000) => new DirectSolanaProvider({ web3: async () => web3, rpc, registry: registry(), now });

  it('quotes from pools it read itself and picks the one that pays most', async () => {
    const { rpc } = rpcWith();
    const q = await provider(rpc).getQuote(req);
    expect(q.providerId).toBe('aretia-sol');
    expect(q.expectedOut).toBe(getAmountOutCpmm(10_000_000n, 500_000_000_000n, 100_000_000_000n, 2500));
    expect(q.minOut).toBe((q.expectedOut * 9900n) / 10_000n);
    expect(q.route.legs[0]!.venue).toBe('Raydium CPMM');
    expect((q.raw as { reasons: string[] }).reasons.join(' ')).toMatch(/2 Raydium CPMM pools read/);
  });

  it('splits a large trade between two comparable pools when that pays more, with a floor on each leg', async () => {
    const { rpc } = rpcWith({ second: { fee: 2500n, r0: 400_000_000_000n, r1: 80_000_000_000n } });
    const big = { ...req, amountIn: 100_000_000_000n };
    const q = await provider(rpc).getQuote(big);
    const raw = q.raw as { shape: string; legs: { amountIn: bigint; minOut: bigint }[]; reasons: string[] };
    const single = getAmountOutCpmm(big.amountIn, 500_000_000_000n, 100_000_000_000n, 2500);
    expect(raw.shape).toBe('split');
    expect(raw.legs).toHaveLength(2);
    expect(raw.legs[0]!.amountIn + raw.legs[1]!.amountIn).toBe(big.amountIn);
    expect(q.expectedOut).toBeGreaterThan(single);
    expect(raw.legs.every((l) => l.minOut > 0n)).toBe(true);
    expect(raw.legs[0]!.minOut + raw.legs[1]!.minOut).toBeGreaterThanOrEqual(q.minOut - 2n);
    expect(q.route.legs.map((l) => l.shareBps).reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(raw.reasons.join(' ')).toMatch(/Split/);
  });

  it('does not split a small trade', async () => {
    const q = await provider(rpcWith({ second: { fee: 2500n, r0: 400_000_000_000n, r1: 80_000_000_000n } }).rpc).getQuote(req);
    expect((q.raw as { shape: string }).shape).toBe('direct');
  });

  it('builds an unsigned, inspectable transaction that passes the simulation judge', async () => {
    const { rpc } = rpcWith();
    const p = provider(rpc);
    const q = await p.getQuote(req);
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.blockers).toEqual([]);
    expect(prepared.simulation.ok).toBe(true);
    const payload = prepared.payload as { transaction: web3.VersionedTransaction; steps: string[] };
    expect(payload.transaction.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    expect(payload.steps.some((s) => /Raydium CPMM pool/.test(s))).toBe(true);
    expect(prepared.simulation.warnings.some((w) => /Transaction step/.test(w))).toBe(true);
  });

  it('blocks when the program rejects the swap, and when it would pay less than the minimum', async () => {
    const failing = provider(rpcWith({ sim: 'fail' }).rpc);
    const p1 = await failing.buildTransaction(await failing.getQuote(req));
    expect(p1.simulation.ok).toBe(false);
    expect(p1.simulation.blockers.join(' ')).toMatch(/reject this swap/);

    const short = provider(rpcWith({ payoutShortfall: 1_000_000n }).rpc);
    const p2 = await short.buildTransaction(await short.getQuote(req));
    expect(p2.simulation.ok).toBe(false);
    expect(p2.simulation.blockers.join(' ')).toMatch(/less than your minimum/);
  });

  it('refuses a stale quote, another provider quote, an unavailable venue, and bad requests', async () => {
    const { rpc } = rpcWith();
    const q = await provider(rpc).getQuote(req);
    await expect(provider(rpc, () => 1_000_000 + 60_000).buildTransaction(q)).rejects.toMatchObject({ code: 'expired' });
    await expect(provider(rpc).buildTransaction({ ...q, providerId: 'jupiter' })).rejects.toMatchObject({ code: 'invalid' });
    const reg = registry();
    reg.setStatus('raydium-cpmm', 'MAINTENANCE');
    reg.setStatus('meteora-damm-v2', 'MAINTENANCE');
    reg.setStatus('orca-whirlpool', 'MAINTENANCE');
    const down = new DirectSolanaProvider({ web3: async () => web3, rpc, registry: reg, now: () => 1_000_000 });
    expect(down.supports('solana')).toBe(false);
    await expect(down.getQuote(req)).rejects.toMatchObject({ code: 'no-route' });
    const p = provider(rpc);
    await expect(p.getQuote({ ...req, to: req.from })).rejects.toMatchObject({ code: 'invalid' });
    await expect(p.getQuote({ ...req, amountIn: 0n })).rejects.toMatchObject({ code: 'invalid' });
    await expect(p.getQuote({ ...req, chain: 'base' })).rejects.toThrow();
    expect(p.supports('base')).toBe(false);
  });

  it('warns, and does not unwrap, when the user already holds wrapped SOL', async () => {
    const { rpc } = rpcWith({ wsolHolds: true });
    const p = provider(rpc);
    const q = await p.getQuote({ ...req, from: req.to, to: req.from, amountIn: 1_000_000n });
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.warnings.join(' ')).toMatch(/already hold wrapped SOL/);
    expect((prepared.payload as { steps: string[] }).steps.join(' ')).not.toMatch(/Unwrap/);
  });
});

import { dammSwapDiscriminator, dammSwapInstruction, METEORA_DAMM_V2_PROGRAM, MeteoraDammAdapter, parseDammPool } from './meteoraDamm.js';
import { buildSwapTransaction } from './builder.js';

describe('Meteora DAMM v2', () => {
  const ACT = rnd();
  const MINT_A = ACT;
  const MINT_B = USDC;
  const VAULT_A = rnd();
  const VAULT_B = rnd();
  const POOL = rnd();
  const adapterOnly = new MeteoraDammAdapter(web3, (async () => ({})) as never, []);

  const poolBytes = (o: { status?: number; liquidity?: bigint; activation?: bigint; activationType?: number; mintA?: string; mintB?: string } = {}): Uint8Array => {
    const d = new Uint8Array(1112);
    const view = new DataView(d.buffer);
    const put = (offset: number, key: string) => d.set(new web3.PublicKey(key).toBytes(), offset);
    put(168, o.mintA ?? MINT_A);
    put(200, o.mintB ?? MINT_B);
    put(232, VAULT_A);
    put(264, VAULT_B);
    view.setBigUint64(360, (o.liquidity ?? 10n ** 20n) & ((1n << 64n) - 1n), true);
    view.setBigUint64(368, (o.liquidity ?? 10n ** 20n) >> 64n, true);
    view.setBigUint64(472, o.activation ?? 0n, true);
    d[480] = o.activationType ?? 1;
    d[481] = o.status ?? 0;
    return d;
  };
  const tokenBytes = (amount: bigint) => {
    const t = new Uint8Array(165);
    new DataView(t.buffer).setBigUint64(64, amount, true);
    return t;
  };
  const b64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));

  function rpcFor(state: Parameters<typeof poolBytes>[0] = {}) {
    const store = new Map<string, { data: [string, string]; owner: string }>();
    store.set(POOL, { data: [b64(poolBytes(state)), 'base64'], owner: METEORA_DAMM_V2_PROGRAM });
    store.set(VAULT_A, { data: [b64(tokenBytes(5_000n)), 'base64'], owner: TOKEN_2022_PROGRAM_ID });
    store.set(VAULT_B, { data: [b64(tokenBytes(7n)), 'base64'], owner: TOKEN_PROGRAM_ID });
    store.set(MINT_A, { data: ['', 'base64'], owner: TOKEN_2022_PROGRAM_ID });
    store.set(MINT_B, { data: ['', 'base64'], owner: TOKEN_PROGRAM_ID });
    return (async (method: string, params: unknown[]) => {
      if (method === 'getMultipleAccounts') return { value: (params[0] as string[]).map((a) => store.get(a) ?? null) };
      if (method === 'getSlot') return 100;
      throw new Error('unexpected ' + method);
    }) as SolRpc;
  }
  const pair = [{ chain: 'solana' as const, address: ACT }, { chain: 'solana' as const, address: USDC }] as const;

  it('derives the program authorities by its own seeds', () => {
    expect(adapterOnly.poolAuthority()).toBe('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC');
    expect(adapterOnly.eventAuthority()).toBe('3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet');
  });

  it("the instruction tag is sha256('global:swap')[0..8]", async () => {
    expect([...(await dammSwapDiscriminator())]).toEqual([248, 198, 158, 145, 225, 117, 135, 200]);
  });

  it('parses a pool at the documented offsets', () => {
    const s = parseDammPool(web3, poolBytes({ liquidity: 123n, activation: 77n }))!;
    expect(s).toMatchObject({ tokenAMint: MINT_A, tokenBMint: MINT_B, tokenAVault: VAULT_A, tokenBVault: VAULT_B, liquidity: 123n, activationPoint: 77n, poolStatus: 0, activationType: 1 });
    expect(parseDammPool(web3, new Uint8Array(40))).toBeNull();
    fc.assert(fc.property(fc.uint8Array({ maxLength: 1200 }), (b) => { parseDammPool(web3, b); return true; }));
  });

  it('reads a known pool, takes token programs from the mints, and respects status, activation and liquidity', async () => {
    const mk = (state?: Parameters<typeof poolBytes>[0]) => new MeteoraDammAdapter(web3, rpcFor(state), [POOL], () => 2_000_000_000_000);
    const ok = (await mk().getPools(pair[0], pair[1]))[0]!;
    expect(ok).toMatchObject({ model: 'concentrated', status: 'active', reserve0: 5_000n, reserve1: 7n });
    expect(ok.extra).toMatchObject({ programA: TOKEN_2022_PROGRAM_ID, programB: TOKEN_PROGRAM_ID });
    expect((await mk({ status: 1 }).getPools(pair[0], pair[1]))[0]!.status).toBe('inactive');
    expect((await mk({ activation: 9_999_999_999_999n }).getPools(pair[0], pair[1]))[0]!.status).toBe('inactive');
    expect((await mk({ liquidity: 0n }).getPools(pair[0], pair[1]))[0]!.status).toBe('inactive');
    expect((await mk({ activationType: 0, activation: 50n }).getPools(pair[0], pair[1]))[0]!.status).toBe('active'); // slot 100 >= 50
    expect((await mk({ activationType: 0, activation: 500n }).getPools(pair[0], pair[1]))[0]!.status).toBe('inactive');
  });

  it('ignores pools of another pair or not owned by the program, and rejects bad input', async () => {
    const other = new MeteoraDammAdapter(web3, rpcFor(), [POOL], () => 1);
    expect(await other.getPools(pair[0], { chain: 'solana', address: rnd() })).toEqual([]);
    expect(await new MeteoraDammAdapter(web3, rpcFor(), [], () => 1).getPools(pair[0], pair[1])).toEqual([]);
    const spoof = (async (m: string, p: unknown[]) => {
      const r = (await rpcFor()(m, p)) as { value: ({ owner: string } | null)[] };
      return { value: r.value.map((a, i) => (i === 0 && a ? { ...a, owner: '11111111111111111111111111111111' } : a)) };
    }) as SolRpc;
    expect(await new MeteoraDammAdapter(web3, spoof, [POOL], () => 1).getPools(pair[0], pair[1])).toEqual([]);
    await expect(other.getPools(pair[0], pair[0])).rejects.toThrow();
  });

  it('assembles the swap instruction with the program account order, signer and writable flags, and exact data', async () => {
    const pool = (await new MeteoraDammAdapter(web3, rpcFor(), [POOL], () => 1).getPools(pair[0], pair[1]))[0]!;
    const ix = await dammSwapInstruction(web3, USER, pool, rnd(), rnd(), 1_234n, 99n);
    expect(ix.programId.toBase58()).toBe(METEORA_DAMM_V2_PROGRAM);
    expect(ix.keys).toHaveLength(14);
    expect(ix.keys[8]).toMatchObject({ isSigner: true, isWritable: false });
    expect(ix.keys[8]!.pubkey.toBase58()).toBe(USER);
    expect(ix.keys.map((k) => k.isWritable)).toEqual([false, true, true, true, true, true, false, false, false, false, false, false, false, false]);
    expect(ix.keys[1]!.pubkey.toBase58()).toBe(POOL);
    expect(ix.keys[9]!.pubkey.toBase58()).toBe(TOKEN_2022_PROGRAM_ID);
    expect(ix.keys[10]!.pubkey.toBase58()).toBe(TOKEN_PROGRAM_ID);
    expect(ix.keys[11]!.pubkey.toBase58()).toBe(METEORA_DAMM_V2_PROGRAM); // no referral account
    const data = Buffer.from(ix.data);
    expect([...data.subarray(0, 8)]).toEqual([248, 198, 158, 145, 225, 117, 135, 200]);
    expect(data.readBigUInt64LE(8)).toBe(1_234n);
    expect(data.readBigUInt64LE(16)).toBe(99n);
    await expect(dammSwapInstruction(web3, USER, pool, rnd(), rnd(), 1n, 0n)).rejects.toThrow(/minimum/);
    await expect(dammSwapInstruction(web3, USER, pool, rnd(), rnd(), 0n, 1n)).rejects.toThrow();
    await expect(dammSwapInstruction(web3, USER, { ...pool, extra: undefined }, rnd(), rnd(), 1n, 1n)).rejects.toThrow();
  });

  it('uses the Token-2022 program for the associated account of a Token-2022 mint, and wraps native SOL only when selling it', async () => {
    const pool = (await new MeteoraDammAdapter(web3, rpcFor(), [POOL], () => 1).getPools(pair[0], pair[1]))[0]!;
    const built = await buildSwapTransaction(web3, {
      user: USER, tokenIn: pair[1], tokenOut: pair[0], programIn: TOKEN_PROGRAM_ID, programOut: TOKEN_2022_PROGRAM_ID, amountIn: 1_000n, nativeIn: false, nativeOut: false, closeWsol: false,
      recentBlockhash: web3.PublicKey.default.toBase58(), swapLabel: 'swap', swapInstruction: (i, o) => dammSwapInstruction(web3, USER, pool, i, o, 1_000n, 1n),
    });
    expect(built.outAccount).not.toBe(web3.PublicKey.findProgramAddressSync([new web3.PublicKey(USER).toBytes(), new web3.PublicKey(TOKEN_PROGRAM_ID).toBytes(), new web3.PublicKey(ACT).toBytes()], new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58());
    expect(built.steps.join(' ')).not.toMatch(/Wrap/);
  });
});

describe('DirectSolanaProvider with DAMM v2 (the program is the quoter)', () => {
  const adapterAddr = new MeteoraDammAdapter(web3, (async () => ({})) as never, []);
  void adapterAddr;
  const POOL = rnd();
  const ACT = rnd();
  const VA = rnd();
  const VB = rnd();
  const b64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));
  const reg = () => {
    const entries = SOLANA_DEXES.map((e) => (e.id === 'meteora-damm-v2' ? { ...e, knownPools: [POOL] } : e));
    return new AretiaDexRegistry(entries);
  };
  const mintsSorted = ACT;
  void mintsSorted;
  const req: SwapRequest = { chain: 'solana', from: { chain: 'solana', address: USDC }, to: { chain: 'solana', address: ACT }, amountIn: 1_000_000n, slippageBps: 100, account: { chain: 'solana', address: USER } };

  function rpc(o: { delivered?: bigint; fail?: boolean } = {}) {
    const store = new Map<string, { data: [string, string]; owner: string }>();
    const d = new Uint8Array(1112);
    const put = (off: number, k: string) => d.set(new web3.PublicKey(k).toBytes(), off);
    put(168, ACT); put(200, USDC); put(232, VA); put(264, VB);
    new DataView(d.buffer).setBigUint64(360, 10n ** 18n, true);
    d[480] = 1;
    // State byte 1 = initialised: the judge ignores uninitialised token accounts, as the real chain does.
    const tok = (a: bigint) => { const t = new Uint8Array(165); new DataView(t.buffer).setBigUint64(64, a, true); t[108] = 1; return b64(t); };
    store.set(POOL, { data: [b64(d), 'base64'], owner: METEORA_DAMM_V2_PROGRAM });
    store.set(VA, { data: [tok(1_000_000n), 'base64'], owner: TOKEN_2022_PROGRAM_ID });
    store.set(VB, { data: [tok(1_000n), 'base64'], owner: TOKEN_PROGRAM_ID });
    store.set(ACT, { data: ['', 'base64'], owner: TOKEN_2022_PROGRAM_ID });
    store.set(USDC, { data: ['', 'base64'], owner: TOKEN_PROGRAM_ID });
    return (async (method: string, params: unknown[]) => {
      if (method === 'getMultipleAccounts') {
        const addrs = params[0] as string[];
        if (addrs[0] === USER) return { value: addrs.map((_, i) => (i === 0 ? { lamports: 10_000_000_000, data: ['', 'base64'], owner: '1' } : { data: [tok(5_000_000n), 'base64'], owner: TOKEN_PROGRAM_ID })).map((x, i) => (i === 2 ? null : x)) };
        return { value: addrs.map((a) => store.get(a) ?? null) };
      }
      if (method === 'getAccountInfo') return { value: null };
      if (method === 'getLatestBlockhash') return { value: { blockhash: web3.PublicKey.default.toBase58() } };
      if (method === 'simulateTransaction') {
        if (o.fail) return { value: { err: { InstructionError: [4, 'Custom'] }, logs: ['Program log: Error: ExceededSlippage'], accounts: null } };
        return { value: { err: null, logs: [], unitsConsumed: 36_000, accounts: [{ lamports: 9_999_990_000, data: ['', 'base64'] }, { data: [tok(4_000_000n), 'base64'] }, { data: [tok(o.delivered ?? 195_000n), 'base64'] }] } };
      }
      throw new Error('unexpected ' + method);
    }) as SolRpc;
  }
  const provider = (r: SolRpc, now = () => 1_000_000) => new DirectSolanaProvider({ web3: async () => web3, rpc: r, registry: reg(), now });

  it('quotes the amount the program reports when the swap is simulated, with the comparison in the reasoning', async () => {
    const q = await provider(rpc({ delivered: 195_000n })).getQuote(req);
    expect(q.expectedOut).toBe(195_000n);
    expect(q.minOut).toBe((195_000n * 9900n) / 10_000n);
    expect((q.raw as { shape: string; legs: { entryId: string }[] }).legs[0]!.entryId).toBe('meteora-damm-v2');
    expect((q.raw as { reasons: string[] }).reasons.join(' ')).toMatch(/priced by the program itself/);
    expect(q.route.legs[0]!.venue).toBe('Meteora DAMM v2');
  });

  it('builds the real swap with the floor set from the answer, and blocks when the program later pays less', async () => {
    const p = provider(rpc({ delivered: 195_000n }));
    const q = await p.getQuote(req);
    const ok = await p.buildTransaction(q);
    expect(ok.simulation.blockers).toEqual([]);
    expect(ok.simulation.warnings.some((w) => /Meteora DAMM v2 pool/.test(w))).toBe(true);
    const worse = provider(rpc({ delivered: 100_000n }));
    const prepared = await worse.buildTransaction({ ...q });
    expect(prepared.simulation.ok).toBe(false);
    expect(prepared.simulation.blockers.join(' ')).toMatch(/less than your minimum/);
  });

  it('reports no route when the program rejects the probe swap (for example the account lacks the input token)', async () => {
    await expect(provider(rpc({ fail: true })).getQuote(req)).rejects.toMatchObject({ code: 'no-route' });
  });
});
