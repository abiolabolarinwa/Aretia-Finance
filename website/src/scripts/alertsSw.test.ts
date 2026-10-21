/* The alert service worker (public/aretia-alerts-sw.js): a notification only ever opens a page on Aretia's own site (audit L-28). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../public/aretia-alerts-sw.js', import.meta.url), 'utf8');

function load(): (u: unknown) => string {
  const self = { location: { origin: 'https://aretiafinance.org', href: 'https://aretiafinance.org/aretia-alerts-sw.js?c=1&s=2' }, addEventListener: () => undefined, registration: {}, clients: {} };
  return new Function('self', 'indexedDB', 'caches', `${source}\nreturn sameOriginPath;`)(self, undefined, undefined) as (u: unknown) => string;
}

describe('the alert service worker', () => {
  const path = load();
  it('keeps paths on the site', () => {
    expect(path('/wallet#/favourites')).toBe('/wallet#/favourites');
    expect(path('https://aretiafinance.org/token#/solana/x')).toBe('/token#/solana/x');
  });
  it('refuses protocol-relative, backslash and other-origin links', () => {
    for (const bad of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', null, 5]) expect(path(bad), String(bad)).toBe('/wallet');
  });
});
