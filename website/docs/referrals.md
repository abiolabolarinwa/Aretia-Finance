# Referrals for swap fees

Someone who brings a trader earns a slice of the Aretia swap fee that trader pays. Nothing is paid automatically: the owner pays by hand from a private export.

**Move USDC fees (21 Oct 2026).** A Move USDC move pays Aretia 0.1% of the amount moved, added on top, in USDC on the source chain. If such a fee transaction is reported, it is verified and credited exactly like a swap fee (20% share). This is deliberate: on EVM networks the move's fee is a separate USDC transfer to the fee address, which the chain cannot tell apart from a swap's separate fee transfer; on Solana it is the fee wallet's USDC rise inside the burn transaction. It is one payment in one transaction, so it is credited at most once (unique `(chain, tx, asset)`); the burn transaction itself pays the fee wallet nothing on EVM. The Move tab does not report move fees by itself today, so in practice they are credited only if a page reports them. Edge: a move of exactly 10,000 USDC pays exactly 10 USDC, which matches the flat EVM pool fee and is then not credited.

## The rules (all in one file: `src/swings/referrals/core.ts`, `REFERRAL_CONFIG`)

| Setting | Default | Meaning |
|---|---|---|
| `shareBps` | 2000 | The referrer gets 20% of **Aretia's fee** (0.58%), so about **0.116%** of the trader's swap. Aretia keeps 0.464%. |
| `windowDays` | 90 | A trader's swaps earn their referrer something for 90 days from the server-recorded link visit that bound them. |
| `dailyCapPerReferrer` | 200 | Credited swaps per referrer per 24 h. More are stored but earn nothing (`capped`). |
| `dailyCapPerTrader` | 40 | Same, per trader. |
| `dailyRowsPerTrader` | 80 | Rows of any status stored per trader per 24 h. Past it, reports are answered `daily-limit` and nothing is stored. |
| `washRepeat` / `washWindowMinutes` | 6 / 10 | 6 payments of the same asset and the same fee from one trader within 10 minutes look like a script: stored, earn nothing (`flagged`). |
| `maxTxAgeHours` | 6 | A swap must be reported within 6 hours of confirming. |
| `minimumPayoutUsd` | 25 | The minimum shown on the page. A promise made in words; the owner applies it by hand. |

Change a number, ship, done. Changes apply to swaps after the change; already-stored credits keep the share they were given.

**The trader pays the same 0.58% as everyone.** Nothing in the swap flow changed: `fee.ts` and the fee transfer are untouched. The referrer's share is a bookkeeping line carved out of Aretia's fee after the fact.

## How it works

1. **Link.** `https://aretiafinance.org/?ref=<address>` on any page. The page stores only the address, the time and an expiry in the visitor's browser (`localStorage`, no cookie, no banner needed), and asks the server once for a **capture** (`op: capture`, no sign-in): an HMAC-signed token saying which referrer the link named and when the server first saw the visit. First touch wins: a later link does not replace an unexpired one. Pages without `?ref=` load nothing extra.
2. **Report.** After a swap confirms, a browser that holds a referrer queues the swap's fee transaction(s) and reports them to `/api/swings-referrals` (`op: record`). This needs the wallet sign-in the account features already use (a free signed message, no password), so a stranger cannot bind a trader to a referrer: only the trader's own signature binds them. A new binding needs a valid capture; it starts at the capture's time, and **no transaction made before it is credited** (`before-binding`). Reports are limited to 6 per minute per signed-in owner and 20 per IP. If the trader is not signed in, the report waits (up to 6 hours) and the Referrals page asks them to sign in.
3. **Verify on chain.** The server never believes the browser about money. EVM hashes are lower-cased (and anything that is not a 32-byte hex hash refused) before they are compared, stored or read; Solana signatures are kept exactly as written. It reads each transaction from a public node, and only once it is final: Solana at `finalized` commitment, EVM chains under `EVM_CONFIRMATIONS` blocks (`api/_referralVerify.ts`: Ethereum 64, BNB 30, Polygon 64, Base 60, Robinhood 480). Until then the answer is `pending` and the page reports it again later.
   - Solana: the trader signed it, it succeeded, and Aretia's fee wallet's balance (SOL, or USDC/USDT) went up in it. The rise is the fee.
   - EVM: it succeeded and either the trader sent the native coin to the fee address, or ERC-20 `Transfer` logs move a fee asset from the trader to the fee address. Those amounts are the fee.
   - Only assets that carry the fee (`isFeeAsset`) count. The client-supplied amount is ignored.
4. **Credit.** One row per fee payment `(chain, tx, asset)`, unique, so a payment is credited once. Share = 20% of the verified fee, rounded down, in the smallest unit.
5. **Referrer page** (wallet sidebar, "Referrals"): the link, how many people they brought, estimated volume, and what they are owed per chain and coin. It reads only the signed-in address's own rows.
6. **Owner export** (`node scripts/referral-export.mjs`, with the database service key on the owner's machine): who is owed what, per chain and coin. It counts each on-chain payment once (EVM hashes grouped by lower case) and, by default, **re-reads every unpaid payment from the chain before listing it**: anything that is missing, failed or not final at the same depths is left out and printed separately (`--no-recheck` skips this).

## Why inventing volume does not pay

A credit exists only for a fee that really reached Aretia's fee wallet, and the referrer receives 20% of it. Fake volume therefore costs the faker 100% of the fee plus gas to earn 20% back. The extra checks (self-referral, mutual referral, caps, bursts, revoke) cover the remaining cases, mostly nuisance and data-quality ones.

- **No self-referral:** the referrer address may not equal the trader address (any letter case). Two addresses naming each other are refused as well. Longer loops are not detected; they lose money for the same reason.
- **Same family only:** an Ethereum-style address earns on Ethereum-style networks, a Solana address on Solana. A swap whose referrer cannot be paid on that chain is stored as `family` and earns nothing. (Registering a payout address per family is a possible later step.)
- **Revocation:** the owner inserts a row in `referral_revocations`. From then on the referrer earns nothing, the referrer page shows nothing owed, and the export lists their earlier credits as void.

## Payouts (said plainly on the referrer page)

By the owner, by hand, on a schedule the owner sets, in the coin each amount is owed in, to the address the referrer signed in with, once what is owed is worth at least about $25. After paying, mark rows paid (SQL in the header of `scripts/referral-export.mjs`). No code sends money.

Terms shown on the page: no guarantee of any amount or that the programme continues; Aretia may change or stop it (changes apply to later swaps); only swaps that really paid the fee count; daily limits and automated-looking swaps earn nothing; misuse voids earnings; figures are estimates, not advice, and tax is the referrer's own.

## Data

Migration `supabase/migrations/0013_referral_tx_case.sql` merges credits stored under several letter cases of one EVM hash (keeping a paid row, else a credited row, else the earliest), lower-cases the rest, and adds a check that EVM hashes are stored lower-case. Run it once after deploying this version (before the next export). Migration `0014_auth_nonces_and_pruning.sql` is needed for the sign-in the referral page uses.

Migration `supabase/migrations/0011_referrals.sql` adds `referral_bindings`, `referral_credits`, `referral_revocations`. Row-level security is on with no policy; only the service role (the api function, and the owner's export) can touch them. Stored: addresses, transaction hashes, amounts, times. No names, emails or IP addresses.

**Until the migration is applied the feature is inert:** the api answers 502 and nothing is recorded; swaps and fees are unaffected. Apply it with:

```bash
cd website && SUPABASE_DB_URL="postgresql://..." npm run db:migrate
```

(or paste `supabase/migrations/0011_referrals.sql` into the Supabase SQL editor; it is safe to run twice).

## What is NOT verified

- A real swap crediting a real referrer end to end. Everything is tested with a fake database and fake chain nodes shaped like the real responses; none of it has run against Supabase, a live node, or a real swap.
- **EVM batched sends** (wallets that send approval, fee and swap as one EIP-5792 batch): the page reports the batch's returned hash. If that is not a transaction hash whose receipt shows the fee `Transfer`, the swap is not credited. Separate-transaction wallets report the fee transaction's own hash and are expected to work.
- Public nodes may be slow or rate-limited; a transaction that cannot be read yet is retried until it is 6 hours old.
- The per-day caps are read-then-write; two simultaneous reports can overshoot a cap by a swap or two. The per-owner and per-IP rate limits are kept per server instance.
- **Self-referral with a second wallet** is still possible: a person can open their own link from another wallet, then swap. The capture only guarantees that nothing before the visit is credited and that the trader and referrer differ; such a pair gets 20% of its own fee back (never more, since a payment is credited once). Revoke on sight.
- The server reads the EVM fee address from `PUBLIC_ARETIA_EVM_FEE_ADDRESS` if set, else the address in this repo; if the live build used a different address, set the variable.
