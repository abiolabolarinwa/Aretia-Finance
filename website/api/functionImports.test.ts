/**
 * Guards against a failure that tests cannot otherwise see: a server function that crashes the moment it loads.
 *
 * Each file in api/ that does not start with an underscore is a Vercel function. Vercel compiles it to plain JavaScript and
 * runs it in Node's own module system, where a relative import must name its file extension ("./walletTools.js"). The
 * browser scripts in src/scripts are bundled by Astro, which accepts "./walletTools", so an import like that works in the
 * browser and in the test runner, and then throws "Cannot find module" on Vercel, taking down every route of the function.
 * That happened once: a function started importing a few browser scripts, and the market list, candles, trades and swap
 * quotes all returned FUNCTION_INVOCATION_FAILED until the imports were fixed.
 *
 * This walks the imports of every function and fails on any relative import without an extension.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API = dirname(fileURLToPath(import.meta.url));

/** Static imports and exports ("from './x'"), side-effect imports ("import './x'") and dynamic imports ("import('./x')"). */
const SPECIFIER = /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const HAS_EXTENSION = /\.(?:js|json|mjs|cjs)$/;

interface Files {
  read(path: string): string;
  exists(path: string): boolean;
}

/** The source file a relative specifier points to ("./x.js" is written as x.ts), or null when it is not one of ours. */
function sourceFor(from: string, spec: string, files: Files): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`]) if (files.exists(candidate)) return candidate;
  return null;
}

/** Every relative import without a file extension that a function can reach, as "file -> specifier". Pure apart from `files`. */
export function importsWithoutExtension(entry: string, files: Files): string[] {
  const seen = new Set<string>();
  const bad = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = files.read(file);
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      if (!HAS_EXTENSION.test(spec)) bad.add(`${file} -> ${spec}`);
      const next = sourceFor(file, spec, files);
      if (next) visit(next);
    }
  };
  visit(entry);
  return [...bad].sort();
}

const real: Files = { read: (p) => readFileSync(p, 'utf8'), exists: (p) => existsSync(p) };

const functions = readdirSync(API).filter((n) => n.endsWith('.ts') && !n.startsWith('_') && !n.endsWith('.test.ts'));

describe('importsWithoutExtension (the checker itself)', () => {
  const fake = (tree: Record<string, string>): Files => ({ read: (p) => tree[p] ?? '', exists: (p) => p in tree });
  const at = (p: string): string => resolve('/virtual', p);

  it('passes a function whose imports all name their extension', () => {
    const files = fake({ [at('api/f.ts')]: "import { a } from './_a.js';\nexport { b } from '../src/b.js';", [at('api/_a.ts')]: '', [at('src/b.ts')]: "import './c.js';", [at('src/c.ts')]: '' });
    expect(importsWithoutExtension(at('api/f.ts'), files)).toEqual([]);
  });

  it('finds an extensionless import however deep it is, in a static, side-effect, export or dynamic import', () => {
    const files = fake({
      [at('api/f.ts')]: "import { a } from '../src/a.js';",
      [at('src/a.ts')]: "import { x } from './b';\nexport * from './c';\nimport './d';\nconst e = () => import('./e');",
      [at('src/b.ts')]: '',
      [at('src/c.ts')]: '',
      [at('src/d.ts')]: '',
      [at('src/e.ts')]: '',
    });
    const found = importsWithoutExtension(at('api/f.ts'), files).map((s) => s.split(' -> ')[1]);
    expect(found.sort()).toEqual(['./b', './c', './d', './e']);
  });

  it('only follows files that exist, ignores package imports, and copes with a cycle', () => {
    const files = fake({ [at('api/f.ts')]: "import fs from 'node:fs';\nimport { z } from 'zod';\nimport { a } from './_a.js';", [at('api/_a.ts')]: "import { f } from './f.js';" });
    expect(importsWithoutExtension(at('api/f.ts'), files)).toEqual([]);
  });
});

describe('the API functions', () => {
  it('finds the functions', () => {
    expect(functions).toContain('swings-data.ts');
    expect(functions.length).toBeGreaterThan(5);
  });

  for (const name of functions) {
    it(`${name} imports only files that Node can resolve (every relative import names its extension)`, () => {
      expect(importsWithoutExtension(resolve(API, name), real)).toEqual([]);
    });
  }
});
