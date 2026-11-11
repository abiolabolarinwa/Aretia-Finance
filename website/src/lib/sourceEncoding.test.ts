import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|astro|css)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * A file read and saved in the wrong encoding turns every non-ASCII character into two or three odd ones ("·" becomes "Â·",
 * "…" becomes "â€¦"). It happened once to the swap page; this keeps it from reaching a release.
 */
describe('the source files are clean UTF-8', () => {
  const all = files(ROOT).filter((p) => !p.endsWith('sourceEncoding.test.ts'));
  it('has files to check', () => {
    expect(all.length).toBeGreaterThan(100);
  });
  it('has no double-encoded characters', () => {
    const bad: string[] = [];
    for (const p of all) {
      const text = readFileSync(p, 'utf8');
      if (/\u00e2\u20ac|\u00c2[\u00a0-\u00bf]/.test(text)) bad.push(p.slice(ROOT.length));
    }
    expect(bad).toEqual([]);
  });
});
