-- Launch Box: every token created through Aretia's Launch page, found on chain by the site's server (never reported by a browser).
-- Written and read only with the service role: row level security is on and no policy grants anything to anon/authenticated.
-- Safe to run more than once.

create table if not exists public.launchbox_tokens (
  -- "<chain>:<address>"; EVM addresses lower-case, Solana addresses exactly as encoded.
  key           text   primary key check (length(key) between 8 and 100),
  chain         text   not null check (chain in ('solana', 'bnb', 'ethereum', 'polygon')),
  address       text   not null check (length(address) between 32 and 60),
  name          text   not null default '',
  symbol        text   not null default '',
  decimals      integer check (decimals between 0 and 36),
  -- Smallest units as a decimal string (it can exceed 64 bits). Null while the supply has not been minted or could not be read.
  supply        text   check (supply ~ '^[0-9]{1,80}$'),
  creator       text,
  -- When the token was created, in milliseconds. Null when it could not be read (a token found by counting the factory's creations).
  created_at    bigint,
  tx            text,
  -- How it was found: "factory" (a TokenCreated event), "nonce" (counted from the factory's creations), "solana-fee" (fee payment plus a new Token-2022 mint).
  source        text   not null check (source in ('factory', 'nonce', 'solana-fee')),
  indexed_at    bigint not null,
  -- The pool Aretia last saw for it, if any.
  pool_dex      text,
  pool_address  text,
  pool_url      text,
  pool_seen_at  bigint,
  -- The Aretia Curve address, once a curve exists for it.
  curve_address text,
  unique (chain, address)
);
create index if not exists launchbox_tokens_created on public.launchbox_tokens (created_at desc nulls last);
create index if not exists launchbox_tokens_chain_created on public.launchbox_tokens (chain, created_at desc nulls last);

-- Where the indexer stopped, per chain. `cursor` is opaque text owned by the indexer (a block number, or the Solana signature state).
create table if not exists public.launchbox_cursors (
  chain       text   primary key check (chain in ('solana', 'bnb', 'ethereum', 'polygon')),
  cursor      text,
  updated_at  bigint not null,
  -- What the last run found, for the page to say honestly: { expected, indexed, error, unreadable }.
  stats       jsonb
);

alter table public.launchbox_tokens enable row level security;
alter table public.launchbox_cursors enable row level security;
