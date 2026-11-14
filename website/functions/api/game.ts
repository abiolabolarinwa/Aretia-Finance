/**
 * Cloudflare Pages Function for /api/game: Ultimate City Search. It runs on Cloudflare, next to the site, and keeps all game data in
 * a Cloudflare D1 database (binding GAME_DB). It is more specific than the catch-all in [[path]].ts, so /api/game is answered here and
 * never forwarded to Vercel.
 *
 * Needs, in the Pages project: a D1 binding named GAME_DB, the compatibility flag nodejs_compat, and the secrets GAME_SESSION_SECRET,
 * GAME_ANSWER_SECRET and (for administrators) ADMIN_WALLETS. See docs/ULTIMATE_CITY_SEARCH_LAUNCH.md.
 */
import { d1Rest, type D1Like } from '../../api/_d1Rest';
import { handleGame } from '../../api/_game';
import { requestOrigin } from '../../api/_rpcProxy';

interface Env {
  GAME_DB?: D1Like;
  GAME_SESSION_SECRET?: string;
  GAME_ANSWER_SECRET?: string;
  GAME_PRIZES_ENABLED?: string;
  ADMIN_WALLETS?: string;
  SWINGS_LOGIN_DOMAINS?: string;
  RPC_ALLOWED_ORIGINS?: string;
  /** Set to "development" only on a preview that should accept requests from localhost. */
  GAME_ENV?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  if (!env.GAME_DB) return new Response('{"error":"not-configured","message":"The game is not set up on this server yet."}', { status: 503, headers: JSON_HEADERS });
  let body: unknown = {};
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }
  const out = await handleGame({
    method: request.method,
    origin: requestOrigin(Object.fromEntries(request.headers)),
    authorization: request.headers.get('authorization'),
    ip: request.headers.get('cf-connecting-ip') ?? 'unknown',
    body,
    db: d1Rest(env.GAME_DB),
    env: {
      SWINGS_SESSION_SECRET: env.GAME_SESSION_SECRET,
      GAME_ANSWER_SECRET: env.GAME_ANSWER_SECRET,
      GAME_PRIZES_ENABLED: env.GAME_PRIZES_ENABLED,
      ADMIN_WALLETS: env.ADMIN_WALLETS,
      SWINGS_LOGIN_DOMAINS: env.SWINGS_LOGIN_DOMAINS,
      RPC_ALLOWED_ORIGINS: env.RPC_ALLOWED_ORIGINS,
      // The shared origin check treats anything but "production" as a place that may accept localhost; here that is opt-in.
      VERCEL_ENV: env.GAME_ENV === 'development' ? 'development' : 'production',
    },
    now: Date.now(),
  });
  return new Response(out.status === 204 ? null : out.body, { status: out.status, headers: out.headers });
}
