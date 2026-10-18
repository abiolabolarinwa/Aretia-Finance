-- OPTIONAL. Runs the Launch Box indexer every five minutes from inside Supabase.
-- Without it the indexer still runs once a day (Vercel cron, vercel.json) and whenever someone opens Launch Box after it has been quiet
-- for five minutes, so new tokens can appear a few minutes late but are not missed. Run this once in the SQL editor AFTER migration 0012.
-- Replace REPLACE_WITH_CRON_SECRET with the same CRON_SECRET the site uses. Needs the pg_cron and pg_net extensions (free).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('aretia-launchbox') where exists (select 1 from cron.job where jobname = 'aretia-launchbox');

select cron.schedule(
  'aretia-launchbox',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://aretiafinance.org/api/launchbox-run',
    headers := jsonb_build_object('Authorization', 'Bearer REPLACE_WITH_CRON_SECRET'),
    timeout_milliseconds := 55000
  );
  $$
);

-- To stop it:  select cron.unschedule('aretia-launchbox');
