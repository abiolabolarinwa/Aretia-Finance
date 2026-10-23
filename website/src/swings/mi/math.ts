/**
 * Decimal-safe maths for token amounts. Raw amounts are bigint; prices are fixed-point decimal strings with PRICE_SCALE
 * digits after the point. A JavaScript number is used only at the very edge (a chart candle, a percentage shown to a person).
 */

/** Digits after the point in a stored price. 30 keeps a 1e-12 price to 18 significant digits. */
export const PRICE_SCALE = 30;
const PRICE_UNIT = 10n ** BigInt(PRICE_SCALE);

export const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Parses a non-negative integer string; null for anything else (no sign, no decimals, no exponent). */
export function parseRaw(v: unknown): bigint | null {
  return typeof v === 'string' && /^[0-9]{1,78}$/.test(v) ? BigInt(v) : null;
}

/**
 * Price of one whole base token in whole quote tokens, as a scaled integer (value x 10^PRICE_SCALE), rounded half up.
 * price = (quoteRaw / 10^quoteDecimals) / (baseRaw / 10^baseDecimals).
 */
export function priceScaled(baseRaw: bigint, baseDecimals: number, quoteRaw: bigint, quoteDecimals: number): bigint | null {
  if (baseRaw <= 0n || quoteRaw <= 0n) return null;
  const num = quoteRaw * pow10(baseDecimals) * PRICE_UNIT;
  const den = baseRaw * pow10(quoteDecimals);
  return (num * 2n + den) / (den * 2n);
}

/** A scaled integer as a decimal string with trailing zeros removed ("0.000001", "12.5", "3"). */
export function scaledToString(v: bigint, scale = PRICE_SCALE): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(scale + 1, '0');
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, '');
  return (neg ? '-' : '') + int + (frac ? `.${frac}` : '');
}

/** The reverse of scaledToString. Null if the text is not a plain decimal. Digits beyond `scale` are cut off. */
export function stringToScaled(text: string, scale = PRICE_SCALE): bigint | null {
  const m = /^(-?)(\d{1,60})(?:\.(\d{1,60}))?$/.exec(text);
  if (!m) return null;
  const frac = (m[3] ?? '').slice(0, scale).padEnd(scale, '0');
  const v = BigInt(m[2]! + frac);
  return m[1] ? -v : v;
}

export function priceString(baseRaw: bigint, baseDecimals: number, quoteRaw: bigint, quoteDecimals: number): string | null {
  const p = priceScaled(baseRaw, baseDecimals, quoteRaw, quoteDecimals);
  return p === null || p <= 0n ? null : scaledToString(p);
}

/** A raw amount in whole tokens, as a decimal string. */
export function formatUnits(raw: bigint, decimals: number): string {
  return scaledToString(raw, decimals);
}

/**
 * Change from `from` to `to` in basis points (1% = 100), rounded toward zero, as an integer. Null when either price is
 * missing or `from` is zero. Both are decimal strings from priceString.
 */
export function changeBps(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const a = stringToScaled(from);
  const b = stringToScaled(to);
  if (a === null || b === null || a <= 0n) return null;
  const bps = ((b - a) * 10_000n) / a;
  const n = Number(bps);
  return Number.isSafeInteger(n) ? n : null;
}

/** Edge conversion for charts and display only. */
export function toNumber(decimal: string): number {
  return Number(decimal);
}

/** Whole-token value of a raw amount as a JS number, for display and ranking only (never for stored facts). */
export function unitsToNumber(raw: bigint, decimals: number): number {
  const s = formatUnits(raw, decimals);
  return Number(s);
}
