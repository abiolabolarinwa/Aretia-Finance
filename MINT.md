# ACT — Live Mainnet Mint Record

**Status:** ✅ Live on Solana mainnet, 2 Sept 2026. All parameters locked and verified on-chain. Deployed under the ticker ACC and issued by Aretia Climate Coin LLC; both renamed 4 Sept 2026 to ACT / Aretia Finance LLC (Delaware amendment in progress). No on-chain metadata was ever set for the old symbol, so nothing about the deployment below changes; this is a documentation and legal-name update only.

| Field | Value |
|---|---|
| Mint address | `BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT` |
| Program | Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) |
| Decimals | 9 |
| Total supply | 100,000,000 (fixed, permanent) |
| Mint authority | Revoked — not set, cannot be reinstated |
| Freeze authority | Never granted |
| Transfer fee | 410 bps (4.1%) now; 350 bps (3.5%) confirmed on-chain for epoch 1031, takes effect automatically — see below |
| Transfer-fee-config authority | Treasury vault (`3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg`) |
| Withheld-withdraw authority | Treasury vault (`3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg`) |
| Full supply holder | Treasury vault |

Verified independently on [Solscan](https://solscan.io/token/BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT) as well as via CLI. Also independently checkable by anyone, live, with no tool install required: `website/verify.html` queries mainnet directly from the visitor's own browser and checks every row in the table above against real on-chain state — parses the raw Token-2022 account bytes itself (no third-party parsing library), so the logic is short enough to actually read. Not a substitute for the independent program review below — see the page's own footer for what it can't check.

## Deployment sequence (for the record)

1. Created mint with 4.1% transfer-fee extension, deployer as initial authority.
2. Minted full 100,000,000 supply directly to the treasury vault's associated token account — never touched a personal wallet.
3. Transferred transfer-fee-config and withheld-withdraw authorities to the treasury vault.
4. Permanently revoked mint authority.

The disposable deployer keypair (`ETpFf19TbxHG4cBiq38SMWbdxvG3L8VapcW2uH52tAdC`) used to pay fees and initiate these transactions holds no ongoing authority, no tokens, and no lasting power over ACT — it can be discarded.

## Still open

- [ ] No liquidity pool exists yet — ACT is not tradeable anywhere.
- [ ] No exchange listing.
- [ ] Independent program review — this deployment skipped the formal audit called for in the roadmap, by deliberate decision, given time constraints. Worth revisiting before liquidity is seeded.
- [ ] Transparency dashboard not yet built.

## Permanently closed: on-chain metadata (name, symbol, logo)

**Confirmed 4 Sept 2026, empirically, not from documentation alone.** The mint has no on-chain name, symbol, or logo — wallets, explorers, and scanners (e.g. RugCheck) show it as an unverified/unnamed token. This cannot be fixed. Both routes to attaching it require an authority this mint permanently gave up:

- **Token-2022's native metadata extension** requires a `MetadataPointer` extension, which is fixed-length and must be reserved in the account's byte layout at creation. A live read of the mint account (`scripts/management-fee-proposal/check-metadata.mjs`) confirms it is exactly 278 bytes, containing only the `TransferFeeConfig` extension — no metadata pointer slot exists, and none can be added to an already-finalized mint.
- **The separate Metaplex Token Metadata program** requires the mint's current authority to sign the instruction that creates it. Ours is `None` (revoked 2 Sept 2026), so no signer can ever satisfy that check.

This is the direct, permanent cost of the mint-authority revocation — the same irreversibility that makes "mint authority: revoked" a real, verifiable claim (see `website/verify.html`) also closed this door. The practical mitigation is not fixing the token's on-chain identity, but making the real identity easy to find anyway: the whitepaper, `MINT.md`, and the live verification page are what a visitor should be pointed to when a scanner shows "unverified."

## Still open: the transfer fee rate is NOT permanently fixed

**Confirmed 6 Sept 2026, empirically** (`scripts/management-fee-proposal/check-fee-authority.mjs`), because this is the natural next question once mint authority's revocation is understood: revoking mint authority fixes *supply*, but the transfer-fee rate is a separate on-chain field with its own separate authority, and that one was **not** revoked.

- `transfer_fee_config_authority` on the live mint is `3FyoJdvC7FaZDEt5YoLHF3PB2xo3vtp4GWTBTN6cyzZg` — the Aretia Treasury Squads multisig itself (2-of-3), not `None`, not a single wallet, not left over from deployment.
- `withdraw_withheld_authority` is the same multisig.
- Live on-chain rate confirmed, still true as of 6 Sept 2026: 410 basis points (4.10%). `withheld_amount` is currently 0 — no trading has occurred yet, so there is nothing "already collected at the old rate" to reconcile if the rate changes now.
- Token-2022 will not let a rate change apply retroactively or instantly: a `SetTransferFee` instruction schedules a new rate that only takes effect starting from a future epoch, giving a mandatory on-chain notice window.

Practical upshot: the 4.1% rate — and by extension the fee split derived from it (Section 5.2 of the whitepaper) — **can** be changed, but only through the same 2-of-3 multisig approval that governs every other treasury action, never unilaterally. It is exactly as changeable as anything else the treasury multisig controls, and exactly as protected: no single signer, including the founder, can move it alone.

One further clarification this check surfaced: Token-2022's transfer-fee extension only enforces the *aggregate* withheld rate on-chain. It has no native concept of splitting that withheld amount into named destinations. The 2.0% / 1.0% / 1.0% / 0.1% breakdown that was live when this check was run is the treasury's own harvest-and-route procedure, not a second on-chain-enforced ratio — there is no custom program on this project that would make it one. That distinction matters for anyone evaluating exactly what "enforced by the mint's own configuration" does and doesn't cover.

**6 Sept 2026 — rate change approved and executed, scheduled for epoch 1031.** The design was changed to remove the 1% burn allocation and raise the management fee from 0.1% to 0.5%, taking the aggregate rate from 4.1% to 3.5% (recipient net 95.9% → 96.5%). `WHITEPAPER.md`, the website, and `TOKENOMICS.md`/`PROTOCOL.md` describe 3.5%/350 bps as the current design.

A `SetTransferFee` proposal (`scripts/management-fee-proposal/propose-fee-change.mjs`) was submitted by the founder signer, approved 2-of-3 in Squads, and executed on 6 Sept 2026. Confirmed independently — not just from the Squads UI — by reading the executed proposal's actual instruction bytes (`verify-proposal.mjs`) and the mint's resulting fee schedule (`check-fee-authority.mjs`):

- Transaction: [`4YwPZzV3q5yrRvjydHQ9rSAxEwi2vt2qZ9QyexuLb3DfAenTx92gR5tJEhZMWjnQe3rWsWePZNAbcTFBbNc7KfLD`](https://solscan.io/tx/4YwPZzV3q5yrRvjydHQ9rSAxEwi2vt2qZ9QyexuLb3DfAenTx92gR5tJEhZMWjnQe3rWsWePZNAbcTFBbNc7KfLD)
- `olderTransferFee`: epoch 1027, 410 bps (still the rate actually charged on transfers today)
- `newerTransferFee`: epoch 1031, 350 bps (takes effect automatically once the network reaches that epoch — Token-2022 never applies a fee change retroactively or instantly)
- At the time of execution, current epoch was 1029; rough estimate ~1-2 days until epoch 1031 based on recent slot times, not a guarantee

`website/verify.html`'s fee-rate check is epoch-aware: until epoch 1031 arrives, it correctly reports the live rate as 410 bps with a note explaining the scheduled change. Once the epoch turns over, re-run `check-fee-authority.mjs` to confirm 350 bps is actually active before treating this section as fully closed.

This also reopened a securities-analysis question counsel had previously reviewed against the management fee's earlier 0.1% figure; it has not been re-reviewed at 0.5%, and that on-chain execution happened before that legal question was resolved.

Public addresses and transaction data only. No private keys, seed phrases, or personal information belong in this file or this repository, ever.
