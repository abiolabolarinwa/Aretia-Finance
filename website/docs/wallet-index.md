# Aretia wallet index

Aretia's own answer to "which tokens does this wallet hold", instead of a paid provider.

## Decision (owner, 2026-11-14)

A wallet starts afresh with Aretia: the index records what a wallet **receives from the moment it first connects**. It does not rebuild history
from before that. Free public nodes cannot answer a full-history question (tested 2026-11-14 on seven BNB Chain nodes: archive refused or
a key needed, ranges capped at 50 to 10,000 blocks, `eth_getLogs` refused or limited), so a "complete past" would need a paid provider or our own
archive node. This design needs neither for new activity.

## How it works

1. **Register.** When a wallet connects, the site asks to watch it. Its `since_block` is the chain's current block.
2. **Index.** A worker reads the chain's `Transfer` events whose receiver is a watched wallet (`scan.ts`: one `eth_getLogs` call names many
   wallets; ranges are cut to the node's limit and halved if refused), and records each `(wallet, token)` in `wallet_tokens`.
3. **Read.** The dashboard asks for the wallet's tokens, then checks each one's balance on the chain (Multicall3, as today) and prices it.
   The table only says "look at this token"; it never stores a balance.

## What is built

- Tables `wallet_watch`, `wallet_tokens`, `wallet_cursor` (migration `0023`), allowed through the data server's web entry.
- `src/swings/walletIndex/scan.ts`: the range scanner, tested against a fake node.

## What is not built yet

- The worker that runs the scan on a timer and writes the tables (reuses the Market Indexer's per-chain node settings, `MI_RPC_<CHAIN>`).
- The routes that register a wallet and return its tokens (in the shared `swings-data` function; the site is at Vercel's 12-function limit).
- The dashboard using the index (as one more source beside the on-chain scan).

## Known limits

- Tokens received **before** a wallet first connected are not indexed. The existing on-chain scan of Aretia's market index, the outside list and
  "swapped through Aretia" history still find some of them; the rest need the person to add the token by address.
- Reading all recent logs needs a node that allows it. Public nodes mostly refuse address-less ranges; a node of our own (or a keyed provider) is
  needed for the worker to run reliably.
- Tokens sent to a wallet are indexed too, spam included; the dashboard's airdrop tagging applies on top.
