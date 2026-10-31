-- Market Indexer on Robinhood Chain: lets the two tables hold rows for it. Safe to run more than once.
-- Apply this BEFORE switching on the uniswap-v3-robinhood adapter (MI_ADAPTERS), or its writes are refused by the old check.
alter table public.mi_tokens drop constraint if exists mi_tokens_chain_check;
alter table public.mi_tokens add constraint mi_tokens_chain_check check (chain in ('solana','ethereum','base','bnb','polygon','robinhood','arbitrum','optimism','avalanche'));
alter table public.mi_pools drop constraint if exists mi_pools_chain_check;
alter table public.mi_pools add constraint mi_pools_chain_check check (chain in ('solana','ethereum','base','bnb','polygon','robinhood','arbitrum','optimism','avalanche'));
