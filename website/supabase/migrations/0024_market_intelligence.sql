-- Aretia market intelligence: a stored snapshot, every few minutes, of what the market mood, rising/falling and busiest-venues calculations read
-- (src/swings/market/intel/). The volume, momentum and stability parts of the mood index and the venue growth figure need history, and a stored
-- snapshot lets any shown figure be worked out again. Written by the indexer worker and read by the site with the service role only: row level
-- security is on and no policy grants anything to anon/authenticated. Safe to run more than once.

create table if not exists public.mi_market_snapshots (
  scope      text   not null,                     -- 'all' or one network ('solana', 'bnb', ...)
  at         bigint not null,                     -- ms, when the pools were read
  v          smallint not null default 1,         -- methodology version; a row is only read with the formulas it was made with
  eligible   integer not null default 0,          -- tokens that counted for the 24-hour return
  r1h        double precision,                    -- liquidity-weighted log return of the market over the last hour (null: too few tokens)
  r24h       double precision,
  liquidity  double precision not null default 0, -- total liquidity of the pools that counted for venue volume, USD
  volume24h  double precision not null default 0, -- their total 24-hour volume, USD
  depth      double precision,                    -- depth score 0 to 100
  arf        jsonb  not null default '{}'::jsonb, -- rising / falling / neutral counts per window
  venues     jsonb  not null default '[]'::jsonb, -- per venue: volume24h, swaps, pools
  primary key (scope, at)
);
create index if not exists mi_market_snapshots_at on public.mi_market_snapshots (at);

alter table public.mi_market_snapshots enable row level security;
