/**
 * One function behind fifteen public paths, because the Hobby plan allows at most twelve serverless functions:
 *   /api/swings-candles  price history candles        (GET)
 *   /api/swings-ohlcv    candles for the TradingView chart, shared and cached (GET)
 *   /api/swings-trades   recent trades of a pool for the Transactions table, shared and cached (GET)
 *   /api/swings-pools    Solana pools of a token      (GET)
 *   /api/swings-market   the shared Marketplace lists (GET)
 *   /api/swings-account  favourites and saved swaps   (POST)
 *   /api/swings-radar    the Aretia Radar server       (GET, POST)
 *   /api/swings-referrals referral credits and a referrer's own numbers (POST)
 *   /api/swings-notify   alerts to a phone: Telegram and browser push (GET, POST)
 *   /api/swings-telegram the Telegram bot's webhook    (POST)
 *   /api/swings-alerts-run the scheduled alert check   (GET, with the cron secret)
 *   /api/launchbox       Launch Box: tokens made through Aretia Launch, with market data (GET)
 *   /api/launchbox-run   the Launch Box indexer (GET, with the cron secret)
 *   /api/swings-upload   a one-use upload link for a token's picture or details file, for a signed-in wallet (POST)
 *   /api/swings-meta     the picture, description and links of tokens made through Aretia Launch (GET)
 *   /api/v1/...          the Market Indexer's public read API: new pairs, trending, pools, tokens, trades, candles (GET)
 *   /api/mi-run          the Market Indexer's scheduled run (GET, with the cron secret)
 *   /api/swings-mi-admin Market Indexer owner controls with an audit log (POST; 404 for anyone but ADMIN_WALLETS)
 *   /api/swings-beacon   anonymous visit and outcome counters (POST)
 *   /api/swings-admin    the owner's private numbers (POST; 404 for anyone but the wallets in ADMIN_WALLETS)
 * vercel.json rewrites each path here with `?route=`. The handlers themselves live in the _swings*.ts files.
 */
import { handleAdmin, handleBeacon } from './_adminStats.js';
import { handleAccount } from './_swingsAccount.js';
import { handleAlertsRun, handleNotify, handleTelegramWebhook } from './_swingsNotify.js';
import { handleCandles } from './_swingsCandles.js';
import { handleMeta, handleUpload } from './_swingsUpload.js';
import { handleReferrals } from './_swingsReferrals.js';
import { handleLaunchbox, handleLaunchboxRun } from './_launchbox.js';
import { handleMarket } from './_swingsMarket.js';
import { handleMi, handleMiAdmin, handleMiRun } from './_marketIndexer.js';
import { handleOhlcv } from './_swingsOhlcv.js';
import { handleTrades } from './_swingsTrades.js';
import { handlePools } from './_swingsPools.js';
import { handleRadar } from './_radarProxy.js';
import { requestOrigin } from './_rpcProxy.js';
import { clientIp } from './_clientIp.js';
import { refuse, viaCloudflare } from './_proxyGuard.js';

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
/** Routes that platform schedulers or Telegram call without going through Cloudflare. */
const DIRECT_ROUTES: ReadonlySet<string> = new Set(['alerts-run', 'launchbox-run', 'telegram']);

export default async function handler(req: Req, res: Res): Promise<void> {
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) query[k] = one(v) ?? undefined;
  const route = query.route;
  // Vercel's own cron calls alerts-run and launchbox-run directly and Telegram calls its webhook; each has its own secret.
  if (!viaCloudflare(req.headers, process.env, route !== undefined && DIRECT_ROUTES.has(route))) return void refuse(res);
  delete query.route;
  const common = {
    method: req.method ?? 'GET',
    origin: requestOrigin(req.headers),
    authorization: one(req.headers.authorization),
    ip: clientIp(req.headers),
    env: process.env,
    fetchImpl: fetch,
    now: Date.now(),
  };
  let out: { status: number; body: string; headers: Record<string, string> };
  let body: unknown = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (route === 'account') out = await handleAccount({ ...common, body });
  else if (route === 'referrals') out = await handleReferrals({ ...common, body });
  else if (route === 'radar') out = await handleRadar({ ...common, query, body });
  else if (route === 'notify') out = await handleNotify({ ...common, query, body, inboxSecret: one(req.headers['x-inbox-secret']) });
  else if (route === 'telegram') out = await handleTelegramWebhook({ ...common, query, body, telegramSecret: one(req.headers['x-telegram-bot-api-secret-token']) });
  else if (route === 'alerts-run') out = await handleAlertsRun({ ...common, query, body });
  else if (route === 'candles') out = await handleCandles({ ...common, query });
  else if (route === 'pools') out = await handlePools({ ...common, query });
  else if (route === 'market') out = await handleMarket({ ...common, query });
  else if (route === 'ohlcv') out = await handleOhlcv({ ...common, query });
  else if (route === 'trades') out = await handleTrades({ ...common, query });
  else if (route === 'beacon') out = await handleBeacon({ ...common, body, country: one(req.headers['x-vercel-ip-country']) });
  else if (route === 'admin') out = await handleAdmin({ ...common, body });
  else if (route === 'upload') out = await handleUpload({ ...common, query, body });
  else if (route === 'meta') out = await handleMeta({ ...common, query, body });
  else if (route === 'mi') out = await handleMi({ ...common, query, body });
  else if (route === 'mi-run') out = await handleMiRun({ ...common, query });
  else if (route === 'mi-admin') out = await handleMiAdmin({ ...common, body });
  else if (route === 'launchbox') out = await handleLaunchbox(common);
  else if (route === 'launchbox-run') out = await handleLaunchboxRun(common);
  else out = { status: 404, body: '{"error":"not-found"}', headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } };
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  res.status(out.status).send(out.body);
}
