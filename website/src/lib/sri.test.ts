import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every script the wallet pages load from another origin must be pinned by its hash (audit L-17): a changed or compromised CDN file
// is then refused by the browser instead of running next to the transaction checks.
const pages = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? pages(p) : /\.(astro|html)$/.test(f) ? [p] : [];
  });

// The one exception: Jupiter's swap widget on /buy is published only at an unversioned URL that Jupiter updates, so it cannot be pinned.
// It runs its own swap flow, not the wallet page's checks. Recorded as a residual risk in the October 2026 remediation report.
const UNPINNABLE = new Set(['https://plugin.jup.ag/plugin-v1.js']);

describe('third-party scripts carry Subresource Integrity (audit L-17)', () => {
  it('every <script src="https://..."> in the pages has an integrity hash and crossorigin', () => {
    const missing: string[] = [];
    for (const file of pages(join(__dirname, '..', 'pages'))) {
      for (const tag of readFileSync(file, 'utf8').match(/<script\b[^>]*\bsrc="https?:\/\/[^"]+"[^>]*>/g) ?? []) {
        if (UNPINNABLE.has(/src="([^"]+)"/.exec(tag)?.[1] ?? '')) continue;
        if (!/\bintegrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/.test(tag) || !/\bcrossorigin="anonymous"/.test(tag)) missing.push(`${file}: ${tag}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
