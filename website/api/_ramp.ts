/**
 * Core of the backend for buying USDT and USDC inside Aretia Pay (/api/ramp): buying and selling USDT and USDC through
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

/**
 * USDC on the EVM networks Swings supports, with MoonPay's own currency codes and the real contract addresses. The codes
 * and contracts were read from MoonPay's public currency list (api.moonpay.com/v3/currencies) on 8 Oct 2026. `sell` says
 * whether MoonPay lists that token as sellable. Nothing outside this table can be requested.
 */
export const RAMP_EVM_USDC = {
  ethereum: { moonpay: 'usdc', contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', sell: true },
  arbitrum: { moonpay: 'usdc_arbitrum', contract: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', sell: true },
  base: { moonpay: 'usdc_base', contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', sell: true },
  optimism: { moonpay: 'usdc_optimism', contract: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', sell: false },
  polygon: { moonpay: 'usdc_polygon', contract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', sell: true },
  avalanche: { moonpay: 'usdc_cchain', contract: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', sell: false },
} as const;
export type RampEvmChain = keyof typeof RAMP_EVM_USDC;
export const isRampEvmChain = (c: unknown): c is RampEvmChain => typeof c === 'string' && Object.prototype.hasOwnProperty.call(RAMP_EVM_USDC, c);
export const isEvmAddress = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

export interface RampEnv extends ProxyEnv {
  RAMP_ENABLED?: string;
  MOONPAY_PUBLISHABLE_KEY?: string;
  MOONPAY_SECRET_KEY?: string;
  /** "production" for live keys; anything else uses MoonPay's sandbox widget. */
  MOONPAY_ENV?: string;
  /** Override the widget host (for example if MoonPay changes it). */
  MOONPAY_WIDGET_URL?: string;
  /**
   * Set to "1" to offer selling USDC. Off by default: the sell widget parameters have not been checked against a
   * MoonPay account, so the operator turns it on only after testing it with sandbox keys.
   */
  MOONPAY_SELL_ENABLED?: string;
  /** Override the sell widget host. */
  MOONPAY_SELL_WIDGET_URL?: string;
}

export interface ProviderInfo {
  id: 'moonpay';
  name: string;
  /** Which directions are built. Selling is not built for any provider yet. */
  sides: Side[];
}

export const rampEnabled = (env: RampEnv): boolean => env.RAMP_ENABLED === '1';

/**
 * Sandbox-only aid for setup mistakes: the kind and length of the configured keys, never the keys themselves.
 * (A secret key pasted into the wrong field, or a key from another account, shows up here as the wrong prefix.)
 */
export function keyShape(env: RampEnv): { publishable: string; secret: string } {
  const shape = (v: string | undefined): string => {
    const s = v ?? '';
    const prefix = /^(pk|sk)_(test|live)_/.exec(s)?.[0] ?? 'unrecognised';
    return `${prefix} (${s.length} characters${s !== s.trim() ? ', has stray spaces' : ''})`;
  };
  return { publishable: shape(env.MOONPAY_PUBLISHABLE_KEY), secret: shape(env.MOONPAY_SECRET_KEY) };
}

/** Providers whose keys are present. Nothing is listed unless it can actually create a session. */
export function configuredProviders(env: RampEnv): ProviderInfo[] {
  const out: ProviderInfo[] = [];
  if (env.MOONPAY_PUBLISHABLE_KEY?.trim() && env.MOONPAY_SECRET_KEY?.trim()) out.push({ id: 'moonpay', name: 'MoonPay', sides: env.MOONPAY_SELL_ENABLED === '1' ? ['buy', 'sell'] : ['buy'] });
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
  /** The network. Omitted means Solana, as before. */
  chain?: string;
}

export type Checked = { ok: true; asset: RampAsset; chain: 'solana' | RampEvmChain; moonpayCode: string; side: Side; fiat: string | null; amount: number | null } | { ok: false; message: string };

export function checkSession(req: SessionRequest): Checked {
  if (req.side !== 'buy' && req.side !== 'sell') return { ok: false, message: 'Choose buy or sell.' };
  const chain = req.chain === undefined || req.chain === '' ? 'solana' : req.chain;
  let moonpayCode: string;
  let asset: RampAsset;
  let resolved: 'solana' | RampEvmChain;
  if (chain === 'solana') {
    if (req.asset !== 'USDC' && req.asset !== 'USDT') return { ok: false, message: 'Only USDT and USDC can be used here.' };
    if (typeof req.wallet !== 'string' || !isSolanaAddress(req.wallet)) return { ok: false, message: 'That is not a valid Solana wallet address.' };
    asset = req.asset;
    moonpayCode = RAMP_ASSETS[asset].moonpay;
    resolved = 'solana';
  } else if (isRampEvmChain(chain)) {
    if (req.asset !== 'USDC') return { ok: false, message: 'Only USDC is offered on this network.' };
    if (!isEvmAddress(req.wallet)) return { ok: false, message: 'That is not a valid wallet address for this network.' };
    if (req.side === 'sell' && !RAMP_EVM_USDC[chain].sell) return { ok: false, message: 'MoonPay does not list selling USDC on this network.' };
    asset = 'USDC';
    moonpayCode = RAMP_EVM_USDC[chain].moonpay;
    resolved = chain;
  } else return { ok: false, message: 'That network is not available here.' };
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
  return { ok: true, asset, chain: resolved, moonpayCode, side: req.side, fiat, amount };
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
export function buildMoonpayBuyUrl(env: RampEnv, args: { moonpayCode: string; wallet: string; fiat: string | null; amount: number | null }): string {
  const key = env.MOONPAY_PUBLISHABLE_KEY?.trim();
  const secret = env.MOONPAY_SECRET_KEY?.trim();
  if (!key || !secret) throw new Error('MoonPay is not configured.');
  const url = new URL(`${moonpayWidgetBase(env)}/`);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('currencyCode', args.moonpayCode);
  url.searchParams.set('walletAddress', args.wallet);
  if (args.fiat) url.searchParams.set('baseCurrencyCode', args.fiat);
  if (args.amount !== null) url.searchParams.set('baseCurrencyAmount', String(args.amount));
  url.searchParams.set('theme', 'light');
  // The signature covers exactly the query string that will be sent, values already encoded.
  const signature = moonpaySignature(secret, url.search);
  return `${url.toString()}&signature=${encodeURIComponent(signature)}`;
}

export function moonpaySellBase(env: RampEnv): string {
  if (env.MOONPAY_SELL_WIDGET_URL?.trim()) return env.MOONPAY_SELL_WIDGET_URL.trim();
  return env.MOONPAY_ENV === 'production' ? 'https://sell.moonpay.com' : 'https://sell-sandbox.moonpay.com';
}

/**
 * The signed sell-widget URL. The wallet given is the REFUND wallet (where the crypto returns if the sale does not go
 * through); the customer sends the crypto from their own wallet to the address MoonPay shows. Switched on only by
 * MOONPAY_SELL_ENABLED, because these parameters have not yet been checked against a MoonPay account.
 */
export function buildMoonpaySellUrl(env: RampEnv, args: { moonpayCode: string; wallet: string; fiat: string | null; amount: number | null }): string {
  const key = env.MOONPAY_PUBLISHABLE_KEY?.trim();
  const secret = env.MOONPAY_SECRET_KEY?.trim();
  if (!key || !secret) throw new Error('MoonPay is not configured.');
  const url = new URL(`${moonpaySellBase(env)}/`);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('baseCurrencyCode', args.moonpayCode);
  url.searchParams.set('refundWalletAddress', args.wallet);
  if (args.fiat) url.searchParams.set('quoteCurrencyCode', args.fiat);
  if (args.amount !== null) url.searchParams.set('baseCurrencyAmount', String(args.amount));
  url.searchParams.set('theme', 'light');
  return `${url.toString()}&signature=${encodeURIComponent(moonpaySignature(secret, url.search))}`;
}

// ------------------------------------------------------------------ catalog (public MoonPay lists)

export interface Catalog {
  countries: { code: string; name: string; buy: boolean; sell: boolean }[];
  fiats: string[];
  /** The tokens MoonPay currently lists as available (from its live list) among those Aretia allows. */
  tokens: { chain: string; symbol: string; contract: string; sell: boolean }[];
}
let catalogCache: { at: number; value: Catalog } | null = null;

/** Countries where MoonPay allows buying and the fiat currencies it lists, from its public API. Cached for an hour. */
export async function loadCatalog(fetchImpl: typeof fetch, now: number): Promise<Catalog | null> {
  if (catalogCache && now - catalogCache.at < 3_600_000) return catalogCache.value;
  try {
    const [c, f] = await Promise.all([fetchImpl('https://api.moonpay.com/v3/countries'), fetchImpl('https://api.moonpay.com/v3/currencies')]);
    if (!c.ok || !f.ok) return null;
    const countries = (await c.json()) as { alpha2?: string; name?: string; isAllowed?: boolean; isBuyAllowed?: boolean; isSellAllowed?: boolean }[];
    const currencies = (await f.json()) as { code?: string; type?: string; isSuspended?: boolean; isSellSupported?: boolean }[];
    const listed = (code: string): { sell: boolean } | null => {
      const x = currencies.find((y) => y.code === code && !y.isSuspended);
      return x ? { sell: x.isSellSupported === true } : null;
    };
    const tokens: Catalog['tokens'] = [];
    for (const [chain, t] of Object.entries(RAMP_EVM_USDC)) {
      const l = listed(t.moonpay);
      if (l) tokens.push({ chain, symbol: 'USDC', contract: t.contract, sell: l.sell && t.sell });
    }
    for (const sym of ['USDC', 'USDT'] as const) {
      const l = listed(RAMP_ASSETS[sym].moonpay);
      if (l) tokens.push({ chain: 'solana', symbol: sym, contract: RAMP_ASSETS[sym].mint, sell: l.sell });
    }
    const value: Catalog = {
      countries: countries.filter((x) => x.isAllowed && (x.isBuyAllowed || x.isSellAllowed) && x.alpha2 && x.name).map((x) => ({ code: x.alpha2!, name: x.name!, buy: x.isBuyAllowed === true, sell: x.isSellAllowed === true })).sort((a, b) => a.name.localeCompare(b.name)),
      fiats: currencies.filter((x) => x.type === 'fiat' && !x.isSuspended && x.code).map((x) => x.code!.toLowerCase()).sort(),
      tokens,
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
      return json(200, { enabled: true, assets: Object.keys(RAMP_ASSETS), providers, ...(env.MOONPAY_ENV === 'production' ? {} : { keyCheck: keyShape(env) }) }, headers);
    case 'catalog': {
      const catalog = await loadCatalog(input.fetchImpl, input.now);
      return catalog ? json(200, catalog, headers) : json(502, { error: 'The country list is unavailable right now.' }, headers);
    }
    case 'session': {
      const provider = providers.find((p) => p.id === req.provider);
      if (!provider) return json(400, { error: 'That provider is not available.' }, headers);
      const checked = checkSession({ provider: String(req.provider), side: String(req.side), asset: String(req.asset), wallet: req.wallet as string, fiat: req.fiat as string | undefined, amount: req.amount as number | undefined, chain: req.chain as string | undefined });
      if (!checked.ok) return json(400, { error: checked.message }, headers);
      if (!provider.sides.includes(checked.side)) return json(400, { error: 'That provider does not offer this yet.' }, headers);
      const build = checked.side === 'sell' ? buildMoonpaySellUrl : buildMoonpayBuyUrl;
      const url = build(env, { moonpayCode: checked.moonpayCode, wallet: req.wallet as string, fiat: checked.fiat, amount: checked.amount });
      return json(200, { provider: provider.id, url }, headers);
    }
    default:
      return json(400, { error: 'Unknown action.' }, headers);
  }
}
