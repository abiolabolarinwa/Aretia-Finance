# Verified by Aretia: what it means

The badge is a record of four checks that Aretia ran on one day. Nothing more.

## What it means

On the date shown, Aretia checked that:

1. **The supply is fixed.** No one can create more of the token.
2. **Special powers are given up.** Solana: the mint authority and the freeze authority are gone, and the mint has no transfer-fee, permanent-delegate, transfer-hook or frozen-by-default extension. Ethereum-style chains (BNB Chain, Ethereum, Polygon): the token's code has no mint, pause, owner, ownership-transfer or blacklist function.
3. **The project link matches the claim.** A person at Aretia checked that the project link and the creator named in the request are the ones the token points to.
4. **A locked pool exists.** A trading pool or curve for the token exists and its liquidity is locked, checked on the chain.

## What it does NOT mean

- It is not a security audit of the token, a pool or a project.
- It is not an endorsement, and not investment advice.
- It does not say the price will hold, that the team is trustworthy, or that nothing can go wrong.
- It describes only the day it was checked. Anything can change afterwards (a pool's lock can be a timed lock that ends; a project's website can change hands).
- It cannot be bought. Asking for it, or paying for other Aretia services, does not get it. Aretia can say no, and a failed check is not hidden.

The same words are in the badge's tooltip and dialog (`src/lib/verified.ts`, `DEFINITION`). If this document and that file disagree, fix the file to match this document.

## How the checks are run

| # | Check | How | Who |
|---|---|---|---|
| 1 | Supply is fixed | `node scripts/verify-token.mjs <chain> <address>` | script |
| 2 | Powers given up | same command | script |
| 3 | Project link matches | read the project site and the token's metadata or explorer page; record what was compared | a person |
| 4 | Locked pool exists | open the pool on the explorer or the pool's own page and confirm the lock; record the address | a person |

The script is read-only: it asks a public node, uses no key and sends nothing. Use `--out evidence.txt` to save the report.
It exits 0 only when checks 1 and 2 both pass. Its limits, plainly:

- On Ethereum-style chains it looks for function selectors in the contract's code. That catches the usual ways of keeping control, but it is a scan, not a proof: code can hide a power (a proxy, a hidden function). A person reads the code or its verified source before the badge is granted.
- It reads the mint account as it is now. A Token-2022 extension it does not know is not flagged, so an unfamiliar extension list is a reason for a person to look.
- A token that fails is not badged. For example, ACT itself has a Token-2022 transfer fee by design, so check 2 fails for it, and it would not carry this badge. The badge is not a statement about whether a design choice is good, only about which powers exist.

## Recording a token

1. Run the script and save the report.
2. Do checks 3 and 4 and write down what was compared.
3. Publish the report and notes at an https address (for example a file under `website/public/docs/verified/`).
4. Add an entry to `src/data/verified.ts` with the token, chain, date, all four check keys and the evidence link. An entry that is missing a check, has a bad address, or has a non-https link is skipped by the site, never shown half-formed.

To withdraw a badge, delete the entry. Do it as soon as a check would no longer pass, and say so.

## Where the badge shows

The token page, Launch "done" screens, Radar (detail and rows), and the Markets table. Other code reads `verifiedFor(VERIFIED, chain, address)` from `src/lib/verified.ts`, or draws it with `verifiedBadge(chain, address)` from `src/lib/verifiedBadge.ts`, which returns `null` for any token not on the list. The public list and the request form are at `/verified`.

## Requests

The form at `/verified#request` collects the token address, network, project link and an email. It takes no payment. Any price for the service is a decision for the owner and is not set or collected here.
