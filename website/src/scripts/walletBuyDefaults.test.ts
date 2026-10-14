import { describe, expect, it } from 'vitest';
import { currencyFor, defaultAmount, pickCountry, pickNetwork, regionOf } from './walletBuyDefaults';

const offered = [{ code: 'US' }, { code: 'NG' }, { code: 'GB' }, { code: 'BS' }];

describe('regionOf', () => {
  it('reads the country out of a language tag', () => {
    expect(regionOf('en-NG')).toBe('NG');
    expect(regionOf('fr-ca')).toBe('CA');
    expect(regionOf('zh-Hant-TW')).toBe('TW');
  });
  it('returns nothing when there is none', () => {
    for (const x of ['en', 'fr', '', null, undefined, 'es-419', 'x']) expect(regionOf(x as string)).toBe('');
  });
});

describe('pickCountry', () => {
  it('prefers the remembered country, then the browser language, then nothing (never the first in the list)', () => {
    expect(pickCountry('GB', ['en-NG'], offered)).toBe('GB');
    expect(pickCountry('', ['en-NG'], offered)).toBe('NG');
    expect(pickCountry('', ['en', 'en-GB'], offered)).toBe('GB');
    expect(pickCountry('', ['en-FR'], offered)).toBe('');
    expect(pickCountry('XX', ['en'], offered)).toBe('');
  });
});

describe('currencyFor', () => {
  const fiats = ['usd', 'eur', 'gbp', 'ngn'];
  it('uses the country\'s own currency when the provider takes it, else dollars, else the first listed', () => {
    expect(currencyFor('NG', fiats)).toBe('ngn');
    expect(currencyFor('GB', fiats)).toBe('gbp');
    expect(currencyFor('DE', fiats)).toBe('eur');
    expect(currencyFor('JP', fiats)).toBe('usd');
    expect(currencyFor('JP', ['eur', 'gbp'])).toBe('eur');
    expect(currencyFor('', [])).toBe('usd');
  });
});

describe('pickNetwork', () => {
  const nets = ['ethereum', 'base', 'arbitrum'] as const;
  it('uses the last network if offered, else Base, else the first', () => {
    expect(pickNetwork('arbitrum', nets)).toBe('arbitrum');
    expect(pickNetwork('polygon', nets)).toBe('base');
    expect(pickNetwork(null, ['ethereum', 'arbitrum'])).toBe('ethereum');
    expect(pickNetwork(null, [])).toBeNull();
  });
});

describe('defaultAmount', () => {
  it('starts at an amount worth buying in the currency, never 100 of a small-value currency', () => {
    expect(defaultAmount('usd')).toBe('100');
    expect(defaultAmount('EUR')).toBe('100');
    expect(defaultAmount('ngn')).toBe('50000');
    expect(defaultAmount('jpy')).toBe('10000');
    expect(defaultAmount('xyz')).toBe('100');
  });
});
