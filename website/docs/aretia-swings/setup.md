# Aretia Swings: setup

Nothing here needs to be done for the Solana swap, which works with the existing RPC proxy. These steps switch on the pieces that need outside accounts.

## Environment variables (Vercel, server only, mark Sensitive)

| Variable | Used by | Needed for |
|---|---|---|
| `ZEROX_API_KEY` | `/api/swings-0x` | EVM quotes (0x). Without it the endpoint answers 503 and EVM stays off. |
| `SUPABASE_URL` | `/api/swings-tokens`, `/api/swings-discover` | The token registry. |
| `SUPABASE_SERVICE_ROLE_KEY` | same | Server-side database access. Never put this in frontend code or a `PUBLIC_` variable. |
| `CRON_SECRET` | `/api/swings-discover` | Authorises the scheduler. Without it the endpoint refuses everything. |
| `EVM_RPC_ETHEREUM`, `EVM_RPC_BNB`, `EVM_RPC_POLYGON`, `EVM_RPC_BASE` | discovery | Optional. On-chain checks for EVM tokens. Without one, that chain's tokens are stored with no risk assessment. |
| `SOLANA_RPC_URL` | existing | Already used by `/api/rpc`; discovery reuses it. |
| `SWINGS_EVM_CHAINS` | `/api/swings-status` | The operator's explicit switch per EVM chain, for example `base,polygon`. Aretia's own router needs no third-party key, so this alone enables a chain. Unlisted chains stay off. |
| `SWINGS_AGGREGATORS` | `/api/swings-status` | Set to `off` to remove Jupiter and 0x from quotes so only Aretia's own routing is used. Default on (they are non-core). Switching off today makes Solana prices worse: see `milestone-status.md`. |
| `SWINGS_CANARY_WALLETS` | `/api/swings-status` | Staged rollout: comma-separated wallet addresses allowed to review and sign. Unset means everyone. Only SHA-256 hashes reach the page. See `real-swap-runbook.md`. |
| `SWINGS_PROTECTED_SUBMIT` | `/api/swings-status`, `/api/swings-submit` | Set to `on` to offer protected (Jito) sending for Solana swaps. Off unless set. |
| `SWINGS_PUBLIC_API` | `/api/swings-quote` | Set to `on` to serve the public read-only quote API. Off unless set. It needs a keyed `SOLANA_RPC_URL`: on the public node a Solana quote takes about 20 seconds, so also allow the function a longer `maxDuration` on Vercel. |
| `EVM_RPC_ARBITRUM`, `EVM_RPC_OPTIMISM`, `EVM_RPC_AVALANCHE` | discovery, quote API | Optional, like the other `EVM_RPC_*` variables. |
| `PUBLIC_SWINGS_ANALYTICS` | `/api/swings-events`, `/api/swings-status` | Set to `1` to store anonymous aggregate events (needs migration 0002 and the database variables). Off by default. |
| `ETHERSCAN_API_KEY` | discovery | Optional: contract-source verification for EVM tokens. |

Local development: put values in `website/.env.local` (git-ignored).

## Token registry database
1. Create a Supabase project.
2. Apply the migrations. Either paste each file in `supabase/migrations/` into the SQL editor in order, or from your own machine run `SUPABASE_DB_URL=<connection string> npm run db:migrate -- --dry-run` to list what would run, then the same without `--dry-run`. The runner records what it applied and refuses an edited file. The URL is Supabase's connection string (Project settings, Database); keep it out of Vercel and out of git. Row level security is on with no policies: only the service role can read or write, so the browser cannot touch the tables. The runner is tested on a real Postgres engine but has not been run against your project.
3. Set the variables above and redeploy.
4. Schedule discovery: call `GET /api/swings-discover` with `Authorization: Bearer <CRON_SECRET>` every few minutes (Vercel Cron, or any scheduler). Each call polls the five chains once and advances a stored cursor per chain.
5. Check: `GET /api/swings-tokens` from the site origin should return `{"tokens":[...]}`.

## Turning on an EVM chain (do not skip steps)
The code for EVM is built; turning a chain on is an operator action with no code change.
1. Nothing to set for Aretia's own router. (`ZEROX_API_KEY` only adds the optional, non-core 0x benchmark provider.)
2. The venue contracts (`dex/entries.ts`) are proven by `npm run test:live`; run it before enabling a chain and confirm the addresses on the chain's block explorer.
3. Leave the fee policy off (the default) unless the buyback design has been reviewed.
4. Test with your own wallet and a small amount on that chain: quote, review, sign, confirm, check balances. Use a browser with your wallet and a staging deployment first.
5. Only then add the chain to `SWINGS_EVM_CHAINS` in production, for example `base`. Start with one chain.
6. To switch a chain off again, remove it from the variable. No deploy is needed beyond the environment change.

Optional database tables: run `0002_swings_events.sql` too if you enable analytics.

## Read-only live checks
`npm run test:live` calls real public services (Jupiter quote, GeckoTerminal on five chains, public Solana and EVM nodes). It signs nothing and spends nothing. It can fail because a third party is down or rate-limiting (GeckoTerminal allows about 30 requests a minute).

## The ACT buyback (0.87%)
Policy object: `DEFAULT_BUYBACK_POLICY` and `DEFAULT_FEE_CONFIG` in `src/swings/core/fee.ts`. It ships off. The Solana executor is built (see `milestone-status.md`): while it is on, every Aretia Solana swap carries a second swap of 0.87% of the input into ACT, in the same transaction, delivered to `chains.solana.buybackExecutorAddress`. To turn it on, in code and after review: set `policy.enabled: true`, `chains.solana.enabled: true`, a `treasuryAddress` and a `buybackExecutorAddress` (the wallet that should receive the ACT), then test on a staging deployment with your own wallet. If any address is missing the swap fails with `config-missing` and nothing falls back to another address. While it is on, Jupiter and 0x quotes are dropped (they cannot carry it), and swaps that sell ACT are not offered. There is no EVM buyback.
