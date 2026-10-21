-- Referral credits: one spelling per EVM transaction hash (audit 2026-10, M-1). Safe to run more than once.
--
-- An EVM node reads a transaction hash in any letter case, but the primary key (chain, tx, asset) compares text exactly, so the
-- same fee payment could be stored, and credited, once per spelling. The API now lower-cases EVM hashes before it stores or reads
-- them. This migration merges the copies already stored and makes the database refuse anything else.
-- Solana signatures are base58, where case matters: they are never changed.

-- 1. For each EVM payment stored under several spellings, keep one row: a row already paid first, then a credited row, then the
--    earliest stored. The others are deleted (their shares were never owed: they are copies of the same payment).
with ranked as (
  select ctid,
         row_number() over (
           partition by chain, lower(tx), asset
           order by (paid_at is not null) desc, (status = 'credited') desc, created_at asc, tx asc
         ) as rn
  from public.referral_credits
  where chain <> 'solana'
)
delete from public.referral_credits c
using ranked r
where c.ctid = r.ctid and r.rn > 1;

-- 2. Store what is left in lower case.
update public.referral_credits set tx = lower(tx) where chain <> 'solana' and tx <> lower(tx);
update public.referral_credits set swap_tx = lower(swap_tx) where chain <> 'solana' and swap_tx is not null and swap_tx <> lower(swap_tx);

-- 3. From now on an EVM hash can only be stored in lower case.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'referral_credits_evm_tx_lower') then
    alter table public.referral_credits add constraint referral_credits_evm_tx_lower check (chain = 'solana' or (tx = lower(tx) and (swap_tx is null or swap_tx = lower(swap_tx))));
  end if;
end $$;

-- 4. The per-trader and per-referrer cap queries filter by status and the transaction's time.
create index if not exists referral_credits_referrer_tx_at on public.referral_credits (referrer, status, tx_at desc);
create index if not exists referral_credits_trader_tx_at on public.referral_credits (trader, status, tx_at desc);
