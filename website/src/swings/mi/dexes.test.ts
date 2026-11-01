import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allSpecs, SIGNATURES, specById, TOPICS, topicOf } from './dexes.js';
import { EVM_MI_CHAINS } from './chains.js';

const specsFile = join(process.cwd(), 'src/swings/mi/fixtures/specs.json');

describe('DEX adapter catalogue', () => {
  it('hashes the event signatures to the well-known topics', () => {
    expect(TOPICS.v2PairCreated).toBe('0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9');
    expect(TOPICS.v2Swap).toBe('0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
    expect(TOPICS.v2Sync).toBe('0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1');
    expect(TOPICS.v3PoolCreated).toBe('0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118');
    expect(TOPICS.v3Swap).toBe('0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
    expect(topicOf(SIGNATURES.pancakeV3Swap)).toBe(TOPICS.pancakeV3Swap);
    expect(TOPICS.pancakeV3Swap).not.toBe(TOPICS.v3Swap);
  });

  it('has unique ids, lower-case 0x factories, and only the requested families on known EVM chains', () => {
    const specs = allSpecs();
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
    for (const s of specs) {
      expect(s.factory).toMatch(/^0x[0-9a-f]{40}$/);
      expect(EVM_MI_CHAINS).toContain(s.chain);
      expect(['pancakeswap', 'uniswap', 'sushiswap', 'apeswap', 'aerodrome']).toContain(s.family);
    }
  });

  it('lists ApeSwap on the three chains it was verified on, and nothing invented elsewhere', () => {
    expect(allSpecs().filter((s) => s.family === 'apeswap').map((s) => s.chain).sort()).toEqual(['bnb', 'ethereum', 'polygon']);
    expect(specById('apeswap-v2-optimism')).toBeNull();
  });

  it('keeps fixtures/specs.json (used by the capture script) in step with the catalogue', () => {
    const current = allSpecs().map((s) => ({ id: s.id, chain: s.chain, kind: s.kind, factory: s.factory, creationTopic: s.creationTopic, swapTopic: s.swapTopic, creationShape: s.creationShape ?? null }));
    if (process.env.MI_WRITE_SPECS === '1') writeFileSync(specsFile, JSON.stringify(current, null, 1));
    expect(JSON.parse(readFileSync(specsFile, 'utf8'))).toEqual(current);
  });
});
