-- Launch Box: where each stored token stands on the public list (re-audit of M-6, 2026-10). Safe to run more than once.
--
-- Nothing is deleted any more. A Solana creation between its two transactions is stored as pending and not shown. A token found breaking
-- the launch rule is hidden only after two reads in a row (fail_count), with the reason and time kept, and shown again when a later read
-- finds it keeping the rule. The public list (/api/launchbox) shows only rows that are not pending, not hidden and, on Solana, have been
-- read and found keeping the rule at least once (checked_at), so a daily indexer run never exposes an unchecked token.

alter table public.launchbox_tokens add column if not exists pending       boolean not null default false;
alter table public.launchbox_tokens add column if not exists hidden_at     bigint;
alter table public.launchbox_tokens add column if not exists hidden_reason text check (hidden_reason is null or length(hidden_reason) <= 200);
alter table public.launchbox_tokens add column if not exists fail_count    integer not null default 0 check (fail_count >= 0);
alter table public.launchbox_tokens add column if not exists checked_at    bigint;

-- Solana rows stored before this migration were never judged under these rules: a row with nothing minted is pending until the
-- indexer reads it again. Touches only rows never checked, so a second run changes nothing.
update public.launchbox_tokens set pending = true where chain = 'solana' and checked_at is null and (supply is null or supply = '0');

-- The public list, and the indexer's re-check (pending, hidden and unchecked rows first, then all of them in key order).
create index if not exists launchbox_tokens_public on public.launchbox_tokens (created_at desc nulls last) where not pending and hidden_at is null;
create index if not exists launchbox_tokens_recheck on public.launchbox_tokens (chain, key) where pending or hidden_at is not null or checked_at is null or fail_count > 0;
