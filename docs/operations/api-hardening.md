# API hardening: Cloudflare-only access and the launch-assets bucket

Two settings that code alone cannot apply. Both ship switched off or inert until the owner does the steps below.

## 1. Make Vercel serve only requests that came through Cloudflare

The site's `/api/*` goes through the Cloudflare Pages function (`website/functions/api/[[path]].ts`), which adds the header `x-aretia-proxy-secret`. Until now Vercel did not require it, so anyone could call the `*.vercel.app` address and skip every rule set at Cloudflare.

Steps:

1. In the Vercel project's environment variables, confirm `CF_PROXY_SECRET` is set (it already is if the forwarder works). It must equal the value in the Cloudflare Pages project.
2. Add `REQUIRE_CF_PROXY=1` to Vercel (Production) and redeploy.
3. Check: `curl -i https://<project>.vercel.app/api/swings-status` returns 403 `{"error":"forbidden"}`, and `curl -i https://aretiafinance.org/api/swings-status` returns 200.
4. Roll back by removing `REQUIRE_CF_PROXY`; nothing else changes.

Exempt on purpose, because the platform or Telegram calls them directly and each has its own secret: the `alerts-run`, `launchbox-run` and `telegram` routes of `/api/swings-data`. The GitHub and Supabase schedulers already call `aretiafinance.org`, so they pass through Cloudflare.

## 2. Rate limits that hold across instances

The limits in `website/api/_limits.ts`, `_rpcProxy.ts` and `_radarProxy.ts` live in one serverless instance's memory (see ARETIA-SEC-005). Add edge rules at Cloudflare, which run before any instance and are shared:

| Rule (Security, Rate limiting) | Match | Limit | Action |
|---|---|---|---|
| RPC proxy | URI path equals `/api/rpc` | 60 requests per minute per IP | Block for 1 minute |
| Sign-in nonces | URI path equals `/api/swings-account` and method POST | 30 per minute per IP | Block for 1 minute |
| Radar analysis | URI path equals `/api/swings-radar` and query contains `op=analyze` | 6 per minute per IP | Block for 10 minutes |
| Uploads | URI path equals `/api/swings-upload` | 20 per minute per IP | Block for 10 minutes |
| General | URI path starts with `/api/` | 300 per minute per IP | Managed challenge |

Also set a monthly spend cap and a requests-per-second cap on the Solana RPC key at the provider, and keep a public fallback node in the client for when it is exhausted.

## 3. The launch-assets bucket must be restricted (ARETIA-SEC-004)

A signed upload link does not fix the file's type, size or name, so the bucket's own limits are the control. The server now refuses to issue links (`/api/swings-upload` answers "Image upload is not set up yet") unless the bucket is public, has a file size limit of at most 15 MB, and lists only `image/png`, `image/jpeg`, `image/gif` and `application/json`.

Set it once, in the Supabase SQL editor (replace the bucket name if `LAUNCH_ASSETS_BUCKET` is not the default):

```sql
update storage.buckets
set public = true,
    file_size_limit = 15728640,
    allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'application/json']
where id = 'launch-assets';
```

Check: `select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'launch-assets';`, then open the Launch page and confirm picture upload is offered.
