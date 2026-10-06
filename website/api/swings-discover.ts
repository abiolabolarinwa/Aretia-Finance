/**
 * GET /api/swings-discover: runs the token-discovery workers once. Protected by CRON_SECRET
 * (Vercel Cron sends it as a bearer token). See _swingsTokens.ts.
 */
import { handleDiscover } from './_swingsTokens.js';

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function handler(req: Req, res: Res): Promise<void> {
  const out = await handleDiscover({
    method: req.method ?? 'GET',
    origin: one(req.headers.origin),
    authorization: one(req.headers.authorization),
    ip: 'cron',
    query: {},
    env: process.env,
    fetchImpl: fetch,
    now: Date.now(),
  });
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.status(out.status).send(out.body);
}
