-- Market Indexer on Solana: a pool's two token accounts (vaults) and the two Solana pool shapes. Safe to run more than once.
alter table public.mi_pools add column if not exists base_vault text;
alter table public.mi_pools add column if not exists quote_vault text;
alter table public.mi_pools drop constraint if exists mi_pools_kind_check;
alter table public.mi_pools add constraint mi_pools_kind_check check (kind in ('v2','v3','cpmm','clmm'));
