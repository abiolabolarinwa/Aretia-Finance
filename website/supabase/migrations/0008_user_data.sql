-- Favourite tokens and swap history that follow a wallet address across devices. A row belongs to an "owner": the
-- address the person proved they control by signing a message, written "solana:<address>" or "evm:<lowercase address>".
-- Written and read only by /api/swings-account with the service role, after it has checked a session token that the
-- same endpoint issued for that owner (row-level security is on and no policy exists, so no other role can touch it).
create table if not exists public.user_favourites (
  owner     text   not null check (length(owner) between 10 and 80),
  chain     text   not null check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche')),
  address   text   not null check (length(address) between 20 and 100),
  symbol    text   not null,
  name      text   not null default '',
  icon      text,
  added_at  bigint not null,
  primary key (owner, chain, address)
);
create table if not exists public.user_trades (
  owner  text   not null check (length(owner) between 10 and 80),
  id     text   not null check (length(id) between 1 and 80),
  at     bigint not null,
  data   jsonb  not null,
  primary key (owner, id)
);
create index if not exists user_trades_owner_at on public.user_trades (owner, at desc);
alter table public.user_favourites enable row level security;
alter table public.user_trades enable row level security;
