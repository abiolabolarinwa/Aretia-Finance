-- OPTIONAL. Runs the Aretia Market Indexer every minute from inside Supabase (the Vercel Hobby plan only allows a daily cron).
-- Run once in the SQL editor AFTER migration 0017. Replace REPLACE_WITH_CRON_SECRET with the MI_CRON_SECRET you set on the site (a long random string of your own; if you did not set
-- MI_CRON_SECRET, use the site's CRON_SECRET instead).
-- Needs the pg_cron and pg_net extensions (free). Each call is bounded to about 45 seconds of work and is safe to repeat: the indexer
-- resumes from its own checkpoint, so a missed or overlapping call loses and duplicates nothing.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('aretia-market-indexer') where exists (select 1 from cron.job where jobname = 'aretia-market-indexer');

select cron.schedule(
  'aretia-market-indexer',
  '* * * * *',
  $$
  select net.http_get(
    url := 'https://aretiafinance.org/api/mi-run',
    headers := jsonb_build_object('Authorization', 'Bearer REPLACE_WITH_CRON_SECRET'),
    timeout_milliseconds := 55000
  );
  $$
);

-- To stop it:  select cron.unschedule('aretia-market-indexer');
