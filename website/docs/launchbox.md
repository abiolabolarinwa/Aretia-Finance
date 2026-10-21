# Launch Box

A market of every token created through Aretia Launch, in the wallet (sidebar: Launch Box, `#/launchbox`). Each row opens the public token page, `/token#/<chain>/<address>`.

## How tokens are found (nothing a browser sends is used)

| Chain | Source | Accepted when |
| --- | --- | --- |
| BNB Chain, Ethereum, Polygon | the Aretia factory's `TokenCreated` event, read from confirmed blocks after a stored block number | the log comes from that chain's factory with the event's topic and decodes |
| the same three | the factory's own creation count (its contract nonce): token _n_ lives at a computable address | the address has code; name, symbol, decimals and supply are read from the token itself |
| Solana | new signatures of the fee wallet `2tcBrd1J…VoZX2` | one transaction holds BOTH a System transfer of exactly 50,000,000 lamports to the fee wallet from a signer AND a Token-2022 `InitializeMint` for a mint that the same transaction created. Names are read from the mint's own metadata, never from the transaction |

The creation count is also a check: the API reports, per chain, `expected` (what the factory has made) and `indexed` (what is stored), and the page says when they differ. Free public nodes refuse old log queries (BNB serves about the last 5,000 blocks), so for tokens older than a node's window the creator, time and transaction are unknown unless `EVM_RPC_BNB`, `EVM_RPC_ETHEREUM` or `EVM_RPC_POLYGON` point at a provider with history; the row then shows a dash for its age.

Run it: `GET /api/launchbox-run` with `Authorization: Bearer $CRON_SECRET` (Vercel's cron sends that itself, once a day, `vercel.json`). It also catches up by itself when someone opens Launch Box and the index has been quiet for five minutes. For a five-minute schedule from Supabase, run `supabase/cron/launchbox-every-5-minutes.sql` once (optional).

## What the public list shows (Solana)

A Solana creation is two transactions, and the first leaves the creator holding the mint authority with nothing minted. Every creation the indexer accepts is stored, with where it stands (migration 0015):

| State | Shown? | How it changes |
| --- | --- | --- |
| pending (nothing minted, or a mint authority still set) | no | shown once a read finds the supply minted, the authority gone and the rest of the launch rule kept |
| never checked (`checked_at` empty) | no | the next read decides |
| failing once (`fail_count` 1) | as before | a good read resets the count |
| hidden (`hidden_at`, `hidden_reason`) | no | after two failing reads in a row; shown again as soon as a read finds the mint keeping the rule |

Nothing is ever deleted, so a node that answers wrongly once cannot take a token off the list, and a creator who finishes the second transaction after the three-day pending window is listed when that read comes. Every run re-checks stored Solana tokens with a share of the time of its own (35% of the run by default): pending, hidden, never-checked and never-minted rows first, then every row a hundred at a time, carrying on from where the last run stopped (`recheckAfter` in the cursor's stats), so a list of any length is covered.

The schedule: Vercel's cron runs the indexer once a day (`0 4 * * *`). A more frequent Vercel cron needs a paid plan, so it is not set here; `supabase/cron/launchbox-every-5-minutes.sql` (optional) and the page-visit catch-up make it more often. The daily cadence is safe because `/api/launchbox` lists only rows that are not pending, not hidden and, on Solana, already read and found keeping the rule: an unchecked token waits for a run rather than being shown.

## Set-up (owner)

Run migrations 0012 and 0015 once. Until 0012 is run the page says "Launch Box is being set up" and lists nothing; with 0012 but not 0015 it says the same (the list asks for 0015's columns). After 0015, Solana rows stored earlier are not shown until the indexer has read them once (the next run, or the catch-up when someone opens Launch Box).

```
SUPABASE_DB_URL=postgresql://... npm run db:migrate
```

## What is not proven

A real creation has not been indexed end to end: when this was built, none of the three factories had created a token (each factory's nonce was 1) and the fee wallet showed no transactions. The Solana and EVM readers are tested against fabricated transactions and logs shaped like the real ones. The Solana rule cannot tell a token made with the Launch page from one built by hand with the same instructions. Solana curves are not on mainnet, so no Solana curve is shown. Reorgs: an EVM log is trusted after 2 (Ethereum), 3 (BNB) or 12 (Polygon) confirmations and never removed afterwards.
