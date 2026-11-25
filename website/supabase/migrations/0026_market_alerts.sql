-- Market alerts: new launches on a chosen network, large buys of a favourite, and liquidity taken out of a favourite's pool.
-- Read and written only by the site's server with the service role (row-level security is on and there is no policy), after the
-- same wallet sign-in the other alerts use. Until this file is run, the price alerts keep working and the market alerts stay off.

-- What each person chose. Empty or zero = that alert is off.
create table if not exists public.notify_market_prefs (
  owner             text    primary key check (length(owner) between 10 and 80),
  launch_chains     text[]  not null default '{}' check (launch_chains <@ array['solana','ethereum','base','bnb','polygon','robinhood']::text[]),
  launch_min_liq    double precision not null default 0 check (launch_min_liq in (0, 1000, 5000, 10000, 50000)),
  big_buy_usd       double precision not null default 0 check (big_buy_usd in (0, 1000, 5000, 10000, 50000)),
  liq_drop_pct      integer not null default 0 check (liq_drop_pct in (0, 30, 50, 80)),
  updated_at        bigint  not null
);

-- What each person has already been told about (a launch, a buy, a liquidity drop), so nothing is sent twice. `msg` marks the
-- rows that went out as their own message: they count toward the hourly limit. Rows older than two days are removed by the run.
create table if not exists public.notify_market_sent (
  owner  text    not null check (length(owner) between 10 and 80),
  key    text    not null check (length(key) between 3 and 200),
  at     bigint  not null,
  msg    boolean not null default false,
  primary key (owner, key)
);
create index if not exists notify_market_sent_at on public.notify_market_sent (at);
create index if not exists notify_market_sent_msg on public.notify_market_sent (owner, at) where msg;

-- The most liquidity seen in a favourite's pool lately (raw reserves), shared by everyone: a drop is measured from it.
create table if not exists public.notify_pool_marks (
  pool_key      text   primary key check (length(pool_key) between 3 and 140),
  reserve_base  double precision not null check (reserve_base > 0),
  reserve_quote double precision not null check (reserve_quote > 0),
  at            bigint not null
);

alter table public.notify_market_prefs enable row level security;
alter table public.notify_market_sent enable row level security;
alter table public.notify_pool_marks enable row level security;
