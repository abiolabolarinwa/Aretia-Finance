# Aretia Shield

"Know before you sign." The wallet's Shield page (`#/shield`) reads public data about something a person is about to trust and says what it found as a colour (the same five as the Aretia rating): green, yellow, orange, red, and grey for "could not tell". It never says "safe". Green means no problems were found among the things it could check, and every result lists what it could not.

## What it does

**Check** (`src/swings/shield/check.ts`, page: `src/scripts/walletShield.ts`). Paste anything:
- a Solana address: exists or not, who owns the account (a person's wallet, a program, a token, a token account), how long it has been active and how busy it is, SOL balance. A burn address is red. `.sns` names are resolved first.
- an Ethereum-style address: on each of the eight networks, contract or wallet, transactions sent, funds held. A mixed-case address whose capital letters fail the EIP-55 checksum is red (mistyped or altered). A contract is named when it is a router Aretia routes through, flagged as upgradable when it is an EIP-1967 proxy.
- a token: Aretia's rating (the same engine as the Markets list), the market (DexScreener), and whether the liquidity is burned or locked. Stablecoins and wrapped coins (the same list that carries the swap fee, `core/feeAssets.ts`) are shown as "major assets": their admin powers are notes, not warnings.
- a link: look-alike letters, the same name on another ending, a real name hidden inside a fake one, the `@` trick, bare numbers, special characters, plain http, shorteners, scam words, cheap endings, and the age of the domain from its public registration record (RDAP). Only a brand's own address is labelled with its name.

Every result can be copied as a link (`#/shield/<what was checked>`, which re-runs the check live and carries nothing private), copied as a text summary, or downloaded as a picture. A token can be opened in Swap, watched, or saved; an address can be saved as trusted with a name.

**Guard** (`guard.ts`, used by Pay). Before the wallet is asked to sign a send, the recipient is compared with the addresses saved or sent to on this device. A copy-cat (same first and last three or more characters, different address: address poisoning) is a problem and needs a ticked box; a first-time recipient is a note. Sent-to addresses are remembered after a send. The book is per connected wallet and kept in this browser only.

**My wallet** (`health.ts`, `walletShieldTx.ts`). A Solana wallet is scanned for standing permissions (a token delegate), risky or no-market tokens (the held tokens are rated, up to 14 at a time), frozen accounts, empty token accounts that can be closed to get their rent back, and very low SOL. Two fixes are offered, each simulated first and signed by the person's own wallet: take a permission back (SPL Token `Revoke`) and close empty accounts (`CloseAccount`, 12 to a transaction). Any address can be scanned read-only; fixing needs the wallet to be the connected one.

**Approvals** (`approvals.ts`). For an Ethereum-style address, the allowance of the wrapped coin and stablecoins to each venue's router and to Permit2, on all eight networks, read in one Multicall3 call per network. Taking one back sends `approve(spender, 0)` through the connected wallet.

**Watching** (`watch.ts`). A token, address or link can be watched. While the page is open and visible it is re-checked at most every 15 minutes, and the bell rings only when something got worse: the colour moved toward red, a new problem or caution appeared, or a liquidity lock was no longer found. Nothing runs when the page is closed.

## What it cannot see (and says so)

- Who owns an address. There is no scam-address database.
- Whether a linked page is itself honest, and any scam-site blocklist. Link checks are heuristics.
- Approvals to contracts it does not know, or for tokens it was not asked about: that needs a full transaction index.
- How old an Ethereum-style wallet is.
- Anything on a network or node that did not answer: the result says how many.

A note on the data: the public Solana node (`solana-rpc.publicnode.com`) silently returns an empty transaction history and blocks token-account listing. Shield asks the Solana Foundation's node for history when the first answer is empty, and falls back to it for token accounts. In production the `/api/rpc` proxy answers first.

## Tests

`src/swings/shield/*.test.ts` (engine, look-alikes, links, health, approvals including the Multicall3 encoding, watching, the guard). `shield.live.ts` is the read-only proof against the real networks, including that Multicall3 gives the same allowances as asking the token directly:

```
npx vitest run --config vitest.live.config.ts src/swings/shield/shield.live.ts
```
