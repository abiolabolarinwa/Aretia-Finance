-- Ultimate City Search, milestone 7: an XP ledger (so boards can be daily, weekly, monthly and per city), the leaderboard and rank
-- functions, teams, and the one-first-finder-per-treasure-class rule. Safe to run more than once. Written and read only by /api/game
-- with the service role (row-level security on, no policy). Nothing here holds a wallet address or a treasure location.

-- One row for every award of XP, written by game_award_xp in the same statement as the totals, so the two never disagree.
create table if not exists public.game_xp_events (
  id        bigint  generated always as identity primary key,
  player_id uuid    not null references public.game_players (id) on delete restrict,
  city_id   text,
  xp        bigint  not null check (xp > 0),
  at        bigint  not null
);
create index if not exists game_xp_events_at on public.game_xp_events (at);
create index if not exists game_xp_events_player_at on public.game_xp_events (player_id, at);
create index if not exists game_xp_events_city_at on public.game_xp_events (city_id, at);

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
  insert into public.game_xp_events (player_id, city_id, xp, at)
  select p_player, p_city, p_xp, (extract(epoch from now()) * 1000)::bigint where p_xp > 0;
$$;
revoke all on function public.game_award_xp(uuid, text, bigint, integer, integer) from public, anon, authenticated;
grant execute on function public.game_award_xp(uuid, text, bigint, integer, integer) to service_role;

-- The top players for a city (or all, when p_city is null) since a time. Returns a display name, never a wallet.
create or replace function public.game_leaderboard(p_city text, p_since bigint, p_limit integer)
returns table (player_id uuid, display_name text, xp bigint, rank bigint)
language sql
stable
security definer
set search_path = public
as $$
  select e.player_id,
         coalesce(nullif(p.display_name, ''), 'Explorer ' || substr(e.player_id::text, 1, 4)) as display_name,
         sum(e.xp)::bigint as xp,
         rank() over (order by sum(e.xp) desc) as rank
    from public.game_xp_events e
    join public.game_player_profiles p on p.player_id = e.player_id
   where e.at >= p_since and (p_city is null or e.city_id = p_city)
   group by e.player_id, p.display_name
   order by xp desc, e.player_id
   limit least(greatest(p_limit, 1), 100);
$$;
revoke all on function public.game_leaderboard(text, bigint, integer) from public, anon, authenticated;
grant execute on function public.game_leaderboard(text, bigint, integer) to service_role;

-- One player's rank on the same board (null when they have no XP in the window).
create or replace function public.game_player_rank(p_player uuid, p_city text, p_since bigint)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select sum(xp) as xp from public.game_xp_events
     where player_id = p_player and at >= p_since and (p_city is null or city_id = p_city)
  )
  select case when mine.xp is null then null
              else (select count(*) + 1 from (
                      select sum(xp) as s from public.game_xp_events
                       where at >= p_since and (p_city is null or city_id = p_city)
                       group by player_id having sum(xp) > mine.xp) t)
         end
    from mine;
$$;
revoke all on function public.game_player_rank(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.game_player_rank(uuid, text, bigint) to service_role;

-- Teams. A player is in at most one team. The join code is shown only to members.
create table if not exists public.game_teams (
  id         uuid   primary key default gen_random_uuid(),
  name       text   not null check (length(name) between 2 and 24),
  join_code  text   not null unique check (join_code ~ '^[0-9A-F]{8}$'),
  created_by uuid   not null references public.game_players (id),
  created_at bigint not null
);
create unique index if not exists game_teams_name_lower on public.game_teams (lower(name));
create table if not exists public.game_team_members (
  team_id   uuid   not null references public.game_teams (id) on delete cascade,
  player_id uuid   not null references public.game_players (id) on delete restrict,
  role      text   not null default 'member' check (role in ('owner','member')),
  joined_at bigint not null,
  primary key (team_id, player_id),
  unique (player_id)
);

-- Teams ranked by the XP their current members earned since a time.
create or replace function public.game_team_board(p_since bigint, p_limit integer)
returns table (team_id uuid, name text, xp bigint, members bigint, rank bigint)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.name, coalesce(sum(e.xp), 0)::bigint as xp, count(distinct m.player_id) as members,
         rank() over (order by coalesce(sum(e.xp), 0) desc)
    from public.game_teams t
    join public.game_team_members m on m.team_id = t.id
    left join public.game_xp_events e on e.player_id = m.player_id and e.at >= p_since
   group by t.id, t.name
   order by xp desc, t.id
   limit least(greatest(p_limit, 1), 100);
$$;
revoke all on function public.game_team_board(bigint, integer) from public, anon, authenticated;
grant execute on function public.game_team_board(bigint, integer) to service_role;

-- First Finder: the first player to collect a treasure of a class in a city holds the badge "ff-<city>-<class>". The partial unique
-- index makes it one holder, ever, even if two collections are recorded at the same instant.
create unique index if not exists game_one_first_finder on public.game_player_achievements (achievement_id) where achievement_id like 'ff-%';

alter table public.game_xp_events enable row level security;
alter table public.game_teams enable row level security;
alter table public.game_team_members enable row level security;
