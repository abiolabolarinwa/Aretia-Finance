import { describe, expect, it } from 'vitest';
import { isTrustedAssetUrl, legacyToR2, publicUrl, r2PublicBase } from './core.js';

const SHA = 'ab'.repeat(32);
const R2 = 'https://assets.aretiafinance.org';
const BASE = 'https://abcd.supabase.co';
const IMG = publicUrl(BASE, 'launch-assets', `img/${SHA}.png`);

describe('Cloudflare R2 addresses', () => {
  it('accepts only an https subdomain of aretiafinance.org as the public base', () => {
    expect(r2PublicBase(R2)).toBe(R2);
    expect(r2PublicBase(` "${R2}/" `)).toBe(R2);
    for (const bad of ['https://aretiafinance.org', 'http://assets.aretiafinance.org', 'https://assets.aretiafinance.org.evil.example', 'https://evil.example/assets.aretiafinance.org', 'https://assets.aretiafinance.org/x', 'https://u:p@assets.aretiafinance.org', 'https://assets.aretiafinance.org:8443', '', undefined]) {
      expect(r2PublicBase(bad), String(bad)).toBeNull();
    }
  });
  it('trusts a picture or details file at the R2 domain by the bucket layout only', () => {
    expect(isTrustedAssetUrl(`${R2}/img/${SHA}.png`)).toBe(true);
    expect(isTrustedAssetUrl(`${R2}/meta/${SHA}.json`)).toBe(true);
    expect(isTrustedAssetUrl(`${R2}/evm/bnb/0x${'1'.repeat(40)}.json`)).toBe(true);
    for (const bad of [`${R2}/other/${SHA}.png`, `${R2}/img/x.png`, `${R2}/img/${SHA}.png?x=1`, `${R2}/img/${SHA}.svg`, `https://evil.example/img/${SHA}.png`, `http://assets.aretiafinance.org/img/${SHA}.png`]) {
      expect(isTrustedAssetUrl(bad), bad).toBe(false);
    }
  });
  it('still trusts the old Supabase public path', () => {
    expect(isTrustedAssetUrl(IMG)).toBe(true);
  });
  it('maps an old Supabase address to the same path on R2, and nothing else', () => {
    expect(legacyToR2(IMG, R2)).toBe(`${R2}/img/${SHA}.png`);
    expect(legacyToR2(publicUrl(BASE, 'launch-assets', `meta/${SHA}.json`), R2)).toBe(`${R2}/meta/${SHA}.json`);
    for (const bad of [publicUrl(BASE, 'launch-assets', 'img/x.png'), publicUrl(BASE, 'launch-assets', '../secret.json'), 'https://evil.example/storage/v1/object/public/a/img/x.png', `${R2}/img/${SHA}.png`, 'nope']) {
      expect(legacyToR2(bad, R2), bad).toBeNull();
    }
  });
});
