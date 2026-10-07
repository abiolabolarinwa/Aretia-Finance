-- Shadow comparison events (Aretia Swings): how Aretia's own route compared with the best aggregator route
-- for the same request. Still anonymous: no wallet, no IP, no amount, no token. `diff_bps` is Aretia's expected
-- output minus the rival's, in basis points of the rival's (negative = Aretia was behind).
alter table public.swings_events add column if not exists rival    text;
alter table public.swings_events add column if not exists diff_bps int check (diff_bps between -10000 and 10000);

alter table public.swings_events drop constraint if exists swings_events_name_check;
alter table public.swings_events add constraint swings_events_name_check check (name in ('quote_failed','routes_found','swap','shadow'));

-- Where Aretia loses, by chain and rival: the question this data exists to answer.
create or replace view public.swings_shadow_summary with (security_invoker = true) as
  select chain, provider as winner, rival,
         count(*)                                  as comparisons,
         round(avg(diff_bps)::numeric, 1)          as avg_diff_bps,
         count(*) filter (where diff_bps < 0)      as aretia_behind,
         count(*) filter (where diff_bps >= 0)     as aretia_level_or_ahead,
         min(diff_bps)                             as worst_diff_bps
  from public.swings_events
  where name = 'shadow'
  group by chain, provider, rival;
