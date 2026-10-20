import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { issueSession } from './_swingsAuth.js';
import { RAMP_EVM_USDC, buildMoonpayBuyUrl, buildMoonpaySellUrl, checkSession, configuredProviders, handleRamp, loadCatalog, moonpaySignature, resetCatalogCache, type RampEnv } from './_ramp.js';

const ENV: RampEnv = { RAMP_ENABLED: '1', MOONPAY_PUBLISHABLE_KEY: 'pk_test_abc', MOONPAY_SECRET_KEY: 'sk_test_def', SUPABASE_URL: 'https://db.example.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SWINGS_SESSION_SECRET: 'session-secret' };
const EVM = '0x' + 'a'.repeat(40);
const SOL = 'HncLFBcun4ePWvUz8cefMx7XJR1ZBQ1d2vnXsWv2gK6F';

describe('what may be requested', () => {
  beforeEach(() => resetCatalogCache());

  it('keeps Solana behaviour: no chain means Solana, and only USDC or USDT', () => {
    expect(checkSession({ provider: 'moonpay', side: 'buy', asset: 'USDC', wallet: SOL })).toMatchObject({ ok: true, chain: 'solana', moonpayCode: 'usdc_sol' });
    expect(checkSession({ provider: 'moonpay', side: 'buy', asset: 'DOGE', wallet: SOL }).ok).toBe(false);
  });

  it('accepts USDC on each listed EVM network with its MoonPay code, and rejects USDT, other networks and bad addresses', () => {
    for (const [chain, t] of Object.entries(RAMP_EVM_USDC)) expect(checkSession({ provider: 'moonpay', side: 'buy', asset: 'USDC', wallet: EVM, chain })).toMatchObject({ ok: true, moonpayCode: t.moonpay });
    expect(checkSession({ provider: 'moonpay', side: 'buy', asset: 'USDT', wallet: EVM, chain: 'base' }).ok).toBe(false);
    expect(checkSession({ provider: 'moonpay', side: 'buy', asset: 'USDC', wallet: EVM, chain: 'bnb' }).ok).toBe(false);
    expect(checkSession({ provider: 'moonpay', side: 'buy', asset: 'USDC', wallet: SOL, chain: 'base' }).ok).toBe(false);
    expect(checkSession({ provider: 'moonpay', side: 'buy', asset: 'USDC', wallet: EVM }).ok).toBe(false); // an EVM address is not a Solana one
  });

  it('refuses to sell on a network MoonPay does not list for selling', () => {
    expect(checkSession({ provider: 'moonpay', side: 'sell', asset: 'USDC', wallet: EVM, chain: 'optimism' })).toMatchObject({ ok: false });
    expect(checkSession({ provider: 'moonpay', side: 'sell', asset: 'USDC', wallet: EVM, chain: 'base' })).toMatchObject({ ok: true, side: 'sell' });
  });

  it('lists selling only when the operator switched it on', () => {
    expect(configuredProviders(ENV)[0]!.sides).toEqual(['buy']);
    expect(configuredProviders({ ...ENV, MOONPAY_SELL_ENABLED: '1' })[0]!.sides).toEqual(['buy', 'sell']);
  });
});

describe('the widget URLs', () => {
  it('signs exactly the query string that is sent, with the secret, and never puts the secret in the URL', () => {
    const url = buildMoonpayBuyUrl(ENV, { moonpayCode: 'usdc_base', wallet: EVM, fiat: 'usd', amount: 100 });
    const u = new URL(url);
    const sig = u.searchParams.get('signature')!;
    const unsigned = url.slice(url.indexOf('?'), url.lastIndexOf('&signature='));
    expect(sig).toBe(createHmac('sha256', 'sk_test_def').update(unsigned).digest('base64'));
    expect(sig).toBe(moonpaySignature('sk_test_def', unsigned));
    expect(u.searchParams.get('currencyCode')).toBe('usdc_base');
    expect(u.searchParams.get('walletAddress')).toBe(EVM);
    expect(url).not.toContain('sk_test');
  });

  it('the sell URL passes the wallet as the refund address and is signed too', () => {
    const url = buildMoonpaySellUrl(ENV, { moonpayCode: 'usdc_base', wallet: EVM, fiat: 'eur', amount: 50 });
    const u = new URL(url);
    expect(u.host).toBe('sell-sandbox.moonpay.com');
    expect(u.searchParams.get('refundWalletAddress')).toBe(EVM);
    expect(u.searchParams.get('baseCurrencyCode')).toBe('usdc_base');
    expect(u.searchParams.get('signature')).toBeTruthy();
  });
});

describe('the catalog and the handler', () => {
  const fakeFetch = (async (url: string) => {
    if (String(url).includes('/rest/v1/account_sessions')) return new Response('[]');
    if (String(url).endsWith('/countries')) return new Response(JSON.stringify([{ alpha2: 'US', name: 'United States', isAllowed: true, isBuyAllowed: true, isSellAllowed: true }, { alpha2: 'NG', name: 'Nigeria', isAllowed: true, isBuyAllowed: true, isSellAllowed: false }, { alpha2: 'KP', name: 'North Korea', isAllowed: false }]));
    return new Response(JSON.stringify([{ code: 'usd', type: 'fiat' }, { code: 'usdc_base', type: 'crypto', isSellSupported: true }, { code: 'usdc', type: 'crypto', isSuspended: true }, { code: 'usdc_sol', type: 'crypto', isSellSupported: true }]));
  }) as unknown as typeof fetch;

  it('lists only tokens MoonPay currently has live, per country buy and sell, and drops suspended ones', async () => {
    const c = (await loadCatalog(fakeFetch, 1))!;
    expect(c.tokens.map((t) => t.chain).sort()).toEqual(['base', 'solana']);
    expect(c.tokens.find((t) => t.chain === 'base')).toMatchObject({ symbol: 'USDC', sell: true });
    expect(c.countries.map((x) => [x.code, x.buy, x.sell])).toEqual([['NG', true, false], ['US', true, true]]);
    expect(c.fiats).toEqual(['usd']);
  });

  const signedIn = (owner: string) => `Bearer ${issueSession('session-secret', owner, 5).token}`;
  const call = (body: unknown, env: RampEnv = ENV, authorization: string | null = signedIn(`evm:${EVM}`)) => handleRamp({ method: 'POST', origin: 'https://aretiafinance.org', authorization, ip: '1.2.3.4', contentType: 'application/json', body: JSON.stringify(body), env, fetchImpl: fakeFetch, now: 5 });

  it('creates an EVM buy session, and refuses selling unless switched on', async () => {
    const ok = await call({ action: 'session', provider: 'moonpay', side: 'buy', asset: 'USDC', chain: 'base', wallet: EVM, fiat: 'usd', amount: 50 });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).url).toContain('currencyCode=usdc_base');
    const sell = await call({ action: 'session', provider: 'moonpay', side: 'sell', asset: 'USDC', chain: 'base', wallet: EVM });
    expect(sell.status).toBe(400);
    const sellOn = await call({ action: 'session', provider: 'moonpay', side: 'sell', asset: 'USDC', chain: 'base', wallet: EVM }, { ...ENV, MOONPAY_SELL_ENABLED: '1' });
    expect(sellOn.status).toBe(200);
  });

  it('L-4: signs a widget URL only for the wallet the caller is signed in with', async () => {
    const body = { action: 'session', provider: 'moonpay', side: 'buy', asset: 'USDC', chain: 'ethereum', wallet: '0x' + '9'.repeat(40), amount: 500 };
    // no session (the scripted request with a forged Origin of the review)
    expect((await call(body, ENV, null)).status).toBe(401);
    // a session for another wallet
    expect((await call(body)).status).toBe(403);
    // a forged session
    expect((await call(body, ENV, 'Bearer v1.abc.def')).status).toBe(401);
    // the signed-in wallet itself, any letter case
    expect((await call({ ...body, wallet: '0x' + '9'.repeat(40) }, ENV, signedIn(`evm:0x${'9'.repeat(40)}`))).status).toBe(200);
    expect((await call({ action: 'session', provider: 'moonpay', side: 'buy', asset: 'USDC', wallet: SOL }, ENV, signedIn(`solana:${SOL}`))).status).toBe(200);
    expect((await call({ action: 'session', provider: 'moonpay', side: 'buy', asset: 'USDC', wallet: SOL }, ENV, signedIn(`solana:${SOL.toLowerCase()}`))).status).toBe(403);
  });
});
