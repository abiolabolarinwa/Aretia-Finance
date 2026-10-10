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
| `SWINGS_EVM_CHAINS` | `/api/swings-status` | EVM networks are **on by default** (all seven). When this is set it is an allow-list, for example `base,polygon`: any chain not listed is off. `none` turns every EVM network off. Aretia's own router needs no third-party key. |
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
All seven EVM networks are on by default. Narrowing or switching them off is an operator action with no code change. **Only BNB Chain has had a real swap signed so far (10 October 2026); the others have not**, so until the runbook is done, consider narrowing with `SWINGS_EVM_CHAINS` and `SWINGS_CANARY_WALLETS`.
1. Nothing to set for Aretia's own router. (`ZEROX_API_KEY` only adds the optional, non-core 0x benchmark provider.)
2. The venue contracts (`dex/entries.ts`) are proven by `npm run test:live`; run it before enabling a chain and confirm the addresses on the chain's block explorer.
3. The 0.58% Aretia fee is on for every network, for swaps paid with a coin or stablecoin (see below); set `PUBLIC_ARETIA_EVM_FEE_ADDRESS` before enabling any EVM network.
4. Test with your own wallet and a small amount on that chain: quote, review, sign, confirm, check balances. Use a browser with your wallet and a staging deployment first.
5. To test one chain on its own, set `SWINGS_EVM_CHAINS=base` (for example) in production so only that chain is on.
6. To switch every EVM network off, set it to `none`. To go back to all on, delete the variable. No deploy is needed beyond the environment change.

Optional database tables: run `0002_swings_events.sql` too if you enable analytics.

## Read-only live checks
`npm run test:live` calls real public services (Jupiter quote, GeckoTerminal on five chains, public Solana and EVM nodes). It signs nothing and spends nothing. It can fail because a third party is down or rate-limiting (GeckoTerminal allows about 30 requests a minute).

## The Aretia fee (0.58%, on swaps paid with a coin or stablecoin)
Rate: 58 bps, `ARETIA_FEE_BPS` in `src/swings/core/fee.ts`, charged on every listed network. The ACT buyback has been removed. The fee is taken out of the amount the user enters (what they spend is exactly what they typed; the rest is swapped), in the asset they are paying with, and only when that asset is a network's own coin (SOL, ETH, BNB, POL, AVAX), that coin wrapped, or a main stablecoin (USDC, USDT and the others in `core/feeAssets.ts`, which reuses the router's hop-token list). Paying with any other token, which is selling it, carries no fee. So the fee wallet only ever receives liquid assets, and swapping USDC to SOL pays it too. Fees from before 10 October 2026 were 0.29% on sales as well, in the token sold, so the fee wallet may hold some of those tokens.

- **Solana:** one transfer inside the same transaction as the swap, to the owner's existing fee wallet (`SWAP_FEE_WALLET`). A token fee also opens the fee wallet's account for that token the first time (the user pays its rent once).
- **EVM networks:** a separate transaction sent just before the swap (after any approval), confirmed first, and never sent twice for one quote. It goes to one address you set at build time: **`PUBLIC_ARETIA_EVM_FEE_ADDRESS`** (a public value, like the WalletConnect id). Until it is set, EVM swaps are paused with a plain message instead of letting them through without the fee.
- **Routes that cannot collect it** are left out while it is on (Jupiter on Solana). Aretia's own routers and 0x collect it.
- The public quote API (`/api/swings-quote`) only quotes and prepares for integrators and charges no fee.

Test it on staging with the canary wallet first (`real-swap-runbook.md`, step 7).

## WalletConnect (phone and hardware wallets)

1. Create a free project at the WalletConnect Cloud dashboard (cloud.reown.com) and copy its **project id** (32 characters). It is public by design; it identifies your site, it is not a secret.
2. In Vercel, set `PUBLIC_WALLETCONNECT_PROJECT_ID` (a build-time variable, so redeploy). In the dashboard, add `aretiafinance.org` as an allowed domain.
3. A "Connect with WalletConnect" button then appears next to the browser wallets in the Swap and Move USDC tabs. A saved session reconnects without a prompt; the large WalletConnect library loads only when someone uses it or has a saved session.
Without the id nothing changes: the button is not shown. Test with a small amount on one network before telling anyone it is available.
