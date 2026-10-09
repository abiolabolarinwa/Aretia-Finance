-- Aretia Swings: all database setup in one paste. Run it once in the Supabase SQL Editor.
-- It is the five migration files in order; every statement is safe to run again.

-- ===== migrations\0001_token_registry.sql =====
-- Aretia Token Registry (Aretia Swings). Run in the Supabase SQL editor or with the Supabase CLI.
-- Access is through the service role only, from server functions in website/api/. The browser never
-- talks to these tables: row level security is on and no policy grants anything to anon/authenticated.

create table if not exists public.token_registry (
  key                 text primary key,               -- 'chain:address' (EVM addresses lower-case)
  chain               text   not null check (chain in ('solana','ethereum','bnb','polygon','base')),
  address             text   not null,
  symbol              text   not null,
  name                text   not null default '',
  decimals            int    not null check (decimals between 0 and 36),
  logo                text,
  first_detected_at   bigint not null,                -- ms; when Aretia first saw it
  discovery_source    text   not null,
  created_at_chain    bigint,                         -- ms; on-chain creation, only if known
  first_pool_at       bigint,                         -- ms; first trading pool, only if known
  discovery_status    text   not null check (discovery_status in ('discovered','tradable')),
  liquidity_usd       double precision,
  volume_24h_usd      double precision,
  holder_count        double precision,
  pools               jsonb  not null default '[]',
  metadata            jsonb  not null default '{}',
  verified            boolean not null default false, -- Aretia's curated flag; never set by discovery
  metadata_confidence text   not null check (metadata_confidence in ('onchain','api','unknown')),
  risk                jsonb,
  risk_status         text,
  risk_score          int,
  updated_at          bigint not null,
  unique (chain, address)
);

create index if not exists token_registry_chain_detected on public.token_registry (chain, first_detected_at desc);
create index if not exists token_registry_address on public.token_registry (address);
create index if not exists token_registry_symbol on public.token_registry (lower(symbol));

create table if not exists public.discovery_cursors (
  source     text primary key,
  cursor     text not null,
  updated_at bigint not null
);

alter table public.token_registry enable row level security;
alter table public.discovery_cursors enable row level security;

-- ===== migrations\0002_swings_events.sql =====
-- Anonymous, aggregate Swings events (Aretia Swings analytics). No wallet address, no IP, no amounts,
-- no token identities. Written only by /api/swings-events with the service role.
create table if not exists public.swings_events (
  id        bigint generated always as identity primary key,
  at        bigint not null,                 -- ms, server clock
  name      text   not null check (name in ('quote_failed','routes_found','swap')),
  chain     text   check (chain in ('solana','ethereum','bnb','polygon','base')),
  provider  text,                            -- provider id such as 'jupiter' or '0x'
  status    text   check (status in ('submitted','confirmed','failed','rejected','expired')),
  ms        int,                             -- duration
  count     int                              -- number of routes found
);
create index if not exists swings_events_at on public.swings_events (at desc);
alter table public.swings_events enable row level security;

-- ===== migrations\0003_shadow_events.sql =====
-- Shadow comparison events (Aretia Swings): how Aretia's own route compared with the best aggregator route
-- for the same request. Still anonymous: no wallet, no IP, no amount, no token. `diff_bps` is Aretia's expected
-- output minus the rival's, in basis points of the rival's (negative = Aretia was behind).
alter table public.swings_events add column if not exists rival    text;
alter table public.swings_events add column if not exists diff_bps int check (diff_bps between -10000 and 10000);

alter table public.swings_events drop constraint if exists swings_events_name_check;
alter table public.swings_events add constraint swings_events_name_check check (name in ('quote_failed','routes_found','swap','shadow'));

-- Where Aretia loses, by chain and rival: the question this data exists to answer.
create or replace view public.swings_shadow_summary with (security_invoker = true) as
  select chain, provider as winner, rival,
         count(*)                                  as comparisons,
         round(avg(diff_bps)::numeric, 1)          as avg_diff_bps,
         count(*) filter (where diff_bps < 0)      as aretia_behind,
         count(*) filter (where diff_bps >= 0)     as aretia_level_or_ahead,
         min(diff_bps)                             as worst_diff_bps
  from public.swings_events
  where name = 'shadow'
  group by chain, provider, rival;

-- ===== migrations\0004_more_chains.sql =====
-- Arbitrum, Optimism and Avalanche join the chains Aretia Swings reads. Only the allowed-chain checks change.
alter table public.token_registry drop constraint if exists token_registry_chain_check;
alter table public.token_registry add constraint token_registry_chain_check
  check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche'));

alter table public.swings_events drop constraint if exists swings_events_chain_check;
alter table public.swings_events add constraint swings_events_chain_check
  check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche'));

-- ===== migrations\0005_swings_records.sql =====
-- Optional recovery copies of Swings executions and plans. Opt-in: the page sends a record only if the user turns
-- "keep a recovery copy" on. A record holds public information (states, quotes, transaction hashes, the two wallet
-- addresses of the move) and never a key or a secret. Access is by the record's long random id, which only the user
-- holds; there is no listing. Written and read only by /api/swings-records with the service role (row-level security is
-- on and no policy exists, so no other role can touch it).
create table if not exists public.swings_records (
  id          text   primary key check (id ~ '^[a-z0-9_]{24,72}$'),
  kind        text   not null check (kind in ('settlement','plan')),
  version     int    not null check (version >= 1),
  state       text   not null,
  body        jsonb  not null,
  created_at  bigint not null,   -- ms, server clock
  updated_at  bigint not null
);
create index if not exists swings_records_updated on public.swings_records (updated_at desc);
alter table public.swings_records enable row level security;

-- ===== migrations\0006_token_market.sql =====
-- Aretia's own copy of each token's market numbers (price, value, trades, volume, changes), written by the discovery job.
-- Find Tokens reads this instead of asking DexScreener from every visitor's browser. Safe to run more than once.
alter table public.token_registry add column if not exists market jsonb;
alter table public.token_registry add column if not exists market_at bigint;
create index if not exists token_registry_market_at on public.token_registry (chain, market_at asc nulls first);

-- ===== migrations\0007_pool_ticks.sql =====
-- Aretia's own price history. The discovery job records a price "tick" for every pool it refreshes, and for every pool a
-- visitor has opened a chart for (those are tracked for a day after the last view). Candles are built from the ticks on
-- request. History starts from the first tick; nothing older is invented. Written and read only with the service role.
create table if not exists public.pool_ticks (
  chain   text    not null check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche')),
  pool    text    not null,
  ts      bigint  not null,          -- ms
  price   double precision not null check (price > 0),
  liq     double precision,
  vol24   double precision,
  primary key (chain, pool, ts)
);
create table if not exists public.tracked_pools (
  chain      text   not null,
  pool       text   not null,
  last_seen  bigint not null,        -- ms of the last chart view
  primary key (chain, pool)
);
create index if not exists tracked_pools_seen on public.tracked_pools (last_seen desc);
alter table public.pool_ticks enable row level security;
alter table public.tracked_pools enable row level security;
