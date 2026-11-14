# Ultimate City Search: launch runbook and honest status

Milestones 2 to 8 are merged and off by default. This file says what is built, what was tested, what is **not** done, and the exact
steps to turn it on. Read the "Not done" list before announcing anything.

## 1. Turning it on (in this order)

1. **Apply the migrations 0024 to 0030** to the Supabase database (`SUPABASE_DB_URL=... npm run db:migrate -- --dry-run`, then without
   `--dry-run`). They only add tables, indexes and service-role-only functions; they do not change an existing table.
2. **Set the server secrets** on the API host (Vercel): `GAME_ANSWER_SECRET` (a long random value, kept for ever: every stored answer
   hash depends on it; if it is changed, every answer must be re-entered), `ADMIN_WALLETS` (already used by the owner pages; the
   wallets in it become game administrators), and leave `GAME_PRIZES_ENABLED` **unset** (prizes closed).
3. **Create the content.** Sign in to the game as an administrator, and in the console: confirm each city is Active, then make
   missions and clues, then place treasures. Nothing is in the repository on purpose (the repository is public). To try the engine
   first: `GAME_ANSWER_SECRET=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/game-answers.ts seed-tutorial` adds a
   Paris warm-up that pays XP and no prize.
4. **Build the site with `PUBLIC_GAME_ENABLED=1`** (Cloudflare Pages build variable). Until then the sidebar item and page do not exist
   and `#/ultimate-city-search` opens the dashboard.
5. Optional satellite: build with `PUBLIC_SATELLITE_TILES` (an XYZ URL) and `PUBLIC_SATELLITE_ATTRIBUTION` for a provider you are
   licensed to use. Without them the Satellite button is disabled.

To turn it off again: remove `PUBLIC_GAME_ENABLED` and rebuild. Player data stays in the database.

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
- The SQL (XP ledger, leaderboard and rank functions, teams, one Diamond per city, one First Finder per class and city, the overview) runs
  on a real Postgres engine (PGlite) in the test suite, together with every earlier migration.
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

Map tiles come from OpenFreeMap (free, no key; consider supporting it or self-hosting PMTiles on R2 if traffic grows). The game adds
database rows and a few API calls per action on the existing Supabase and Vercel plans: expect little extra at hundreds of players.
At tens of thousands, plan for a Supabase Pro plan and possibly a Vercel Pro plan for function limits, and a paid tile or satellite
provider (hundreds of dollars a month at the high end). Street-level imagery, if added, is the item most likely to dominate cost.

## 6. Where things are

- Plan and decisions: `docs/ULTIMATE_CITY_SEARCH_PLAN.md`
- Server: `api/_game.ts` (sign-in, cities, travel), `_gameMissions.ts`, `_gameProgress.ts`, `_gameBoards.ts`, `_gameAdmin.ts`
- Client: `src/game/` (panel, explore, missions, progress, boards, admin)
- Rules shared by both: `cities.ts`, `travel.ts`, `rarity.ts`, `achievements.ts`, `periods.ts`, `exclusions.ts`
- Operator tool: `scripts/game-answers.ts`
- Database: migrations `0024` to `0030`, with the self-hosted data server allow-list in `server/caddy/Caddyfile`
