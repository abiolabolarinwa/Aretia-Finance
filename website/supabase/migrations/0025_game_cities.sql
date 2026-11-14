-- Ultimate City Search, milestone 3: the cities, each player's progress in each city, and the city a player last chose.
-- Safe to run more than once. Written and read only by /api/game with the service role (row-level security on, no policy).

create table if not exists public.game_cities (
  id         text   primary key check (id ~ '^[a-z][a-z-]{1,30}$'),
  city_name  text   not null,
  country    text   not null,
  bounds     jsonb  not null,
  status     text   not null default 'active' check (status in ('active','inactive','coming_soon')),
  created_at bigint not null default 0
);

insert into public.game_cities (id, city_name, country, bounds, status) values
  ('lagos',     'Lagos',     'Nigeria',              '[3.0,6.3,3.75,6.75]',        'active'),
  ('new-york',  'New York',  'United States',        '[-74.26,40.49,-73.7,40.92]', 'active'),
  ('nairobi',   'Nairobi',   'Kenya',                '[36.65,-1.45,37.1,-1.15]',   'active'),
  ('hong-kong', 'Hong Kong', 'Hong Kong',            '[113.83,22.15,114.45,22.57]','active'),
  ('london',    'London',    'United Kingdom',       '[-0.51,51.28,0.33,51.7]',    'active'),
  ('dubai',     'Dubai',     'United Arab Emirates', '[54.9,24.75,55.6,25.4]',     'active'),
  ('paris',     'Paris',     'France',               '[2.22,48.8,2.47,48.92]',     'active'),
  ('miami',     'Miami',     'United States',        '[-80.45,25.55,-80.1,25.95]', 'active'),
  ('nicosia',   'Nicosia',   'Cyprus',               '[33.28,35.1,33.47,35.25]',   'active')
on conflict (id) do nothing;

-- One row per player and city, created the first time the player chooses the city. Switching city never deletes or resets it.
create table if not exists public.game_player_cities (
  id                 uuid    primary key default gen_random_uuid(),
  player_id          uuid    not null references public.game_players (id) on delete restrict,
  city_id            text    not null references public.game_cities (id) on delete restrict,
  first_visit_at     bigint  not null,
  last_visit_at      bigint  not null,
  city_xp            bigint  not null default 0 check (city_xp >= 0),
  discoveries        integer not null default 0 check (discoveries >= 0),
  completed_missions integer not null default 0 check (completed_missions >= 0),
  exploration_status text    not null default 'exploring' check (exploration_status in ('exploring','completed')),
  unique (player_id, city_id)
);
create index if not exists game_player_cities_player on public.game_player_cities (player_id, last_visit_at desc);

alter table public.game_player_profiles add column if not exists selected_city text references public.game_cities (id);

alter table public.game_cities enable row level security;
alter table public.game_player_cities enable row level security;
