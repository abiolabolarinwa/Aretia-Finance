/**
 * Entry point of the live market stream service (bundled by server/worker/Dockerfile, target `stream`; run with `node stream.mjs`).
 * Environment: STREAM_SECRET (required, shared with the worker), STREAM_PORT (default 8090), STREAM_ORIGINS (comma list of sites allowed to
 * read the stream; default the production site), STREAM_MAX_CLIENTS, STREAM_MAX_PER_IP.
 */
import { StreamHub } from './hub.js';
import { createStreamServer } from './server.js';

const env = process.env as Record<string, string | undefined>;
const secret = (env.STREAM_SECRET ?? '').trim();
if (secret.length < 16) {
  console.error('STREAM_SECRET must be set to a random string of at least 16 characters. Nothing was started.');
  process.exit(2);
}
const int = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const origins = (env.STREAM_ORIGINS || 'https://aretiafinance.org,https://www.aretiafinance.org').split(',').map((s) => s.trim()).filter(Boolean);
const port = int(env.STREAM_PORT, 8090, 1, 65_535);
const hub = new StreamHub({ maxClients: int(env.STREAM_MAX_CLIENTS, 2000, 1, 20_000) });
const server = createStreamServer({ hub, secret, origins, maxPerIp: int(env.STREAM_MAX_PER_IP, 20, 1, 1000) });

const flush = setInterval(() => hub.flush(), 250);
const beat = setInterval(() => hub.heartbeat(), 20_000);
const report = setInterval(() => console.log(`${new Date().toISOString()} stream: ${hub.clientCount} viewer(s), ${hub.received} update(s) in, ${hub.sent} sent`), 5 * 60_000);

server.listen(port, '0.0.0.0', () => console.log(`${new Date().toISOString()} stream listening on ${port}, origins: ${origins.join(', ')}`));

const stop = (signal: string): void => {
  console.log(`${new Date().toISOString()} ${signal}: closing`);
  clearInterval(flush);
  clearInterval(beat);
  clearInterval(report);
  hub.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
