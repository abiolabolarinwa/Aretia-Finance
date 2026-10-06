# Audit scope: Aretia Swings

Status: **prepared, not frozen.** No commit has been made for this work, so there is no production commit to freeze yet. Before an audit starts: commit, run the full checks, then tag that commit (for example `swings-audit-1`) and give the auditors that tag only.

## In scope (Aretia-developed code)
- `website/src/swings/**`: core types, fee policy, router, chain adapters, providers, token registry, discovery, risk engine, telemetry, cross-chain interfaces
- `website/src/scripts/walletSwings.ts` (UI) and the Swings changes in `walletApp.ts`, `walletSwap.ts`, `walletTools.ts`
- `website/api/{swings-0x,swings-tokens,swings-discover}.ts` and their `_` cores
- `website/supabase/migrations/0001_token_registry.sql`, `0002_swings_events.sql`
- `website/api/{swings-status,swings-events}.ts` and their `_` cores; `website/src/swings/{runtime,history,live}.ts`, `chains/evmSession.ts`, `core/{keccak,mev}.ts`, `observability/beacon.ts`
- Existing Solana swap path that Swings reuses: `walletSwap.ts`, `walletSend.ts`, `walletTools.ts`

## Out of scope
- Third-party contracts and programs (Jupiter, DEX programs, 0x settlement contracts, ERC-20/SPL tokens). Aretia did not write or audit these.
- Third-party services: Jupiter API, 0x API, GeckoTerminal, Supabase, RPC providers, Vercel.
- The Aretia wallet extension and ACT on-chain programs (not in this repository's Swings code).
- `wallet.js` (wallet connection, existing).

## What does not exist yet (do not audit as if it did)
A tested EVM swap (the code exists but has never sent a transaction), the ACT buyback executor, cross-chain execution, protected transaction submission.

## Questions for auditors
1. Is `judgeSwapSimulation` sufficient against a hostile Jupiter instruction set?
2. Is the router's once-per-quote guard sound against races and wallet quirks?
3. Is the discovery pipeline safe against hostile metadata and hostile contracts?
4. Are the server endpoints safe against abuse and information leakage?
