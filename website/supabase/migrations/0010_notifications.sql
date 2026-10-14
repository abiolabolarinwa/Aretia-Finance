-- Alerts that reach a phone: Telegram and browser (web push) notifications, sent by the server while the page is closed.
-- Everything is written and read only by the site's server with the service role (row-level security is on and there is no policy),
-- after it has checked the wallet sign-in the same way the favourites do. A row belongs to an "owner": "solana:<address>" or "evm:<address>".

-- Where a person's alerts go. One row per Telegram chat or browser. `ref` is the Telegram chat id, or the browser's push address.
create table if not exists public.notify_channels (
  id         bigint generated always as identity primary key,
  owner      text   not null check (length(owner) between 10 and 80),
  kind       text   not null check (kind in ('telegram', 'webpush')),
  ref        text   not null check (length(ref) between 1 and 600),
  -- webpush: a secret that lets that browser read its own waiting messages (the push itself carries no text)
  secret     text,
  created_at bigint not null,
  last_ok_at bigint,
  unique (owner, kind, ref)
);
create index if not exists notify_channels_owner on public.notify_channels (owner);

-- One-time codes for linking a Telegram chat: made when the person presses "Connect Telegram", used by the bot's /start.
create table if not exists public.notify_links (
  code       text   primary key check (length(code) between 16 and 64),
  owner      text   not null check (length(owner) between 10 and 80),
  expires_at bigint not null
);

-- How much a favourite has to move before a message is sent, and whether messages are on.
create table if not exists public.notify_prefs (
  owner    text primary key check (length(owner) between 10 and 80),
  move_pct integer not null default 5 check (move_pct in (2, 5, 10, 20)),
  enabled  boolean not null default true
);

-- The price each favourite is measured from (the same idea as the page's own alerts), per person.
create table if not exists public.notify_state (
  owner      text   not null check (length(owner) between 10 and 80),
  token_key  text   not null check (length(token_key) between 3 and 140),
  baseline   double precision not null check (baseline > 0),
  updated_at bigint not null,
  primary key (owner, token_key)
);

-- Price orders ("tell me when it reaches this price"), copied from the browser so the server can watch them.
create table if not exists public.user_price_orders (
  owner      text   not null check (length(owner) between 10 and 80),
  id         text   not null check (length(id) between 1 and 80),
  chain      text   not null check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche','robinhood')),
  address    text   not null check (length(address) between 20 and 100),
  symbol     text   not null,
  name       text   not null default '',
  icon       text,
  side       text   not null check (side in ('buy', 'sell')),
  target_usd double precision not null check (target_usd > 0),
  created_at bigint not null,
  hit_at     bigint,
  hit_price  double precision,
  primary key (owner, id)
);

-- Messages waiting for a browser to collect after its push arrives.
create table if not exists public.notify_inbox (
  id         bigint generated always as identity primary key,
  channel_id bigint not null references public.notify_channels(id) on delete cascade,
  title      text   not null,
  body       text   not null,
  url        text   not null default '/wallet',
  created_at bigint not null
);
create index if not exists notify_inbox_channel on public.notify_inbox (channel_id, created_at);

alter table public.notify_channels enable row level security;
alter table public.notify_links enable row level security;
alter table public.notify_prefs enable row level security;
alter table public.notify_state enable row level security;
alter table public.user_price_orders enable row level security;
alter table public.notify_inbox enable row level security;
