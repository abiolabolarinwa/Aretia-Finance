# Aretia (ACT) — Liquidity Seed: One-Pager

**Status: Draft, 4 Sept 2026.** For internal use and direct one-to-one conversations only. **Not reviewed by counsel. Do not distribute publicly or post anywhere until it has been.** This document makes a direct, specific ask for capital — a materially different thing from the whitepaper, which was deliberately built to *not* solicit investment. Treat this one with more caution, not less.

---

## The ask

**$10,000 USDT**, to be paired with **5,000,000 ACT** (5% of the treasury's supply, already held — no new tokens minted) into a single ACT/USDT liquidity pool on Raydium, created and held directly by the Aretia treasury multisig. Implied starting price: **≈$0.002/ACT**. LP position locked for **6 months** from creation.

## What's actually live today, independently verifiable

| Fact | Where to check |
|---|---|
| 100,000,000 ACT fixed supply, mint authority permanently revoked | `BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT` on Solscan |
| Full supply held by the treasury vault since mint (never touched a personal wallet) | Same address |
| Treasury is a 2-of-3 Squads multisig, tested end-to-end with a real transaction | `3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg` |
| 3.5% protocol-enforced transfer fee, verified on-chain | Mint's TransferFeeConfig extension |
| In-page swap widget live, wired to the real mint | aretiacoin site, "Buy ACT" |

Nothing above is a claim you have to trust; all of it is on-chain state.

## How the money actually moves

This is not a purchase of ACT and not an investment in Aretia Finance LLC. It is a **liquidity contribution** to an automated market maker pool:

1. The $10,000 USDT and the treasury's 5,000,000 ACT go into the pool together, executed through Squads' native Raydium integration — the funds never pass through any individual's personal wallet, on either side.
2. In exchange, the contributor receives an **LP position** representing their proportional claim on the pool's two assets, plus a share of ordinary AMM trading fees generated as people swap ACT and USDT against the pool.
3. That LP position is locked for 6 months. It cannot be withdrawn early.
4. After the lock, the LP position can be redeemed for its proportional share of whatever the pool then holds (ACT and USDT, in whatever ratio the market has moved them to).

## What this unlocks

- ACT becomes actually tradeable for the first time — right now the mint and treasury are live but there is no market at all.
- The management fee wallet and catalyst fund begin accruing real capital from real trading volume, rather than sitting at $0.
- The in-page Buy widget (already built and wired to the mint) starts returning live swap routes automatically, with no further changes needed on that side.

## Risks — read before anything else

- **Impermanent loss.** If ACT's price moves significantly against USDT while capital is in the pool, the LP position can be worth less, in dollar terms, than simply holding the original $10,000 and 5,000,000 ACT separately. This is a standard, well-documented property of AMM liquidity provision, not specific to ACT.
- **No guaranteed return.** Trading fee income depends entirely on real trading volume, which does not yet exist and is not forecast here.
- **Six-month illiquidity.** The LP position cannot be exited, partially or fully, before the lock expires, regardless of what happens to ACT's price in the meantime.
- **ACT itself carries every risk described in the whitepaper's Risk Disclosure** (Section 12): it is a freely traded, speculative asset with no guaranteed value or floor.
- **This is not investment advice**, and nothing here is a forecast of what trading volume, fee income, or ACT's price will actually be.

## Next step

If this is of interest, the next step is a direct conversation, not a wire — final numbers, timing, and the exact Squads transaction get confirmed together before anything moves. Contact: `[to be added]`.
