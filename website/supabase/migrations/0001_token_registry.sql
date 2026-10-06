-- Aretia Token Registry (Aretia Swings). Run in the Supabase SQL editor or with the Supabase CLI.
-- Access is through the service role only, from server functions in website/api/. The browser never
-- talks to these tables: row level security is on and no policy grants anything to anon/authenticated.

create table if not exists public.token_registry (
  key                 text primary key,               -- 'chain:address' (EVM addresses lower-case)
  chain               text   not null check (chain in ('solana','ethereum','bnb','polygon','base')),
  address             text   not null,
  symbol              text   not null,
  name                text   not null default '',
  decimals            int    not null check (decimals between 0 and 36),
  logo                text,
  first_detected_at   bigint not null,                -- ms; when Aretia first saw it
  discovery_source    text   not null,
  created_at_chain    bigint,                         -- ms; on-chain creation, only if known
  first_pool_at       bigint,                         -- ms; first trading pool, only if known
  discovery_status    text   not null check (discovery_status in ('discovered','tradable')),
  liquidity_usd       double precision,
  volume_24h_usd      double precision,
  holder_count        double precision,
  pools               jsonb  not null default '[]',
  metadata            jsonb  not null default '{}',
  verified            boolean not null default false, -- Aretia's curated flag; never set by discovery
  metadata_confidence text   not null check (metadata_confidence in ('onchain','api','unknown')),
  risk                jsonb,
  risk_status         text,
  risk_score          int,
  updated_at          bigint not null,
  unique (chain, address)
);

create index if not exists token_registry_chain_detected on public.token_registry (chain, first_detected_at desc);
create index if not exists token_registry_address on public.token_registry (address);
create index if not exists token_registry_symbol on public.token_registry (lower(symbol));

create table if not exists public.discovery_cursors (
  source     text primary key,
  cursor     text not null,
  updated_at bigint not null
);

alter table public.token_registry enable row level security;
alter table public.discovery_cursors enable row level security;
