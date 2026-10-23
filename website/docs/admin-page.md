# Owner admin page

A private page at `/owner-admin` showing visits, country, wallet types, traders, coins traded, Aretia fee revenue and issues. It is not linked from
any menu, carries `noindex, nofollow`, and is protected **on the server**: the numbers come from `POST /api/swings-admin` (a route of
`api/swings-data.ts`, so no new serverless function), which answers only when the request carries a valid wallet sign-in session whose address
is in `ADMIN_WALLETS`. Anyone else (no session, another wallet, no allow-list, wrong method or origin) gets the same `404 {"error":"not-found"}`
as a path that does not exist, and no data. The page itself is a static shell that holds no numbers.

## What you must set

| Where | What |
|---|---|
| Vercel env var `ADMIN_WALLETS` | Your wallet address(es), comma-separated: `0x…` (any case), `evm:0x…`, `solana:<address>` or a bare Solana address. Without it every request is a 404. |
| Vercel env vars already needed | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SWINGS_SESSION_SECRET` (the wallet sign-in the site already uses). |
| Supabase | Apply `supabase/migrations/0016_admin_counters.sql` (the table and the `admin_bump` function). The sign-in also needs 0014 (nonces, sessions). Sections whose table is missing show "Not set up" instead of failing. |

Then open `/owner-admin`, sign in with the owner wallet (a free signed message, not a transaction).

## Where each number comes from, and what it is not

| Figure | Source | Honest limit |
|---|---|---|
| Visits, country | `admin_counters`, one count per browser tab session; country from Vercel's `x-vercel-ip-country` header | Counted only from the day 0016 is applied. Self-reported: anyone can call the endpoint, so it can be inflated. Not counted: Do Not Track / Global Privacy Control, blockers. Country is the network's, not proof of residence. |
| Wallet types | Name of the wallet app, counted when a swap ends | Only wallets that finished or failed a swap, not wallets merely connected. |
| Traders | Distinct signed-in wallets in `user_trades` (people who chose to save swap history) | A floor. Swaps without that sign-in are not tied to a wallet, and the beacon stores no wallet. |
| Coins traded | Coin symbols of confirmed swaps (counter) and of saved histories | Symbols are labels; two tokens can share one. |
| Revenue | "Held now": balances at the fee addresses (SOL, USDC; ETH/BNB/POL, USDC, USDT) read from public nodes at CoinGecko prices. "Creation fees": Launch Box tokens in the window times the flat fee | Held is **not income for the period** (it ignores anything you moved out, before gas). The creation line is an estimate. Swap fees paid in a chain's own coin cannot be itemised from free data. For income by chain and stream use `scripts/revenue-report.mjs` ([revenue-report.md](revenue-report.md)) on your computer. |
| Issues | Failed swaps and script errors by category (counter), failed quotes/swaps from `swings_events` | Category and error kind only, never a message. `swings_events` fills only when swap analytics are on. |

## Privacy

The beacon sends a few words (visit; swap network, two coin symbols, wallet name, outcome; failure category). The server adds one to a daily count in
`admin_counters` (day, kind, key, count). No IP (used only for an in-memory rate limit), address, amount, transaction, cookie or id is stored. The
privacy page says so. To switch collection off, do not apply 0016, or remove `startSiteBeacon()` from `src/layouts/Base.astro`.

## Unverified

Written and unit-tested (owner/non-owner paths, allow-list, counters, summaries, fee addresses equal to the revenue report's). Not yet run against
the production database or with a real wallet signature on the live site.
