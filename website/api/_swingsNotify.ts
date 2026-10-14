/**
 * Alerts that reach a phone while the page is closed: Telegram and browser (web push) notifications.
 *
 *   POST /api/swings-notify   { op: 'config' }                               what is set up on this server (no sign-in)
 *                             { op: 'status' }                               the person's linked channels and settings
 *                             { op: 'telegram-link' }                        a link that opens the bot with a one-time code
 *                             { op: 'push-subscribe', endpoint }             remember this browser for push
 *                             { op: 'unlink', id }                           remove one channel
 *                             { op: 'prefs', movePct, enabled }              how big a move to report, and on/off
 *                             { op: 'orders', orders: [...] }                copy the browser's price orders so the server watches them
 *                             { op: 'test' }                                 send a test message to every channel
 *   GET  /api/swings-notify?inbox=<id>&s=<secret>                            a browser collects its waiting messages
 *   POST /api/swings-telegram                                                Telegram's webhook (the bot's messages)
 *   GET  /api/swings-alerts-run                                              the scheduled check (Authorization: Bearer CRON_SECRET)
 *
 * Everything but `config`, the inbox and the webhook needs the same wallet sign-in the favourites use, and only touches that
 * wallet's rows. Nothing here can move funds. A message only ever carries a title, some numbers and a link to the site.
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { readSession } from './_swingsAuth.js';
import { rest, type Rest } from './_swingsAccount.js';
import { isChainId, type ChainId } from '../src/swings/core/types.js';
import { normalizeTokenRef } from '../src/swings/core/token.js';
import { cleanLogo, cleanText } from '../src/swings/tokens/registry.js';
import { rowsFromFavourites } from '../src/swings/market/registryRows.js';
import { watchKey, PCT_CHOICES } from '../src/swings/account/priceAlerts.js';
import type { PriceOrder } from '../src/swings/account/priceOrders.js';
import { planForOwner, telegramText, type PlannedMessage, type WatchedFavourite } from '../src/swings/notify/plan.js';
import { isStop, readUpdate, sendTelegram, startCode, telegramLink } from '../src/swings/notify/telegram.js';
import { sendPush, validPushEndpoint, type VapidKeys } from '../src/swings/notify/vapid.js';
import type { TokensEnv, TokensOutput } from './_swingsTokens.js';

export interface NotifyEnv extends TokensEnv {
  SWINGS_SESSION_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** The site's address, for links in messages. */
  SITE_ORIGIN?: string;
}

export interface NotifyInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  query: Record<string, string | undefined>;
  body: unknown;
  env: NotifyEnv;
  fetchImpl: typeof fetch;
  now: number;
  /** Telegram's `X-Telegram-Bot-Api-Secret-Token` header, for the webhook. */
  telegramSecret?: string | null;
}

const MAX_CHANNELS = 6;
const MAX_ORDERS = 20;
const LINK_TTL_MS = 15 * 60_000;
const DEFAULT_ORIGIN = 'https://aretiafinance.org';
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const json = (status: number, data: unknown, headers: Record<string, string>): TokensOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });
const randomHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const inList = (values: readonly string[]): string => `in.(${values.map((v) => `"${v.replace(/"/g, '')}"`).join(',')})`;

const vapidFrom = (env: NotifyEnv): VapidKeys | null => {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  return publicKey && privateKey ? { publicKey, privateKey, subject: env.VAPID_SUBJECT?.trim() || 'mailto:support@aretiafinance.org' } : null;
};

interface Channel {
  id: number;
  owner: string;
  kind: 'telegram' | 'webpush';
  ref: string;
  secret: string | null;
  created_at?: number;
}

/**
 * Sends one message to one channel. Telegram: a chat message. Browser: the message is put in that browser's inbox and the
 * browser is woken with an empty push; it collects the text itself. A person who blocked the bot, or a browser that has gone,
 * is removed so it is not tried again. Returns whether it was handed over.
 */
export async function deliver(env: NotifyEnv, fetchImpl: typeof fetch, db: Rest, ch: Channel, m: PlannedMessage, now: number): Promise<boolean> {
  const origin = env.SITE_ORIGIN?.trim() || DEFAULT_ORIGIN;
  try {
    if (ch.kind === 'telegram') {
      const token = env.TELEGRAM_BOT_TOKEN?.trim();
      if (!token) return false;
      const status = await sendTelegram(fetchImpl, token, ch.ref, telegramText(m, origin));
      if (status === 403 || status === 400) {
        await db.call(`notify_channels?id=eq.${ch.id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
        return false;
      }
      if (status !== 200) return false;
    } else {
      const keys = vapidFrom(env);
      if (!keys) return false;
      await db.call('notify_inbox', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ channel_id: ch.id, title: m.title, body: m.body, url: m.url, created_at: now }) });
      const status = await sendPush(fetchImpl, keys, ch.ref, now);
      if (status === 404 || status === 410) {
        await db.call(`notify_channels?id=eq.${ch.id}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
        return false;
      }
      if (status < 200 || status >= 300) return false;
    }
    await db.call(`notify_channels?id=eq.${ch.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ last_ok_at: now }) });
    return true;
  } catch {
    return false;
  }
}

function database(env: NotifyEnv, fetchImpl: typeof fetch): { db: Rest; secret: string } | null {
  const url = supabaseBase(env.SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { db: rest(url, key, fetchImpl), secret: env.SWINGS_SESSION_SECRET?.trim() || key } : null;
}

/** A price order as the page sends it, checked field by field. */
export function cleanOrder(v: unknown): { id: string; chain: ChainId; address: string; symbol: string; name: string; icon: string | null; side: 'buy' | 'sell'; targetUsd: number; createdAt: number } | null {
  const o = obj(v);
  const chain = typeof o.chain === 'string' && isChainId(o.chain) ? o.chain : null;
  const ref = chain ? normalizeTokenRef(chain, typeof o.address === 'string' ? o.address : '') : null;
  const id = typeof o.id === 'string' && o.id.length > 0 && o.id.length <= 80 ? cleanText(o.id, 80) : null;
  const symbol = cleanText(o.symbol, 24);
  const side = o.side === 'buy' || o.side === 'sell' ? o.side : null;
  const targetUsd = typeof o.targetUsd === 'number' && Number.isFinite(o.targetUsd) && o.targetUsd > 0 ? o.targetUsd : null;
  const createdAt = typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) && o.createdAt > 0 ? Math.floor(o.createdAt) : null;
  if (!chain || !ref || !id || !symbol || !side || targetUsd === null || createdAt === null) return null;
  return { id, chain, address: ref.address, symbol, name: cleanText(o.name, 64), icon: cleanLogo(o.icon), side, targetUsd, createdAt };
}

export async function handleNotify(input: NotifyInput): Promise<TokensOutput> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type, authorization';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  const base = database(input.env, input.fetchImpl);

  // A browser collecting what its push announced. The channel number and its secret are the only credentials.
  if (input.method === 'GET') {
    if (!base) return json(503, { error: 'not-configured' }, headers);
    const id = Number(input.query.inbox);
    const secret = input.query.s ?? '';
    if (!Number.isInteger(id) || id < 1 || secret.length < 16 || secret.length > 80) return json(400, { error: 'bad-request' }, headers);
    if (overLimit(`inbox:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '30' });
    try {
      const ch = (await base.db.call(`notify_channels?id=eq.${id}&kind=eq.webpush&select=id,secret`)) as { id: number; secret: string | null }[];
      if (!ch[0] || ch[0].secret !== secret) return json(404, { error: 'not-found' }, headers);
      const rows = (await base.db.call(`notify_inbox?channel_id=eq.${id}&select=id,title,body,url&order=created_at.asc&limit=20`)) as { id: number; title: string; body: string; url: string }[];
      if (rows.length > 0) await base.db.call(`notify_inbox?id=in.(${rows.map((r) => Number(r.id)).join(',')})`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
      return json(200, { messages: rows.map((r) => ({ title: r.title, body: r.body, url: r.url })) }, headers);
    } catch {
      return json(502, { error: 'database' }, headers);
    }
  }
  if (input.method !== 'POST') return json(405, { error: 'method' }, { ...headers, allow: 'GET, POST, OPTIONS' });
  if (!allowed) return json(403, { error: 'origin' }, headers);
  const body = obj(input.body);
  const op = body.op;
  const botName = input.env.TELEGRAM_BOT_USERNAME?.trim() || null;
  const vapid = vapidFrom(input.env);

  if (op === 'config') return json(200, { telegram: !!(botName && input.env.TELEGRAM_BOT_TOKEN?.trim() && input.env.TELEGRAM_WEBHOOK_SECRET?.trim()), webpush: !!vapid, vapidPublicKey: vapid?.publicKey ?? null }, headers);

  if (!base) return json(503, { error: 'not-configured', message: 'Alerts to your phone are not set up on this server yet.' }, headers);
  if (overLimit(`notify:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
  const bearer = input.authorization?.startsWith('Bearer ') ? input.authorization.slice(7).trim() : null;
  const owner = readSession(base.secret, bearer, input.now);
  if (!owner) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
  const q = encodeURIComponent(owner);
  const { db } = base;

  try {
    const channels = async (): Promise<Channel[]> => (await db.call(`notify_channels?owner=eq.${q}&select=id,owner,kind,ref,secret,created_at&order=created_at.asc`)) as Channel[];

    if (op === 'status') {
      const [chs, prefs] = await Promise.all([channels(), db.call(`notify_prefs?owner=eq.${q}&select=move_pct,enabled`) as Promise<{ move_pct: number; enabled: boolean }[]>]);
      return json(200, { channels: chs.map((c) => ({ id: c.id, kind: c.kind, label: c.kind === 'telegram' ? 'Telegram' : 'This browser', createdAt: Number(c.created_at ?? 0), secret: c.kind === 'webpush' ? c.secret : null })), prefs: { movePct: prefs[0]?.move_pct ?? 5, enabled: prefs[0]?.enabled ?? true } }, headers);
    }
    if (op === 'telegram-link') {
      if (!botName || !input.env.TELEGRAM_BOT_TOKEN?.trim()) return json(503, { error: 'not-configured', message: 'Telegram alerts are not set up on this server yet.' }, headers);
      if ((await channels()).length >= MAX_CHANNELS) return json(409, { error: 'limit', message: `You can link up to ${MAX_CHANNELS} places. Remove one first.` }, headers);
      const code = randomHex(16);
      await db.call('notify_links', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ code, owner, expires_at: input.now + LINK_TTL_MS }) });
      return json(200, { url: telegramLink(botName, code), expiresAt: input.now + LINK_TTL_MS }, headers);
    }
    if (op === 'push-subscribe') {
      if (!vapid) return json(503, { error: 'not-configured', message: 'Browser alerts are not set up on this server yet.' }, headers);
      if (!validPushEndpoint(body.endpoint)) return json(400, { error: 'bad-request' }, headers);
      const existing = await channels();
      const same = existing.find((c) => c.kind === 'webpush' && c.ref === body.endpoint);
      if (same) return json(200, { id: same.id, secret: same.secret }, headers);
      if (existing.length >= MAX_CHANNELS) return json(409, { error: 'limit', message: `You can link up to ${MAX_CHANNELS} places. Remove one first.` }, headers);
      const secret = randomHex(24);
      const made = (await db.call('notify_channels?select=id', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ owner, kind: 'webpush', ref: body.endpoint, secret, created_at: input.now }) })) as { id: number }[];
      return json(200, { id: made[0]?.id, secret }, headers);
    }
    if (op === 'unlink') {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1) return json(400, { error: 'bad-request' }, headers);
      await db.call(`notify_channels?id=eq.${id}&owner=eq.${q}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
      return json(200, { ok: true }, headers);
    }
    if (op === 'prefs') {
      const movePct = typeof body.movePct === 'number' && (PCT_CHOICES as readonly number[]).includes(body.movePct) ? body.movePct : 5;
      const enabled = body.enabled !== false;
      await db.call('notify_prefs?on_conflict=owner', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ owner, move_pct: movePct, enabled }) });
      return json(200, { ok: true }, headers);
    }
    if (op === 'orders') {
      const given = (Array.isArray(body.orders) ? body.orders.slice(0, MAX_ORDERS) : []).map(cleanOrder).filter((o): o is NonNullable<typeof o> => o !== null);
      const keep = given.map((o) => o.id);
      // What the browser no longer has is dropped; what it has is added if new. An order the server already marked as reached stays that way.
      const have = (await db.call(`user_price_orders?owner=eq.${q}&select=id,hit_at,hit_price`)) as { id: string; hit_at: number | null; hit_price: number | null }[];
      const drop = have.filter((h) => !keep.includes(h.id)).map((h) => h.id);
      if (drop.length > 0) await db.call(`user_price_orders?owner=eq.${q}&id=${encodeURIComponent(inList(drop))}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
      if (given.length > 0) await db.call('user_price_orders?on_conflict=owner,id', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(given.map((o) => ({ owner, id: o.id, chain: o.chain, address: o.address, symbol: o.symbol, name: o.name, icon: o.icon, side: o.side, target_usd: o.targetUsd, created_at: o.createdAt }))) });
      return json(200, { saved: given.length, reached: have.filter((h) => h.hit_at !== null && keep.includes(h.id)).map((h) => ({ id: h.id, price: Number(h.hit_price ?? 0) })) }, headers);
    }
    if (op === 'test') {
      const chs = await channels();
      if (chs.length === 0) return json(409, { error: 'none', message: 'Link Telegram or this browser first.' }, headers);
      const m: PlannedMessage = { kind: 'move', title: 'Aretia test alert', body: 'If you can read this, alerts reach this device.', url: '/wallet#/favourites' };
      let sent = 0;
      for (const ch of chs) if (await deliver(input.env, input.fetchImpl, db, ch, m, input.now)) sent++;
      return json(200, { sent, of: chs.length }, headers);
    }
    return json(400, { error: 'bad-request' }, headers);
  } catch (e) {
    const detail = e instanceof Error ? /answered (\d{3})/.exec(e.message)?.[1] ?? null : null;
    return json(502, { error: 'database', message: 'Your alert settings could not be reached.', ...(detail ? { status: Number(detail) } : {}) }, headers);
  }
}

/** The bot's messages, sent by Telegram. Only a request carrying our secret is believed. */
export async function handleTelegramWebhook(input: NotifyInput): Promise<TokensOutput> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  const secret = input.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const token = input.env.TELEGRAM_BOT_TOKEN?.trim();
  if (input.method !== 'POST') return json(405, { error: 'method' }, headers);
  if (!secret || !token || input.telegramSecret !== secret) return json(401, { error: 'unauthorized' }, headers);
  const base = database(input.env, input.fetchImpl);
  const update = readUpdate(input.body);
  // Anything unreadable is acknowledged, so Telegram does not send it again.
  if (!base || !update) return json(200, { ok: true }, headers);
  const { db } = base;
  const reply = (text: string): Promise<number> => sendTelegram(input.fetchImpl, token, update.chatId, text);
  try {
    const code = startCode(update.text);
    if (code) {
      const links = (await db.call(`notify_links?code=eq.${encodeURIComponent(code)}&select=owner,expires_at`)) as { owner: string; expires_at: number }[];
      const link = links[0];
      if (!link || Number(link.expires_at) < input.now) {
        await reply('That link has expired. Press "Connect Telegram" in Aretia again to get a new one.');
        return json(200, { ok: true }, headers);
      }
      await db.call(`notify_links?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
      await db.call('notify_channels?on_conflict=owner,kind,ref', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ owner: link.owner, kind: 'telegram', ref: update.chatId, created_at: input.now }) });
      await reply('✅ Connected. You will get your Aretia price alerts here: favourites that move, and prices you set. Send /stop at any time to stop them.');
    } else if (isStop(update.text)) {
      await db.call(`notify_channels?kind=eq.telegram&ref=eq.${encodeURIComponent(update.chatId)}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
      await reply('Stopped. You will not get Aretia alerts here any more. You can connect again from the wallet.');
    } else {
      await reply('This is the Aretia alerts bot. To get alerts here, open the Aretia wallet, go to Favourites and press "Connect Telegram". Send /stop to stop them.');
    }
  } catch {
    // The person can press the link again; Telegram is told the message arrived.
  }
  return json(200, { ok: true }, headers);
}

/** The scheduled check: reads what everyone with a linked channel watches, and sends what is owed. */
export async function handleAlertsRun(input: NotifyInput): Promise<TokensOutput> {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  const secret = input.env.CRON_SECRET?.trim();
  if (!secret || input.authorization !== `Bearer ${secret}`) return json(401, { error: 'unauthorized' }, headers);
  const base = database(input.env, input.fetchImpl);
  if (!base) return json(503, { error: 'not-configured' }, headers);
  const { db } = base;
  const stats = { owners: 0, tokens: 0, sent: 0, failed: 0, ordersReached: 0 };
  try {
    const chs = (await db.call('notify_channels?select=id,owner,kind,ref,secret&limit=3000')) as Channel[];
    const byOwner = new Map<string, Channel[]>();
    for (const c of chs) byOwner.set(c.owner, [...(byOwner.get(c.owner) ?? []), c]);
    const prefs = new Map<string, { movePct: number; enabled: boolean }>();
    const favs = new Map<string, WatchedFavourite[]>();
    const orders = new Map<string, PriceOrder[]>();
    const states = new Map<string, Record<string, number>>();
    const owners = [...byOwner.keys()];
    for (let i = 0; i < owners.length; i += 25) {
      const list = encodeURIComponent(inList(owners.slice(i, i + 25)));
      const [p, f, o, s] = await Promise.all([
        db.call(`notify_prefs?owner=${list}&select=owner,move_pct,enabled`) as Promise<{ owner: string; move_pct: number; enabled: boolean }[]>,
        db.call(`user_favourites?owner=${list}&select=owner,chain,address,symbol,icon&limit=5000`) as Promise<{ owner: string; chain: ChainId; address: string; symbol: string; icon: string | null }[]>,
        db.call(`user_price_orders?owner=${list}&hit_at=is.null&select=owner,id,chain,address,symbol,name,icon,side,target_usd,created_at&limit=2000`) as Promise<{ owner: string; id: string; chain: ChainId; address: string; symbol: string; name: string; icon: string | null; side: 'buy' | 'sell'; target_usd: number; created_at: number }[]>,
        db.call(`notify_state?owner=${list}&select=owner,token_key,baseline&limit=20000`) as Promise<{ owner: string; token_key: string; baseline: number }[]>,
      ]);
      for (const r of p) prefs.set(r.owner, { movePct: r.move_pct, enabled: r.enabled });
      for (const r of f) favs.set(r.owner, [...(favs.get(r.owner) ?? []), { chain: r.chain, address: r.address, symbol: r.symbol, icon: r.icon }]);
      for (const r of o) orders.set(r.owner, [...(orders.get(r.owner) ?? []), { id: r.id, chain: r.chain, address: r.address, symbol: r.symbol, name: r.name, icon: r.icon, side: r.side, targetUsd: Number(r.target_usd), createdAt: Number(r.created_at), hitAt: null, hitPrice: null }]);
      for (const r of s) states.set(r.owner, { ...(states.get(r.owner) ?? {}), [r.token_key]: Number(r.baseline) });
    }
    stats.owners = owners.length;

    // One price lookup for every token anyone watches, however many people watch it.
    const wanted = new Map<string, { chain: ChainId; address: string; symbol: string; name: string; icon: string | null; addedAt: number }>();
    for (const owner of owners) {
      for (const f of favs.get(owner) ?? []) wanted.set(watchKey(f.chain, f.address), { chain: f.chain, address: f.address, symbol: f.symbol, name: '', icon: f.icon, addedAt: input.now });
      for (const o of orders.get(owner) ?? []) wanted.set(watchKey(o.chain, o.address), { chain: o.chain, address: o.address, symbol: o.symbol, name: o.name, icon: o.icon, addedAt: input.now });
    }
    const tokens = [...wanted.values()].slice(0, 400);
    stats.tokens = tokens.length;
    const prices: Record<string, number | null> = {};
    if (tokens.length > 0) for (const r of await rowsFromFavourites(tokens, input.fetchImpl, () => input.now)) prices[watchKey(r.chain, r.address)] = r.priceUsd;

    for (const owner of owners) {
      const pref = prefs.get(owner) ?? { movePct: 5, enabled: true };
      if (!pref.enabled) continue;
      const plan = planForOwner({ movePct: pref.movePct, favourites: favs.get(owner) ?? [], orders: orders.get(owner) ?? [], baselines: states.get(owner) ?? {} }, prices, input.now);
      let delivered = plan.messages.length === 0;
      for (const m of plan.messages) {
        let any = false;
        for (const ch of byOwner.get(owner) ?? []) if (await deliver(input.env, input.fetchImpl, db, ch, m, input.now)) any = true;
        if (any) {
          stats.sent++;
          delivered = true;
        } else stats.failed++;
      }
      // What was reported is remembered only if it reached somewhere, so a failed send is tried again on the next run.
      if (!delivered) continue;
      const q = encodeURIComponent(owner);
      const rows = Object.entries(plan.baselines).map(([token_key, baseline]) => ({ owner, token_key, baseline, updated_at: input.now }));
      if (rows.length > 0) await db.call('notify_state?on_conflict=owner,token_key', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      const old = Object.keys(states.get(owner) ?? {}).filter((k) => !(k in plan.baselines));
      if (old.length > 0) await db.call(`notify_state?owner=eq.${q}&token_key=${encodeURIComponent(inList(old))}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
      for (const h of plan.hitOrders) {
        await db.call(`user_price_orders?owner=eq.${q}&id=eq.${encodeURIComponent(h.id)}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ hit_at: input.now, hit_price: h.price }) });
        stats.ordersReached++;
      }
    }
    return json(200, stats, headers);
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 120) : 'failed';
    return json(502, { error: 'run', detail, ...stats }, headers);
  }
}

