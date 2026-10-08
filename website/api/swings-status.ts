/** GET /api/swings-status: which optional Swings services are on. See _swingsStatus.ts. */
import { handleStatus } from './_swingsStatus.js';
import { requestOrigin } from './_rpcProxy.js';

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}


export default function handler(req: Req, res: Res): void {
  const out = handleStatus({ method: req.method ?? 'GET', origin: requestOrigin(req.headers), env: process.env });
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.status(out.status).send(out.body);
}
