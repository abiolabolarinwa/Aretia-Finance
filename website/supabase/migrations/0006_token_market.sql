-- Aretia's own copy of each token's market numbers (price, value, trades, volume, changes), written by the discovery job.
-- Find Tokens reads this instead of asking DexScreener from every visitor's browser. Safe to run more than once.
alter table public.token_registry add column if not exists market jsonb;
alter table public.token_registry add column if not exists market_at bigint;
create index if not exists token_registry_market_at on public.token_registry (chain, market_at asc nulls first);
