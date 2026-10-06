/**
 * POST /api/swings-0x: server-side proxy to the 0x Swap API for Aretia Swings (EVM chains).
 * See _swings0x.ts for the rules. The key is read from ZEROX_API_KEY and is never sent to the browser.
 */
import { handleZeroX } from './_swings0x.js';

// Just what this handler uses of Vercel's Node request and response objects.
interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function handler(req: Req, res: Res): Promise<void> {
  const body = typeof req.body === 'string' ? req.body : req.body === undefined ? '' : JSON.stringify(req.body);
  const forwarded = one(req.headers['x-forwarded-for']);
  const out = await handleZeroX({
    method: req.method ?? 'GET',
    origin: one(req.headers.origin),
    ip: forwarded?.split(',')[0]?.trim() || one(req.headers['x-real-ip']) || 'unknown',
    contentType: one(req.headers['content-type']),
    body,
    env: process.env,
    fetchImpl: fetch,
    now: Date.now(),
  });
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.status(out.status).send(out.body);
}
