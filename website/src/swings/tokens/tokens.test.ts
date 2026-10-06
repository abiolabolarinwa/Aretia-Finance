import { describe, expect, it, vi } from 'vitest';
import { assessEvmToken, assessSolanaToken, MIN_SIGNALS_FOR_SCORE, RISK_LABELS } from './risk.js';
import { ageInfo, cleanLogo, cleanText, InMemoryTokenRepository, TokenRegistryService } from './registry.js';
import { TokenDiscoveryWorker, type DiscoverySource } from './discovery.js';
import { parseNewPools, GeckoTerminalNewPoolsSource } from './sources/geckoTerminal.js';
import { evmFactsFromCode, parseMintFacts, SolanaTokenEnricher } from './enrich.js';
import { fromRow, toRow } from './supabase.js';

const MINT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_B = 'So11111111111111111111111111111111111111112';
const EVM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

describe('risk engine', () => {
  it('scores a Solana token with named, explainable signals', () => {
    const r = assessSolanaToken({ mintAuthoritySet: true, freezeAuthoritySet: false, top10Pct: 90, liquidityUsd: 5_000, volume24hUsd: 100, poolCount: 1, ageHours: 0.5 });
    expect(r.score).toBe(25 + 25 + 20 + 12);
    expect(r.status).toBe('high');
    expect(r.signals.find((s) => s.id === 'mint-authority')).toMatchObject({ state: 'warn', weight: 25 });
    expect(r.signals.every((s) => s.detail.length > 0)).toBe(true);
  });

  it('does not guess: unknown signals are listed and add nothing', () => {
    const r = assessSolanaToken({ mintAuthoritySet: false, freezeAuthoritySet: false, liquidityUsd: 2_000_000, poolCount: 3 });
    expect(r.unavailable).toEqual(expect.arrayContaining(['Holder concentration', 'Trading activity', 'Token age']));
    expect(r.score).toBe(0);
  });

  it('refuses to score on too little evidence', () => {
    const r = assessSolanaToken({ mintAuthoritySet: false });
    expect(r.score).toBeNull();
    expect(r.status).toBe('unknown');
    expect(MIN_SIGNALS_FOR_SCORE).toBeGreaterThan(1);
  });

  it('never produces a "safe" status', () => {
    const best = assessSolanaToken({ mintAuthoritySet: false, freezeAuthoritySet: false, hasExtensions: false, top10Pct: 10, liquidityUsd: 9e6, volume24hUsd: 1e6, poolCount: 4, ageHours: 9_000 }, { verified: true });
    expect(best.score).toBe(0);
    expect(best.status).toBe('verified');
    // Without the curated flag the same facts read as Established: a track record, not an endorsement.
    expect(assessSolanaToken({ mintAuthoritySet: false, freezeAuthoritySet: false, hasExtensions: false, top10Pct: 10, liquidityUsd: 9e6, volume24hUsd: 1e6, poolCount: 4, ageHours: 9_000 }).status).toBe('established');
    expect(Object.values(RISK_LABELS).join(' ').toLowerCase()).not.toContain('safe');
  });

  it('marks young tokens as new and only curated tokens as verified', () => {
    const young = assessSolanaToken({ mintAuthoritySet: false, freezeAuthoritySet: false, liquidityUsd: 9e6, poolCount: 1, ageHours: 30 });
    expect(young.status).toBe('new');
    const old = assessSolanaToken({ mintAuthoritySet: false, freezeAuthoritySet: false, liquidityUsd: 9e6, poolCount: 1, ageHours: 500 });
    expect(old.status).toBe('unverified');
  });

  it('restricts tokens with a punishing sell tax and flags upgradeable/mintable EVM contracts', () => {
    const trap = assessEvmToken({ owner: 'renounced', isProxy: false, canMint: false, canBlacklist: false, sellTaxPct: 90, liquidityUsd: 1e6, poolCount: 1, ageHours: 500 });
    expect(trap.status).toBe('restricted');
    const risky = assessEvmToken({ owner: 'set', isProxy: true, canMint: true, canBlacklist: true, canPause: true, liquidityUsd: 9_000, poolCount: 1, ageHours: 3 });
    expect(risky.status).toBe('high');
    expect(risky.unavailable).toEqual(expect.arrayContaining(['Buy tax', 'Sell tax', 'Holder concentration']));
  });
});

describe('registry service', () => {
  const make = () => {
    const repo = new InMemoryTokenRepository();
    let now = T0;
    const svc = new TokenRegistryService(repo, () => now);
    return { repo, svc, tick: (ms: number) => (now += ms) };
  };

  it('rejects malformed identities and normalises EVM case', async () => {
    const { svc } = make();
    expect(await svc.ingest({ ref: { chain: 'ethereum', address: '0x12' }, source: 't' })).toBeNull();
    const r = await svc.ingest({ ref: { chain: 'ethereum', address: EVM }, symbol: 'USDC', decimals: 6, source: 't' });
    expect(r!.ref.address).toBe(EVM.toLowerCase());
  });

  it('never moves first detection time or source, and API text cannot overwrite on-chain facts', async () => {
    const { svc, tick } = make();
    await svc.ingest({ ref: { chain: 'solana', address: MINT_A }, symbol: 'AAA', name: 'First', decimals: 6, source: 'one' });
    tick(HOUR);
    await svc.ingest({ ref: { chain: 'solana', address: MINT_A }, symbol: 'AAA', decimals: 6, onchain: true, source: 'chain' });
    tick(HOUR);
    const r = (await svc.ingest({ ref: { chain: 'solana', address: MINT_A }, symbol: 'SCAM', name: 'Evil', decimals: 9, source: 'two' }))!;
    expect(r).toMatchObject({ symbol: 'AAA', decimals: 6, firstDetectedAt: T0, discoverySource: 'one', metadataConfidence: 'onchain' });
  });

  it('cleans untrusted text and logos', async () => {
    expect(cleanText('Hi‮there\u0000  x', 50)).toBe('Hithere x');
    expect(cleanText('x'.repeat(100), 10)).toHaveLength(10);
    expect(cleanLogo('javascript:alert(1)')).toBeNull();
    expect(cleanLogo('http://x.example/a.png')).toBeNull();
    expect(cleanLogo('https://x.example/a.png')).toBe('https://x.example/a.png');
  });

  it('rejects out-of-range decimals instead of storing them', async () => {
    const { svc } = make();
    const r = await svc.ingest({ ref: { chain: 'solana', address: MINT_A }, decimals: 200, source: 't' });
    expect(r!.decimals).toBe(0);
    expect(r!.metadataConfidence).toBe('unknown');
  });

  it('flags symbol collisions and finds by exact address', async () => {
    const { svc } = make();
    await svc.ingest({ ref: { chain: 'solana', address: MINT_A }, symbol: 'ABC', decimals: 6, source: 't' });
    await svc.ingest({ ref: { chain: 'solana', address: MINT_B }, symbol: 'ABC', decimals: 9, source: 't' });
    await svc.ingest({ ref: { chain: 'base', address: EVM }, symbol: 'ABC', decimals: 6, source: 't' });
    const bySymbol = await svc.search('abc');
    expect(bySymbol).toHaveLength(3);
    expect(bySymbol.every((r) => r.symbolCollision)).toBe(true);
    const byAddress = await svc.search(EVM);
    expect(byAddress).toHaveLength(1);
    expect(byAddress[0]!.record.ref.chain).toBe('base');
    expect(byAddress[0]!.symbolCollision).toBe(true);
    expect(await svc.search('a')).toEqual([]);
  });

  it('measures age from the best defensible time and says which', () => {
    expect(ageInfo({ createdAt: T0, firstPoolAt: T0 + 5, firstDetectedAt: T0 + 10 }, T0 + HOUR)).toEqual({ ms: HOUR, basis: 'created' });
    expect(ageInfo({ createdAt: null, firstPoolAt: T0, firstDetectedAt: T0 + 10 }, T0 + HOUR).basis).toBe('first-pool');
    expect(ageInfo({ createdAt: null, firstPoolAt: null, firstDetectedAt: T0 }, T0 + HOUR).basis).toBe('detected');
  });

  it('filters and sorts the New Tokens list', async () => {
    const { svc, tick } = make();
    await svc.ingest({ ref: { chain: 'solana', address: MINT_A }, symbol: 'OLD', decimals: 6, firstPoolAt: T0 - 48 * HOUR, liquidityUsd: 1_000_000, volume24hUsd: 10, source: 't' });
    await svc.ingest({ ref: { chain: 'base', address: EVM }, symbol: 'NEW', decimals: 6, firstPoolAt: T0 - HOUR, liquidityUsd: 50, volume24hUsd: 5_000, source: 't' });
    tick(0);
    expect((await svc.listNew({ maxAgeHours: 2 })).map((r) => r.symbol)).toEqual(['NEW']);
    expect((await svc.listNew({ minLiquidityUsd: 1_000 })).map((r) => r.symbol)).toEqual(['OLD']);
    expect((await svc.listNew({ chain: 'base' })).map((r) => r.symbol)).toEqual(['NEW']);
    expect((await svc.listNew({ sort: 'volume' })).map((r) => r.symbol)).toEqual(['NEW', 'OLD']);
    expect((await svc.listNew({ riskStatuses: ['high'] }))).toEqual([]);
  });
});

describe('discovery worker', () => {
  const candidate = (address: string, chain: 'solana' | 'base' = 'solana') => ({ ref: { chain, address }, symbol: 'T', decimals: 6, source: 'test' });

  it('ingests, enriches and advances the cursor only after a full batch', async () => {
    const repo = new InMemoryTokenRepository();
    const svc = new TokenRegistryService(repo, () => T0);
    const source: DiscoverySource = { id: 's', chain: 'solana', poll: async () => ({ candidates: [candidate(MINT_A), candidate(MINT_B), candidate('bad'), candidate(EVM, 'base')], nextCursor: 'c1' }) };
    const enricher = { enrich: vi.fn(async () => ({ risk: assessSolanaToken({}), metadata: { k: 1 }, decimals: 6 })) };
    const run = await new TokenDiscoveryWorker(source, svc, repo, enricher, () => T0).runOnce();
    expect(run).toMatchObject({ polled: 4, ingested: 2, rejected: 2, error: null });
    expect(await repo.getCursor('s')).toBe('c1');
    expect(enricher.enrich).toHaveBeenCalledTimes(2);
    expect((await repo.get({ chain: 'solana', address: MINT_A }))!.metadataConfidence).toBe('onchain');
  });

  it('keeps the cursor and reports when the source fails', async () => {
    const repo = new InMemoryTokenRepository();
    await repo.setCursor('s', 'old');
    const source: DiscoverySource = { id: 's', chain: 'solana', poll: async () => Promise.reject(new Error('upstream 500')) };
    const run = await new TokenDiscoveryWorker(source, new TokenRegistryService(repo), repo).runOnce();
    expect(run.error).toBe('upstream 500');
    expect(await repo.getCursor('s')).toBe('old');
  });

  it('keeps a token even when enrichment fails', async () => {
    const repo = new InMemoryTokenRepository();
    const source: DiscoverySource = { id: 's', chain: 'solana', poll: async () => ({ candidates: [candidate(MINT_A)], nextCursor: 'c' }) };
    const run = await new TokenDiscoveryWorker(source, new TokenRegistryService(repo, () => T0), repo, { enrich: async () => Promise.reject(new Error('rpc')) }, () => T0).runOnce();
    expect(run).toMatchObject({ ingested: 1, enrichFailures: 1 });
    expect(await repo.get({ chain: 'solana', address: MINT_A })).not.toBeNull();
  });

  it('does not advance the cursor when the batch was truncated', async () => {
    const repo = new InMemoryTokenRepository();
    const source: DiscoverySource = { id: 's', chain: 'solana', poll: async () => ({ candidates: [candidate(MINT_A), candidate(MINT_B)], nextCursor: 'c' }) };
    await new TokenDiscoveryWorker(source, new TokenRegistryService(repo, () => T0), repo, null, () => T0, 1).runOnce();
    expect(await repo.getCursor('s')).toBeNull();
  });
});

describe('GeckoTerminal source', () => {
  const payload = {
    data: [
      { attributes: { address: 'pool1', pool_created_at: '2026-10-06T10:00:00Z', reserve_in_usd: '1234.5', volume_usd: { h24: '99' } }, relationships: { base_token: { data: { id: `solana_${MINT_A}` } }, dex: { data: { id: 'raydium' } } } },
      { attributes: { address: 'pool2', pool_created_at: 'garbage' }, relationships: { base_token: { data: { id: `solana_${MINT_B}` } } } },
      { attributes: { address: 'pool3', pool_created_at: '2026-10-06T11:00:00Z' }, relationships: { base_token: { data: { id: 'solana_not-a-mint' } } } },
      { attributes: { address: 'pool4', pool_created_at: '2026-10-06T09:00:00Z' }, relationships: { base_token: { data: { id: `eth_${EVM}` } } } },
    ],
    included: [{ type: 'token', attributes: { address: MINT_A, symbol: 'AAA', name: 'Token A', decimals: 6, image_url: 'https://x.example/a.png' } }],
  };

  it('parses defensively and keeps only well-formed pools on the right chain', () => {
    const { candidates, newest } = parseNewPools('solana', payload);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ symbol: 'AAA', decimals: 6, liquidityUsd: 1234.5, volume24hUsd: 99, firstPoolAt: Date.parse('2026-10-06T10:00:00Z'), source: 'geckoterminal:new_pools' });
    expect(newest).toBe('2026-10-06T10:00:00.000Z');
    expect(parseNewPools('solana', null).candidates).toEqual([]);
  });

  it('only returns pools newer than the cursor', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload))) as unknown as typeof fetch;
    const src = new GeckoTerminalNewPoolsSource('solana', fetchImpl);
    expect((await src.poll(null)).candidates).toHaveLength(1);
    const again = await src.poll('2026-10-06T10:00:00.000Z');
    expect(again.candidates).toHaveLength(0);
    expect(again.nextCursor).toBeNull();
    await expect(new GeckoTerminalNewPoolsSource('base', (async () => new Response('', { status: 429 })) as unknown as typeof fetch).poll(null)).rejects.toThrow(/429/);
  });
});

describe('on-chain enrichment', () => {
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const mintBytes = (opts: { mintAuth: boolean; freeze: boolean; supply: bigint; decimals: number }) => {
    const b = new Uint8Array(82);
    const v = new DataView(b.buffer);
    v.setUint32(0, opts.mintAuth ? 1 : 0, true);
    v.setBigUint64(36, opts.supply, true);
    b[44] = opts.decimals;
    b[45] = 1;
    v.setUint32(46, opts.freeze ? 1 : 0, true);
    return b;
  };
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

  it('reads authorities, supply and decimals from a mint account', () => {
    expect(parseMintFacts(TOKEN, mintBytes({ mintAuth: true, freeze: false, supply: 1_000n, decimals: 6 }))).toEqual({ decimals: 6, supply: 1_000n, mintAuthoritySet: true, freezeAuthoritySet: false, hasExtensions: false });
    expect(parseMintFacts('SomeOtherProgram', mintBytes({ mintAuth: false, freeze: false, supply: 1n, decimals: 0 }))).toBeNull();
    expect(parseMintFacts(TOKEN, new Uint8Array(10))).toBeNull();
  });

  it('turns a mint into a risk assessment with on-chain decimals', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'getAccountInfo') return { value: { owner: TOKEN, data: [b64(mintBytes({ mintAuth: true, freeze: true, supply: 1_000n, decimals: 9 })), 'base64'] } };
      return { value: [{ amount: '900' }, { amount: '50' }] };
    }) as never;
    const out = await new SolanaTokenEnricher(rpc, () => T0).enrich({ ref: { chain: 'solana', address: MINT_A }, source: 't', liquidityUsd: 5_000, pool: { venue: 'x', address: 'p' }, firstPoolAt: T0 - 600_000 });
    expect(out!.decimals).toBe(9);
    expect(out!.risk.signals.find((s) => s.id === 'mint-authority')!.state).toBe('warn');
    expect(out!.risk.signals.find((s) => s.id === 'concentration')!.detail).toContain('95%');
  });

  it('claims nothing about an address that is not a mint', async () => {
    const rpc = (async () => ({ value: null })) as never;
    expect(await new SolanaTokenEnricher(rpc).enrich({ ref: { chain: 'solana', address: MINT_A }, source: 't' })).toBeNull();
  });

  it('detects dangerous EVM functions from bytecode selectors', () => {
    const f = evmFactsFromCode('0x6080' + '6340c10f19' + '63f9f92be4' + '638456cb59' + '638da5cb5b');
    expect(f).toMatchObject({ canMint: true, canBlacklist: true, canPause: true, hasOwnerFn: true, isProxy: false });
    expect(evmFactsFromCode('0x363d3d373d3d3d363d73' + 'aa'.repeat(20)).isProxy).toBe(true);
    expect(evmFactsFromCode('0x6080604052')).toMatchObject({ canMint: false, canBlacklist: false });
  });
});

describe('Supabase row mapping', () => {
  it('round-trips a record without loss', async () => {
    const svc = new TokenRegistryService(new InMemoryTokenRepository(), () => T0);
    const rec = (await svc.ingest({ ref: { chain: 'base', address: EVM }, symbol: 'X', name: 'Ex', decimals: 6, firstPoolAt: T0 - 5, liquidityUsd: 12.5, pool: { venue: 'v', address: 'a' }, source: 's' }))!;
    expect(fromRow(toRow(rec))).toEqual(rec);
    expect(toRow(rec).key).toBe(`base:${EVM.toLowerCase()}`);
  });
});
