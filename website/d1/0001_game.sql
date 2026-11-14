-- Ultimate City Search on Cloudflare D1 (SQLite). One file, safe to run more than once.
--   wrangler d1 create aretia-game
--   wrangler d1 execute aretia-game --remote --file=d1/0001_game.sql
-- D1 is reachable only from the Cloudflare Worker that serves /api/game, so there is no public access to guard. Timestamps are
-- milliseconds since 1970. JSON columns hold text. True/false columns hold 0/1. Every id the code makes itself is a UUID; the ones
-- the database makes use the default below, which writes a random version-4 UUID.

-- ---- sign-in (game only) -----------------------------------------------------------------------------------------------
create table if not exists auth_nonces (
  nonce      text    primary key,
  created_at integer not null,
  expires_at integer not null,
  used_at    integer,
  owner      text
);
create index if not exists auth_nonces_expires on auth_nonces (expires_at);

create table if not exists account_sessions (
  owner      text    primary key,
  version    integer not null default 0 check (version >= 0),
  updated_at integer not null default 0
);

-- ---- players -----------------------------------------------------------------------------------------------------------
create table if not exists game_players (
  id             text    primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  created_at     integer not null,
  account_status text    not null default 'active' check (account_status in ('active','suspended','closed'))
);

create table if not exists game_player_wallets (
  id           text    primary key default (lower(hex(randomblob(16)))),
  player_id    text    not null references game_players (id),
  network      text    not null check (network in ('evm','solana')),
  address_norm text    not null,
  verified_at  integer not null,
  is_primary   integer not null default 1,
  unique (network, address_norm)
);
create index if not exists game_player_wallets_player on game_player_wallets (player_id);

create table if not exists game_player_profiles (
  player_id          text    primary key references game_players (id),
  display_name       text    not null default '' check (length(display_name) <= 32),
  avatar             text,
  explorer_level     integer not null default 1 check (explorer_level >= 1),
  total_xp           integer not null default 0 check (total_xp >= 0),
  total_discoveries  integer not null default 0 check (total_discoveries >= 0),
  missions_completed integer not null default 0 check (missions_completed >= 0),
  last_login_at      integer,
  selected_city      text    references game_cities (id),
  flight_from        text    references game_cities (id),
  flight_to          text    references game_cities (id),
  flight_departed_at integer,
  flight_arrives_at  integer
);

create table if not exists game_player_activities (
  id             text    primary key default (lower(hex(randomblob(16)))),
  player_id      text    not null references game_players (id),
  wallet_address text    not null,
  network        text    not null check (network in ('evm','solana')),
  activity_type  text    not null check (length(activity_type) between 1 and 40),
  city_id        text,
  ref_id         text,
  metadata       text    not null default '{}',
  created_at     integer not null
);
create index if not exists game_player_activities_player_at on game_player_activities (player_id, created_at desc);
create index if not exists game_player_activities_type_at on game_player_activities (activity_type, created_at);

-- ---- cities ------------------------------------------------------------------------------------------------------------
-- The catalogue lives here, so an administrator can add a city without a release. bounds is [west, south, east, north].
create table if not exists game_cities (
  id           text    primary key check (length(id) between 2 and 31),
  city_name    text    not null,
  country      text    not null,
  bounds       text    not null,
  center_lng   real    not null,
  center_lat   real    not null,
  blurb        text    not null default '',
  transport    text    not null default '["walk","run","taxi","car","bus","flight"]',
  tint         text    not null default '["#1b1f3a","#c9a227"]',
  image_url    text,
  image_credit text,
  landmarks    text    not null default '[]',
  scene        text    not null default 'skyline',
  status       text    not null default 'active' check (status in ('active','inactive','coming_soon')),
  sort_order   integer not null default 100,
  created_at   integer not null default 0
);

insert or ignore into game_cities (id, city_name, country, bounds, center_lng, center_lat, blurb, transport, tint, sort_order) values
  ('lagos',     'Lagos',     'Nigeria',              '[3.0,6.3,3.75,6.75]',         3.3792,   6.5244,  'A lagoon megacity of islands, bridges and markets, where Victoria Island, the Mainland and the Atlantic coast all meet.', '["walk","run","taxi","car","bus","flight","ferry"]', '["#0b3d2e","#c9a227"]', 10),
  ('new-york',  'New York',  'United States',        '[-74.26,40.49,-73.7,40.92]',  -74.006,  40.7128, 'A grid of towers and boroughs on a harbour, stitched together by the subway, bridges and ferries.', '["walk","run","taxi","car","bus","flight","metro","train","ferry"]', '["#1b1f3a","#8a8fb8"]', 20),
  ('nairobi',   'Nairobi',   'Kenya',                '[36.65,-1.45,37.1,-1.15]',    36.8219,  -1.2921, 'A highland capital on the edge of a national park, with a busy centre, green suburbs and the Rift close by.', '["walk","run","taxi","car","bus","flight"]', '["#2c3b1a","#d9a441"]', 30),
  ('hong-kong', 'Hong Kong', 'Hong Kong',            '[113.83,22.15,114.45,22.57]', 114.1694, 22.3193, 'Steep hills, a deep harbour and one of the densest skylines on earth, linked by the MTR, trams and ferries.', '["walk","run","taxi","car","bus","flight","metro","ferry"]', '["#3a1022","#e0526e"]', 40),
  ('london',    'London',    'United Kingdom',       '[-0.51,51.28,0.33,51.7]',     -0.1276,  51.5072, 'Two thousand years on a river: Roman walls, royal parks, the City and the Underground running beneath it all.', '["walk","run","taxi","car","bus","flight","metro","train","ferry"]', '["#182a44","#b6384a"]', 50),
  ('dubai',     'Dubai',     'United Arab Emirates', '[54.9,24.75,55.6,25.4]',      55.2708,  25.2048, 'A creek-side trading port turned glass skyline, with the desert at its back and the Gulf at its front.', '["walk","run","taxi","car","bus","flight","metro","ferry"]', '["#3b2a12","#e8b94a"]', 60),
  ('paris',     'Paris',     'France',               '[2.22,48.8,2.47,48.92]',      2.3522,   48.8566, 'Boulevards, bridges over the Seine and a Métro that reaches almost every corner of a compact, walkable city.', '["walk","run","taxi","car","bus","flight","metro","train","ferry"]', '["#232a52","#d6c58a"]', 70),
  ('miami',     'Miami',     'United States',        '[-80.45,25.55,-80.1,25.95]',  -80.1918, 25.7617, 'Art deco beaches, causeways over Biscayne Bay, and a downtown that faces the water on both sides.', '["walk","run","taxi","car","bus","flight","train","ferry"]', '["#0f4c5c","#ff7a59"]', 80),
  ('nicosia',   'Nicosia',   'Cyprus',               '[33.28,35.1,33.47,35.25]',    33.3823,  35.1856, 'A walled Venetian old town at the heart of the island, a capital that is still divided by a green line.', '["walk","run","taxi","car","bus","flight"]', '["#3a2a1d","#c8a06a"]', 90);

create table if not exists game_player_cities (
  id                 text    primary key default (lower(hex(randomblob(16)))),
  player_id          text    not null references game_players (id),
  city_id            text    not null references game_cities (id),
  first_visit_at     integer not null,
  last_visit_at      integer not null,
  city_xp            integer not null default 0 check (city_xp >= 0),
  discoveries        integer not null default 0 check (discoveries >= 0),
  completed_missions integer not null default 0 check (completed_missions >= 0),
  exploration_status text    not null default 'exploring' check (exploration_status in ('exploring','completed')),
  pos_lng            real,
  pos_lat            real,
  travel_mode        text,
  travel_from_lng    real,
  travel_from_lat    real,
  travel_to_lng      real,
  travel_to_lat      real,
  travel_departed_at integer,
  travel_arrives_at  integer,
  unique (player_id, city_id)
);
create index if not exists game_player_cities_player on game_player_cities (player_id, last_visit_at desc);

create table if not exists game_journeys (
  id          text    primary key default (lower(hex(randomblob(16)))),
  player_id   text    not null references game_players (id),
  kind        text    not null check (kind in ('local','flight')),
  mode        text    not null,
  from_city   text    not null references game_cities (id),
  to_city     text    not null references game_cities (id),
  distance_km real    not null check (distance_km >= 0),
  departed_at integer not null,
  arrives_at  integer not null
);
create index if not exists game_journeys_player on game_journeys (player_id, departed_at desc);

-- ---- treasures, missions, clues ----------------------------------------------------------------------------------------
create table if not exists game_treasure_classes (
  id            text    primary key,
  coin_name     text    not null,
  usd_value     real    not null check (usd_value > 0),
  rarity_rank   integer not null unique check (rarity_rank between 1 and 8),
  rarity_weight integer not null check (rarity_weight >= 0)
);
insert or ignore into game_treasure_classes (id, coin_name, usd_value, rarity_rank, rarity_weight) values
  ('diamond', 'Diamond Coin', 1000, 1, 1), ('golden', 'Golden Coin', 587, 2, 2), ('lithium', 'Lithium Coin', 212, 3, 5),
  ('silver', 'Silver Coin', 65, 4, 10), ('cerium', 'Cerium Coin', 37, 5, 20), ('samarium', 'Samarium Coin', 1, 6, 50),
  ('thulium', 'Thulium Coin', 0.10, 7, 200), ('lutetium', 'Lutetium Coin', 0.0027, 8, 700);

create table if not exists game_treasures (
  id         text    primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  city_id    text    not null references game_cities (id),
  class_id   text    not null references game_treasure_classes (id),
  season     text    not null default 'launch',
  status     text    not null default 'hidden' check (status in ('hidden','found','withdrawn')),
  found_by   text    references game_players (id),
  found_at   integer,
  created_at integer not null default 0
);
-- At most one live Diamond Treasure per city: nine in all.
create unique index if not exists game_one_diamond_per_city on game_treasures (city_id) where class_id = 'diamond' and status <> 'withdrawn';
create index if not exists game_treasures_city on game_treasures (city_id, status);

create table if not exists game_treasure_locations (
  treasure_id text primary key references game_treasures (id) on delete cascade,
  lng         real not null,
  lat         real not null,
  radius_m    integer not null default 60 check (radius_m between 10 and 500)
);

create table if not exists game_missions (
  id          text    primary key check (length(id) between 3 and 61),
  city_id     text    not null references game_cities (id),
  title       text    not null check (length(title) between 1 and 120),
  description text    not null default '',
  difficulty  text    not null check (difficulty in ('beginner','intermediate','advanced','expert','legendary')),
  kind        text    not null default 'long' check (kind in ('daily','weekly','long','event','team')),
  status      text    not null default 'draft' check (status in ('draft','active','closed')),
  opens_at    integer,
  closes_at   integer,
  xp_reward   integer not null default 100 check (xp_reward >= 0),
  treasure_id text    references game_treasures (id),
  template_id text,
  window_key  text
);
create index if not exists game_missions_city on game_missions (city_id, status);
create unique index if not exists game_missions_window on game_missions (template_id, city_id, window_key) where template_id is not null;

create table if not exists game_clues (
  id          text    primary key,
  mission_id  text    not null references game_missions (id) on delete cascade,
  seq         integer not null check (seq >= 1),
  clue_type   text    not null check (clue_type in ('riddle','historical','geographical','architectural','numerical','cryptographic','visual','pattern','observation','trail','mystery')),
  content     text    not null check (length(content) between 1 and 2000),
  answer_hash text    not null,
  hints       text    not null default '[]',
  unique (mission_id, seq)
);

create table if not exists game_player_missions (
  id           text    primary key default (lower(hex(randomblob(16)))),
  player_id    text    not null references game_players (id),
  mission_id   text    not null references game_missions (id),
  status       text    not null default 'active' check (status in ('active','completed','abandoned')),
  stage        integer not null default 1 check (stage >= 1),
  hints_used   integer not null default 0 check (hints_used >= 0),
  hints_total  integer not null default 0 check (hints_total >= 0),
  score        integer not null default 0 check (score >= 0),
  started_at   integer not null,
  completed_at integer,
  unique (player_id, mission_id)
);

create table if not exists game_attempts (
  id         text    primary key default (lower(hex(randomblob(16)))),
  player_id  text    not null references game_players (id),
  mission_id text    not null references game_missions (id),
  seq        integer not null,
  correct    integer not null,
  at         integer not null
);
create index if not exists game_attempts_player_mission on game_attempts (player_id, mission_id, at desc);
create index if not exists game_attempts_at on game_attempts (at);

create table if not exists game_player_treasures (
  id                  text    primary key default (lower(hex(randomblob(16)))),
  player_id           text    not null references game_players (id),
  treasure_id         text    not null references game_treasures (id),
  discovery_status    text    not null default 'unlocked' check (discovery_status in ('unlocked','discovered')),
  verification_status text    not null default 'none' check (verification_status in ('none','pending','verified','rejected')),
  claim_status        text    not null default 'none' check (claim_status in ('none','pending','approved','paid','rejected')),
  unlocked_at         integer not null,
  discovered_at       integer,
  unique (player_id, treasure_id)
);

-- ---- progression, boards, teams ----------------------------------------------------------------------------------------
create table if not exists game_player_achievements (
  id             text    primary key default (lower(hex(randomblob(16)))),
  player_id      text    not null references game_players (id),
  achievement_id text    not null,
  unlocked_at    integer not null,
  unique (player_id, achievement_id)
);
-- First Finder: one holder, ever, of "ff-<city>-<class>".
create unique index if not exists game_one_first_finder on game_player_achievements (achievement_id) where achievement_id like 'ff-%';

-- One row for every award of XP, written in the same batch as the totals.
create table if not exists game_xp_events (
  id        integer primary key autoincrement,
  player_id text    not null references game_players (id),
  city_id   text,
  xp        integer not null check (xp > 0),
  at        integer not null
);
create index if not exists game_xp_events_at on game_xp_events (at);
create index if not exists game_xp_events_player_at on game_xp_events (player_id, at);
create index if not exists game_xp_events_city_at on game_xp_events (city_id, at);

create table if not exists game_teams (
  id         text    primary key default (lower(hex(randomblob(16)))),
  name       text    not null check (length(name) between 2 and 24),
  join_code  text    not null unique,
  created_by text    not null references game_players (id),
  created_at integer not null
);
create unique index if not exists game_teams_name_lower on game_teams (lower(name));
create table if not exists game_team_members (
  team_id   text    not null references game_teams (id) on delete cascade,
  player_id text    not null references game_players (id),
  role      text    not null default 'member' check (role in ('owner','member')),
  joined_at integer not null,
  primary key (team_id, player_id),
  unique (player_id)
);

-- ---- administration ----------------------------------------------------------------------------------------------------
create table if not exists game_prize_claims (
  id                   text    primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  player_id            text    not null references game_players (id),
  treasure_id          text    not null unique references game_treasures (id),
  amount_usd           real    not null check (amount_usd > 0),
  claim_status         text    not null default 'pending' check (claim_status in ('pending','approved','rejected','paid')),
  verification_details text    not null default '' check (length(verification_details) <= 2000),
  payment_reference    text    check (payment_reference is null or length(payment_reference) <= 200),
  created_at           integer not null,
  decided_at           integer,
  paid_at              integer
);
create index if not exists game_prize_claims_status on game_prize_claims (claim_status, created_at);

create table if not exists game_reserve_entries (
  id         integer primary key autoincrement,
  amount_usd real    not null check (amount_usd <> 0),
  note       text    not null default '' check (length(note) <= 300),
  admin      text    not null,
  at         integer not null
);

create table if not exists game_announcements (
  id         text    primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  title      text    not null check (length(title) between 1 and 120),
  body       text    not null default '' check (length(body) <= 2000),
  created_at integer not null,
  expires_at integer,
  active     integer not null default 1
);

create table if not exists game_abuse_reports (
  id          text    primary key default (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  reporter    text    not null references game_players (id),
  kind        text    not null check (kind in ('cheating','exploit','wrong-clue','harassment','other')),
  details     text    not null default '' check (length(details) <= 2000),
  status      text    not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at  integer not null,
  resolved_at integer
);
create index if not exists game_abuse_reports_status on game_abuse_reports (status, created_at);

create table if not exists game_admin_audit (
  id      integer primary key autoincrement,
  admin   text    not null,
  action  text    not null check (length(action) between 1 and 60),
  target  text    not null default '',
  details text    not null default '{}',
  at      integer not null
);
create index if not exists game_admin_audit_at on game_admin_audit (at desc);
