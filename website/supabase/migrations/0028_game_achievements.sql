-- Ultimate City Search, milestone 6: the achievements a player has unlocked. The list of achievements and what earns them lives in
-- the server code (src/game/achievements.ts); this table only records that a player has one, once.
-- Safe to run more than once. Written and read only by /api/game with the service role (row-level security on, no policy).
create table if not exists public.game_player_achievements (
  id             uuid   primary key default gen_random_uuid(),
  player_id      uuid   not null references public.game_players (id) on delete restrict,
  achievement_id text   not null check (achievement_id ~ '^[a-z0-9-]{3,40}$'),
  unlocked_at    bigint not null,
  unique (player_id, achievement_id)
);
create index if not exists game_player_achievements_player on public.game_player_achievements (player_id, unlocked_at desc);
alter table public.game_player_achievements enable row level security;
