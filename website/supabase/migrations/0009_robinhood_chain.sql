-- Robinhood Chain joins the chains Aretia reads. Only the allowed-chain checks change.
alter table public.token_registry drop constraint if exists token_registry_chain_check;
alter table public.token_registry add constraint token_registry_chain_check
  check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche','robinhood'));

alter table public.swings_events drop constraint if exists swings_events_chain_check;
alter table public.swings_events add constraint swings_events_chain_check
  check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche','robinhood'));

alter table public.pool_ticks drop constraint if exists pool_ticks_chain_check;
alter table public.pool_ticks add constraint pool_ticks_chain_check
  check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche','robinhood'));

alter table public.user_favourites drop constraint if exists user_favourites_chain_check;
alter table public.user_favourites add constraint user_favourites_chain_check
  check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche','robinhood'));
