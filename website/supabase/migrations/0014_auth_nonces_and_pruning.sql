-- Sign-in nonces, revocable sessions, and pruning of tables that only grow (audit 2026-10: L-3, I-22, I-25, L-27).
-- Safe to run more than once. Written and read only with the service role (row-level security on, no policy).

-- Single-use sign-in nonces. /api/swings-account issues one ({ op: 'nonce' }), the person signs a message carrying it, and the
-- login marks it used in one conditional update (used_at is null and not expired), recording the owner who used it. A nonce, and so
-- a signature, therefore works once, on every server instance, in any spelling of the signature.
create table if not exists public.auth_nonces (
  nonce      text   primary key check (nonce ~ '^[0-9a-f]{16,64}$'),
  created_at bigint not null,
  expires_at bigint not null,
  used_at    bigint,
  owner      text   check (owner is null or length(owner) between 10 and 80)
);
create index if not exists auth_nonces_expires on public.auth_nonces (expires_at);
create unique index if not exists auth_nonces_owner_nonce on public.auth_nonces (owner, nonce) where owner is not null;

-- Per-owner session version. Every session token carries the version it was issued under; a token older than the stored version is
-- refused. { op: 'sign-out-all' } raises it; the operator can too:
--   insert into public.account_sessions (owner, version, updated_at) values ('evm:0x...', 1, 0)
--     on conflict (owner) do update set version = account_sessions.version + 1;
create table if not exists public.account_sessions (
  owner      text    primary key check (length(owner) between 10 and 80),
  version    integer not null default 0 check (version >= 0),
  updated_at bigint  not null default 0
);

alter table public.auth_nonces enable row level security;
alter table public.account_sessions enable row level security;

-- Pruning. Called by the scheduled alert job (/api/swings-alerts-run, through PostgREST rpc) and, where pg_cron is installed, every
-- hour by the database itself. Removes:
--   auth_nonces       a day after they expired
--   notify_links      a day after they expired (Telegram link codes live 15 minutes)
--   notify_inbox      messages no browser collected within 7 days
--   tracked_pools     pools no chart has asked for in 7 days (the refresh job only reads the last day)
--   swings_records    recovery copies not updated for 90 days
create or replace function public.aretia_prune(now_ms bigint default (extract(epoch from now()) * 1000)::bigint)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.auth_nonces where expires_at < now_ms - 86400000::bigint;
  delete from public.notify_links where expires_at < now_ms - 86400000::bigint;
  delete from public.notify_inbox where created_at < now_ms - 604800000::bigint;
  delete from public.tracked_pools where last_seen < now_ms - 604800000::bigint;
  delete from public.swings_records where updated_at < now_ms - 7776000000::bigint;
$$;
revoke all on function public.aretia_prune(bigint) from public, anon, authenticated;
grant execute on function public.aretia_prune(bigint) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aretia-prune', '17 * * * *', 'select public.aretia_prune()');
  end if;
exception when others then
  raise notice 'pg_cron schedule not created (%); the alert job still prunes.', sqlerrm;
end $$;
