-- Runs the alert check once a minute from inside Supabase, which keeps time far better than GitHub's scheduler.
-- Run this once in the SQL editor AFTER migration 0010 and after the site is deployed with CRON_SECRET set.
-- Replace the two placeholders below: your site's address, and the same CRON_SECRET the site uses.
-- Needs the pg_cron and pg_net extensions (Database > Extensions in the dashboard; both are free).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Stop an older copy of this job first, so running the file twice does not make two.
select cron.unschedule('aretia-alerts') where exists (select 1 from cron.job where jobname = 'aretia-alerts');

select cron.schedule(
  'aretia-alerts',
  '* * * * *',
  $$
  select net.http_get(
    url := 'https://aretiafinance.org/api/swings-alerts-run',
    headers := jsonb_build_object('Authorization', 'Bearer REPLACE_WITH_CRON_SECRET'),
    timeout_milliseconds := 55000
  );
  $$
);

-- To stop it:  select cron.unschedule('aretia-alerts');
-- To look at how it is doing:  select * from cron.job_run_details order by start_time desc limit 10;
