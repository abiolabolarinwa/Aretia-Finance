import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'api');
const functions = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'));

describe('serverless functions', () => {
  it('stay within the twelve the Hobby plan allows (more makes the whole deployment fail)', () => {
    expect(functions.length).toBeLessThanOrEqual(12);
  });

  it('every path that was folded into swings-data is rewritten to it', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { rewrites?: { source: string; destination: string }[] };
    const have = new Map((config.rewrites ?? []).map((r) => [r.source, r.destination]));
    for (const route of ['candles', 'pools', 'market', 'account']) expect(have.get(`/api/swings-${route}`)).toBe(`/api/swings-data?route=${route}`);
    expect(functions).toContain('swings-data.ts');
  });
});
