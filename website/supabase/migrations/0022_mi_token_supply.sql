-- Token supply for the Markets list's fully diluted value (website/docs/markets-from-index.md). Safe to run more than once.
--
-- total_supply: the token's total supply as a raw integer written out in full (text, because it can exceed what a number holds), read from the
--   chain by the indexer's supply refresher (EVM totalSupply(), Solana mint supply). Null when it could not be read.
-- supply_at: ms when that was last attempted (null: never), so the refresher works through the oldest first and does not retry a token that
--   has no readable supply on every pass.
alter table public.mi_tokens add column if not exists total_supply text;
alter table public.mi_tokens add column if not exists supply_at bigint;
create index if not exists mi_tokens_supply_at on public.mi_tokens (chain, supply_at nulls first);

-- PostgREST caches the schema: ask it to reload so the new columns can be selected at once.
notify pgrst, 'reload schema';
