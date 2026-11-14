# Ultimate City Search: launch runbook and honest status

The game is merged and off by default. This file says what is built, what was tested, what is **not** done, and the exact
steps to turn it on. Read the "Not done" list before announcing anything.

## 1. Turning it on (in this order)

The game runs on **Cloudflare**: a Pages Function (`functions/api/game.ts`) with its data in a **D1** database. It does not use Supabase
or Vercel. The function is more specific than the site's catch-all `/api` forwarder, so `/api/game` is answered on Cloudflare.

1. **Create the database and load the schema** (from `website/`, signed in to the right Cloudflare account):
   ```
   npx wrangler d1 create aretia-game
   npx wrangler d1 execute aretia-game --remote --file=d1/0001_game.sql
   ```
   The schema file is safe to run again. It seeds the nine cities and the eight coin classes.
2. **Bind it to the Pages project** (Cloudflare dashboard, Workers & Pages, the site, Settings, Bindings and Variables):
   - D1 database binding, variable name `GAME_DB`, database `aretia-game`
   - Compatibility flag `nodejs_compat` (Settings, Compatibility flags), for production and preview
   - Secrets: `GAME_SESSION_SECRET` and `GAME_ANSWER_SECRET` (long random values; keep `GAME_ANSWER_SECRET` for ever, because every
     stored answer hash depends on it), and `ADMIN_WALLETS` (the wallets that become game administrators)
   - Leave `GAME_PRIZES_ENABLED` **unset** (prizes closed)
   Then redeploy the site so the function picks them up.
3. **Create the content.** Sign in to the game as an administrator, and in the console: confirm each city is Active, then make
   missions and clues, then place treasures. Nothing is in the repository on purpose (the repository is public). To try the engine
   first: `GAME_ANSWER_SECRET=... node scripts/game-answers.ts tutorial-sql > tutorial.sql` then
   `npx wrangler d1 execute aretia-game --remote --file=tutorial.sql` adds a Paris warm-up that pays XP and no prize.
4. **Build the site with `PUBLIC_GAME_ENABLED=1`** (Cloudflare Pages build variable). Until then the sidebar item and page do not exist
   and `#/ultimate-city-search` opens the dashboard.
5. Optional satellite: build with `PUBLIC_SATELLITE_TILES` (an XYZ URL) and `PUBLIC_SATELLITE_ATTRIBUTION` for a provider you are
   licensed to use. Without them the Satellite button is disabled.

To turn it off again: remove `PUBLIC_GAME_ENABLED` and rebuild. Player data stays in D1. To back it up:
`npx wrangler d1 export aretia-game --remote --output=game-backup.sql`.

## 2. Cash prizes: do not switch on yet

`GAME_PRIZES_ENABLED=1` lets players file claims. Do not set it until all of these are true:

- Written competition terms are published (eligibility, ages, excluded countries, how a winner is chosen, how and when paid).
- A lawyer has confirmed the game is lawful where you will offer cash. Finding a randomly placed coin can be treated as a lottery in
  some places even when clues are skill-based.
- The prize reserve is funded and recorded in the console (Overview shows obligations against the reserve and any shortfall).
- You have a way to pay winners outside this app, and to check who they are.

The $1,000 Diamond Coin per city is a game denomination. Only coins worth $1 or more can be claimed; the smaller ones are collectibles.

## 3. What was tested

- Unit and integration tests for every server rule (about 150 game tests): sign-in and replay, wallet-versus-game message separation,
  player identity, city selection and progress, server-timed travel and flights, clues, hints, answer limits, XP paid once,
  treasure locking and first-finder, achievements, history, boards, teams, the admin gate and every admin operation.
- The D1 schema runs on a real SQLite engine (the dialect D1 uses) in the test suite, and a whole game (administrator hides a coin, a player
  solves the trail, travels, collects, is verified, claims and is paid; two players racing for one coin; a flight; a team) is played through
  the real request handler against it. The XP ledger, boards, ranks, team standings, the one-Diamond-per-city and one-First-Finder rules
  and the administrator overview are tested there.
- Typecheck, lint, and a production build with the flag on. The game's code is split into lazy chunks; the wallet's first load does
  not change. The map library is about 1.1 MB (roughly 300 KB compressed) and loads only when a city is opened.
- A check that the game folder and API contain no ACT, staking, fee or transaction-signing code.
- Treasure locations and answers: tests assert that mission lists, clue views and boards contain no coordinates, answers or hashes.

## 4. Not done (be honest about these)

| Area | Status |
|---|---|
| **The pages have not been seen in a browser by me.** | The sandbox refused localhost. Open the flagged build and click through sign-in, a city, a journey, a flight, a mission and the admin console on desktop and a phone before launch. |
| Street-level imagery | Not built. Needs a Mapillary or Google account and key and a viewer. The map says it is unavailable. |
| 3D (Cesium, Three.js), underwater and underground scenes | Not built. Missions are text clues on a 2D map. |
| City-specific environments | Each city is its real map, bounds and transport set, not a bespoke 3D world. |
| Card photography | None licensed. Cards use a colour tint. |
| Creating new cities | The nine are in the code catalogue (`src/game/cities.ts`). The console can activate, deactivate and rename them; adding a tenth needs the catalogue moved to the database. |
| Team treasure hunts, seasons, daily challenge generation | Teams are scored on member XP. Missions can be daily/weekly/event with open and close times, but nothing auto-creates them. |
| Wallet coverage | Sign-in uses an injected Ethereum-style wallet or Phantom-style Solana wallet. WalletConnect and mobile-app wallets are not wired to the game. |
| Real-time | Boards refresh by polling every 30 seconds. |
| Anti-cheat | Server-side scoring, positions and clocks; attempt limits; per-address limits; suspicious-activity flags. No bot detection beyond rate limits, and the in-memory rate limiter is per server instance. |
| Admin roles | One tier: any wallet in `ADMIN_WALLETS`. |
| Independent review | No third-party security review or load test. Do at least a review of the sign-in, collect and admin paths before cash prizes. |
| Content | No real missions, clues or treasures exist yet. Writing nine solvable Diamond chains is an editorial job. |

## 5. Running cost (estimates, not quotes)

Map tiles come from OpenFreeMap (free, no key; consider supporting it or self-hosting PMTiles on R2 if traffic grows). The game runs on
Cloudflare (Pages Functions and D1), whose free allowances cover hundreds of players; at tens of thousands, plan for the Workers Paid
plan (about $5 a month plus usage) and a paid tile or satellite provider (hundreds of dollars a month at the high end). Street-level imagery, if added, is the item most likely to dominate cost.

## 6. Where things are

- Plan and decisions: `docs/ULTIMATE_CITY_SEARCH_PLAN.md`
- Server: `functions/api/game.ts` (the Cloudflare entry), `api/_game.ts` (sign-in, cities, travel), `_gameMissions.ts`, `_gameProgress.ts`,
  `_gameBoards.ts`, `_gameAdmin.ts`, and `_d1Rest.ts` (the D1 data layer)
- Client: `src/game/` (panel, explore, missions, progress, boards, admin)
- Rules shared by both: `cities.ts`, `travel.ts`, `rarity.ts`, `achievements.ts`, `periods.ts`, `exclusions.ts`
- Operator tool: `scripts/game-answers.ts`
- Database: `d1/0001_game.sql` (Cloudflare D1)
