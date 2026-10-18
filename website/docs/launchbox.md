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

## Set-up (owner)

Run migration 0012 once. Until it is run the page says "Launch Box is being set up" and lists nothing.

```
SUPABASE_DB_URL=postgresql://... npm run db:migrate
```

## What is not proven

A real creation has not been indexed end to end: when this was built, none of the three factories had created a token (each factory's nonce was 1) and the fee wallet showed no transactions. The Solana and EVM readers are tested against fabricated transactions and logs shaped like the real ones. The Solana rule cannot tell a token made with the Launch page from one built by hand with the same instructions. Solana curves are not on mainnet, so no Solana curve is shown. Reorgs: an EVM log is trusted after 2 (Ethereum), 3 (BNB) or 12 (Polygon) confirmations and never removed afterwards.
