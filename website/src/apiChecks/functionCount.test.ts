import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'api');
const functions = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'));

/** Vercel turns EVERY file in api/ that does not start with an underscore into a function, test files included. */
const everyFile = readdirSync(dir).filter((f) => !f.startsWith('_'));

describe('serverless functions', () => {
  it('has no test or helper file that Vercel would count as a function', () => {
    expect(everyFile.filter((f) => f.endsWith('.test.ts'))).toEqual([]);
    expect(everyFile.length).toBeLessThanOrEqual(12);
  });

  it('stay within the twelve the Hobby plan allows (more makes the whole deployment fail)', () => {
    expect(functions.length).toBeLessThanOrEqual(12);
  });

  it('every path that was folded into swings-data is rewritten to it', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { rewrites?: { source: string; destination: string }[] };
    const have = new Map((config.rewrites ?? []).map((r) => [r.source, r.destination]));
    for (const route of ['candles', 'pools', 'market', 'account', 'radar']) expect(have.get(`/api/swings-${route}`)).toBe(`/api/swings-data?route=${route}`);
    expect(functions).toContain('swings-data.ts');
  });
});
