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
| `PUBLIC_SWINGS_ANALYTICS` | `/api/swings-events`, `/api/swings-status` | Set to `1` to store anonymous aggregate events (needs migration 0002 and the database variables). Off by default. |
| `ETHERSCAN_API_KEY` | discovery | Optional: contract-source verification for EVM tokens. |

Local development: put values in `website/.env.local` (git-ignored).

## Token registry database
1. Create a Supabase project.
2. Run `supabase/migrations/0001_token_registry.sql` in the SQL editor. Row level security is on with no policies: only the service role can read or write, so the browser cannot touch the tables.
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
Policy object: `DEFAULT_BUYBACK_POLICY` in `src/swings/core/fee.ts`. It ships `enabled: false`. Before enabling, the execution design must settle: where the 0.87% is taken from (extra input versus the output), how it is converted to ACT without extra slippage or a circular route, what happens when the buyback leg fails but the swap succeeds, and who holds the executor. The code refuses to proceed with an enabled policy whose treasury or executor address is missing.
