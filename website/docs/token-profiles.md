# Free token profiles

A token's creator can add a description, links (website, X, Telegram, Discord) and a logo to the token's page in Markets. It is free, and it
never changes where a token ranks: no list, sort or score reads profiles (a test, `src/swings/profiles/core.test.ts`, fails if the market or
index code ever mentions them). It is separate from the hand-checked "Verified by Aretia" badge (`src/data/verified.ts`), which is unchanged.

## Who can publish (owner's decision, 2026-11-25)

- **The wallet that controls the token publishes at once.** Solana: its mint authority, its Metaplex metadata update authority, or its
  Token-2022 metadata update authority. Ethereum-style: the contract's `owner()` / `getOwner()`, or the wallet that created it through
  Aretia Launch (shown by the creation transaction). Read from the chain by the server, never taken from the browser.
- **Anyone else sends a request** that waits in the owner page (`/owner-admin`, section "Token profiles") until the owner approves it. Most
  pump.fun tokens have given up every authority, so this is how they get a profile. Before approving, check who sent it (for example that
  the sender's wallet created the token, on the explorer link shown).

The person signs in with one free message (the same wallet sign-in as the rest of Aretia); there is no transaction and no fee.

## What is refused automatically

Tokens named like a well-known token at another address; links that are not plain `https://` web addresses (no IPs, ports, passwords);
X, Telegram and Discord links to other sites; link shorteners; look-alike (punycode) hosts; hosts that use a wallet or exchange name
(MetaMask, Phantom, WalletConnect, Uniswap, PancakeSwap, Raydium, pump.fun, DEX Screener, Coinbase, Binance, Aretia) without being its real
site; hosts named like airdrop, claim or wallet-recovery pages; abusive words; invisible and direction-changing characters (removed); a
description over 500 characters; a logo that is not stored in Aretia's own picture bucket.

## What the owner can do

In the owner page: **Approve** or **Reject** a waiting request; **Remove and block token** for anything that impersonates, scams or is
adult content (takes the live profile and every request down, and nobody can publish for that token until **Allow again**). Only wallets in
`ADMIN_WALLETS` can do any of this; the server answers 404 to everyone else.

## Where things are

| Part | File |
| --- | --- |
| Rules (pure) | `src/swings/profiles/core.ts` |
| Server: `GET/POST /api/swings-profiles` (inside `swings-data`) | `api/_tokenProfiles.ts` |
| Table and access rules | `supabase/migrations/0027_token_profiles.sql` |
| Token page block and edit form | `src/scripts/walletTokenProfile.ts`, `src/scripts/walletMarketPanel.ts` |
| Owner review | `src/scripts/ownerAdminProfiles.ts` |

The database: anyone may read the public columns of **live** profiles; who sent or reviewed a profile is never public; only the server
(service role) writes. Logos use the existing Launch picture upload (Cloudflare R2, `docs/R2_LAUNCH_ASSETS.md`); without R2 set up, a
profile can still be published without a logo.

## Switching it on

Run migration `0027_token_profiles.sql` on the site database (the same way as the earlier ones). Until it is run, the token page shows no
profiles and saving one answers "could not be saved". Nothing else needs setting.
