import { describe, expect, it } from 'vitest';
import { isOffensive } from './safeText.js';
import { InMemoryTokenRepository, TokenRegistryService } from './registry.js';
import type { TokenRecord } from '../core/types.js';

describe('the abusive-name filter', () => {
  it('hides slurs and abusive words, however they are disguised', () => {
    for (const bad of ['FAGGOT', 'faggot coin', 'DUVAL KYSSSS', 'f4gg0t', 'N1GG3R', 'n i g g e r', 'F.A.G.G.O.T', 'PORN', 'p0rn', 'CUNT', 'Hitler Inu', 'rapist']) expect(isOffensive(bad), bad).toBe(true);
    expect(isOffensive('fine name', 'KYS')).toBe(true); // any of the texts
  });

  it('leaves innocent names alone, including ones that contain a bad word as part of a longer word', () => {
    for (const ok of ['Grape', 'Class', 'Scunthorpe', 'Niger', 'Passion', 'Assist', 'Cocktail', 'Cocoa', 'Therapist', 'Analysis', 'Cumulus', 'Skynet', 'Kyoto', 'Dickens', 'Essex', 'Pepe', 'Dogecoin', 'USD Coin', 'Wrapped SOL', 'Rapeseed', 'Hello World', 'Aretia ACT', '华夏', 'BOTPAD', 'blohard.social']) expect(isOffensive(ok), ok).toBe(false);
    expect(isOffensive(null, undefined, '')).toBe(false);
  });

  it('keeps genuinely doubled letters: "Niger" the country is not the slur', () => {
    expect(isOffensive('Niger')).toBe(false);
    expect(isOffensive('NIGGER')).toBe(true);
  });
});

const rec = (symbol: string, name: string, over: Partial<TokenRecord> = {}): TokenRecord => ({
  ref: { chain: 'solana', address: `${[...symbol].map((c) => c.charCodeAt(0).toString(36)).join('')}${'Q'.repeat(44)}`.slice(0, 44) }, symbol, name, decimals: 6, logo: 'https://x.example/logo.png', firstDetectedAt: 1_000, discoverySource: 't', createdAt: null, firstPoolAt: 900, discoveryStatus: 'tradable', liquidityUsd: 5000, volume24hUsd: 100, holderCount: null, pools: [{ venue: 'v', address: 'p' }], metadata: {}, verified: false, metadataConfidence: 'api', risk: null, updatedAt: 1_000, ...over,
});

describe('the registry hides what the filter catches', () => {
  const setup = async () => {
    const repo = new InMemoryTokenRepository();
    for (const r of [rec('GOOD', 'A fine token'), rec('FAGGOT', 'DUVAL KYSSSS'), rec('RISKY', 'Looks scary', { risk: { status: 'high', score: 80, signals: [], assessedAt: 1, version: 1 } as never }), rec('MEH', 'Elevated one', { risk: { status: 'elevated', score: 50, signals: [], assessedAt: 1, version: 1 } as never })]) await repo.upsert(r);
    return { repo, service: new TokenRegistryService(repo, () => 2_000) };
  };

  it('never lists an abusive name', async () => {
    const { service } = await setup();
    const list = await service.listNew({});
    expect(list.map((r) => r.symbol).sort()).toEqual(['GOOD', 'MEH', 'RISKY']);
  });

  it('can also hide high-risk and restricted tokens, keeping elevated and unknown ones visible', async () => {
    const { service } = await setup();
    const list = await service.listNew({ hideRisky: true });
    expect(list.map((r) => r.symbol).sort()).toEqual(['GOOD', 'MEH']);
  });

  it('shows an abusive token found by its exact address with its name masked, never the words', async () => {
    const { service, repo } = await setup();
    const bad = (await repo.listRecent(undefined, 10)).find((r) => r.symbol === 'FAGGOT')!;
    const hits = await service.search(bad.ref.address);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.record.symbol).toBe('[hidden]');
    expect(hits[0]!.record.name).toMatch(/hidden/i);
    expect(hits[0]!.record.logo).toBeNull();
    expect(JSON.stringify(hits)).not.toMatch(/faggot|kyss/i);
  });

  it('does not return an abusive token for a text search', async () => {
    const { service } = await setup();
    expect(await service.search('FAGGOT')).toEqual([]);
    expect(await service.search('DUVAL')).toEqual([]);
  });
});
