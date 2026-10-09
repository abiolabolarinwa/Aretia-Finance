/**
 * One function behind four public paths, because the Hobby plan allows at most twelve serverless functions:
 *   /api/swings-candles  price history candles        (GET)
 *   /api/swings-pools    Solana pools of a token      (GET)
 *   /api/swings-market   the shared Marketplace lists (GET)
 *   /api/swings-account  favourites and saved swaps   (POST)
 * vercel.json rewrites each path here with `?route=`. The handlers themselves live in the _swings*.ts files.
 */
import { handleAccount } from './_swingsAccount.js';
import { handleCandles } from './_swingsCandles.js';
import { handleMarket } from './_swingsMarket.js';
import { handlePools } from './_swingsPools.js';
import { requestOrigin } from './_rpcProxy.js';

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function handler(req: Req, res: Res): Promise<void> {
  const forwarded = one(req.headers['x-forwarded-for']);
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) query[k] = one(v) ?? undefined;
  const route = query.route;
  delete query.route;
  const common = {
    method: req.method ?? 'GET',
    origin: requestOrigin(req.headers),
    authorization: one(req.headers.authorization),
    ip: forwarded?.split(',')[0]?.trim() || one(req.headers['x-real-ip']) || 'unknown',
    env: process.env,
    fetchImpl: fetch,
    now: Date.now(),
  };
  let out: { status: number; body: string; headers: Record<string, string> };
  if (route === 'account') {
    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    out = await handleAccount({ ...common, body });
  } else if (route === 'candles') out = await handleCandles({ ...common, query });
  else if (route === 'pools') out = await handlePools({ ...common, query });
  else if (route === 'market') out = await handleMarket({ ...common, query });
  else out = { status: 404, body: '{"error":"not-found"}', headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } };
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.status(out.status).send(out.body);
}
