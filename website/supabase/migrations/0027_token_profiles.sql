-- Free token profiles (website/docs/token-profiles.md): a description, links and a logo that a token's creator publishes for its page in
-- Markets. Free, and never bought: there is no price, payment or paid tier, and no list or ranking reads this table.
--
-- token_profiles: one row per submission.
--   status 'live'     shown on the token page (at most one per token);
--          'pending'  waiting for the owner's review (at most one per token and wallet);
--          'rejected' turned down or replaced; kept for the record.
--   proof  'authority' published by a wallet the chain shows controls the token (mint / update authority, or owner());
--          'review'    approved by the owner by hand in the admin page.
-- token_profile_blocks: tokens whose profile the owner removed. Nobody can publish for them again until the owner allows it.
--
-- Access: row level security is on. Anyone (the public anon key) may read the public columns of LIVE profiles only; who submitted or
-- reviewed a profile is never public. Nobody but the server (service role, which bypasses row level security) can write.
-- Safe to run more than once.

create table if not exists public.token_profiles (
  id           bigint generated always as identity primary key,
  chain        text   not null check (chain in ('solana','ethereum','bnb','polygon','base','robinhood')),
  address      text   not null check ((chain = 'solana' and address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') or (chain <> 'solana' and address ~ '^0x[0-9a-f]{40}$')),
  status       text   not null check (status in ('live','pending','rejected')),
  proof        text   not null check (proof in ('authority','review')),
  submitted_by text   not null check (submitted_by ~ '^(solana:[1-9A-HJ-NP-Za-km-z]{32,44}|evm:0x[0-9a-f]{40})$'),
  description  text   not null default '' check (char_length(description) <= 500),
  website      text   check (website is null or (char_length(website) <= 120 and website like 'https://%')),
  x            text   check (x is null or (char_length(x) <= 120 and x like 'https://%')),
  telegram     text   check (telegram is null or (char_length(telegram) <= 120 and telegram like 'https://%')),
  discord      text   check (discord is null or (char_length(discord) <= 120 and discord like 'https://%')),
  logo         text   check (logo is null or (char_length(logo) <= 300 and logo like 'https://%')),
  created_at   bigint not null,  -- ms
  updated_at   bigint not null,  -- ms
  reviewed_by  text,
  reviewed_at  bigint,
  note         text   check (note is null or char_length(note) <= 300)
);
create unique index if not exists token_profiles_one_live on public.token_profiles (chain, address) where status = 'live';
create unique index if not exists token_profiles_one_pending on public.token_profiles (chain, address, submitted_by) where status = 'pending';
create index if not exists token_profiles_queue on public.token_profiles (status, created_at);
create index if not exists token_profiles_by_wallet on public.token_profiles (submitted_by, updated_at);

create table if not exists public.token_profile_blocks (
  chain      text   not null check (chain in ('solana','ethereum','bnb','polygon','base','robinhood')),
  address    text   not null,
  blocked_at bigint not null,
  blocked_by text   not null,
  reason     text   check (reason is null or char_length(reason) <= 300),
  primary key (chain, address)
);

alter table public.token_profiles enable row level security;
alter table public.token_profile_blocks enable row level security;

-- Public read: live profiles only, and only the columns meant for the page.
drop policy if exists token_profiles_public_read on public.token_profiles;
create policy token_profiles_public_read on public.token_profiles for select to anon, authenticated using (status = 'live');
revoke all on public.token_profiles from anon, authenticated;
grant select (id, chain, address, description, website, x, telegram, discord, logo, proof, updated_at) on public.token_profiles to anon, authenticated;
revoke all on public.token_profile_blocks from anon, authenticated;

-- PostgREST caches the schema: ask it to reload so the new tables can be used at once.
notify pgrst, 'reload schema';
