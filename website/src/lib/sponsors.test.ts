import { describe, expect, it } from 'vitest';
import { pickSponsor, problemWith, sponsorsFor, type Sponsor } from './sponsors.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const ad = (over: Partial<Sponsor> = {}): Sponsor => ({
  id: 'a1', advertiser: 'Example Co', headline: 'Fund a real project', body: 'Back verified climate projects.', cta: 'Learn more', href: 'https://example.com/go',
  slots: ['token-panel'], from: '2026-10-01', to: '2026-10-31', ...over,
});

describe('what may be shown', () => {
  it('accepts a well-formed card', () => {
    expect(problemWith(ad())).toBeNull();
    expect(sponsorsFor([ad()], 'token-panel', NOW)).toHaveLength(1);
  });

  it('refuses anything that is not a plain https link to a real site', () => {
    for (const href of ['http://example.com', 'javascript:alert(1)', 'https://localhost/x', 'https://127.0.0.1/x', 'ftp://example.com', 'example.com']) {
      expect(problemWith(ad({ href }))).not.toBeNull();
      expect(sponsorsFor([ad({ href })], 'token-panel', NOW)).toEqual([]);
    }
  });

  it('refuses text that is too long, empty fields and bad images', () => {
    expect(problemWith(ad({ headline: 'x'.repeat(61) }))).toMatch(/too long/);
    expect(problemWith(ad({ body: '' }))).toMatch(/empty/);
    expect(problemWith(ad({ image: 'http://example.com/a.png' }))).toMatch(/image/);
    expect(problemWith(ad({ image: '/assets/sponsors/logo.png' }))).toBeNull();
    expect(problemWith(ad({ image: '/assets/../secret.png' }))).toMatch(/image/);
  });

  it('shows a card only inside its run, including the last day', () => {
    expect(sponsorsFor([ad()], 'token-panel', Date.parse('2026-09-30T23:59:59Z'))).toEqual([]);
    expect(sponsorsFor([ad()], 'token-panel', Date.parse('2026-10-31T23:59:59Z'))).toHaveLength(1);
    expect(sponsorsFor([ad()], 'token-panel', Date.parse('2026-11-01T00:00:00Z'))).toEqual([]);
    expect(problemWith(ad({ from: '2026-10-31', to: '2026-10-01' }))).toMatch(/dates/);
  });

  it('keeps a card to its slots and its chains', () => {
    expect(sponsorsFor([ad({ slots: ['market-footer'] })], 'token-panel', NOW)).toEqual([]);
    const sol = ad({ chains: ['solana'] });
    expect(sponsorsFor([sol], 'token-panel', NOW, { chain: 'solana' })).toHaveLength(1);
    expect(sponsorsFor([sol], 'token-panel', NOW, { chain: 'bnb' })).toEqual([]);
    expect(sponsorsFor([sol], 'token-panel', NOW)).toEqual([]);
    expect(sponsorsFor([ad()], 'token-panel', NOW, { chain: 'bnb' })).toHaveLength(1);
  });
});

describe('choosing one', () => {
  it('gives nothing when there is nothing, and the same card for the same seed', () => {
    expect(pickSponsor([], 'x')).toBeNull();
    const list = [ad({ id: 'a' }), ad({ id: 'b' }), ad({ id: 'c' })];
    expect(pickSponsor(list, 'bnb:0x1')?.id).toBe(pickSponsor(list, 'bnb:0x1')?.id);
  });

  it('shares the slot between sponsors across different tokens', () => {
    const list = [ad({ id: 'a' }), ad({ id: 'b' })];
    const seen = new Set(Array.from({ length: 40 }, (_, i) => pickSponsor(list, `solana:token${i}`)?.id));
    expect(seen).toEqual(new Set(['a', 'b']));
  });
});
