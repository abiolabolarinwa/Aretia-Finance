-- Cuts database size and log volume (see docs/SUPABASE_USAGE.md). Safe to run more than once.
--
--  1. mi_prune_trades: the indexer used to delete old trades with one request per row; now one call deletes a batch inside the database.
--  2. A one-off removal of trades older than 14 days (the new retention; the indexer and the hourly job below keep it there).
--  3. An hourly housekeeping job that trims the two tables pg_cron and pg_net fill on every call: cron.job_run_details (one row per
--     run of every scheduled job, never removed by Supabase) and net._http_response (the answer to every pg_net call).
--     Both are wrapped so the migration still succeeds where pg_cron or pg_net is not installed.

create or replace function public.mi_prune_trades(p_before bigint, p_limit integer default 2000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with old as (
    select chain, pool, id from public.mi_trades where time < p_before order by time asc limit greatest(1, least(p_limit, 20000))
  )
  delete from public.mi_trades t using old where t.chain = old.chain and t.pool = old.pool and t.id = old.id;
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.mi_prune_trades(bigint, integer) from public, anon, authenticated;
grant execute on function public.mi_prune_trades(bigint, integer) to service_role;

-- One-off: everything older than 14 days, in a single statement (run it again if the editor times out; it resumes where it stopped).
delete from public.mi_trades where time < extract(epoch from now())::bigint - 14 * 86400;

create or replace function public.aretia_housekeeping()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.mi_trades where time < extract(epoch from now())::bigint - 14 * 86400;
  begin
    delete from cron.job_run_details where end_time < now() - interval '1 day';
  exception when others then
    null; -- pg_cron not installed
  end;
  begin
    delete from net._http_response where created < now() - interval '1 hour';
  exception when others then
    null; -- pg_net not installed
  end;
end;
$$;
revoke all on function public.aretia_housekeeping() from public, anon, authenticated;
grant execute on function public.aretia_housekeeping() to service_role;

-- Clear what has piled up since 24 October, once.
select public.aretia_housekeeping();

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('aretia-housekeeping') where exists (select 1 from cron.job where jobname = 'aretia-housekeeping');
    perform cron.schedule('aretia-housekeeping', '23 * * * *', 'select public.aretia_housekeeping()');
  end if;
exception when others then
  raise notice 'pg_cron schedule not created (%); run select public.aretia_housekeeping() by hand now and then.', sqlerrm;
end $$;
