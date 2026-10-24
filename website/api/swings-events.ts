/** POST /api/swings-events: anonymous aggregate analytics. See _swingsEvents.ts for what it will and will not store. */
import { handleEvents } from './_swingsEvents.js';
import { requestOrigin } from './_rpcProxy.js';
import { clientIp } from './_clientIp.js';
import { refuse, viaCloudflare } from './_proxyGuard.js';

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
  if (!viaCloudflare(req.headers)) return void refuse(res);
  const body = typeof req.body === 'string' ? req.body : req.body === undefined ? '' : JSON.stringify(req.body);
  const out = await handleEvents({
    method: req.method ?? 'GET',
    origin: requestOrigin(req.headers),
    ip: clientIp(req.headers),
    contentType: one(req.headers['content-type']),
    body,
    env: process.env,
    fetchImpl: fetch,
    now: Date.now(),
  });
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.status(out.status).send(out.body);
}
