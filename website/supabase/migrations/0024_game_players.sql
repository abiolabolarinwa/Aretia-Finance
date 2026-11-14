-- Ultimate City Search, milestone 2: players, their wallets, profiles and an append-only activity log.
-- Safe to run more than once. Written and read only by /api/game with the service role (row-level security on, no policy).
-- Independent of ACT: nothing here refers to tokens, staking or fees.

-- The permanent internal identity. The wallet is only how a player proves who they are; it is not the key.
create table if not exists public.game_players (
  id             uuid   primary key default gen_random_uuid(),
  created_at     bigint not null,
  account_status text   not null default 'active' check (account_status in ('active','suspended','closed'))
);

-- network is the wallet family ('evm' or 'solana'); address_norm is lower-case for evm and as-is for solana. One wallet belongs to one
-- player. Linking a second wallet to a player is a later, signed step: accounts are never merged automatically.
create table if not exists public.game_player_wallets (
  id           uuid   primary key default gen_random_uuid(),
  player_id    uuid   not null references public.game_players (id) on delete restrict,
  network      text   not null check (network in ('evm','solana')),
  address_norm text   not null check (length(address_norm) between 20 and 100),
  verified_at  bigint not null,
  is_primary   boolean not null default true,
  unique (network, address_norm)
);
create index if not exists game_player_wallets_player on public.game_player_wallets (player_id);

create table if not exists public.game_player_profiles (
  player_id         uuid    primary key references public.game_players (id) on delete restrict,
  display_name      text    not null default '' check (length(display_name) <= 32),
  avatar            text,
  explorer_level    integer not null default 1 check (explorer_level >= 1),
  total_xp          bigint  not null default 0 check (total_xp >= 0),
  total_discoveries integer not null default 0 check (total_discoveries >= 0),
  missions_completed integer not null default 0 check (missions_completed >= 0),
  last_login_at     bigint
);

-- Append-only: the API only ever inserts. Every row names the player, the wallet and the network it happened under.
create table if not exists public.game_player_activities (
  id             uuid   primary key default gen_random_uuid(),
  player_id      uuid   not null references public.game_players (id) on delete restrict,
  wallet_address text   not null,
  network        text   not null check (network in ('evm','solana')),
  activity_type  text   not null check (length(activity_type) between 1 and 40),
  city_id        text,
  ref_id         text,
  metadata       jsonb  not null default '{}'::jsonb,
  created_at     bigint not null
);
create index if not exists game_player_activities_player_at on public.game_player_activities (player_id, created_at desc);

alter table public.game_players enable row level security;
alter table public.game_player_wallets enable row level security;
alter table public.game_player_profiles enable row level security;
alter table public.game_player_activities enable row level security;
