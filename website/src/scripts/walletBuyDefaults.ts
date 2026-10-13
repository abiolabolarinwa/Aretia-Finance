/**
 * Sensible starting answers for buying USDC with cash, so the person is asked for as little as possible: their country from
 * the browser's language, the currency that country uses, and the network they used last. Anything it cannot work out is
 * left empty for the person to choose; nothing is guessed in a way that could send money somewhere unexpected.
 */

/** Country (ISO 3166 alpha-2) to the currency its people pay in, for the countries MoonPay serves where it is not the US dollar. */
const REGION_CURRENCY: Readonly<Record<string, string>> = {
  NG: 'ngn', GH: 'ghs', KE: 'kes', ZA: 'zar', EG: 'egp', MA: 'mad', TN: 'tnd', UG: 'ugx', TZ: 'tzs',
  GB: 'gbp', IE: 'eur', DE: 'eur', FR: 'eur', ES: 'eur', IT: 'eur', NL: 'eur', BE: 'eur', PT: 'eur', AT: 'eur', FI: 'eur', GR: 'eur', LU: 'eur', MT: 'eur', CY: 'eur', SK: 'eur', SI: 'eur', EE: 'eur', LV: 'eur', LT: 'eur', HR: 'eur',
  CH: 'chf', SE: 'sek', NO: 'nok', DK: 'dkk', PL: 'pln', CZ: 'czk', HU: 'huf', RO: 'ron', BG: 'bgn', TR: 'try',
  CA: 'cad', MX: 'mxn', BR: 'brl', AR: 'ars', CL: 'clp', CO: 'cop', PE: 'pen',
  AU: 'aud', NZ: 'nzd', JP: 'jpy', KR: 'krw', IN: 'inr', ID: 'idr', PH: 'php', TH: 'thb', VN: 'vnd', MY: 'myr', SG: 'sgd', HK: 'hkd', TW: 'twd', IL: 'ils', AE: 'aed', SA: 'sar',
};

/** The country in a language tag such as "en-NG" or "fr-CA", upper-cased, or '' when the tag names none. */
export function regionOf(locale: string | null | undefined): string {
  const m = /^[a-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2}|\d{3})(?:-|$)/.exec((locale ?? '').trim());
  return m && /^[A-Za-z]{2}$/.test(m[1]!) ? m[1]!.toUpperCase() : '';
}

/** The remembered country if it is still offered, otherwise the browser's, otherwise nothing. */
export function pickCountry(saved: string, locales: readonly string[], offered: readonly { code: string }[]): string {
  const has = (c: string): boolean => c !== '' && offered.some((o) => o.code === c);
  if (has(saved)) return saved;
  for (const l of locales) {
    const r = regionOf(l);
    if (has(r)) return r;
  }
  return '';
}

/** The currency for a country, if the provider takes it; otherwise US dollars, otherwise the first it lists. */
export function currencyFor(country: string, fiats: readonly string[]): string {
  const want = REGION_CURRENCY[country.toUpperCase()];
  if (want && fiats.includes(want)) return want;
  if (fiats.includes('usd')) return 'usd';
  return fiats[0] ?? 'usd';
}

/** The network to receive on: the one used last if it is still offered, else Base (cheap fees), else the first offered. */
export function pickNetwork<T extends string>(saved: string | null, offered: readonly T[]): T | null {
  if (saved && (offered as readonly string[]).includes(saved)) return saved as T;
  if ((offered as readonly string[]).includes('base')) return 'base' as T;
  return offered[0] ?? null;
}

/** A starting amount that is worth buying in this currency (a few tens of dollars' worth; providers refuse very small purchases). */
const DEFAULT_AMOUNT: Readonly<Record<string, number>> = { ngn: 50000, ghs: 1000, kes: 10000, ugx: 200000, tzs: 100000, zar: 1000, egp: 2500, mad: 500, inr: 5000, jpy: 10000, krw: 100000, idr: 500000, php: 3000, thb: 2000, vnd: 1000000, mxn: 1000, brl: 300, ars: 50000, clp: 50000, cop: 200000, pen: 200, huf: 20000, czk: 1500, try: 2000 };
export const defaultAmount = (fiat: string): string => String(DEFAULT_AMOUNT[fiat.toLowerCase()] ?? 100);
