-- Referrals for swap fees (docs/referrals.md). Three tables, all written and read only by /api/swings-referrals with the service
-- role (row-level security is on and no policy exists, so no other role can touch them). An "owner" is the address a person proved
-- they control, written "solana:<address>" or "evm:<lowercase address>", as in user_trades.
--
-- Nothing here moves money. A credit is a line saying "this fee reached Aretia's fee wallet on chain, and this much of it is owed to
-- this referrer"; the owner pays by hand from an export read with the service key on the owner's own machine.

-- Who brought whom. One row per trader: the first referrer wins, and the row is never moved to another referrer.
create table if not exists public.referral_bindings (
  trader     text   primary key check (length(trader) between 10 and 80),
  referrer   text   not null check (length(referrer) between 10 and 80),
  bound_at   bigint not null,
  expires_at bigint not null,
  check (lower(trader) <> lower(referrer))
);
create index if not exists referral_bindings_referrer on public.referral_bindings (referrer);

-- One row per fee payment the server verified on chain. (chain, tx, asset) is unique, so one payment can be credited only once.
-- Amounts are whole numbers in the smallest unit, kept as text so no precision is lost; the code adds them as big integers.
create table if not exists public.referral_credits (
  chain      text   not null check (chain in ('solana','ethereum','bnb','polygon','base','arbitrum','optimism','avalanche','robinhood')),
  tx         text   not null check (length(tx) between 20 and 130),
  asset      text   not null check (length(asset) between 3 and 100),
  trader     text   not null,
  referrer   text   not null,
  swap_tx    text,
  fee_raw    text   not null check (fee_raw ~ '^[0-9]{1,78}$'),
  share_raw  text   not null check (share_raw ~ '^[0-9]{1,78}$'),
  status     text   not null check (status in ('credited','capped','flagged','family')),
  tx_at      bigint not null,
  created_at bigint not null,
  paid_at    bigint,
  primary key (chain, tx, asset)
);
create index if not exists referral_credits_referrer on public.referral_credits (referrer, created_at desc);
create index if not exists referral_credits_trader on public.referral_credits (trader, created_at desc);

-- Referrers the owner has switched off (abuse). A revoked referrer earns nothing from then on, and the export shows their earlier
-- credits as void. The owner adds a row here by hand; the app never does.
create table if not exists public.referral_revocations (
  referrer   text   primary key,
  reason     text   not null default '',
  revoked_at bigint not null
);

alter table public.referral_bindings enable row level security;
alter table public.referral_credits enable row level security;
alter table public.referral_revocations enable row level security;
