-- Aretia Market Indexer: tokens, pools (markets), trades, per-adapter checkpoints, health, admin controls, audit log and backfill jobs.
-- Everything is derived from chain data the indexer read itself. Written and read only with the service role: row level security is on
-- and no policy grants anything to anon/authenticated. Amounts are stored as TEXT because a raw token amount can exceed 2^53 and
-- PostgREST would hand a numeric back as a JSON number. Safe to run more than once.

create table if not exists public.mi_tokens (
  key             text primary key,                 -- 'chain:address' (EVM addresses lower-case)
  chain           text   not null check (chain in ('solana','ethereum','base','bnb','polygon','arbitrum','optimism','avalanche')),
  address         text   not null,
  symbol          text   not null default '',
  name            text   not null default '',
  decimals        int    not null check (decimals between 0 and 36),
  first_seen_at   bigint not null,                  -- ms, when the indexer first saw the token in a pool
  first_trade_at  bigint,                           -- ms, first trade seen in any pool of the token
  launchbox_key   text,                             -- set when Aretia Launch Box holds the same token (read-only association)
  updated_at      bigint not null,
  unique (chain, address)
);
create index if not exists mi_tokens_symbol on public.mi_tokens (lower(symbol));

create table if not exists public.mi_pools (
  key             text primary key,                 -- 'chain:pool'
  chain           text   not null check (chain in ('solana','ethereum','base','bnb','polygon','arbitrum','optimism','avalanche')),
  address         text   not null,
  adapter_id      text   not null,
  dex             text   not null,
  kind            text   not null check (kind in ('v2','v3')),
  fee_tier        int,
  base            text   not null,
  quote           text   not null,
  base_decimals   int    not null,
  quote_decimals  int    not null,
  base_is_token0  boolean not null,
  created_block   bigint not null,
  created_tx      text   not null,
  created_at      bigint not null,                  -- ms, block time of the creation event
  state           text   not null check (state in ('discovered','validating','awaiting_liquidity','active','inactive','suspended','unsupported')),
  state_reason    text   not null default '',
  state_at        bigint not null,
  reserve_base    text,
  reserve_quote   text,
  reserve_block   bigint,
  first_trade_at  bigint,
  last_trade_at   bigint,
  paused          boolean not null default false,
  stats           jsonb,
  vol24_usd       double precision,                 -- copies of stats numbers, for sorting only
  liquidity_usd   double precision,
  updated_at      bigint not null,
  unique (chain, address)
);
create index if not exists mi_pools_new on public.mi_pools (state, created_at desc, key desc);
create index if not exists mi_pools_chain_new on public.mi_pools (chain, created_at desc, key desc);
create index if not exists mi_pools_base on public.mi_pools (chain, base);
create index if not exists mi_pools_quote on public.mi_pools (chain, quote);
create index if not exists mi_pools_adapter on public.mi_pools (adapter_id, created_block desc);
create index if not exists mi_pools_last_trade on public.mi_pools (adapter_id, last_trade_at desc);
create index if not exists mi_pools_volume on public.mi_pools (state, vol24_usd desc nulls last);

create table if not exists public.mi_trades (
  chain        text   not null,
  pool         text   not null,
  id           text   not null,                     -- 'txHash:logIndex'
  adapter_id   text   not null,
  block        bigint not null,
  block_hash   text   not null,
  time         bigint not null,                     -- unix seconds
  side         text   not null check (side in ('buy','sell')),
  base_amount  text   not null,
  quote_amount text   not null,
  price        text   not null,                     -- fixed-point decimal string
  maker        text   not null,
  primary key (chain, pool, id)
);
create index if not exists mi_trades_pool_time on public.mi_trades (chain, pool, time desc);
create index if not exists mi_trades_adapter_block on public.mi_trades (adapter_id, block);

create table if not exists public.mi_checkpoints (
  adapter_id  text primary key,
  block       bigint not null,
  block_hash  text   not null,
  updated_at  bigint not null
);
create table if not exists public.mi_block_hashes (
  adapter_id  text   not null,
  block       bigint not null,
  hash        text   not null,
  primary key (adapter_id, block)
);
create table if not exists public.mi_health (
  adapter_id  text primary key,
  data        jsonb  not null,
  updated_at  bigint not null
);
create table if not exists public.mi_controls (
  adapter_id  text primary key,
  disabled    boolean not null default false,
  reason      text   not null default '',
  at          bigint not null
);
create table if not exists public.mi_audit (
  id      bigserial primary key,
  at      bigint not null,
  actor   text   not null,
  action  text   not null,
  target  text   not null,
  detail  jsonb  not null default '{}'
);
create index if not exists mi_audit_at on public.mi_audit (at desc);
create table if not exists public.mi_jobs (
  id            text primary key,
  adapter_id    text   not null,
  from_block    bigint not null,
  to_block      bigint not null,
  done_block    bigint not null,
  status        text   not null check (status in ('pending','running','done','failed')),
  requested_by  text   not null,
  requested_at  bigint not null,
  error         text
);
create index if not exists mi_jobs_status on public.mi_jobs (status, requested_at);

alter table public.mi_tokens enable row level security;
alter table public.mi_pools enable row level security;
alter table public.mi_trades enable row level security;
alter table public.mi_checkpoints enable row level security;
alter table public.mi_block_hashes enable row level security;
alter table public.mi_health enable row level security;
alter table public.mi_controls enable row level security;
alter table public.mi_audit enable row level security;
alter table public.mi_jobs enable row level security;

-- Claims the oldest pending backfill job atomically, so two workers never run the same job.
create or replace function public.mi_claim_job()
returns setof public.mi_jobs
language sql
security definer
set search_path = public
as $$
  update public.mi_jobs set status = 'running'
  where id = (select id from public.mi_jobs where status = 'pending' order by requested_at limit 1 for update skip locked)
  returning *;
$$;
revoke all on function public.mi_claim_job() from public, anon, authenticated;
grant execute on function public.mi_claim_job() to service_role;

-- Reorg support: removes an adapter's pools created at or above a block together with their trades, in one transaction.
create or replace function public.mi_delete_pools_from(p_adapter text, p_block bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  delete from public.mi_trades t using public.mi_pools p
    where p.adapter_id = p_adapter and p.created_block >= p_block and t.chain = p.chain and t.pool = p.address;
  with d as (delete from public.mi_pools where adapter_id = p_adapter and created_block >= p_block returning 1)
    select count(*) into n from d;
  return n;
end;
$$;
revoke all on function public.mi_delete_pools_from(text, bigint) from public, anon, authenticated;
grant execute on function public.mi_delete_pools_from(text, bigint) to service_role;
