-- Market Indexer: Uniswap V4 pools. A V4 pool's address is its 32-byte pool id; its key's tick spacing and hooks contract are kept.
-- Safe to run more than once.
alter table public.mi_pools add column if not exists tick_spacing int;
alter table public.mi_pools add column if not exists hooks text;
alter table public.mi_pools drop constraint if exists mi_pools_kind_check;
alter table public.mi_pools add constraint mi_pools_kind_check check (kind in ('v2','v3','v4','cpmm','clmm'));

-- How far back a pool's swaps are stored (see src/swings/mi/types.ts). A pool found at its creation is complete; a pool added on request is
-- read further back by later runs. Existing rows default to complete.
alter table public.mi_pools add column if not exists history_block bigint;
alter table public.mi_pools add column if not exists history_done boolean not null default true;
create index if not exists mi_pools_history on public.mi_pools (adapter_id, updated_at) where history_done = false;
