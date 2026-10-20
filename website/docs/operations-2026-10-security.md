# Operator steps for the October 2026 API security fixes

These go with the fixes for the 2026-10 full review (M-1, M-11, H-3 server side, L-3 to L-7, L-14, L-27, I-21, I-22, I-24, I-25).
Do them in this order when you deploy.

## 1. Set the environment variables (Vercel, Sensitive)

| Variable | What it does |
|---|---|
| `SWINGS_SESSION_SECRET` | Its own long random value (`openssl rand -hex 32`). It signs wallet sessions, referral captures and recovery-record write tokens. Until it is set, the database service key is used, as before, and each instance logs a warning. Setting or changing it signs everyone out once. |
| `SWINGS_LOGIN_DOMAINS` | Optional. Comma-separated hosts a sign-in message may name. Empty means the hosts of the allowed origins (`aretiafinance.org`, `www.aretiafinance.org` and `RPC_ALLOWED_ORIGINS`). The domain is never taken from the request's `Origin` header. |

## 2. Run the new migrations

```bash
cd website && SUPABASE_DB_URL="postgresql://..." npm run db:migrate
```

Or paste each file into the Supabase SQL editor. Both are safe to run twice.

- `supabase/migrations/0013_referral_tx_case.sql`: merges referral credits stored under several letter cases of one EVM hash (keeping a paid row, then a credited row, then the earliest), lower-cases the rest, adds `check (chain = 'solana' or tx = lower(tx))`, and adds the indexes for the cap queries. Solana signatures are not touched.
- `supabase/migrations/0014_auth_nonces_and_pruning.sql`: `auth_nonces` (single-use sign-in nonces with expiry, marked used with the owner who used them), `account_sessions` (per-owner session version), and `aretia_prune()`, which removes expired nonces and Telegram link codes, inbox messages older than 7 days, tracked pools unseen for 7 days and recovery records not updated for 90 days. If `pg_cron` is installed it is scheduled hourly; the alert job (`/api/swings-alerts-run`) also calls it on each run.

**Sign-in does not work until 0014 is applied** (the nonce request answers 502). Swaps are not affected.

## 3. What changes for people

- Sign-in messages are now in the Sign-In with Ethereum (EIP-4361) and Sign In With Solana formats, with a nonce from the server. The page asks for it first; nothing to do.
- Existing sessions keep working until they expire. "Sign out everywhere" (`op: 'sign-out-all'`) ends all of an address's sessions. To end someone's sessions yourself:
  ```sql
  insert into public.account_sessions (owner, version, updated_at) values ('evm:0x...', 1, 0)
    on conflict (owner) do update set version = account_sessions.version + 1;
  ```
- Buying through MoonPay needs the wallet to be signed in (the "Save to my wallet" sign-in). Links are signed only for that wallet; each issued link is logged (`ramp url issued owner=... chain=... side=...`).
- Browser alerts are accepted only for the browsers' push services (FCM, Mozilla autopush, Windows WNS, Apple). Older channels on any other host are removed at the next send. The service worker now sends the inbox secret in a header (`X-Inbox-Secret`); the old `?s=` is still read for workers not yet updated.
- A referral now binds from the server-recorded link visit (a capture token). People who arrived through a link before this version get a capture on their next visit; swaps made before it are not credited.
- Recovery copies (`/api/swings-records`): creating one answers a write token that the browser keeps; updates need it. A record restored on another device is not updated on the server from there.

## 4. Before paying referrers

`node scripts/referral-export.mjs` now re-reads every unpaid payment from the chain and leaves out anything not final, failed or missing (listed separately on stderr). Run 0013 first so copies stored under other letter cases are merged.

## Limits that are per instance

The new per-owner and per-IP limits (referral reports, alert tests, nonce requests, chart tracking) and the global pool-scan budget are kept in memory per server instance, like the existing per-IP limit. A shared store (e.g. Upstash Redis) would make them exact across instances.
