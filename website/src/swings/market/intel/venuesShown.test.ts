import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VENUES_SHOWN } from './compute';

describe('the Busiest venues card', () => {
  it('lists the ten venues with the most volume, not four', () => {
    expect(VENUES_SHOWN).toBe(10);
    expect(readFileSync(new URL('./compute.ts', import.meta.url), 'utf8')).toContain('adv(pools, stored.venuesPrev, VENUES_SHOWN, c)');
  });
});
