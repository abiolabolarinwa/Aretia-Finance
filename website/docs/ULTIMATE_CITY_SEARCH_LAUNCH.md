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
   npx wrangler d1 execute aretia-game --remote --file=d1/0002_city_photos.sql
   ```
   ```
   npx wrangler d1 execute aretia-game --remote --file=d1/0003_roam.sql
   ```
   The first two files are safe to run again. The first seeds the nine cities and the eight coin classes; the second sets a credited,
   freely licensed Wikimedia Commons photograph on each city card. **`0003_roam.sql` must be run exactly once** (SQLite cannot add a
   column "if not exists"; a second run reports a duplicate column, which is harmless). Until it is run, walking and driving report
   "needs a database update" and nothing else is affected.
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
   `npx wrangler d1 execute aretia-game --remote --file=tutorial.sql` adds a Paris warm-up that pays XP and no prize. Daily and weekly
   challenges need nothing: they are built for every open city the first time its missions are listed in a new day or week.
4. **Build the site with `PUBLIC_GAME_ENABLED=1`** (Cloudflare Pages build variable). Until then the sidebar item and page do not exist
   and `#/ultimate-city-search` opens the dashboard.
5. **Optional build variables** (public values, set in the same place):
   - `PUBLIC_MAPILLARY_TOKEN`: a free Mapillary client token (developer account at mapillary.com). Turns on street-level photographs.
     Without it the Street view button says it is not set up.
   - `PUBLIC_WALLETCONNECT_PROJECT_ID`: adds WalletConnect to the sign-in chooser (the wallet may already have one set).
   - `PUBLIC_SATELLITE_TILES` and `PUBLIC_SATELLITE_ATTRIBUTION`: an XYZ tile address and credit for satellite imagery you are licensed
     to use. Without them the Satellite button is disabled.

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
Daily and weekly challenges never carry a prize.

## 3. What is built

- Sign in with any Ethereum-style wallet the browser announces, WalletConnect (phone or hardware), the Solana wallet connected in the
  sidebar, or Phantom. A free message, never a transaction; a game token is kept apart from the wallet's own sessions.
- Nine cities, kept in the database, each with a real photograph and credit, real landmarks, a transport set and a 3D scene preset. An
  administrator can add more from the console (bounds, start point, transport, colours, scene, landmarks, licensed photograph); a new city
  starts hidden and works like the rest once opened.
- An interactive map (OpenStreetMap data), satellite where licensed, street-level photographs (Mapillary), a 3D model of each city with
  its landmarks, journeys and flights timed by the server.
- Missions of several steps with hints, daily and weekly challenges generated automatically, team hunts solved together, simulated
  chambers (dive, mine, vault) as a setting for a clue, treasures in eight classes with protected locations, first-finder badges.
- XP, levels, achievements, history, leaderboards (global, city, day, week, month), teams.
- The administrator console: cities, missions, clues, treasure placement on a map with safety checks, verification, prize claims,
  the funded reserve, reports, announcements, suspicious-activity flags and an audit log.

## 4. What was tested

- Unit and integration tests for every server rule (more than 300 game tests): sign-in and replay, wallet-versus-game message
  separation, player identity, city selection and progress, server-timed travel and flights, clues, hints, answer limits, XP paid
  once, treasure locking and first-finder, achievements, history, boards, teams, team hunts, the admin gate and every admin operation.
- The D1 schema runs on a real SQLite engine (the dialect D1 uses) in the test suite, and whole games are played through the real request
  handler against it: an administrator hides a coin, a player solves the trail, travels, collects, is verified, claims and is paid; two
  players racing for one coin; a flight; a team; a team hunt; an administrator-created city; daily challenges solved with answers the
  game works out itself.
- The challenge generator is checked for truth: over 40 days and nine cities every distance, flight time, compass order and code is
  recomputed independently and must match.
- The 3D scene models (the data the pictures are drawn from) are deterministic, keep landmarks inside the scene and buildings out of the
  water, and stay small enough for a phone. The Mapillary helpers and the wallet chooser are tested with stand-ins.
- Typecheck, lint, a production build with the flag on, and a bundle check that the Cloudflare function builds for a Worker (about 220 KB,
  needs only `node:crypto`). Everything heavy is a lazy chunk: the map (about 300 KB compressed) and the 3D library (about 185 KB) load
  only when opened; the wallet's first load does not change.
- A check that the game folder and API contain no ACT, staking, fee or transaction-signing code.
- Treasure locations and answers: tests assert that mission lists, clue views, boards and the public city list contain no coordinates,
  answers or hashes.

## 5. Not done (be honest about these)

| Area | Status |
|---|---|
| **None of the pages has been seen in a browser, on a phone, or against a real wallet by me.** | The sandbox refused localhost, and there is no device here. WebGL drawing, the map, Mapillary's viewer, WalletConnect and the admin forms need a person to click through them on desktop and phone before launch. |
| Cloudflare setup | Nothing has been created in your Cloudflare account: no D1 database, binding or secrets. Section 1 lists exactly what to do. |
| Walk & drive (GTA-style) | The streets, buildings, rivers and parks are the real map (OpenStreetMap through OpenFreeMap, loaded as you move), with walking, running, cars and boats, walls and water that block you, a minimap and full screen. Buildings are plain extruded shapes at the heights the map gives (or a guess), not textured. Cars are arcade-driven and parked near you, with no other traffic or pedestrians. Where the map has no data the ground is empty. The server only checks that your reported speed is possible for walking, running, driving or boating; it does not replay your path. It is built and tested (map decoding, collisions, physics, geometry, server limits) but has **not been seen running on a real GPU, phone or against the live tile service**. |
| Street photo in Walk & drive | Press V (or the button): Mapillary's real photograph of the street nearest the player, in Mapillary's viewer, with the credit and a link. Needs `PUBLIC_MAPILLARY_TOKEN` (checked live: the token is in the site and the API answers; about 30 photos near the Lagos centre, 50 near Paris and London). Coverage is patchy: away from main streets there may be no photo within 120 m, and the panel says so. |
| Real street data in Walk & drive | With the Mapillary key set, the view also fetches Mapillary's detected map features (traffic lights, crosswalks, street lights, utility poles, bins, benches, hydrants, traffic signs) in 600 m blocks and uses their real positions in place of the game's own rules, rebuilding squares when a block arrives. Where there is no data for a kind in a square the rules stay. Real traffic lights only **add** signals (they never remove rule-based ones). Coverage is very uneven: checked live, Paris and London have over a hundred traffic lights near the centre, Lagos has one but 235 utility poles. A block can take a few seconds to arrive. The data is CC BY-SA 4.0: the credit is shown while it is in use; **have a lawyer confirm how the share-alike term applies to using the positions as placement data.** |
| Overview 3D scene | The older 3D overview (Map tab) is a stylised model: only landmarks (approximate positions) are real places; buildings are generated to suit the kind of city. |
| Underwater and underground | They are 3D scenes to read a clue in, not separate puzzle engines. Clues are still text. |
| Street-level imagery | Only where Mapillary has photographs, which varies by city. Google Street View is not used (its terms bar showing it as a game layer without a billed key and Google's own viewer). |
| Photographs | Real and credited, from Wikimedia Commons, hot-linked. If traffic grows, copy them to R2 with their credits. |
| Daily and weekly challenges | Built from facts the game computes (distances, flight times, compass order, codes). They are a warm-up, not hand-written riddles. The hand-written ones are for you to author. |
| Real-time | Boards refresh by polling every 30 seconds. |
| Anti-cheat | Server-side scoring, positions and clocks; attempt limits; per-address limits; suspicious-activity flags. No bot detection beyond rate limits, and the in-memory rate limiter is per server instance. |
| Admin roles | One tier: any wallet in `ADMIN_WALLETS`. |
| Independent review | No third-party security review or load test. Do at least a review of the sign-in, collect and admin paths before cash prizes. |
| Content | No real missions, clues or treasures exist yet. Writing nine solvable Diamond chains is an editorial job. |
| Seasons | Missions can be daily, weekly, event or team with open and close times, and treasures carry a season label, but there is no season calendar or season-end reset. |

## 6. Running cost (estimates, not quotes)

Map tiles come from OpenFreeMap (free, no key; consider supporting it or self-hosting PMTiles on R2 if traffic grows). The game runs on
Cloudflare (Pages Functions and D1), whose free allowances cover hundreds of players; at tens of thousands, plan for the Workers Paid
plan (about $5 a month plus usage). Mapillary's API is free for a client token. A paid tile or satellite provider is the item most
likely to dominate cost (hundreds of dollars a month at the high end).

## 7. Where things are

- Plan and decisions: `docs/ULTIMATE_CITY_SEARCH_PLAN.md`
- Server: `functions/api/game.ts` (the Cloudflare entry), `api/_game.ts` (sign-in, cities, travel), `_gameMissions.ts`, `_gameChallenges.ts`,
  `_gameProgress.ts`, `_gameBoards.ts`, `_gameAdmin.ts`, `_gameCatalogue.ts`, and `_d1Rest.ts` (the D1 data layer)
- Client: `src/game/` (panel, explore, missions, progress, boards, admin, signers, street, scene)
- Rules shared by both: `cities.ts`, `travel.ts`, `rarity.ts`, `achievements.ts`, `periods.ts`, `exclusions.ts`, `challenges.ts`, `sceneModel.ts`
- Operator tools: `scripts/game-answers.ts` (answer hashes, tutorial), `scripts/game-city-photos.ts` (credited photographs)
- Walk & drive: `src/game/world/` (`roam.ts` the view, `mvt.ts`/`worldData.ts` map data, `colliders.ts`, `physics.ts`, `roamBuild.ts`) and `src/game/roamRules.ts` (speed limits shared with the server)
- Database: `d1/0001_game.sql`, `d1/0002_city_photos.sql`, `d1/0003_roam.sql` (Cloudflare D1)
