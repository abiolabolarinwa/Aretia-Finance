/** GET /api/swings-status: which optional Swings services are on. See _swingsStatus.ts. */
import { handleStatus } from './_swingsStatus.js';

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

export default function handler(req: Req, res: Res): void {
  const out = handleStatus({ method: req.method ?? 'GET', origin: one(req.headers.origin), env: process.env });
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.status(out.status).send(out.body);
}
