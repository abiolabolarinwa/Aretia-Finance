import { describe, expect, it } from 'vitest';
import { MoonPayRampProvider, type RampApi, type RampApiCatalog } from './moonpay.js';
import { RampRouter, rampQuoteProblems, rankRampQuotes } from './router.js';
import { judgeWatch } from './watch.js';
import type { RampIntent, RampProvider, RampQuote } from './types.js';

const NOW = 1_000_000;
const WALLET = '0x' + 'a'.repeat(40);
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const intent = (over: Partial<RampIntent> = {}): RampIntent => ({ side: 'buy', fiat: 'usd', fiatAmount: 100, asset: { chain: 'base', symbol: 'USDC', address: BASE_USDC, decimals: 6 }, wallet: WALLET, country: 'US', ...over });
const catalog: RampApiCatalog = {
  countries: [{ code: 'US', name: 'United States', buy: true, sell: true }, { code: 'NG', name: 'Nigeria', buy: true, sell: false }],
  fiats: ['usd', 'eur'],
  tokens: [{ chain: 'base', symbol: 'USDC', contract: BASE_USDC, sell: true }, { chain: 'optimism', symbol: 'USDC', contract: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', sell: false }],
};
const api = (over: { status?: unknown; catalog?: unknown; session?: unknown; down?: boolean } = {}): { fn: RampApi; calls: Record<string, unknown>[] } => {
  const calls: Record<string, unknown>[] = [];
  const fn: RampApi = async (body) => {
    calls.push(body);
    if (over.down) throw new Error('offline');
    if (body.action === 'status') return over.status ?? { enabled: true, providers: [{ id: 'moonpay', name: 'MoonPay', sides: ['buy', 'sell'] }] };
    if (body.action === 'catalog') return over.catalog ?? catalog;
    return over.session ?? { provider: 'moonpay', url: 'https://buy-sandbox.moonpay.com/?apiKey=pk&signature=x' };
  };
  return { fn, calls };
};
const provider = (o: Parameters<typeof api>[0] = {}) => new MoonPayRampProvider({ api: api(o).fn, now: () => NOW });

describe('MoonPay ramp provider', () => {
  it('supports a listed token in an allowed country and currency', async () => {
    expect(await provider().supports(intent())).toEqual({ supported: true, reason: null });
  });

  it('declines with a reason: not switched on, unreachable, unknown country, country without selling, unlisted token, unlisted currency', async () => {
    expect((await provider({ status: { enabled: false } }).supports(intent())).reason).toMatch(/not switched on/);
    expect((await provider({ down: true }).supports(intent())).reason).toMatch(/could not be reached/);
    expect((await provider().supports(intent({ country: null }))).reason).toMatch(/Choose your country/);
    expect((await provider().supports(intent({ country: 'NG', side: 'sell' }))).reason).toMatch(/does not buy crypto from customers in Nigeria/);
    expect((await provider().supports(intent({ asset: { chain: 'polygon', symbol: 'USDC', address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 } }))).reason).toMatch(/does not list USDC on Polygon/);
    expect((await provider().supports(intent({ side: 'sell', asset: { chain: 'optimism', symbol: 'USDC', address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6 } }))).reason).toMatch(/selling USDC on Optimism/);
    expect((await provider().supports(intent({ fiat: 'ngn' }))).reason).toMatch(/NGN/);
    expect((await provider().supports(intent({ fiatAmount: 1.5 }))).reason).toMatch(/whole amount/);
  });

  it('does not offer selling when the service only lists buying', async () => {
    const p = provider({ status: { enabled: true, providers: [{ id: 'moonpay', name: 'MoonPay', sides: ['buy'] }] } });
    expect((await p.supports(intent({ side: 'sell' }))).reason).toMatch(/not offering selling/);
  });

  it('gives an honest unpriced quote with disclosures and a zero Aretia fee, never an invented price', async () => {
    const q = await provider().getQuote(intent());
    expect(q).toMatchObject({ priced: false, cryptoAmount: null, verification: 'provider' });
    expect(q.fees.find((f) => f.label === 'Aretia fee')!.amount).toBe('0');
    expect(q.fees[0]!.amount).toBeNull();
    expect(q.disclosures.join(' ')).toMatch(/never sees your card/);
  });

  it('only ever shows a checkout link on the provider\'s own site', async () => {
    const q = await provider().getQuote(intent());
    expect((await provider().createSession(q)).host).toBe('buy-sandbox.moonpay.com');
    for (const url of ['https://evil.example/pay', 'http://buy.moonpay.com/', 'https://buy.moonpay.com.evil.example/', 'javascript:alert(1)', 'not a url']) {
      await expect(provider({ session: { url } }).createSession(q), url).rejects.toThrow(/not on the provider|not valid/);
    }
  });

  it('refuses a session from an expired quote, and cannot track an order (answers unknown)', async () => {
    const q = await provider().getQuote(intent());
    const late = new MoonPayRampProvider({ api: api().fn, now: () => NOW + 60 * 60_000 });
    await expect(late.createSession(q)).rejects.toThrow(/expired/);
    expect((await provider().trackOrder()).code).toBe('unknown');
  });

  it('asks the service for the chain, wallet and amount of the intent and nothing else', async () => {
    const { fn, calls } = api();
    const p = new MoonPayRampProvider({ api: fn, now: () => NOW });
    await p.createSession(await p.getQuote(intent()));
    expect(calls.find((c) => c.action === 'session')).toEqual({ action: 'session', provider: 'moonpay', side: 'buy', asset: 'USDC', chain: 'base', wallet: WALLET, fiat: 'usd', amount: 100 });
  });
});

describe('ramp router', () => {
  it('collects quotes and the reasons others declined', async () => {
    const unusedP = async (): Promise<never> => { throw new Error('unused'); };
    const decliner: RampProvider = { id: 'other', name: 'Other', supports: async () => ({ supported: false, reason: 'Not in your country.' }), getQuote: unusedP, createSession: unusedP, trackOrder: unusedP };
    const search = await new RampRouter([provider(), decliner], () => NOW).quote(intent());
    expect(search.quotes.map((q) => q.providerId)).toEqual(['moonpay']);
    expect(search.declined).toEqual([{ providerId: 'other', reason: 'Not in your country.' }]);
  });

  it('reports a failing or hanging provider and still answers from the others', async () => {
    const unused = async (): Promise<never> => { throw new Error('unused'); };
    const fake = (id: string, supports: RampProvider['supports']): RampProvider => ({ id, name: id, supports, getQuote: unused, createSession: unused, trackOrder: unused });
    const down = fake('down', async () => { throw new Error('boom'); });
    const hangs = fake('hangs', () => new Promise(() => undefined));
    const search = await new RampRouter([provider(), down, hangs], () => NOW, 30).quote(intent());
    expect(search.quotes).toHaveLength(1);
    expect(search.failures.map((f) => f.providerId)).toEqual(['down', 'hangs']);
  });

  it('rejects a quote for another wallet, an expired one, a price claim without an amount, and one with no disclosures', async () => {
    const q = await provider().getQuote(intent());
    expect(rampQuoteProblems(intent({ wallet: '0x' + 'b'.repeat(40) }), q, NOW).join(' ')).toMatch(/different request/);
    expect(rampQuoteProblems(intent(), { ...q, expiresAt: NOW - 1 }, NOW).join(' ')).toMatch(/expired/);
    expect(rampQuoteProblems(intent(), { ...q, priced: true }, NOW).join(' ')).toMatch(/gives no amount/);
    expect(rampQuoteProblems(intent(), { ...q, cryptoAmount: 5n }, NOW).join(' ')).toMatch(/without saying/);
    expect(rampQuoteProblems(intent(), { ...q, disclosures: [] }, NOW).join(' ')).toMatch(/no disclosures/);
    expect(rampQuoteProblems(intent(), q, NOW)).toEqual([]);
  });

  it('ranks a priced quote above an unpriced one, then by provider id', async () => {
    const q = await provider().getQuote(intent());
    const mk = (id: string, priced: boolean): RampQuote => ({ ...q, providerId: id, priced, cryptoAmount: priced ? 5n : null });
    expect(rankRampQuotes([mk('b', false), mk('z', true), mk('a', false)]).map((x) => x.providerId)).toEqual(['z', 'a', 'b']);
  });
});

describe('knowing a ramp order is done', () => {
  it('a buy is done only when the balance rose; an unreadable balance is never read as zero', () => {
    const w = { side: 'buy' as const, baseline: 100n, startedAt: 0 };
    expect(judgeWatch(w, 100n).state).toBe('waiting');
    expect(judgeWatch(w, 90n).state).toBe('waiting');
    expect(judgeWatch(w, 150n)).toMatchObject({ state: 'arrived', delta: 50n });
    expect(judgeWatch(w, null).state).toBe('unreadable');
  });

  it('a sell shows the crypto left but never claims the payout arrived', () => {
    const w = { side: 'sell' as const, baseline: 100n, startedAt: 0 };
    expect(judgeWatch(w, 100n).state).toBe('waiting');
    const sent = judgeWatch(w, 40n);
    expect(sent).toMatchObject({ state: 'sent', delta: 60n });
    expect(sent.message).toMatch(/Aretia cannot see/);
  });
});
