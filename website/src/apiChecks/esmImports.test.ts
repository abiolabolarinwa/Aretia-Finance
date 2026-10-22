import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vercel runs each function as plain Node ESM, where a relative import must name its file ('./x.js'). Vite and vitest accept './x', so
 * a missing extension passes every test and still brings the whole function down in production (it did, for every route of swings-data).
 */
const root = join(process.cwd(), 'api');
const entries = readdirSync(root).filter((f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'));

function closure(entry: string): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s(type\s)?[^;]*?from\s+'(\.{1,2}\/[^']+)'/g)) {
      if (m[2]) continue;
      const spec = m[3]!;
      if (!/\.(js|ts|json)$/.test(spec)) bad.push(`${file.slice(process.cwd().length + 1)} imports '${spec}'`);
      const base = resolve(dirname(file), spec);
      const next = [base.replace(/\.js$/, '.ts'), `${base}.ts`].find((c) => existsSync(c));
      if (next) walk(next);
    }
  };
  walk(join(root, entry));
  return bad;
}

describe('serverless functions', () => {
  for (const entry of entries) {
    it(`${entry} and everything it imports use import paths Node can resolve`, () => {
      expect(closure(entry)).toEqual([]);
    });
  }
});
