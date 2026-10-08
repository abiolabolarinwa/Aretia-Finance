/**
 * POST /api/rpc: Solana JSON-RPC proxy for the web wallet. See _rpcProxy.ts for the rules and
 * docs/rpc-proxy.md for setup. The provider URL (with its key) is read from SOLANA_RPC_URL.
 */
import { proxyRpc } from './_rpcProxy.js';
import { requestOrigin } from './_rpcProxy.js';

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
  const out = await proxyRpc({
    method: req.method ?? 'GET',
    origin: requestOrigin(req.headers),
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
