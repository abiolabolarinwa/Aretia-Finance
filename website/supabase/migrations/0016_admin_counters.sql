-- Anonymous daily counters for the owner's private admin page (docs/admin-page.md). Safe to run more than once.
-- One row per (day, kind, key) holding only a count: no address, no IP, no user id, no timestamp finer than a day.
--   kind 'visit'    key 'all'                  one per browser session
--   kind 'country'  key 'GB'                   two-letter country from the host's geo header (XX when unknown)
--   kind 'wallet'   key 'MetaMask'             the wallet's name, counted when it was used for a swap
--   kind 'chain'    key 'solana'               the network of a confirmed swap
--   kind 'coin'     key 'solana:SOL'           a coin on either side of a confirmed swap
--   kind 'issue'    key 'swap-failed:bnb'      a failed action or a script error, by category only (never the message)
-- Written and read only with the service role (row-level security is on and no policy grants anything to anon/authenticated).

create table if not exists public.admin_counters (
  day  text   not null check (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  kind text   not null check (kind in ('visit', 'country', 'wallet', 'chain', 'coin', 'issue')),
  key  text   not null check (length(key) between 1 and 48),
  n    bigint not null default 0 check (n >= 0),
  primary key (day, kind, key)
);
alter table public.admin_counters enable row level security;

-- One atomic increment, so two visitors at once never lose a count.
create or replace function public.admin_bump(p_day text, p_kind text, p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.admin_counters (day, kind, key, n) values (p_day, p_kind, p_key, 1)
  on conflict (day, kind, key) do update set n = public.admin_counters.n + 1;
$$;
revoke all on function public.admin_bump(text, text, text) from public, anon, authenticated;
grant execute on function public.admin_bump(text, text, text) to service_role;

-- Counters older than a year are not needed.
create or replace function public.admin_prune_counters()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.admin_counters where day < to_char(now() - interval '400 days', 'YYYY-MM-DD');
$$;
revoke all on function public.admin_prune_counters() from public, anon, authenticated;
grant execute on function public.admin_prune_counters() to service_role;
