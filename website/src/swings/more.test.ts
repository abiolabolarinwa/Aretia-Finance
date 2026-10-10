import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { isChainEnabled, parseStatus, type RuntimeConfig } from './runtime.js';
import { assessMevExposure } from './core/mev.js';
import { SwapHistory, type HistoryItem, type StorageLike } from './history.js';
import { BeaconSink, toWire } from './observability/beacon.js';
import { decodeAbiString, evmGasProblem, publicRead, readBalance, readErc20 } from './chains/evmSession.js';
import { sourceVerified, zeroXTokenTax } from './tokens/explorer.js';
import { EvmTokenEnricher, SolanaTokenEnricher } from './tokens/enrich.js';
import { assessSolanaToken } from './tokens/risk.js';
import { Evm0xProvider, ZEROX_ALLOWANCE_HOLDER, ZEROX_TRUSTED_CONTRACTS } from './providers/evm0x.js';
import { AretiaRouter } from './router/router.js';
import { EVM_NATIVE_ADDRESS, type SwapRequest } from './core/types.js';

const ADDR = '0x' + '1'.repeat(40);
const TOKEN = '0x' + '2'.repeat(40);

describe('runtime enablement', () => {
  const base: RuntimeConfig = { evmConfigured: false, evmChains: [], tokensConfigured: false, analytics: false, aggregators: true, loaded: true };
  it('is all off by default and for hostile status bodies', () => {
    for (const body of [null, 'x', 42, [], {}, { evm: 'yes' }, { evm: { configured: 'true', chains: 'base' } }]) {
      const s = parseStatus(body);
      expect(s.evmChains).toEqual([]);
      expect(s.evmConfigured).toBe(false);
    }
  });
  it('lists only real EVM chains', () => {
    expect(parseStatus({ evm: { configured: true, chains: ['base', 'solana', 'dogechain', 'polygon'] } }).evmChains).toEqual(['base', 'polygon']);
  });
  it('the operator list alone enables an EVM chain: Aretia\'s own router needs no third-party key', () => {
    expect(parseStatus({ evm: { configured: false, chains: ['base'] } }).evmChains).toEqual(['base']);
    expect(isChainEnabled('solana', base)).toBe(true);
    expect(isChainEnabled('base', base)).toBe(false);
    expect(isChainEnabled('base', { ...base, evmChains: ['base'] })).toBe(true);
    expect(isChainEnabled('ethereum', { ...base, evmChains: ['base'] })).toBe(false);
  });
});

describe('MEV exposure', () => {
  it('rises with slippage and with the trade moving the price', () => {
    expect(assessMevExposure(50, 20).level).toBe('low');
    expect(assessMevExposure(100, 20).level).toBe('elevated');
    expect(assessMevExposure(50, 150).level).toBe('elevated');
    expect(assessMevExposure(300, 20).level).toBe('high');
    expect(assessMevExposure(50, 400).level).toBe('high');
  });
  it('says when the impact is unknown and never claims protection', () => {
    const a = assessMevExposure(50, null);
    expect(a.note).toMatch(/could not be measured/);
    expect(a.note.toLowerCase()).not.toMatch(/protected from|fully protected|safe from/);
  });
  it('property: more slippage never lowers the level', () => {
    const rank = { low: 0, elevated: 1, high: 2 } as const;
    fc.assert(fc.property(fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 0, max: 5000 }), fc.option(fc.integer({ min: 0, max: 5000 }), { nil: null }), (a, b, impact) => rank[assessMevExposure(Math.max(a, b), impact).level] >= rank[assessMevExposure(Math.min(a, b), impact).level]));
  });
});

describe('swap history', () => {
  const mem = (): StorageLike & { data: Record<string, string> } => {
    const data: Record<string, string> = {};
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
  };
  const item = (over: Partial<HistoryItem> = {}): HistoryItem => ({ id: 'a', at: 1, account: ADDR, chain: 'base', provider: '0x', fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: '5', expectedOut: '0.002', txId: null, status: 'submitted', ...over });

  it('stores per account, newest first, and replaces by id', () => {
    const h = new SwapHistory(mem());
    h.save(item({ id: 'a', at: 1 }));
    h.save(item({ id: 'b', at: 2 }));
    h.save(item({ id: 'c', account: '0x' + '9'.repeat(40) }));
    h.save(item({ id: 'a', at: 3, status: 'confirmed' }));
    expect(h.list(ADDR).map((i) => i.id)).toEqual(['a', 'b']);
    expect(h.list(ADDR.toUpperCase().replace('0X', '0x'))).toHaveLength(2);
    expect(h.list(null)).toEqual([]);
  });
  it('updates a status', () => {
    const h = new SwapHistory(mem());
    h.save(item());
    h.setStatus('a', 'confirmed');
    expect(h.list(ADDR)[0]!.status).toBe('confirmed');
  });
  it('works without storage, with a throwing storage and with corrupt data', () => {
    expect(() => new SwapHistory(null).save(item())).not.toThrow();
    expect(new SwapHistory(null).list(ADDR)).toEqual([]);
    const bad: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => new SwapHistory(bad).save(item())).not.toThrow();
    expect(new SwapHistory(bad).list(ADDR)).toEqual([]);
    const corrupt = mem();
    corrupt.setItem('aretia-swings-history-v1', '[{"id":1},"x",null]');
    expect(new SwapHistory(corrupt).list(ADDR)).toEqual([]);
  });
  it('keeps at most 100 items', () => {
    const h = new SwapHistory(mem());
    for (let i = 0; i < 130; i++) h.save(item({ id: `i${i}`, at: i }));
    expect(h.list(ADDR)).toHaveLength(100);
  });
});

describe('analytics beacon', () => {
  it('sends only allow-listed, address-free fields', () => {
    const wire = toWire({ at: 1, event: { name: 'swap', chain: 'base', provider: '0x', status: 'confirmed', ms: 4000, account: ADDR, txId: 'abc', amount: '5' } });
    expect(wire).toEqual({ name: 'swap', chain: 'base', provider: '0x', status: 'confirmed', ms: 4000 });
    expect(toWire({ at: 1, event: { name: 'rpc_failed' } })).toBeNull();
    expect(toWire({ at: 1, event: { name: 'routes_found', chain: 'solana', count: 2, best: 'jupiter', ms: 12 } })).toMatchObject({ provider: 'jupiter', count: 2 });
  });
  it('sends nothing unless enabled, and batches', () => {
    const send = vi.fn();
    let on = false;
    const sink = new BeaconSink(() => on, send);
    for (let i = 0; i < 10; i++) sink.write({ at: 1, event: { name: 'quote_failed', provider: 'x' } });
    expect(send).not.toHaveBeenCalled();
    on = true;
    for (let i = 0; i < 10; i++) sink.write({ at: 1, event: { name: 'quote_failed', provider: 'x' } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0] as string).events).toHaveLength(10);
  });
  it('a failing send is swallowed', () => {
    const sink = new BeaconSink(() => true, () => { throw new Error('offline'); });
    sink.write({ at: 1, event: { name: 'swap', provider: 'x', status: 'failed' } });
    expect(() => sink.flush()).not.toThrow();
  });
});

describe('EVM reads', () => {
  const encodeString = (s: string) => '0x' + '20'.padStart(64, '0') + s.length.toString(16).padStart(64, '0') + [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');
  it('decodes ABI strings and bytes32 symbols, and refuses malformed data', () => {
    expect(decodeAbiString(encodeString('USDC'))).toBe('USDC');
    expect(decodeAbiString('0x' + '4d4b52'.padEnd(64, '0'))).toBe('MKR');
    expect(decodeAbiString('0x')).toBeNull();
    expect(decodeAbiString('zz')).toBeNull();
    expect(decodeAbiString('0x' + '20'.padStart(64, '0') + 'f'.repeat(64))).toBeNull();
    expect(decodeAbiString(42)).toBeNull();
  });
  it('property: decoding hostile hex never throws', () => {
    fc.assert(fc.property(fc.string(), (s) => { decodeAbiString(s); return true; }));
    fc.assert(fc.property(fc.stringMatching(/^0x([0-9a-f]{2}){0,200}$/), (s) => { decodeAbiString(s); return true; }));
  });
  it('reads token facts from the chain, and returns null for non-tokens', async () => {
    const read = vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'eth_getCode') return '0x6080';
      const data = (params[0] as { data: string }).data;
      if (data === '0x313ce567') return '0x' + '6'.padStart(64, '0');
      if (data === '0x95d89b41') return encodeString('USDC');
      return encodeString('USD Coin');
    });
    expect(await readErc20(read, TOKEN)).toEqual({ symbol: 'USDC', name: 'USD Coin', decimals: 6 });
    expect(await readErc20(async () => '0x', TOKEN)).toBeNull();
    expect(await readErc20(async (m) => (m === 'eth_getCode' ? '0x6080' : '0x' + '99'.padStart(64, '0')), TOKEN)).toBeNull();
    expect(await readErc20(async () => Promise.reject(new Error('down')), TOKEN)).toBeNull();
  });
  it('reads balances and rejects garbage', async () => {
    expect(await readBalance(async () => '0x10', ADDR, EVM_NATIVE_ADDRESS)).toBe(16n);
    expect(await readBalance(async () => '0x', ADDR, TOKEN)).toBe(0n);
    await expect(readBalance(async () => 'nope', ADDR, TOKEN)).rejects.toMatchObject({ code: 'invalid' });
  });
  it('turns node errors into clear messages', async () => {
    const fail = (async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }))) as unknown as typeof fetch;
    await expect(publicRead('base', fail)('eth_chainId', [])).rejects.toThrow(/rate limited/);
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(publicRead('base', down)('eth_chainId', [])).rejects.toThrow(/503/);
    expect(() => publicRead('solana')).toThrow();
  });
  it('flags insufficient gas for token and native sells', () => {
    const args = { nativeSymbol: 'ETH', amountIn: 1_000n };
    expect(evmGasProblem({ ...args, nativeBalance: 10n, networkFee: 50n, sellsNative: false })).toMatch(/more ETH/);
    expect(evmGasProblem({ ...args, nativeBalance: 100n, networkFee: 50n, sellsNative: false })).toBeNull();
    expect(evmGasProblem({ ...args, nativeBalance: 1_000n, networkFee: 50n, sellsNative: true })).toMatch(/more ETH/);
    expect(evmGasProblem({ ...args, nativeBalance: 1_050n, networkFee: 50n, sellsNative: true })).toBeNull();
    expect(evmGasProblem({ ...args, nativeBalance: 0n, networkFee: null, sellsNative: false })).toBeNull();
  });
});

describe('optional EVM signals', () => {
  const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('source verification: true, false, and null when unconfigured or odd', async () => {
    expect(await sourceVerified(json({ status: '1', result: [{ SourceCode: 'contract X {}' }] }), 'base', TOKEN, 'k')).toBe(true);
    expect(await sourceVerified(json({ status: '1', result: [{ SourceCode: '' }] }), 'base', TOKEN, 'k')).toBe(false);
    expect(await sourceVerified(json({ status: '0', result: 'Invalid' }), 'base', TOKEN, 'k')).toBeNull();
    expect(await sourceVerified(json({}), 'base', TOKEN, undefined)).toBeNull();
    expect(await sourceVerified(json({}, 500), 'base', TOKEN, 'k')).toBeNull();
    expect(await sourceVerified(json({}), 'solana', TOKEN, 'k')).toBeNull();
  });
  it('token tax: reads 0x metadata strictly and returns null otherwise', async () => {
    expect(await zeroXTokenTax(json({ tokenMetadata: { buyToken: { buyTaxBps: '300', sellTaxBps: 5000 } } }), 'base', TOKEN, 'k')).toEqual({ buyBps: 300, sellBps: 5000 });
    expect(await zeroXTokenTax(json({ tokenMetadata: { buyToken: { buyTaxBps: 'x' } } }), 'base', TOKEN, 'k')).toBeNull();
    expect(await zeroXTokenTax(json({}), 'base', TOKEN, 'k')).toBeNull();
    expect(await zeroXTokenTax(json({}), 'base', TOKEN, undefined)).toBeNull();
  });
  it('the EVM enricher turns a reported sell tax into a restricted classification', async () => {
    const rpc = (async (method: string) => (method === 'eth_getCode' ? '0x6080' + '63' + '8da5cb5b' : '0x' + '0'.repeat(64))) as never;
    const enricher = new EvmTokenEnricher(rpc, () => 1_000_000, { sourceVerified: async () => false, tax: async () => ({ buyBps: 0, sellBps: 9000 }) });
    const out = await enricher.enrich({ ref: { chain: 'base', address: TOKEN }, source: 't', liquidityUsd: 1e6, pool: { venue: 'x', address: 'p' }, firstPoolAt: 0 });
    expect(out!.risk.status).toBe('restricted');
    expect(out!.risk.signals.find((x) => x.id === 'source')!.state).toBe('warn');
  });
});

describe('Solana holder concentration excludes program-controlled accounts', () => {
  const TOKENP = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const mint = () => {
    const b = new Uint8Array(82);
    new DataView(b.buffer).setBigUint64(36, 1000n, true);
    b[44] = 6;
    b[45] = 1;
    return btoa(String.fromCharCode(...b));
  };
  it('reports the wallet share when owners can be read', async () => {
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'getAccountInfo') return { value: { owner: TOKENP, data: [mint(), 'base64'] } };
      if (method === 'getTokenLargestAccounts') return { value: [{ address: 'vault', amount: '700' }, { address: 'whale', amount: '100' }] };
      const first = (params[0] as string[])[0];
      if (first === 'vault') return { value: [{ data: { parsed: { info: { owner: 'poolPda' } } } }, { data: { parsed: { info: { owner: 'walletOwner' } } } }] };
      return { value: [null, { owner: '11111111111111111111111111111111' }] }; // pool PDA has no account; wallet is system-owned
    }) as never;
    const out = await new SolanaTokenEnricher(rpc, () => 1).enrich({ ref: { chain: 'solana', address: 'Mint' }, source: 't' });
    const sig = out!.risk.signals.find((x) => x.id === 'concentration')!;
    expect(sig.detail).toContain('10%');
    expect(sig.detail).toContain('excluded');
  });
  it('falls back to the overall figure, and says so, when owners cannot be read', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'getAccountInfo') return { value: { owner: TOKENP, data: [mint(), 'base64'] } };
      if (method === 'getTokenLargestAccounts') return { value: [{ address: 'vault', amount: '700' }] };
      throw new Error('rpc');
    }) as never;
    const out = await new SolanaTokenEnricher(rpc, () => 1).enrich({ ref: { chain: 'solana', address: 'Mint' }, source: 't' });
    expect(out!.risk.signals.find((x) => x.id === 'concentration')!.detail).toContain('may be included');
  });
  it('the risk text matches the basis used', () => {
    const wallets = assessSolanaToken({ top10Pct: 30, top10Basis: 'wallets' }).signals.find((x) => x.id === 'concentration')!;
    expect(wallets.detail).toContain('wallets');
  });
});

describe('0x trusted contracts and token taxes', () => {
  const user = '0x' + '1'.repeat(40);
  const request: SwapRequest = { chain: 'base', from: { chain: 'base', address: TOKEN }, to: { chain: 'base', address: '0x' + '3'.repeat(40) }, amountIn: 1_000_000n, slippageBps: 100, account: { chain: 'base', address: user } };
  const response = (tax?: { buyTaxBps?: string; sellTaxBps?: string }, to = ZEROX_ALLOWANCE_HOLDER) => ({
    buyAmount: '5000', minBuyAmount: '4950', liquidityAvailable: true, route: { fills: [] }, issues: { allowance: null, balance: null },
    transaction: { to, data: '0xdead', value: '0', gas: '100000' }, ...(tax ? { tokenMetadata: { buyToken: tax } } : {}),
  });
  const provider = (body: unknown) => new Evm0xProvider({ quote: async () => body, rpc: async () => '0x', now: () => 1 });

  it('ships the AllowanceHolder from 0x docs for the four EVM chains and nothing for Solana', () => {
    expect(Object.keys(ZEROX_TRUSTED_CONTRACTS).sort()).toEqual(['base', 'bnb', 'ethereum', 'polygon']);
    for (const c of Object.values(ZEROX_TRUSTED_CONTRACTS)) expect(c!.swapTargets).toEqual([ZEROX_ALLOWANCE_HOLDER]);
  });
  it('builds against the documented address and refuses any other target by default', async () => {
    const ok = provider(response());
    expect((await ok.buildTransaction(await ok.getQuote(request))).simulation.ok).toBe(true);
    const bad = provider(response(undefined, '0x' + '9'.repeat(40)));
    await expect(bad.buildTransaction(await bad.getQuote(request))).rejects.toMatchObject({ code: 'invalid' });
  });
  it('blocks a token 0x reports as unsellable, warns on high tax, and says when tax is unknown', async () => {
    const trap = provider(response({ buyTaxBps: '0', sellTaxBps: '9000' }));
    const t = (await trap.buildTransaction(await trap.getQuote(request))).simulation;
    expect(t.ok).toBe(false);
    expect(t.blockers.join(' ')).toMatch(/sell tax/);
    const taxed = provider(response({ buyTaxBps: '500', sellTaxBps: '500' }));
    const w = (await taxed.buildTransaction(await taxed.getQuote(request))).simulation;
    expect(w.ok).toBe(true);
    expect(w.warnings.join(' ')).toMatch(/5\.0% tax/);
    const unknown = provider(response());
    expect((await unknown.buildTransaction(await unknown.getQuote(request))).simulation.warnings.join(' ')).toMatch(/could not be checked/);
  });
  it('the router can run end to end with the live EVM provider logic and a fake wallet adapter', async () => {
    const sends: unknown[] = [];
    const adapter = { chain: 'base' as const, getBalance: async () => 0n, getStatus: async () => 'confirmed' as const, signAndSubmit: async () => { sends.push(1); return '0x' + 'ab'.repeat(32); } };
    const router = new AretiaRouter({ providers: [provider(response())], adapters: [adapter], isChainEnabled: () => true, now: () => 2 });
    const q = await router.getQuote(request);
    const p = await router.buildTransaction(q);
    const ex = await router.executeRoute(p, q, { quoteId: q.id, confirmed: true });
    expect(ex.status).toBe('submitted');
    expect(sends).toHaveLength(1);
  });
});

describe('proxied EVM tokens are analysed through their implementation', () => {
  const IMPL = '0x' + '5'.repeat(40);
  const proxyCode = '0x6080' + '63' + '5c60da1b';
  const implCode = '0x6080' + '63' + 'f9f92be4' + '63' + '8456cb59' + '63' + '40c10f19';
  const rpcFor = (slotValue: string) =>
    (async (method: string, params: unknown[]) => {
      if (method === 'eth_getCode') return params[0] === IMPL ? implCode : proxyCode;
      if (method === 'eth_getStorageAt') return slotValue;
      return '0x' + '0'.repeat(64);
    }) as never;
  const run = (slotValue: string) => new EvmTokenEnricher(rpcFor(slotValue), () => 1).enrich({ ref: { chain: 'ethereum', address: TOKEN }, source: 't', liquidityUsd: 1e6, pool: { venue: 'x', address: 'p' }, firstPoolAt: 0 });

  it('finds blacklist, pause and mint behind an EIP-1967 proxy', async () => {
    const out = await run('0x' + '0'.repeat(24) + '5'.repeat(40));
    const state = (id: string) => out!.risk.signals.find((x) => x.id === id)!.state;
    expect(state('proxy')).toBe('warn');
    expect(state('blacklist')).toBe('warn');
    expect(state('pause')).toBe('warn');
    expect(state('mint')).toBe('warn');
    expect(out!.metadata.implementation).toBe(IMPL);
  });
  it('does not pretend: with no readable implementation the proxy flag still stands and no implementation is claimed', async () => {
    const out = await run('0x' + '0'.repeat(64));
    expect(out!.risk.signals.find((x) => x.id === 'proxy')!.state).toBe('warn');
    expect(out!.metadata.implementation).toBeNull();
  });
  it('reads the target out of a minimal proxy', async () => {
    const { minimalProxyTarget } = await import('./tokens/enrich.js');
    expect(minimalProxyTarget('0x363d3d373d3d3d363d73' + 'ab'.repeat(20) + '5af43d82803e903d91602b57fd5bf3')).toBe('0x' + 'ab'.repeat(20));
    expect(minimalProxyTarget('0x6080')).toBeNull();
  });
  it('asks a second node when the first refuses the request, as publicnode does for a receipt it has not seen yet', async () => {
    const urls: string[] = [];
    const refuses = (async (url: string) => {
      urls.push(url);
      return url.includes('publicnode') ? new Response('{"error":{"message":"Archive requests require a personal token"}}', { status: 403 }) : new Response(JSON.stringify({ result: null }));
    }) as unknown as typeof fetch;
    expect(await publicRead('bnb', refuses)('eth_getTransactionReceipt', ['0x01'])).toBeNull();
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('publicnode');
    expect(urls[1]).not.toContain('publicnode');
  });
  it('says the node refused only when every node did', async () => {
    const all403 = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(publicRead('bnb', all403)('eth_chainId', [])).rejects.toThrow(/403/);
  });
  it('a public read retries once after a network drop but not after a node error', async () => {
    let calls = 0;
    const flaky = (async () => {
      if (++calls === 1) throw new TypeError('network');
      return new Response(JSON.stringify({ result: '0x1' }));
    }) as unknown as typeof fetch;
    expect(await publicRead('base', flaky)('eth_chainId', [])).toBe('0x1');
    expect(calls).toBe(2);
    let errCalls = 0;
    const erroring = (async () => {
      errCalls++;
      return new Response(JSON.stringify({ error: { message: 'bad' } }));
    }) as unknown as typeof fetch;
    await expect(publicRead('base', erroring)('x', [])).rejects.toThrow('bad');
    expect(errCalls).toBe(1);
  });
});

describe('Established classification', () => {
  const deep = { liquidityUsd: 9e6, volume24hUsd: 1e6, poolCount: 3, ageHours: 24 * 400 };
  it('describes a long, deep, active track record without hiding admin powers', async () => {
    const { assessEvmToken, RISK_LABELS } = await import('./tokens/risk.js');
    const usdcLike = assessEvmToken({ ...deep, owner: 'set', isProxy: true, canMint: true, canBlacklist: true, canPause: true });
    expect(usdcLike.status).toBe('established');
    expect(usdcLike.score).toBeGreaterThanOrEqual(60);
    expect(usdcLike.signals.filter((s) => s.state === 'warn').length).toBeGreaterThanOrEqual(4);
    expect(RISK_LABELS.established).toBe('Established');
  });
  it('is never given to a token with a serious red flag, or one that is too young or too thin', async () => {
    const { assessEvmToken, assessSolanaToken } = await import('./tokens/risk.js');
    expect(assessEvmToken({ ...deep, owner: 'renounced', sellTaxPct: 20, buyTaxPct: 0 }).status).not.toBe('established');
    expect(assessEvmToken({ ...deep, owner: 'renounced', sellTaxPct: 90 }).status).toBe('restricted');
    expect(assessSolanaToken({ mintAuthoritySet: false, freezeAuthoritySet: false, top10Pct: 90, ...deep }).status).not.toBe('established');
    expect(assessSolanaToken({ mintAuthoritySet: false, freezeAuthoritySet: false, top10Pct: 10, ...deep, ageHours: 100 }).status).not.toBe('established');
    expect(assessSolanaToken({ mintAuthoritySet: false, freezeAuthoritySet: false, top10Pct: 10, ...deep, liquidityUsd: 100_000 }).status).not.toBe('established');
  });
});

describe('staged rollout (canary wallets)', () => {
  const cfg = (canary: string[] | null | undefined): RuntimeConfig => ({ evmConfigured: false, evmChains: [], tokensConfigured: false, analytics: false, aggregators: true, canary, loaded: true });
  it('allows everyone when no list is set, and only listed wallets when one is', async () => {
    const { canaryHashes } = await import('../../api/_swingsStatus');
    const { isCanaryAllowed, hashAddress } = await import('./runtime.js');
    expect(canaryHashes(undefined)).toBeNull();
    expect(canaryHashes(' , ')).toBeNull();
    expect(await isCanaryAllowed(null, cfg(null))).toBe(true);
    expect(await isCanaryAllowed(ADDR, cfg(undefined))).toBe(true);
    const list = canaryHashes(`${ADDR.toUpperCase().replace('0X', '0x')}, 5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9`)!;
    expect(list).toHaveLength(2);
    expect(list.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(await isCanaryAllowed(ADDR, cfg(list))).toBe(true); // EVM addresses match whatever the case
    expect(await isCanaryAllowed('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', cfg(list))).toBe(true);
    expect(await isCanaryAllowed('0x' + '9'.repeat(40), cfg(list))).toBe(false);
    expect(await isCanaryAllowed(null, cfg(list))).toBe(false);
    // The browser and the server hash the same way.
    expect(await hashAddress(ADDR)).toBe(list[0]);
  });
  it('parses only well-formed hashes from a status response, and never trusts anything else', () => {
    const good = 'a'.repeat(64);
    expect(parseStatus({ canary: [good, 'zz', 5, null] }).canary).toEqual([good]);
    expect(parseStatus({ canary: 'everyone' }).canary).toBeNull();
    expect(parseStatus({}).canary).toBeNull();
  });
});
