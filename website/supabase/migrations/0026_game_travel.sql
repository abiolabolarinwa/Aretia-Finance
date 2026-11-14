-- Ultimate City Search, milestone 4: where a player is inside a city, the journey in progress, flights between cities, and a journey log.
-- Safe to run more than once. Written and read only by /api/game with the service role (row-level security on, no policy).

-- Position inside a city, and at most one local journey at a time. The server fixes the arrival time from the distance and the
-- transport, and refuses a new journey until it has passed.
alter table public.game_player_cities add column if not exists pos_lng double precision;
alter table public.game_player_cities add column if not exists pos_lat double precision;
alter table public.game_player_cities add column if not exists travel_mode text;
alter table public.game_player_cities add column if not exists travel_from_lng double precision;
alter table public.game_player_cities add column if not exists travel_from_lat double precision;
alter table public.game_player_cities add column if not exists travel_to_lng double precision;
alter table public.game_player_cities add column if not exists travel_to_lat double precision;
alter table public.game_player_cities add column if not exists travel_departed_at bigint;
alter table public.game_player_cities add column if not exists travel_arrives_at bigint;

-- A flight in progress between two cities (one at a time per player). It is finished the next time the player's state is read after
-- arrival: the destination becomes the selected city.
alter table public.game_player_profiles add column if not exists flight_from text references public.game_cities (id);
alter table public.game_player_profiles add column if not exists flight_to text references public.game_cities (id);
alter table public.game_player_profiles add column if not exists flight_departed_at bigint;
alter table public.game_player_profiles add column if not exists flight_arrives_at bigint;

-- Append-only record of every journey started.
create table if not exists public.game_journeys (
  id           uuid   primary key default gen_random_uuid(),
  player_id    uuid   not null references public.game_players (id) on delete restrict,
  kind         text   not null check (kind in ('local','flight')),
  mode         text   not null,
  from_city    text   not null references public.game_cities (id),
  to_city      text   not null references public.game_cities (id),
  distance_km  double precision not null check (distance_km >= 0),
  departed_at  bigint not null,
  arrives_at   bigint not null
);
create index if not exists game_journeys_player on public.game_journeys (player_id, departed_at desc);
alter table public.game_journeys enable row level security;
