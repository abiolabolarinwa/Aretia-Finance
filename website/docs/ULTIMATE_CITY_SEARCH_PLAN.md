# Ultimate City Search: Milestone 1 audit and implementation plan

Status: proposal. Nothing in production has been changed. Awaiting approval.

## 1. What the codebase is (audit findings)

| Area | Finding | Consequence for the game |
|---|---|---|
| Frontend | Astro 7 static site (`website/`), vanilla TypeScript modules, no React/Vue. The wallet is one page, `src/pages/wallet/index.astro` (2,028 lines), driven by `src/scripts/walletApp.ts`. | The game is a vanilla-TS module, lazy-loaded. No framework is introduced. |
| Routing | Hash router. `VIEWS` array in `walletApp.ts:356`, `hashchange` handler at `:1344`, panes switched by `data-view` on `.wapp`. `/wallet/*` is rewritten to `/wallet`. | `#/ultimate-city-search` is a new entry in `VIEWS` plus a `data-pane`. Matches the route you suggested. |
| Sidebar | Markup in `wallet/index.astro`, active-item logic in `walletNav.ts` (`sidebarItemFor`), collapsed-rail CSS, tests in `walletNav.test.ts`. | One new sidebar item and pane. Existing views are untouched. |
| Wallet connect | EVM (`swings/chains/evm*.ts`, WalletConnect) and Solana (`solanaWc.ts`, `swings/chains/solana.ts`). | Reused as is. |
| Sign-in | `api/_swingsAuth.ts`: SIWE / SIWS message, server-issued single-use nonce (`_swingsAccount.ts`), strict ed25519 and secp256k1 verification, domain taken from server config, 7-day HMAC session with revocable version. | This already meets section 4 of the brief (nonce expiry, replay protection, no transaction). The game reuses it and adds a distinct login message wording and a `game` scope, so a game token is not a wallet-feature token. |
| Identity | Existing accounts key on a text `owner` = `solana:<addr>` or `evm:<lowercase addr>` (`0008_user_data.sql`). | Already the composite identity you want. The game adds an internal `players.id` (uuid) on top and a `player_wallets` table. No auto-merge. |
| Database | Supabase Postgres, SQL migrations `0001`-`0016`, RLS on with no policies, access only through server functions with the service role. | New migrations `0017+`, same pattern. This is the right place for protected treasure coordinates. |
| API | Vercel serverless, `api/*.ts`, **11 of 12 functions used**. A test (`_functionCount.test.ts`) fails the build above 12. Routes are folded into `swings-data.ts` via `vercel.json` rewrites. A Cloudflare Pages catch-all (`functions/api/[[path]].ts`) also exists. | **Hard constraint.** The game API must be a route inside an existing function (a `route=game` fold), not new function files. |
| Hosting | Site on Cloudflare Pages, API still on Vercel. Images on Cloudflare R2. | Game art goes to R2. |
| CSP | `public/_headers` has a Report-Only CSP with an explicit `connect-src` allowlist. `img-src` allows `https:`. | Tile, style and glyph hosts and any street imagery host must be added. Report-Only today, but keep it correct. |
| Realtime | None (no WebSocket service). Pages use polling. | Leaderboards poll. See section 4. |
| Admin | `owner-admin.astro` plus `ownerAdmin.ts` and `api/swings-admin`. | The game admin console is a section behind the same owner-session check. |
| ACT | ACT is referenced in staking, fee and pool code. | The game module imports nothing from those files and has no ACT references. A test enforces this (section 6). |
| Repo visibility | The repo is public (see `security-audit` note). | Treasure coordinates, answers and unreleased missions must **never** be in the repo, seed files or built JS. They live only in the database, set through the admin console. |

## 2. Decisions I need from you (these change the plan)

1. **Cash prizes and legality.** $9,000 of headline cash prizes for a wallet-gated treasure game is a prize competition. Depending on country it can be treated as a lottery or gambling, and entry cost, skill versus chance, age and sanctions rules matter. Treasures that are random finds (the rarity engine) lean towards chance. I recommend: (a) the game ships first with **no cash**, only XP, collectibles and a "claim pending" state; (b) cash is switched on per city only after written competition terms and a lawyer's review. I will build the claim, verification and audit pipeline now but leave payout disabled by a flag. Is that acceptable?
2. **Street-level imagery.** Google Street View may only be shown through Google's own viewer or embed, with a billed API key, and may not be scraped, cached or overlaid with a hidden-treasure game logic that reads the imagery. Mapillary (CC BY-SA, free, patchy in some of the nine cities) is the safer base. Proposal: Mapillary first, Google's embedded Street View as an optional per-city layer behind your own key and budget cap. OK?
3. **3D.** CesiumJS and Three.js add several MB and heavy GPU load, and the wallet is also a Capacitor mobile app. I propose 3D only for the three simulated environments (underwater, mine, vault) in a later milestone, and a MapLibre globe for flights. OK?
4. **Win realism.** "Every major prize must have a legitimate discovery path" means each Diamond Treasure needs an authored, solvable chain (I would write and test 9 chains with you). A first-finder-only prize also needs a fair tie-break rule published in the terms.
5. **Budget ceiling.** See cost section. Pick a monthly cap so I can set provider limits.

## 3. Architecture

- **Module:** `src/game/` (new, self-contained): `ui/`, `map/`, `clues/`, `api client`. Loaded with a dynamic `import()` only when the route opens, so the wallet's first script does not grow (the earlier page-weight work in #446 stays intact).
- **Map engine:** MapLibre GL JS (BSD, no per-load fee) over OpenStreetMap vector tiles from a hosted provider (MapTiler or Stadia, or self-hosted PMTiles on R2 for the nine city extracts, which makes cost flat and predictable). Satellite from Mapbox or MapTiler under their terms with attribution. Leaflet is not needed. Mapbox GL JS is excluded for now because its map-load billing and token terms conflict with open caching.
- **Street level:** Mapillary JS viewer; optional Google embed (decision 2). Where there is no coverage the city shows a curated panorama or photo set from R2, labelled honestly.
- **Authentication:** reuse `_swingsAuth` flow with a game-specific message. Backend issues a 7-day session carrying `player_id`. Guests see intro, previews, rules.
- **API:** one route `?route=game&action=...` folded into `swings-data.ts` (or served by the Cloudflare catch-all) so the 12-function cap holds. Every write goes through server-side validation; the client sends only intents (`start_mission`, `submit_answer`, `request_hint`, `travel`). The server computes score, XP, discovery and rarity.
- **Answer security:** answers stored as salted hashes (argon2 or HMAC with a server secret), with per-player attempt limits and cooldowns. Treasure coordinates and zones encrypted at rest or stored only in a table the public role cannot read; API returns only the zone the player has legitimately unlocked.
- **Rarity engine:** server-side, config-driven (table `treasure_classes` with supply, season, city allocation). Spawn is placed by an admin or a seeded server job; the client never receives future placements. Diamond and the other six high tiers are authored multi-stage chains, not random.
- **Anti-cheat:** per-session rate limits, attempt throttles, impossible-travel checks on simulated movement (travel time is enforced server-side), duplicate-claim unique constraints, a transaction with row lock for first-finder, audit log, and an abuse-report table. Real GPS is never required, so there is no spoofing surface and no trespass risk. All "locations" are virtual discovery zones on the map.
- **Realtime:** start with polling and ETag caching. Move to Supabase Realtime (already in the stack) for leaderboard and first-finder broadcasts only if usage justifies it. Broadcast payloads carry no coordinates.
- **Separation from ACT:** no import of ACT/staking/fee modules, a unit test that greps `src/game/` and the game API for `ACT`, `stake`, `fee`, and a rule that the session scope cannot sign or request transactions.

## 4. Data model (migration `0017_game.sql`, RLS on, no public policies)

`players`, `player_wallets (network, address_norm, unique)`, `player_profiles`, `cities`, `player_cities`, `game_sessions`, `missions`, `clues` (answer hash, never returned), `treasure_classes`, `treasures`, `treasure_locations` (protected), `player_activities` (append-only, indexed `(player_id, created_at)`), `player_missions`, `player_treasures`, `achievements`, `player_achievements`, `prize_claims`, `prize_ledger`, `admin_audit`, `abuse_reports`, `teams`, `team_members`, `competitions`. Foreign keys, unique constraints for one-claim-per-treasure, and a DB check that a verified claim has a verification record. This matches the entities in your brief with the extra tables needed for audit and competitions.

## 5. Milestones and acceptance (in order, each shippable behind a flag)

1. **M1 (this document).** Approve decisions in section 2.
2. **M2 Sidebar and auth.** New item, route, pane, game login, `players` + wallets + profile. Flag `PUBLIC_GAME_ENABLED` defaults off so production is unchanged until you enable it. Accept: EVM and Solana sign-in on dev, replayed signature rejected, existing wallet tests still green.
3. **M3 Cities.** Nine city records and cards, selection, per-city progress, switching never erases progress.
4. **M4 Exploration.** MapLibre map, satellite toggle, Mapillary where covered, simulated movement and flights, per-city transport sets as listed in your brief.
5. **M5 Treasure and clue engine.** Eight classes, rarity config, zones, multi-stage missions, hints, server validation. One fully authored sample chain to prove the engine; the real nine Diamond chains are authored with you after.
6. **M6 Progression.** XP, achievements, inventory, history, stats.
7. **M7 Multiplayer.** Leaderboards, First Finder, daily/weekly, teams.
8. **M8 Admin.** Console, placement tool with exclusion layers (military, airports, water, private), claims, reserve view, audit.
9. **M9 Test and launch.** Security tests, anti-cheat tests, mobile (including the Capacitor apps), map performance, then enable the flag.

Rule from the brief kept: no milestone starts until the previous one meets its criteria.

## 6. Test strategy

Vitest (already used). Unit: login message, nonce single-use, composite identity, rarity engine determinism, answer-hash compare, travel-time enforcement. Property tests (fast-check is installed) for first-finder race and duplicate claim. A static test that the game folder has no ACT or transaction-signing code. Existing `walletNav` and bundle tests extended for the new view. Mobile checked in the built-in browser at 375 px and in the Capacitor shell.

## 7. Realistic running cost (estimates, to be confirmed against current provider price sheets)

| Item | Early (hundreds of players) | Growth (tens of thousands monthly) |
|---|---|---|
| Vector tiles (MapTiler/Stadia or self-hosted PMTiles on R2) | $0-$25 | $100-$500, or about $5-$20 if self-hosted |
| Satellite imagery | $0-$50 | $200-$1,000 depending on provider and caching rights |
| Street imagery | Mapillary free; Google embed is billed per panorama load, set a hard cap | Google can dominate cost, cap it |
| Supabase (Postgres, realtime) | within current plan, likely Pro $25 | $25-$100 |
| API compute | existing Vercel/Cloudflare | may need Vercel Pro ($20) if function cap or duration binds |
| R2 storage and egress | under $5 | $5-$30 |
| Prize reserve | **$9,000 headline, funded separately, not an operating cost** | |

Total operating, excluding prizes: roughly $30-$100/month early, $300-$1,500 at growth. These are my estimates, not quotes.

## 8. Risks

- 12-function Vercel cap (solved by folding into an existing route, or moving the game API to Cloudflare).
- Provider terms for Street View and satellite caching (decision 2).
- Prize and gambling law (decision 1). This is the largest non-technical risk.
- Content scale: nine authentic cities and nine solvable Diamond chains is a large editorial job; the engine is the smaller part.
- Public repo: no secrets, answers or coordinates in git.
- Three-D weight on mobile (decision 3).

## 9. What I will not do without approval

Change the sidebar, add routes or migrations, add map dependencies, edit `_headers`, or enable anything in production.
