# ACT — Live Mainnet Mint Record

**Status:** ✅ Live on Solana mainnet, 2 Sept 2026. All parameters locked and verified on-chain. Deployed under the ticker ACC and issued by Aretia Climate Coin LLC; both renamed 4 Sept 2026 to ACT / Aretia Finance LLC (Delaware amendment in progress — see `ENTITY_RENAME_BRIEF.md`). No on-chain metadata was ever set for the old symbol, so nothing about the deployment below changes; this is a documentation and legal-name update only.

| Field | Value |
|---|---|
| Mint address | `BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT` |
| Program | Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) |
| Decimals | 9 |
| Total supply | 100,000,000 (fixed, permanent) |
| Mint authority | Revoked — not set, cannot be reinstated |
| Freeze authority | Never granted |
| Transfer fee | 410 bps (4.1%) |
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

Public addresses and transaction data only. No private keys, seed phrases, or personal information belong in this file or this repository, ever.
