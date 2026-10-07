-- Arbitrum, Optimism and Avalanche join the chains Aretia Swings reads. Only the allowed-chain checks change.
alter table public.token_registry drop constraint if exists token_registry_chain_check;
alter table public.token_registry add constraint token_registry_chain_check
  check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche'));

alter table public.swings_events drop constraint if exists swings_events_chain_check;
alter table public.swings_events add constraint swings_events_chain_check
  check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche'));
