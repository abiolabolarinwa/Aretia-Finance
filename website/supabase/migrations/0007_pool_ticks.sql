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
