# API hardening: Cloudflare-only access and the launch-assets bucket

Two settings that code alone cannot apply. Both ship switched off or inert until the owner does the steps below.

## 1. Make Vercel serve only requests that came through Cloudflare

The site's `/api/*` goes through the Cloudflare Pages function (`website/functions/api/[[path]].ts`), which adds the header `x-aretia-proxy-secret`. With `REQUIRE_CF_PROXY=1`, Vercel also requires it, so every request passes through the rules set at Cloudflare.

Steps:

1. In the Vercel project's environment variables, confirm `CF_PROXY_SECRET` is set (it already is if the forwarder works). It must equal the value in the Cloudflare Pages project.
2. Add `REQUIRE_CF_PROXY=1` to Vercel (Production) and redeploy.
3. Check: `curl -i https://<project>.vercel.app/api/swings-status` returns 403 `{"error":"forbidden"}`, and `curl -i https://aretiafinance.org/api/swings-status` returns 200.
4. Roll back by removing `REQUIRE_CF_PROXY`; nothing else changes.

Exempt on purpose, because the platform or Telegram calls them directly and each has its own secret: the `alerts-run`, `launchbox-run` and `telegram` routes of `/api/swings-data`. The GitHub and Supabase schedulers already call `aretiafinance.org`, so they pass through Cloudflare.

## 2. Rate limits that hold across instances

The limits in `website/api/_limits.ts`, `_rpcProxy.ts` and `_radarProxy.ts` live in one serverless instance's memory. Add edge rules at Cloudflare, which run before any instance and are shared:

| Rule (Security, Rate limiting) | Match | Limit | Action |
|---|---|---|---|
| RPC proxy | URI path equals `/api/rpc` | 60 requests per minute per IP | Block for 1 minute |
| Sign-in nonces | URI path equals `/api/swings-account` and method POST | 30 per minute per IP | Block for 1 minute |
| Radar analysis | URI path equals `/api/swings-radar` and query contains `op=analyze` | 6 per minute per IP | Block for 10 minutes |
| Uploads | URI path equals `/api/swings-upload` | 20 per minute per IP | Block for 10 minutes |
| General | URI path starts with `/api/` | 300 per minute per IP | Managed challenge |

Also set a monthly spend cap and a requests-per-second cap on the Solana RPC key at the provider, and keep a public fallback node in the client for when it is exhausted.

## 3. Launch pictures: R2 upload links

Pictures live on Cloudflare R2 (docs/R2_LAUNCH_ASSETS.md). The server signs a five-minute link for one path that fixes the file type and size (10 MB at most for a picture), so the bucket needs no size or type rules of its own. Keep the R2 API token limited to that one bucket (Object Read & Write), keep the r2.dev address disabled, and keep CORS limited to `https://aretiafinance.org` and `https://www.aretiafinance.org` for `PUT`, `GET`, `HEAD`.
