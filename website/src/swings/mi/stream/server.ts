/**
 * The HTTP side of the live market stream. Two routes matter:
 *   GET  /stream?keys=bnb:0x..,solana:..   Server-Sent Events: the updates for those pools (public, read-only, at most 100 pools)
 *   POST /publish                          the worker's updates in (header `x-stream-secret`; reached on the private network only)
 * and GET /health for the uptime check. Caddy publishes only /stream (and /health); /publish is never routed from the internet, and
 * still needs the secret.
 *
 * Nothing here reads the database: the stream carries what the worker already wrote, so the service stays small and cannot be used to
 * reach data (a viewer can only ask for a pool by name and gets the public numbers the Markets page already shows).
 */
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { LiveUpdate } from '../../market/liveFields.js';
import type { StreamHub } from './hub.js';

export const KEY_PATTERN = /^(solana|ethereum|base|bnb|polygon|robinhood):[A-Za-z0-9]{20,90}$/;
const MAX_PUBLISH_BYTES = 2_000_000;
const MAX_PUBLISH_ITEMS = 2_000;
/** A viewer whose socket holds more than this unsent is too slow to keep. */
const MAX_BUFFERED_BYTES = 1_000_000;

export interface StreamServerOptions {
  hub: StreamHub;
  secret: string;
  /** Sites allowed to read the stream (the `Origin` header). A request with no Origin (not a browser page) is allowed. */
  origins: readonly string[];
  maxPerIp?: number;
}

const number = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const win = <T>(v: unknown, pick: (x: unknown) => T | null): { m5: T | null; h1: T | null; h6: T | null; h24: T | null } | null => {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return { m5: pick(o.m5), h1: pick(o.h1), h6: pick(o.h6), h24: pick(o.h24) };
};
const counts = (v: unknown): { m5: number; h1: number; h6: number; h24: number } | null => {
  const w = win(v, number);
  return w && w.m5 !== null && w.h1 !== null && w.h6 !== null && w.h24 !== null ? { m5: w.m5, h1: w.h1, h6: w.h6, h24: w.h24 } : null;
};

/** One published item made into an update, or null when it is not one: only the known fields are kept. */
export function cleanUpdate(v: unknown): LiveUpdate | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== 'string' || !KEY_PATTERN.test(o.key)) return null;
  const at = number(o.at);
  if (at === null) return null;
  return {
    key: o.key,
    at,
    p_usd: number(o.p_usd),
    rp: number(o.rp),
    chg: win(o.chg, number),
    buys: counts(o.buys),
    sells: counts(o.sells),
    vol: win(o.vol, number),
    ro: flag(o.ro),
    mk: number(o.mk),
    cp: flag(o.cp),
    last_trade_at: number(o.last_trade_at),
    liquidity_usd: number(o.liquidity_usd),
  };
}

function sameSecret(given: string | undefined, secret: string): boolean {
  if (!given || !secret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The viewer's address as Caddy reports it (the proxy is the only way in). */
function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

export function createStreamServer(o: StreamServerOptions): http.Server {
  const perIp = new Map<string, number>();
  const maxPerIp = o.maxPerIp ?? 20;
  const allowed = new Set(o.origins);

  const text = (res: http.ServerResponse, status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };

  const stream = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) return text(res, 403, 'origin not allowed');
    const keys = (url.searchParams.get('keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.some((k) => !KEY_PATTERN.test(k))) return text(res, 400, 'bad key');
    const ip = clientIp(req);
    if ((perIp.get(ip) ?? 0) >= maxPerIp) return text(res, 429, 'too many connections');
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
    if (origin !== undefined) {
      headers['access-control-allow-origin'] = origin;
      headers.vary = 'Origin';
    }
    // What the hub sends while subscribing (the current state of the viewer's pools) waits until the response headers are out.
    let open = false;
    const early: string[] = [];
    const sub = o.hub.subscribe(keys, {
      write: (chunk) => {
        if (!open) {
          early.push(chunk);
          return true;
        }
        if (res.destroyed) return false;
        res.write(chunk);
        return res.writableLength < MAX_BUFFERED_BYTES;
      },
      end: () => res.end(),
    });
    if (!sub.ok) return text(res, sub.reason === 'full' ? 503 : 400, sub.reason);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    res.writeHead(200, headers);
    res.write('retry: 3000\n\n');
    for (const chunk of early) res.write(chunk);
    open = true;
    req.on('close', () => {
      o.hub.unsubscribe(sub.id);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
  };

  /** The pools being watched now, for the worker (private network only, same secret as /publish). */
  const watched = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (!sameSecret(req.headers['x-stream-secret'] as string | undefined, o.secret)) return text(res, 401, 'no');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ keys: o.hub.watchedKeys(500), viewers: o.hub.clientCount }));
  };

  const publish = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (!sameSecret(req.headers['x-stream-secret'] as string | undefined, o.secret)) return text(res, 401, 'no');
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_PUBLISH_BYTES) {
        text(res, 413, 'too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (!Array.isArray(body) || body.length > MAX_PUBLISH_ITEMS) return text(res, 400, 'bad body');
        const updates = body.map(cleanUpdate).filter((u): u is LiveUpdate => u !== null);
        o.hub.publish(updates);
        res.writeHead(204).end();
      } catch {
        text(res, 400, 'bad json');
      }
    });
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stream');
    if (req.method === 'GET' && url.pathname === '/stream') return stream(req, res, url);
    if (req.method === 'POST' && url.pathname === '/publish') return publish(req, res);
    if (req.method === 'GET' && url.pathname === '/watched') return watched(req, res);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, clients: o.hub.clientCount, received: o.hub.received, sent: o.hub.sent }));
      return;
    }
    text(res, 404, 'not found');
  });
}
