/* The TradingView library is installed only when its files match the pinned hash (audit I-26). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { integrityVerdict, treeHash } from '../../scripts/fetch-charting-library';

const dirs: string[] = [];
const tree = (files: Record<string, string>): string => {
  const d = mkdtempSync(join(tmpdir(), 'tv-test-'));
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('the charting library integrity check', () => {
  it('hashes the same files the same way, and any changed or added file differently', () => {
    const a = treeHash(tree({ 'charting_library.standalone.js': 'x', 'bundles/a.js': 'y' }));
    expect(treeHash(tree({ 'bundles/a.js': 'y', 'charting_library.standalone.js': 'x' }))).toBe(a);
    expect(treeHash(tree({ 'charting_library.standalone.js': 'x', 'bundles/a.js': 'z' }))).not.toBe(a);
    expect(treeHash(tree({ 'charting_library.standalone.js': 'x', 'bundles/a.js': 'y', 'bundles/evil.js': '' }))).not.toBe(a);
  });
  it('installs only a match, and without a pin only when a hash is not required', () => {
    expect(integrityVerdict('ab', 'AB', false).ok).toBe(true);
    expect(integrityVerdict('ab', 'cd', false).ok).toBe(false);
    expect(integrityVerdict('ab', null, true).ok).toBe(false);
    expect(integrityVerdict('ab', null, false)).toMatchObject({ ok: true, message: expect.stringMatching(/WARNING.*TRADINGVIEW_SHA256=ab/) });
  });
});
