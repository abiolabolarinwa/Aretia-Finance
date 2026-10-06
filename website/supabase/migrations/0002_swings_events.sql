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
