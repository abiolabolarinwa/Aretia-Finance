/**
 * Core of the Aretia Marketplace backend (/api/ramp): buying and selling USDT and USDC through
 * third-party fiat ramp providers. Aretia never holds fiat or crypto here. A provider verifies the
 * customer, takes the payment and sends the stablecoin straight to the customer's own wallet; this
 * module only decides what may be requested and builds the provider's hosted-page URL.
 *
 * Hard rules enforced here, whatever the page asks for:
 *  - Only USDT and USDC, only on Solana, only the real mints.
 *  - Off unless RAMP_ENABLED=1 on the server.
 *  - A provider appears only when its keys are set. Secret keys never leave the server.
 *  - Same allowed-origin rule as the RPC proxy.
 *
 * No framework types, so it can be tested on its own. See docs/ramp.md.
 */
import { createHmac } from 'node:crypto';
import { isOriginAllowed, overLimit, type ProxyEnv } from './_rpcProxy.js';

// ------------------------------------------------------------------ assets

/** The only assets the marketplace offers. `moonpay` is MoonPay's code for the Solana version. */
export const RAMP_ASSETS = {
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', moonpay: 'usdc_sol' },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', moonpay: 'usdt_sol' },
} as const;
export type RampAsset = keyof typeof RAMP_ASSETS;
export type Side = 'buy' | 'sell';

export interface RampEnv extends ProxyEnv {
  RAMP_ENABLED?: string;
  MOONPAY_PUBLISHABLE_KEY?: string;
  MOONPAY_SECRET_KEY?: string;
  /** "production" for live keys; anything else uses MoonPay's sandbox widget. */
  MOONPAY_ENV?: string;
  /** Override the widget host (for example if MoonPay changes it). */
  MOONPAY_WIDGET_URL?: string;
}

export interface ProviderInfo {
  id: 'moonpay';
  name: string;
  /** Which directions are built. Selling is not built for any provider yet. */
  sides: Side[];
}

export const rampEnabled = (env: RampEnv): boolean => env.RAMP_ENABLED === '1';

/** Providers whose keys are present. Nothing is listed unless it can actually create a session. */
export function configuredProviders(env: RampEnv): ProviderInfo[] {
  const out: ProviderInfo[] = [];
  if (env.MOONPAY_PUBLISHABLE_KEY?.trim() && env.MOONPAY_SECRET_KEY?.trim()) out.push({ id: 'moonpay', name: 'MoonPay', sides: ['buy'] });
  return out;
}

// ------------------------------------------------------------------ validation

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** True for a base58 string that decodes to exactly 32 bytes: a Solana address. (Mirrors the wallet page's check.) */
export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  const bytes: number[] = [];
  for (const ch of value) {
    let carry = BASE58.indexOf(ch);
    if (carry < 0) return false;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of value) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return bytes.length === 32;
}

export interface SessionRequest {
  provider: string;
  side: string;
  asset: string;
  wallet: string;
  /** Fiat currency code such as "ngn". Optional. */
  fiat?: string;
  /** Fiat amount as a whole number. Optional. */
  amount?: number;
}

export type Checked = { ok: true; asset: RampAsset; fiat: string | null; amount: number | null } | { ok: false; message: string };

export function checkSession(req: SessionRequest): Checked {
  if (req.side !== 'buy') return { ok: false, message: 'Only buying is available so far.' };
  if (req.asset !== 'USDC' && req.asset !== 'USDT') return { ok: false, message: 'Only USDT and USDC can be bought here.' };
  if (typeof req.wallet !== 'string' || !isSolanaAddress(req.wallet)) return { ok: false, message: 'That is not a valid Solana wallet address.' };
  let fiat: string | null = null;
  if (req.fiat !== undefined && req.fiat !== '') {
    if (typeof req.fiat !== 'string' || !/^[a-zA-Z]{3}$/.test(req.fiat)) return { ok: false, message: 'The currency must be a three-letter code.' };
    fiat = req.fiat.toLowerCase();
  }
  let amount: number | null = null;
  if (req.amount !== undefined && req.amount !== null) {
    if (typeof req.amount !== 'number' || !Number.isInteger(req.amount) || req.amount < 1 || req.amount > 1_000_000) return { ok: false, message: 'The amount must be a whole number between 1 and 1,000,000.' };
    amount = req.amount;
  }
  return { ok: true, asset: req.asset, fiat, amount };
}

// ------------------------------------------------------------------ MoonPay

/** MoonPay's documented signature: base64 HMAC-SHA256 of the URL's query string, leading "?" included. */
export function moonpaySignature(secret: string, search: string): string {
  return createHmac('sha256', secret).update(search).digest('base64');
}

export function moonpayWidgetBase(env: RampEnv): string {
  if (env.MOONPAY_WIDGET_URL?.trim()) return env.MOONPAY_WIDGET_URL.trim();
  return env.MOONPAY_ENV === 'production' ? 'https://buy.moonpay.com' : 'https://buy-sandbox.moonpay.com';
}

/** The signed widget URL that sends the purchase to `wallet`. Throws if the provider is not configured. */
export function buildMoonpayBuyUrl(env: RampEnv, args: { asset: RampAsset; wallet: string; fiat: string | null; amount: number | null }): string {
  const key = env.MOONPAY_PUBLISHABLE_KEY?.trim();
  const secret = env.MOONPAY_SECRET_KEY?.trim();
  if (!key || !secret) throw new Error('MoonPay is not configured.');
  const url = new URL(`${moonpayWidgetBase(env)}/`);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('currencyCode', RAMP_ASSETS[args.asset].moonpay);
  url.searchParams.set('walletAddress', args.wallet);
  if (args.fiat) url.searchParams.set('baseCurrencyCode', args.fiat);
  if (args.amount !== null) url.searchParams.set('baseCurrencyAmount', String(args.amount));
  url.searchParams.set('theme', 'light');
  // The signature covers exactly the query string that will be sent, values already encoded.
  const signature = moonpaySignature(secret, url.search);
  return `${url.toString()}&signature=${encodeURIComponent(signature)}`;
}

// ------------------------------------------------------------------ catalog (public MoonPay lists)

export interface Catalog {
  countries: { code: string; name: string; buy: boolean }[];
  fiats: string[];
}
let catalogCache: { at: number; value: Catalog } | null = null;

/** Countries where MoonPay allows buying and the fiat currencies it lists, from its public API. Cached for an hour. */
export async function loadCatalog(fetchImpl: typeof fetch, now: number): Promise<Catalog | null> {
  if (catalogCache && now - catalogCache.at < 3_600_000) return catalogCache.value;
  try {
    const [c, f] = await Promise.all([fetchImpl('https://api.moonpay.com/v3/countries'), fetchImpl('https://api.moonpay.com/v3/currencies')]);
    if (!c.ok || !f.ok) return null;
    const countries = (await c.json()) as { alpha2?: string; name?: string; isAllowed?: boolean; isBuyAllowed?: boolean }[];
    const currencies = (await f.json()) as { code?: string; type?: string; isSuspended?: boolean }[];
    const value: Catalog = {
      countries: countries.filter((x) => x.isAllowed && x.isBuyAllowed && x.alpha2 && x.name).map((x) => ({ code: x.alpha2!, name: x.name!, buy: true })).sort((a, b) => a.name.localeCompare(b.name)),
      fiats: currencies.filter((x) => x.type === 'fiat' && !x.isSuspended && x.code).map((x) => x.code!.toLowerCase()).sort(),
    };
    catalogCache = { at: now, value };
    return value;
  } catch {
    return null;
  }
}
export function resetCatalogCache(): void {
  catalogCache = null;
}

// ------------------------------------------------------------------ request handling

export interface RampInput {
  method: string;
  origin: string | null;
  ip: string;
  contentType: string | null;
  body: string;
  env: RampEnv;
  fetchImpl: typeof fetch;
  now: number;
}
export interface RampOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const json = (status: number, value: unknown, headers: Record<string, string>): RampOutput => ({ status, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(value) });

export async function handleRamp(input: RampInput): Promise<RampOutput> {
  const { env } = input;
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'POST') return json(405, { error: 'Use POST.' }, { ...headers, allow: 'POST, OPTIONS' });
  if (!allowed) return json(403, { error: 'This origin is not allowed.' }, headers);
  if (!(input.contentType ?? '').toLowerCase().includes('application/json')) return json(415, { error: 'Send JSON.' }, headers);
  if (input.body.length > 4096) return json(413, { error: 'Request too large.' }, headers);
  if (overLimit(`ramp:${input.ip}`, input.now)) return json(429, { error: 'Too many requests. Try again in a minute.' }, { ...headers, 'retry-after': '60' });

  let req: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
    req = parsed as Record<string, unknown>;
  } catch {
    return json(400, { error: 'Send a JSON object.' }, headers);
  }

  if (!rampEnabled(env)) return json(200, { enabled: false }, headers);
  const providers = configuredProviders(env);

  switch (req.action) {
    case 'status':
      return json(200, { enabled: true, assets: Object.keys(RAMP_ASSETS), providers }, headers);
    case 'catalog': {
      const catalog = await loadCatalog(input.fetchImpl, input.now);
      return catalog ? json(200, catalog, headers) : json(502, { error: 'The country list is unavailable right now.' }, headers);
    }
    case 'session': {
      const provider = providers.find((p) => p.id === req.provider);
      if (!provider) return json(400, { error: 'That provider is not available.' }, headers);
      const checked = checkSession({ provider: String(req.provider), side: String(req.side), asset: String(req.asset), wallet: req.wallet as string, fiat: req.fiat as string | undefined, amount: req.amount as number | undefined });
      if (!checked.ok) return json(400, { error: checked.message }, headers);
      if (!provider.sides.includes('buy')) return json(400, { error: 'That provider does not offer this yet.' }, headers);
      const url = buildMoonpayBuyUrl(env, { asset: checked.asset, wallet: req.wallet as string, fiat: checked.fiat, amount: checked.amount });
      return json(200, { provider: provider.id, url }, headers);
    }
    default:
      return json(400, { error: 'Unknown action.' }, headers);
  }
}
