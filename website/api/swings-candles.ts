/**
 * GET /api/swings-candles: candles from the prices Aretia has recorded for a pool.
 * See _swingsCandles.ts.
 */
import { handleCandles } from './_swingsCandles.js';
import { requestOrigin } from './_rpcProxy.js';

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
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
  const out = await handleCandles({
    method: req.method ?? 'GET',
    origin: requestOrigin(req.headers),
    authorization: null,
    ip: forwarded?.split(',')[0]?.trim() || one(req.headers['x-real-ip']) || 'unknown',
    query,
    env: process.env,
    fetchImpl: fetch,
    now: Date.now(),
  });
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.status(out.status).send(out.body);
}
