# Moving the data service off Supabase: how the site switches, and the cut-over order

The kit is in `server/` (start with `server/README.md`). This note is about the **site**: which settings switch it, what in the code
depends on Supabase-specific behaviour, and the order to move things so that nothing is cut over before it is verified.
**Nothing in production changes until the owner sets the variables below.**

## The configuration points (environment variables only, no code change)

| Variable (Vercel) | Meaning | Falls back to |
|---|---|---|
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | the data service for **every** table (21 files read these). Set them to the new server (`https://data.<domain>` and the `eyJ...` key from `node server/bin/make-keys.mjs --print-key`) | the Supabase project |
| `MI_DATA_URL` + `MI_DATA_SERVICE_ROLE_KEY` | the data service for the **indexer's tables only** (`mi_*`: the public `/api/v1/*` read API, `/api/mi-run`, the owner controls). Both must be set; one alone is ignored | `SUPABASE_URL` / key |
| `STORAGE_URL` + `STORAGE_SERVICE_ROLE_KEY` | where the Launch Box picture bucket lives (`/storage/v1`) | `SUPABASE_URL` / key |

So step by step moves are possible: indexer first (`MI_DATA_*`), everything else later (`SUPABASE_*`), pictures last (`STORAGE_*` stays on Supabase meanwhile).

## What the code relies on, and how each is handled

| Supabase behaviour | Where | On the new server |
|---|---|---|
| `https://<host>/rest/v1/<table>` | all 21 files | Caddy serves the same path and strips `/rest/v1` for PostgREST |
| `apikey` header, plus `Authorization: Bearer` when the key starts with `eyJ` (`supabaseHeaders`) | all | `make-keys.mjs` signs an HS256 JWT with `role: service_role` (starts with `eyJ`), PostgREST verifies it with `JWT_SECRET`; Caddy refuses a request without a Bearer token (401) |
| `Prefer:` `return=minimal`, `return=representation`, `resolution=ignore-duplicates`, `resolution=merge-duplicates`, `count=exact` | all stores | native PostgREST (v12, same family) |
| `rpc/` functions: `admin_bump`, `aretia_prune`, `mi_claim_job`, `mi_delete_pools_from` (and `admin_prune_counters`) | admin stats, alerts, indexer | created by the migrations; Caddy allows exactly these names |
| roles `anon`, `authenticated`, `service_role`, row-level security with no policy | migrations 0001-0020 | created by `server/db/init/01-roles.sh`; `service_role` bypasses RLS; `anon`/`authenticated` get nothing |
| `max_rows` 1000 | paging | `PGRST_DB_MAX_ROWS=1000` |
| `pg_cron` + `pg_net` jobs (alerts every minute, Launch Box every 5, indexer every minute) | `supabase/cron/*.sql` | the `scheduler` container calls the same site URLs; or the worker replaces the indexer job. Migration `0014` already tolerates no `pg_cron` |
| `supabaseBase()` accepts only an `https://` host | all | the server is https via Caddy. The worker talks to `http://caddy:8080` inside Docker with its own store, which does not go through `supabaseBase` |
| `storage/v1/...` signed uploads and public bucket `launch-assets` | `api/_swingsUpload.ts`, `launchmeta/core.ts` | **not provided**: Caddy answers 404. Keep pictures on Supabase Storage with `STORAGE_*`, then move them to R2 (design below) |
| Supabase Auth / Realtime / Edge functions | none | the code uses none of them (checked by search) |

## Cut-over order

Each step is reversible by putting the previous value back and redeploying. Supabase stays in parallel and untouched until the last step.

0. **Server ready.** Follow `server/README.md` through Part 7: healthy stack, backups running **and one restore tested**, monitoring on. `docker compose logs migrate` shows all migrations applied.
1. **Indexer tables first (they are rebuildable, so the risk is lowest).**
   1. On the server, start the worker: `docker compose --profile worker up -d --build worker` with `MI_ADAPTERS` and a dedicated `MI_RPC_*` node. It writes to the *new* database from the start. Optionally `MI_BACKFILL_DAYS=7` for BNB Chain.
   2. Do **not** copy `mi_trades` (it holds days of data and costs Supabase egress); copy `mi_pools`/`mi_tokens` only if you do not want to wait for re-discovery: `SKIP_TABLES="mi_trades mi_block_hashes mi_checkpoints" ./bin/copy-from-supabase.sh` (without checkpoints the worker re-reads from its lookback).
   3. Compare for a day: `https://data.<domain>/rest/v1/mi_pools?select=key&limit=1` with the key, and the worker log. Check `/api/v1/status` lag on the new data once step 4 is done.
   4. In Vercel set `MI_DATA_URL` and `MI_DATA_SERVICE_ROLE_KEY`, redeploy. The public read API now reads the new tables. Remove `mi` from the Supabase `pg_cron` job (`select cron.unschedule('aretia-market-indexer');`) so Supabase stops being called every minute.
   5. The Launch Box link (`launchbox_tokens`) is read from Supabase by the Vercel route and from the new database by the worker. Until step 2 below, tokens launched on Aretia will not show their Launch Box badge from the worker's rows; the Vercel run is unaffected.
2. **Other tables later**, in a quiet hour: pause writers (set the site's maintenance flag or accept a minute of lost writes), run `./bin/copy-from-supabase.sh --restart` for the remaining tables (resets id counters, prints row counts), check counts, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the new server, redeploy, and test: sign in, favourites, notifications, a referral, the admin page, Launch Box. Switch the `scheduler` jobs on (`SCHEDULER_JOBS=alerts,launchbox`) and unschedule the matching Supabase `pg_cron` jobs.
3. **Pictures.** Until then set `STORAGE_URL` and `STORAGE_SERVICE_ROLE_KEY` to the Supabase project's values *before* step 2, so uploads keep working. Moving them is the R2 design below.
4. **Retire Supabase** only after two weeks of clean running and two successful nightly backups restored once. Keep a final dump in the drive. Until then Supabase is the rollback.

### Rollback

Put the previous values of `SUPABASE_*` / `MI_DATA_*` back and redeploy. Data written to the new server since the switch is not in Supabase; the copy script runs the other way if you swap the two connection strings (ask first). For the indexer nothing needs copying back: it rebuilds from the chain.

## Pictures on Cloudflare R2: design only (not built)

Today `/api/swings-upload` asks Supabase Storage for a signed upload link, the browser PUTs the file straight to the public bucket, and the
public URL is `<supabase>/storage/v1/object/public/launch-assets/<path>`. The bucket's own limits (size, allowed types) are the guard,
because a Supabase signed link does not bind type or size.

R2 version, same flow for the browser:
1. The route keeps its checks (session, owner of the token, `planUpload` path and size rules).
2. Instead of `POST /storage/v1/object/upload/sign/...` it builds a **presigned S3 `PUT` URL** for `https://<account>.r2.cloudflarestorage.com/<bucket>/<path>` (SigV4, about 40 lines with `crypto.subtle`, no new dependency), expiry 5 minutes, and **signs `content-type` and `content-length`** so the link cannot be used for another type or size (an improvement on Supabase).
3. Public reads come from a custom domain on the bucket (for example `https://img.aretiafinance.org/<path>`), which also serves from Cloudflare's cache and costs no egress. `publicUrl()` takes that base instead of `<supabase>/storage/v1/object/public/<bucket>`.
4. `bucketReady()` (which asks Supabase whether the bucket is public with limits) becomes a check that the R2 variables are set.
5. Existing pictures: copy once with `rclone copy` from Supabase Storage (S3-compatible endpoint) to R2 and keep the old URLs working by leaving Supabase Storage up until the metadata that points at it is rewritten, or by redirecting the old path in Cloudflare.
6. New variables: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE`; the access key limited to that one bucket.

It is not built here because it needs an R2 bucket, a custom domain and a key from the owner to test against.

## What was and was not verified

Verified by tests: the `MI_DATA_*` and `STORAGE_*` variables pick the right address (`api/_dataSwitch.test.ts`, `api/_swingsUpload.test.ts`); a key from `make-keys.mjs` is sent the way Supabase keys are. **Not verified:** any request against a real PostgREST, Caddy or Postgres 16 (no Docker or server was available), and the migrations on the stock Postgres image.
