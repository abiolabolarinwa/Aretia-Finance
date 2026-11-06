# Supabase usage: what talks to the database, what it costs, and what changed

Written 2026-11-04 after the free-plan quota was exceeded (egress 13.70 GB of 5 GB, log ingestion 5.95 GB of 1 GB, database 0.54 GB of 0.5 GB; billing cycle 08 Oct to 08 Nov).

**All byte figures below are estimates from reading the code, not measurements.** They use one stated model (below). The ratios matter more than the absolute numbers. The real check is the usage page, see "What to check in two days".

## Read this first: the 06 November date

The quota is counted per billing cycle. 13.70 GB has already been used in this cycle, and the cycle only resets on 08 November. Nothing in this change can bring the cycle total under 5 GB before 06 November. What this change does is stop the total from growing and keep the next cycle (from 08 November) well under the free quota. If the project must stay up on 06 and 07 November, that needs a plan change for the month (Supabase Pro includes much more egress), or accepting the restriction for two days. That is a decision for the owner and it is not made here.

## What produces the traffic

Every Supabase call here is a PostgREST request (`/rest/v1`) with the service key, made from the Vercel functions in `website/api` and `website/src/swings`. Storage, auth, realtime and edge functions are not used for anything heavy, which matches the usage page.

| Source | Schedule | Heavy? |
| --- | --- | --- |
| Market Indexer run (`/api/mi-run`, `src/swings/mi/*`) | pg_cron, was every minute, 19 adapters per run | **Yes, almost all of it** |
| Alerts (`/api/swings-alerts-run`) | pg_cron, every minute | No: one page of channels and one `aretia_prune` call; grows with the number of people with a linked channel |
| Launch Box indexer (`/api/launchbox-run`) | pg_cron every 5 minutes plus Vercel daily | Small (cursor rows, a batch existence check) |
| Launch Box list (`/api/launchbox`) | on visit, cached 60 s | Small: 300 rows once a minute at most |
| Public Markets API (`/api/v1/...`) | on visit, cached 8 s in memory and at the edge | Moderate, bounded: at most 100 pool rows a page |
| Token discovery and price ticks (`swings-discover`, `swings-candles`) | on demand | Small |
| Admin page (`_adminStats`) | owner opens it | Up to a few MB per open (20,000-row reads); not a background job |

### Why the indexer was heavy

Per adapter, per run, every minute, whether or not anything new had happened on chain:

1. `poolsOfAdapter` twice with `select=*`: up to 200 full pool rows, each carrying the `stats` jsonb.
2. `maintain()`: up to 60 more pool rows, then for **each** of them `refreshPool`: one full pool read, up to 5,000 trade rows with `select=*` (24 hours of trades), one more trade read, one pool write and one token write. Roughly 5 requests per pool, up to 300 requests per adapter per run.
3. `recordHealth` read the whole `mi_health` table (19 rows) once per adapter, so 19 times per run.
4. Inserts of tokens, pools and trades used `return=representation`, which sends every inserted row back.
5. Retention deleted old trades with one read of 200 keys and then 200 separate DELETE requests.

That also explains the log volume: every request is a log line, so hundreds of requests a minute become gigabytes of logs in a few days. `cron.job_run_details` (one row per run of each scheduled job) and `net._http_response` (the answer to every pg_net call) were also never cleaned, which adds to the 0.54 GB database.

### One thing the code cannot explain

Between 24 October and 03 November the indexer tables did not exist, so each run failed on its first request with a tiny error (well under 1 KB). That period cannot account for 0.7 to 1.4 GB a day. Either the tables existed earlier than believed, or a second source produced traffic in that period. Please run the two checks in "If the numbers do not fall" below; they name the source directly.

## Model used for the estimates

19 adapters, about 10 followed pools per adapter, about 5 trades per pool in 24 hours, about 13 pools re-read by `maintain`. Pool row with `stats` about 2 KB, without `stats` about 0.8 KB. Trade row about 450 B with all columns, about 330 B without the block hash. Health row about 0.6 KB.

## Bytes per adapter run, before and after

| Part of one adapter's run | Before | After |
| --- | --- | --- |
| Followed pools (2 lists) | 40 KB (`select=*`) | 16 KB (no `stats`); skipped when there is no new block |
| Re-read of waiting and live pools (`maintain`) | about 75 KB, every run | about 62 KB, **at most every 10 minutes** (about 31 KB averaged over 5-minute runs) |
| Pools that traded in this run | 14 KB | 12 KB (lighter trade rows) |
| Health read | 11 KB (whole table, once per adapter) | 0.6 KB (one row) |
| Insert echoes | 1.4 KB | 0.15 KB (`select=key`) |
| Old-trade deletes | 200 requests when there is anything to delete | 1 request (`mi_prune_trades`) |
| **Total per adapter run** | **about 150 KB** | **about 60 KB** |

The run rate also changes: from every minute (1,440 a day) to every five minutes (288 a day).

| | Before | After |
| --- | --- | --- |
| Per-run bytes (relative) | 1.0 | 0.4 |
| Runs a day | 1,440 | 288 |
| Egress from the indexer (relative) | 1.0 | about 0.08 (a twelfth) |
| Requests a day (logs) | very high | about 10 to 20 times fewer |

The model puts the indexer at several GB a day, higher than the 0.7 to 1.4 GB the usage page shows, because in practice the 45-second budget stops some runs early and most adapters have few pools. Applying the same ratio to the observed figure: **expected daily egress about 0.1 GB or less, from about 1 GB**.

## What changed in the code

- `supabaseStore.ts`: `poolsOfAdapter` and `poolsNeedingHistory` no longer read `stats`; trade reads leave out `block_hash`; token, pool and trade inserts echo only the key (`select=key` with `return=representation`, so the new-row counts still work); new `getHealth` reads one row; `pruneTrades` uses the `mi_prune_trades` function in one call and falls back to the old way until migration 0021 is applied.
- `engine.ts` and `solana/engine.ts`: health is read as one row; the followed pools are read only when there is a block range to read; `maintain()` (EVM) and the waiting-pool refresh (Solana) run at most once per 10 minutes per adapter (time kept in the adapter's health row as `maintainedAt`); the token's first-trade write happens only when it changed.
- `runner.ts` and `track.ts`: trade retention default 30 days to **14 days** (`MI_TRADE_RETENTION_DAYS` still overrides); one prune request removes up to 2,000 rows.
- `launchbox/store.ts`: inserts echo only the key.
- `supabase/cron/market-indexer-every-5-minutes.sql` (renamed from `...-every-minute.sql`): every five minutes.
- Migration `0021_supabase_usage.sql`: `mi_prune_trades`, a one-off deletion of trades older than 14 days, and an hourly `aretia_housekeeping` job that trims `cron.job_run_details` (older than 1 day) and `net._http_response` (older than 1 hour) and removes old trades.

## Trade-offs

- The indexer is up to five minutes behind the chain instead of one. A run still reads every block since its checkpoint, so no trade is lost. The Markets lists show data that is at most a few minutes older.
- Pools that change without a swap (funded later, gone quiet) are re-evaluated every 10 minutes at most instead of every run. Pools that traded in a run are still refreshed in that run.
- Trades older than 14 days are deleted instead of 30. Charts that need more than 14 days of Aretia's own trades, and statistics beyond that range, are no longer available from the index. Set `MI_TRADE_RETENTION_DAYS` higher if that matters more than database size (about 0.5 GB is the free limit).
- The alerts job stays at one minute: it is one small request when few people have linked a channel, and price alerts are time sensitive. The Launch Box job stays at five minutes.

## What the owner runs

1. Right now, before this is deployed (stops the growth at once; the Markets lists keep what is already stored):

```sql
select cron.unschedule('aretia-market-indexer');
```

   I agree with doing this today. The Markets lists and the chart only fall back to the index when the main feed fails, and they read stored rows, so they keep working with data that stops getting fresher.

2. Apply `website/supabase/migrations/0021_supabase_usage.sql` in the SQL editor (or `npm run db:migrate`). It is safe to run twice. If the editor times out on the first delete, run it again.
3. After this change is deployed, put the indexer back at five minutes by running `website/supabase/cron/market-indexer-every-5-minutes.sql` (replace `REPLACE_WITH_CRON_SECRET` with the new `MI_CRON_SECRET`; never commit it).
4. Optional, to see what is big:

```sql
select n.nspname as schema, c.relname as table, pg_size_pretty(pg_total_relation_size(c.oid)) as size
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname in ('public', 'cron', 'net')
order by pg_total_relation_size(c.oid) desc limit 15;
```

## What to check in two days

On the usage page (Organization, Usage, current cycle, All projects):

- **Egress per day**: from 06 November the daily bar should be about 0.1 GB or less, down from 0.7 to 1.4 GB. If the indexer stays scheduled at five minutes, expect up to about 0.15 GB a day. The cycle total does not fall; it only stops growing.
- **Log ingestion**: the daily growth should drop by roughly ten times.
- **Database size**: should drop after step 2 (the old trades and the pg_cron and pg_net rows go), toward or under 0.5 GB.

## If the numbers do not fall

In Supabase, Logs Explorer, run this to see which paths make the requests (last 24 hours):

```sql
select r.path, count(*) as requests
from edge_logs as t
cross join unnest(t.metadata) as m
cross join unnest(m.request) as r
group by r.path
order by requests desc
limit 20
```

And to see which paths send the bytes:

```sql
select r.path, sum(cast(h.content_length as int64)) as bytes
from edge_logs as t
cross join unnest(t.metadata) as m
cross join unnest(m.request) as r
cross join unnest(m.response) as resp
cross join unnest(resp.headers) as h
group by r.path
order by bytes desc
limit 20
```

The top path (for example `/rest/v1/mi_pools` or `/rest/v1/mi_trades`) names the table, and that points at the code above.
