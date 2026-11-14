-- Ultimate City Search, milestone 5: treasure classes, missions and clues, treasures and their protected locations, and what each
-- player has done with them. Safe to run more than once. Written and read only by /api/game with the service role
-- (row-level security on, no policy). Answers are stored only as keyed hashes and locations only in game_treasure_locations,
-- which no endpoint returns except the zone a player has unlocked by solving the final clue.

-- The eight treasure classes. USD values are game prize denominations, not market prices and not a promise of cash.
create table if not exists public.game_treasure_classes (
  id            text    primary key check (id ~ '^[a-z]{3,20}$'),
  coin_name     text    not null,
  usd_value     numeric not null check (usd_value > 0),
  rarity_rank   integer not null unique check (rarity_rank between 1 and 8),
  rarity_weight integer not null check (rarity_weight >= 0)
);
insert into public.game_treasure_classes (id, coin_name, usd_value, rarity_rank, rarity_weight) values
  ('diamond',   'Diamond Coin',   1000,    1, 1),
  ('golden',    'Golden Coin',    587,     2, 2),
  ('lithium',   'Lithium Coin',   212,     3, 5),
  ('silver',    'Silver Coin',    65,      4, 10),
  ('cerium',    'Cerium Coin',    37,      5, 20),
  ('samarium',  'Samarium Coin',  1,       6, 50),
  ('thulium',   'Thulium Coin',   0.10,    7, 200),
  ('lutetium',  'Lutetium Coin',  0.0027,  8, 700)
on conflict (id) do nothing;

create table if not exists public.game_missions (
  id          text    primary key check (id ~ '^[a-z0-9][a-z0-9-]{2,60}$'),
  city_id     text    not null references public.game_cities (id),
  title       text    not null check (length(title) between 1 and 120),
  description text    not null default '',
  difficulty  text    not null check (difficulty in ('beginner','intermediate','advanced','expert','legendary')),
  kind        text    not null default 'long' check (kind in ('daily','weekly','long','event')),
  status      text    not null default 'draft' check (status in ('draft','active','closed')),
  opens_at    bigint,
  closes_at   bigint,
  xp_reward   integer not null default 100 check (xp_reward >= 0),
  treasure_id uuid
);
create index if not exists game_missions_city on public.game_missions (city_id, status);

-- One row per step of a mission. answer_hash is a keyed hash (HMAC) of the normalised answer; hints go from gentle to revealing.
create table if not exists public.game_clues (
  id          uuid    primary key default gen_random_uuid(),
  mission_id  text    not null references public.game_missions (id) on delete cascade,
  seq         integer not null check (seq >= 1),
  clue_type   text    not null check (clue_type in ('riddle','historical','geographical','architectural','numerical','cryptographic','visual','pattern','observation','trail','mystery')),
  content     text    not null check (length(content) between 1 and 2000),
  answer_hash text    not null check (answer_hash ~ '^[0-9a-f]{64}$'),
  hints       jsonb   not null default '[]'::jsonb,
  unique (mission_id, seq)
);

-- A treasure is a coin of some class placed in a city. status 'hidden' becomes 'found' once, atomically, for the first verified finder.
create table if not exists public.game_treasures (
  id        uuid        primary key default gen_random_uuid(),
  city_id   text        not null references public.game_cities (id),
  class_id  text        not null references public.game_treasure_classes (id),
  season    text        not null default 'launch',
  status    text        not null default 'hidden' check (status in ('hidden','found','withdrawn')),
  found_by  uuid        references public.game_players (id),
  found_at  bigint,
  created_at bigint     not null default 0
);
-- At most one live Diamond Treasure per city: nine in all.
create unique index if not exists game_one_diamond_per_city on public.game_treasures (city_id) where class_id = 'diamond' and status <> 'withdrawn';
create index if not exists game_treasures_city on public.game_treasures (city_id, status);
alter table public.game_missions drop constraint if exists game_missions_treasure_fk;
alter table public.game_missions add constraint game_missions_treasure_fk foreign key (treasure_id) references public.game_treasures (id);

-- Where a treasure is: a circle in the city. Never returned except to a player who has unlocked it.
create table if not exists public.game_treasure_locations (
  treasure_id uuid primary key references public.game_treasures (id) on delete cascade,
  lng         double precision not null,
  lat         double precision not null,
  radius_m    integer not null default 60 check (radius_m between 10 and 500)
);

create table if not exists public.game_player_missions (
  id           uuid    primary key default gen_random_uuid(),
  player_id    uuid    not null references public.game_players (id) on delete restrict,
  mission_id   text    not null references public.game_missions (id),
  status       text    not null default 'active' check (status in ('active','completed','abandoned')),
  stage        integer not null default 1 check (stage >= 1),
  hints_used   integer not null default 0 check (hints_used >= 0),
  hints_total  integer not null default 0 check (hints_total >= 0),
  score        integer not null default 0 check (score >= 0),
  started_at   bigint  not null,
  completed_at bigint,
  unique (player_id, mission_id)
);

-- Every answer given, right or wrong (append-only). The wrong ones are what the attempt limit counts.
create table if not exists public.game_attempts (
  id         uuid    primary key default gen_random_uuid(),
  player_id  uuid    not null references public.game_players (id) on delete restrict,
  mission_id text    not null references public.game_missions (id),
  seq        integer not null,
  correct    boolean not null,
  at         bigint  not null
);
create index if not exists game_attempts_player_mission on public.game_attempts (player_id, mission_id, at desc);

-- A treasure a player has unlocked (solved the trail) and, once they reach it, discovered. A cash claim is a later, separate step.
create table if not exists public.game_player_treasures (
  id                  uuid   primary key default gen_random_uuid(),
  player_id           uuid   not null references public.game_players (id) on delete restrict,
  treasure_id         uuid   not null references public.game_treasures (id),
  discovery_status    text   not null default 'unlocked' check (discovery_status in ('unlocked','discovered')),
  verification_status text   not null default 'none' check (verification_status in ('none','pending','verified','rejected')),
  claim_status        text   not null default 'none' check (claim_status in ('none','pending','approved','paid','rejected')),
  unlocked_at         bigint not null,
  discovered_at       bigint,
  unique (player_id, treasure_id)
);

-- Adds to a player's totals in one statement, so two mission completions at once never lose XP.
create or replace function public.game_award_xp(p_player uuid, p_city text, p_xp bigint, p_discoveries integer, p_missions integer)
returns void
language sql
security definer
set search_path = public
as $$
  update public.game_player_profiles
     set total_xp = total_xp + p_xp,
         total_discoveries = total_discoveries + p_discoveries,
         missions_completed = missions_completed + p_missions,
         explorer_level = floor(sqrt((total_xp + p_xp) / 100.0))::integer + 1
   where player_id = p_player;
  update public.game_player_cities
     set city_xp = city_xp + p_xp,
         discoveries = discoveries + p_discoveries,
         completed_missions = completed_missions + p_missions
   where player_id = p_player and city_id = p_city;
$$;
revoke all on function public.game_award_xp(uuid, text, bigint, integer, integer) from public, anon, authenticated;
grant execute on function public.game_award_xp(uuid, text, bigint, integer, integer) to service_role;

alter table public.game_treasure_classes enable row level security;
alter table public.game_missions enable row level security;
alter table public.game_clues enable row level security;
alter table public.game_treasures enable row level security;
alter table public.game_treasure_locations enable row level security;
alter table public.game_player_missions enable row level security;
alter table public.game_attempts enable row level security;
alter table public.game_player_treasures enable row level security;
