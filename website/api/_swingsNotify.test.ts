import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { issueSession } from './_swingsAuth.js';
import { cleanOrder, handleAlertsRun, handleNotify, handleTelegramWebhook, type NotifyEnv, type NotifyInput } from './_swingsNotify.js';
import { generateVapidKeys } from '../src/swings/notify/vapid.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://aretiafinance.org';
const OWNER = 'evm:0x1111111111111111111111111111111111111111';
const BASE_ADDR = '0x2222222222222222222222222222222222222222';

interface Call {
  method: string;
  url: string;
  body: unknown;
}
type Handler = (c: Call) => unknown;

/** A pretend Supabase, Telegram and price service: each call is recorded, and answered by the first route that matches. */
function fake(routes: [RegExp, Handler][]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : null };
    calls.push(call);
    for (const [re, h] of routes) if (re.test(`${call.method} ${url}`)) {
      const out = h(call);
      return out instanceof Response ? out : new Response(JSON.stringify(out ?? []), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, find: (re: RegExp) => calls.filter((c) => re.test(`${c.method} ${c.url}`)) };
}

const env = (over: Partial<NotifyEnv> = {}): NotifyEnv => ({ SUPABASE_URL: 'https://db.example.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key-for-tests', CRON_SECRET: 'cron-secret', TELEGRAM_BOT_TOKEN: '123:tok', TELEGRAM_BOT_USERNAME: 'AretiaAlertsBot', TELEGRAM_WEBHOOK_SECRET: 'hook-secret', ...over });
const session = (): string => `Bearer ${issueSession('service-key-for-tests', OWNER, NOW).token}`;
const input = (over: Partial<NotifyInput> & { fetchImpl: typeof fetch }): NotifyInput => ({ method: 'POST', origin: ORIGIN, authorization: null, ip: '9.9.9.9', query: {}, body: {}, env: env(), now: NOW, ...over });

beforeEach(() => resetRateLimit());

describe('notify: settings', () => {
  it('reports what is set up without a sign-in', async () => {
    const f = fake([]);
    const keys = await generateVapidKeys();
    const out = await handleNotify(input({ fetchImpl: f.fetchImpl, body: { op: 'config' }, env: env({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }) }));
    expect(JSON.parse(out.body)).toEqual({ telegram: true, webpush: true, vapidPublicKey: keys.publicKey });
    const bare = await handleNotify(input({ fetchImpl: f.fetchImpl, body: { op: 'config' }, env: env({ TELEGRAM_BOT_TOKEN: '' }) }));
    expect(JSON.parse(bare.body)).toMatchObject({ telegram: false, webpush: false, vapidPublicKey: null });
  });
  it('refuses anything else without a sign-in, a foreign origin, and a forged session', async () => {
    const f = fake([]);
    expect((await handleNotify(input({ fetchImpl: f.fetchImpl, body: { op: 'status' } }))).status).toBe(401);
    expect((await handleNotify(input({ fetchImpl: f.fetchImpl, body: { op: 'status' }, authorization: 'Bearer v1.forged.token' }))).status).toBe(401);
    expect((await handleNotify(input({ fetchImpl: f.fetchImpl, origin: 'https://evil.example', body: { op: 'status' }, authorization: session() }))).status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });
  it('makes a Telegram link with a one-time code that expires', async () => {
    const f = fake([[/GET .*notify_channels/, () => []]]);
    const out = await handleNotify(input({ fetchImpl: f.fetchImpl, body: { op: 'telegram-link' }, authorization: session() }));
    const { url, expiresAt } = JSON.parse(out.body) as { url: string; expiresAt: number };
    expect(url).toMatch(/^https:\/\/t\.me\/AretiaAlertsBot\?start=[0-9a-f]{32}$/);
    expect(expiresAt).toBe(NOW + 15 * 60_000);
    const saved = f.find(/POST .*notify_links/)[0]!.body as { code: string; owner: string; expires_at: number };
    expect(url.endsWith(saved.code)).toBe(true);
    expect(saved.owner).toBe(OWNER);
  });
  it('keeps only valid https push addresses, and returns the same browser its existing channel', async () => {
    const keys = await generateVapidKeys();
    const e = env({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    const f = fake([[/GET .*notify_channels/, () => []], [/POST .*notify_channels/, () => [{ id: 7 }]]]);
    expect((await handleNotify(input({ fetchImpl: f.fetchImpl, env: e, body: { op: 'push-subscribe', endpoint: 'http://x.example/a' }, authorization: session() }))).status).toBe(400);
    const ok = JSON.parse((await handleNotify(input({ fetchImpl: f.fetchImpl, env: e, body: { op: 'push-subscribe', endpoint: 'https://push.example.org/abc' }, authorization: session() }))).body) as { id: number; secret: string };
    expect(ok.id).toBe(7);
    expect(ok.secret).toMatch(/^[0-9a-f]{48}$/);
    const again = fake([[/GET .*notify_channels/, () => [{ id: 7, owner: OWNER, kind: 'webpush', ref: 'https://push.example.org/abc', secret: 'keepme' }]]]);
    expect(JSON.parse((await handleNotify(input({ fetchImpl: again.fetchImpl, env: e, body: { op: 'push-subscribe', endpoint: 'https://push.example.org/abc' }, authorization: session() }))).body)).toEqual({ id: 7, secret: 'keepme' });
  });
  it('checks price orders field by field', () => {
    const good = { id: 'o1', chain: 'base', address: BASE_ADDR, symbol: 'AAA', name: 'Aaa', icon: null, side: 'buy', targetUsd: 0.5, createdAt: 5 };
    expect(cleanOrder(good)).toMatchObject({ id: 'o1', chain: 'base', side: 'buy', targetUsd: 0.5 });
    for (const bad of [{ ...good, chain: 'doge' }, { ...good, side: 'hold' }, { ...good, targetUsd: 0 }, { ...good, targetUsd: Number.NaN }, { ...good, id: '' }, { ...good, address: 'nope' }, null, 'x']) expect(cleanOrder(bad)).toBeNull();
  });
});

describe('notify: the browser inbox', () => {
  it('hands over waiting messages only with the right secret, and clears them', async () => {
    const f = fake([[/GET .*notify_channels/, () => [{ id: 7, secret: 's'.repeat(48) }]], [/GET .*notify_inbox/, () => [{ id: 1, title: 'T', body: 'B', url: '/wallet' }]]]);
    const wrong = await handleNotify(input({ fetchImpl: f.fetchImpl, method: 'GET', query: { inbox: '7', s: 'x'.repeat(48) } }));
    expect(wrong.status).toBe(404);
    const right = await handleNotify(input({ fetchImpl: f.fetchImpl, method: 'GET', query: { inbox: '7', s: 's'.repeat(48) } }));
    expect(JSON.parse(right.body)).toEqual({ messages: [{ title: 'T', body: 'B', url: '/wallet' }] });
    expect(f.find(/DELETE .*notify_inbox\?id=in\.\(1\)/)).toHaveLength(1);
    expect((await handleNotify(input({ fetchImpl: f.fetchImpl, method: 'GET', query: { inbox: 'abc', s: 's'.repeat(48) } }))).status).toBe(400);
  });
});

describe('telegram webhook', () => {
  const update = (text: string) => ({ message: { text, chat: { id: 555, type: 'private' } } });
  it('believes only requests that carry the secret', async () => {
    const f = fake([]);
    expect((await handleTelegramWebhook(input({ fetchImpl: f.fetchImpl, body: update('/start x'), telegramSecret: 'wrong' }))).status).toBe(401);
    expect((await handleTelegramWebhook(input({ fetchImpl: f.fetchImpl, body: update('/start x'), telegramSecret: null }))).status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });
  it('links a chat when it sends a valid code, then uses the code up', async () => {
    const code = 'a'.repeat(32);
    const f = fake([[/GET .*notify_links/, () => [{ owner: OWNER, expires_at: NOW + 1000 }]]]);
    const out = await handleTelegramWebhook(input({ fetchImpl: f.fetchImpl, body: update(`/start ${code}`), telegramSecret: 'hook-secret' }));
    expect(out.status).toBe(200);
    expect(f.find(/POST .*notify_channels/)[0]!.body).toMatchObject({ owner: OWNER, kind: 'telegram', ref: '555' });
    expect(f.find(/DELETE .*notify_links/)).toHaveLength(1);
    expect(JSON.stringify(f.find(/sendMessage/)[0]!.body)).toContain('Connected');
  });
  it('turns an expired or unknown code away without linking anything', async () => {
    const code = 'b'.repeat(32);
    for (const links of [[], [{ owner: OWNER, expires_at: NOW - 1 }]]) {
      const f = fake([[/GET .*notify_links/, () => links]]);
      await handleTelegramWebhook(input({ fetchImpl: f.fetchImpl, body: update(`/start ${code}`), telegramSecret: 'hook-secret' }));
      expect(f.find(/POST .*notify_channels/)).toHaveLength(0);
      expect(JSON.stringify(f.find(/sendMessage/)[0]!.body)).toContain('expired');
    }
  });
  it('removes the chat on /stop', async () => {
    const f = fake([]);
    await handleTelegramWebhook(input({ fetchImpl: f.fetchImpl, body: update('/stop'), telegramSecret: 'hook-secret' }));
    expect(f.find(/DELETE .*notify_channels\?kind=eq\.telegram&ref=eq\.555/)).toHaveLength(1);
  });
});

describe('the scheduled check', () => {
  const dexPair = (address: string, price: string) => [{ chainId: 'base', pairAddress: '0x3333333333333333333333333333333333333333', baseToken: { address, symbol: 'AAA', name: 'Aaa' }, quoteToken: { symbol: 'WETH' }, priceUsd: price, liquidity: { usd: 90_000 }, pairCreatedAt: NOW - 86_400_000 }];
  const routes = (price: string, sendStatus = 200): [RegExp, Handler][] => [
    [/GET .*notify_channels/, () => [{ id: 1, owner: OWNER, kind: 'telegram', ref: '555', secret: null }]],
    [/GET .*notify_prefs/, () => []],
    [/GET .*user_favourites/, () => [{ owner: OWNER, chain: 'base', address: BASE_ADDR, symbol: 'AAA', icon: null }]],
    [/GET .*user_price_orders/, () => []],
    [/GET .*notify_state/, () => [{ owner: OWNER, token_key: `base:${BASE_ADDR}`, baseline: 1 }]],
    [/GET .*dexscreener/, () => dexPair(BASE_ADDR, price)],
    [/POST .*sendMessage/, () => new Response('{}', { status: sendStatus })],
  ];
  it('needs the cron secret', async () => {
    const f = fake([]);
    expect((await handleAlertsRun(input({ fetchImpl: f.fetchImpl, method: 'GET', authorization: null }))).status).toBe(401);
    expect((await handleAlertsRun(input({ fetchImpl: f.fetchImpl, method: 'GET', authorization: 'Bearer nope' }))).status).toBe(401);
  });
  it('sends a Telegram message for a move and remembers the new baseline', async () => {
    const f = fake(routes('1.20'));
    const out = await handleAlertsRun(input({ fetchImpl: f.fetchImpl, method: 'GET', authorization: 'Bearer cron-secret' }));
    expect(JSON.parse(out.body)).toMatchObject({ owners: 1, tokens: 1, sent: 1, failed: 0 });
    const sent = f.find(/POST .*sendMessage/);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body as { text: string; chat_id: string }).chat_id).toBe('555');
    expect((sent[0]!.body as { text: string }).text).toContain('AAA ▲ +20.0%');
    expect((sent[0]!.body as { text: string }).text).toContain('https://aretiafinance.org/wallet#/favourites');
    expect((f.find(/POST .*notify_state/)[0]!.body as { baseline: number }[])[0]!.baseline).toBeCloseTo(1.2, 6);
  });
  it('sends nothing for a small move', async () => {
    const f = fake(routes('1.01'));
    const out = await handleAlertsRun(input({ fetchImpl: f.fetchImpl, method: 'GET', authorization: 'Bearer cron-secret' }));
    expect(JSON.parse(out.body)).toMatchObject({ sent: 0, failed: 0 });
    expect(f.find(/sendMessage/)).toHaveLength(0);
  });
  it('does not remember a move that could not be delivered, so it is tried again', async () => {
    const f = fake(routes('1.20', 500));
    const out = await handleAlertsRun(input({ fetchImpl: f.fetchImpl, method: 'GET', authorization: 'Bearer cron-secret' }));
    expect(JSON.parse(out.body)).toMatchObject({ sent: 0, failed: 1 });
    expect(f.find(/POST .*notify_state/)).toHaveLength(0);
  });
  it('drops a chat that blocked the bot', async () => {
    const f = fake(routes('1.20', 403));
    await handleAlertsRun(input({ fetchImpl: f.fetchImpl, method: 'GET', authorization: 'Bearer cron-secret' }));
    expect(f.find(/DELETE .*notify_channels\?id=eq\.1/)).toHaveLength(1);
  });
  it('marks a price order that was reached, once', async () => {
    const r = routes('0.4');
    r[3] = [/GET .*user_price_orders/, () => [{ owner: OWNER, id: 'ord1', chain: 'base', address: BASE_ADDR, symbol: 'AAA', name: 'Aaa', icon: null, side: 'buy', target_usd: 0.5, created_at: 1 }]];
    r[2] = [/GET .*user_favourites/, () => []];
    r[4] = [/GET .*notify_state/, () => []];
    const f = fake(r);
    const out = await handleAlertsRun(input({ fetchImpl: f.fetchImpl, method: 'GET', authorization: 'Bearer cron-secret' }));
    expect(JSON.parse(out.body)).toMatchObject({ sent: 1, ordersReached: 1 });
    expect((f.find(/POST .*sendMessage/)[0]!.body as { text: string }).text).toContain('AAA reached $0.5');
    expect(f.find(/PATCH .*user_price_orders\?owner=.*&id=eq\.ord1/)[0]!.body).toMatchObject({ hit_price: 0.4 });
  });

  it('reaches a browser by putting the text in its inbox and sending an empty push, and forgets a browser that is gone', async () => {
    const keys = await generateVapidKeys();
    const e = env({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    for (const [status, removed] of [[201, 0], [410, 1]] as const) {
      const r = routes('1.20');
      r[0] = [/GET .*notify_channels/, () => [{ id: 4, owner: OWNER, kind: 'webpush', ref: 'https://push.example.org/send/xyz', secret: 'p'.repeat(48) }]];
      r.push([/POST https:\/\/push\.example\.org/, () => new Response(null, { status })]);
      const f = fake(r);
      const out = await handleAlertsRun(input({ fetchImpl: f.fetchImpl, method: 'GET', authorization: 'Bearer cron-secret', env: e }));
      expect(JSON.parse(out.body)).toMatchObject({ sent: status === 201 ? 1 : 0 });
      expect(f.find(/POST .*notify_inbox/)[0]!.body).toMatchObject({ channel_id: 4, title: 'AAA ▲ +20.0%', url: '/wallet#/favourites' });
      const push = f.find(/POST https:\/\/push\.example\.org/)[0]!;
      expect(push.body).toBeNull();
      expect(f.find(/DELETE .*notify_channels\?id=eq\.4/)).toHaveLength(removed);
    }
  });
});
