-- Ultimate City Search, milestone 8: prize claims and the reserve, announcements, abuse reports and the admin audit log.
-- Safe to run more than once. Written and read only by /api/game with the service role (row-level security on, no policy).
-- Nothing here pays anyone: a claim only records an entitlement, a decision and, once the operator has paid by some authorised
-- means elsewhere, the payment reference.

-- One claim per treasure, ever (the unique key is what prevents a duplicate claim).
create table if not exists public.game_prize_claims (
  id                   uuid    primary key default gen_random_uuid(),
  player_id            uuid    not null references public.game_players (id) on delete restrict,
  treasure_id          uuid    not null unique references public.game_treasures (id),
  amount_usd           numeric not null check (amount_usd > 0),
  claim_status         text    not null default 'pending' check (claim_status in ('pending','approved','rejected','paid')),
  verification_details text    not null default '' check (length(verification_details) <= 2000),
  payment_reference    text    check (payment_reference is null or length(payment_reference) <= 200),
  created_at           bigint  not null,
  decided_at           bigint,
  paid_at              bigint
);
create index if not exists game_prize_claims_status on public.game_prize_claims (claim_status, created_at);

-- Money put into (or taken out of) the funded prize reserve, by the operator. Positive is a deposit.
create table if not exists public.game_reserve_entries (
  id         bigint  generated always as identity primary key,
  amount_usd numeric not null check (amount_usd <> 0),
  note       text    not null default '' check (length(note) <= 300),
  admin      text    not null,
  at         bigint  not null
);

create table if not exists public.game_announcements (
  id         uuid    primary key default gen_random_uuid(),
  title      text    not null check (length(title) between 1 and 120),
  body       text    not null default '' check (length(body) <= 2000),
  created_at bigint  not null,
  expires_at bigint,
  active     boolean not null default true
);

create table if not exists public.game_abuse_reports (
  id          uuid   primary key default gen_random_uuid(),
  reporter    uuid   not null references public.game_players (id) on delete restrict,
  kind        text   not null check (kind in ('cheating','exploit','wrong-clue','harassment','other')),
  details     text   not null default '' check (length(details) <= 2000),
  status      text   not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at  bigint not null,
  resolved_at bigint
);
create index if not exists game_abuse_reports_status on public.game_abuse_reports (status, created_at);

-- Every change an administrator makes. Append-only: the API only inserts.
create table if not exists public.game_admin_audit (
  id      bigint generated always as identity primary key,
  admin   text   not null,
  action  text   not null check (length(action) between 1 and 60),
  target  text   not null default '',
  details jsonb  not null default '{}'::jsonb,
  at      bigint not null
);
create index if not exists game_admin_audit_at on public.game_admin_audit (at desc);

alter table public.game_prize_claims enable row level security;
alter table public.game_reserve_entries enable row level security;
alter table public.game_announcements enable row level security;
alter table public.game_abuse_reports enable row level security;
alter table public.game_admin_audit enable row level security;

-- The administrator's headline numbers in one read: players, activity, treasures by state, the value still hidden or waiting to be
-- verified, claims by state, and the funded reserve. Service role only.
create or replace function public.game_admin_overview(p_now bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'players', (select count(*) from public.game_players),
    'newPlayers7d', (select count(*) from public.game_players where created_at >= p_now - 7 * 86400000),
    'activities24h', (select count(*) from public.game_player_activities where created_at >= p_now - 86400000),
    'activePlayers24h', (select count(distinct player_id) from public.game_player_activities where created_at >= p_now - 86400000),
    'missionsActive', (select count(*) from public.game_missions where status = 'active'),
    'treasures', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from public.game_treasures group by status) s), '{}'::jsonb),
    'hiddenValueUsd', coalesce((select sum(c.usd_value) from public.game_treasures t join public.game_treasure_classes c on c.id = t.class_id where t.status = 'hidden'), 0),
    'pendingVerificationUsd', coalesce((select sum(c.usd_value) from public.game_player_treasures pt join public.game_treasures t on t.id = pt.treasure_id join public.game_treasure_classes c on c.id = t.class_id where pt.verification_status = 'pending'), 0),
    'claims', coalesce((select jsonb_object_agg(claim_status, jsonb_build_object('n', n, 'usd', usd)) from (select claim_status, count(*) as n, sum(amount_usd) as usd from public.game_prize_claims group by claim_status) s), '{}'::jsonb),
    'reserveUsd', coalesce((select sum(amount_usd) from public.game_reserve_entries), 0)
  );
$$;
revoke all on function public.game_admin_overview(bigint) from public, anon, authenticated;
grant execute on function public.game_admin_overview(bigint) to service_role;
