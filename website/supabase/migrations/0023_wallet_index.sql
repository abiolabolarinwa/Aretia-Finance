-- Aretia's own wallet index: which tokens a connected wallet has received, from the moment it first connected (website/docs/wallet-index.md).
-- Nothing here is history from before a wallet connected: a wallet starts afresh with Aretia, and every token it receives after that is recorded by
-- reading the chain's Transfer events for the watched wallets. Written and read only with the service role. Safe to run more than once.
--
-- wallet_watch:  one row per (chain, wallet) being followed. `since_block` is the block when it was first registered; the indexer never looks earlier.
-- wallet_tokens: the tokens a watched wallet has received, with the first and last block they were seen. Never holds a balance: balances are read
--                from the chain when the dashboard draws, so this table only has to say "look at this token".
-- wallet_cursor: per chain, the last block the indexer has finished reading, so a restart continues where it stopped.

create table if not exists public.wallet_watch (
  chain        text   not null check (chain in ('ethereum','base','bnb','polygon','arbitrum','optimism','avalanche')),
  wallet       text   not null check (wallet ~ '^0x[0-9a-f]{40}$'),  -- lower-case
  since_block  bigint not null check (since_block >= 0),
  created_at   bigint not null,                                       -- ms
  last_seen_at bigint not null,                                       -- ms, when the wallet last asked for its tokens (idle wallets can be dropped)
  primary key (chain, wallet)
);
create index if not exists wallet_watch_seen on public.wallet_watch (chain, last_seen_at);

create table if not exists public.wallet_tokens (
  chain        text   not null check (chain in ('ethereum','base','bnb','polygon','arbitrum','optimism','avalanche')),
  wallet       text   not null check (wallet ~ '^0x[0-9a-f]{40}$'),
  token        text   not null check (token ~ '^0x[0-9a-f]{40}$'),
  first_block  bigint not null,
  last_block   bigint not null,
  primary key (chain, wallet, token)
);
create index if not exists wallet_tokens_wallet on public.wallet_tokens (wallet, chain);

create table if not exists public.wallet_cursor (
  chain      text primary key check (chain in ('ethereum','base','bnb','polygon','arbitrum','optimism','avalanche')),
  next_block bigint not null check (next_block >= 0),
  updated_at bigint not null
);

alter table public.wallet_watch enable row level security;
alter table public.wallet_tokens enable row level security;
alter table public.wallet_cursor enable row level security;

-- PostgREST caches the schema: ask it to reload so the new tables can be used at once.
notify pgrst, 'reload schema';
