-- What a Solana token's mint still allows, for the Markets lists' "can be bought" rule (website/docs/market-indexer-worker.md).
--
-- mint_flags: bit 1 = the mint still has a MINT authority (more can be created), bit 2 = it still has a FREEZE authority (its issuer can lock
--   a holder's tokens, so a buyer might not be able to sell). Read from the token's mint account by the supply refresher, in the same read as the
--   supply. Null: never read, or not a Solana token. A token whose mint was not read is not listed as buyable.
alter table public.mi_tokens add column if not exists mint_flags smallint;

-- The supply refresher reads a token again only when its supply is stale, so every Solana token is made due once, to get its flags.
update public.mi_tokens set supply_at = null where chain = 'solana' and mint_flags is null;

-- PostgREST caches the schema: ask it to reload so the new column can be selected at once.
notify pgrst, 'reload schema';
