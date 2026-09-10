# ACT v2 — Live Mainnet Mint Record

**Status:** ✅ Live on Solana mainnet, 10 Sept 2026. All parameters locked and independently verified on-chain, phase by phase, before proceeding to the next. Replaces the v1 mint (`BmaBEY6NDbLevUcU59Fgie8JHeqD4UjEFJda8LuSS2yT`, see `MINT.md`), rebuilt to fix v1's permanent lack of on-chain name/symbol/logo. v1 retirement is a separate, not-yet-written task.

| Field | Value |
|---|---|
| Name | Aretia Finance Protocol |
| Symbol | ACT |
| Mint address | `7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG` |
| Program | Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) |
| Decimals | 9 |
| Total supply | 1,000,000,000 (fixed, permanent) |
| Mint authority | Revoked — not set, cannot be reinstated |
| Freeze authority | Never granted |
| Transfer fee | 350 bps (3.5%) |
| Transfer-fee-config authority | v2 treasury vault (`GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA`) — see `TREASURY_V2.md` |
| Withdraw-withheld authority | v2 treasury vault (same address) |
| Full supply holder | v2 treasury vault's associated token account (`8CDckXxT8Ttz5P3jNzUhhrLiaBcVAHqxftKfNx5zNACY`) |
| Metadata standard | Metaplex Token Metadata only, bridged via Token-2022's MetadataPointer extension (see "Metadata design" below) |
| Metaplex metadata account | `7YeVTArd3DZ7aMJs46ZYZDSZiY8seB6g9h2geL4UvW4f` |
| Metadata URI (Arweave, permanent) | `https://gateway.irys.xyz/F3xUCKiXTiVtr864MV2CyaQpmBLHnaroqTE8TuTPHxF3` |
| Metadata mutability | Permanently immutable — `isMutable: false` set at creation |

## Metadata design (a deliberate change from the original plan)

The original plan was to use both Token-2022's native `TokenMetadata` extension and a separate Metaplex account. That changed during devnet testing, for two concrete reasons:

1. Metaplex's `createMetadataAccountV3` instruction (the older, legacy path) does not support Token-2022 mints — it fails with "Instruction not supported for ProgrammableNonFungible assets." `createV1`, the newer Token-2022-aware instruction, is what actually works, since it takes an explicit `splTokenProgram` and `tokenStandard` rather than assuming the classic SPL Token program.
2. Rather than duplicate content in two places, the mint's `MetadataPointer` extension points directly at the Metaplex metadata account (`7YeVTArd3DZ7aMJs46ZYZDSZiY8seB6g9h2geL4UvW4f`) instead of hosting a second copy on the mint itself. Its authority was set to `None` at creation, not revoked afterward — Token-2022's `Update` instruction for this extension can only ever change the target address, never the authority, so leaving a temporary authority here would have created an authority nothing could later revoke.

Net effect: any tool that reads Token-2022's `MetadataPointer` extension and follows it will land on the same Metaplex-hosted metadata that Solscan, Phantom, and other legacy tooling already read directly.

## Deployment sequence (for the record)

Each phase below was executed for real on mainnet and independently verified on-chain (not just trusted from the script's own success message) before the next phase ran. All five ran via `scripts/rebuild-mint/create-mint-v2.mjs`.

1. **create** — created the mint account (346 bytes, sized exactly, no later growth needed) with the `TransferFeeConfig` extension (3.5%, deployer as temporary authority) and the `MetadataPointer` extension (pointed at the not-yet-created Metaplex PDA, authority `None` from the start) plus the base mint (9 decimals, deployer as temporary mint authority, no freeze authority). Tx: `4uK4RxixsNh1MskeerZCjpgzjbwKfGbEkXLfcUVqEdgAw1Qe8nXdUWhH7CkqdcanCVfWUGu5MqviSvAuq6nTMosQ`
2. **metadata** — created the Metaplex metadata account via `createV1`, `isMutable: false`. Verified: name, symbol, and URI all correct; `MetadataPointer.metadataAddress` matches the computed Metaplex PDA exactly. Tx: `28hbjFV5LnkkrufCGvxTo4oLidMQ1gUwPQQRRNo8YFFYQpUf1VDeSYDsFumvrAZFyE9FSCJKBUxpy9ccP587dLXo`
3. **supply** — created the v2 vault's associated token account and minted the entire 1,000,000,000 ACT supply into it in a single instruction — the only mint-to instruction this mint will ever have. Verified: exact raw amount (`1000000000000000000`), correct owner. Tx: `4LCgx9jrymToqDAbwf3ZLBbxM22V4GdvVG7z4P6iMUR4KGt6eFZBy43zAiG36EyYu7nRqQKwPCXkAgXVMduZu1no`
4. **handoff** — transferred `transfer-fee-config` and `withdraw-withheld` authority from the deployer to the v2 treasury vault. Verified both authorities on-chain match the vault address exactly; mint authority confirmed still held by the deployer at this point (not yet revoked). Tx: `541Gb2YekvFR76uHUT54ktzKpcKNfJcBPxEGtCvBjaLfJihyNbBiB6Q87Bpy3j9DNiTia8kN9omsAv2Qzk3Zqoeg`
5. **revoke** — permanently revoked mint authority to `None`. Required an explicit `--i-understand-this-is-permanent` flag in addition to `--execute`, and only ran after a full walkthrough of phases 1–4's verified on-chain state. Verified: mint authority reads `None` on-chain. Tx: `2uS3egboypTBbGLLEE5XQpaUEKMocZ8F4bGUqeNENLBVXFinLzsb3C8NTPDj8NmzYE2KnQAuouRNMfjZHPUmQdKd`

The disposable deployer keypair (`4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX`) used to pay fees and hold temporary authority during setup now holds no ongoing authority over ACT — it can be discarded.

## Still open

- [ ] No liquidity pool exists yet — ACT is not tradeable anywhere.
- [ ] No exchange listing.
- [ ] Independent program review — not yet done, same open item as v1.
- [ ] Transparency dashboard not yet built.
- [ ] v1 retirement — what happens to v1's mint, its 100M supply sitting in the v1 vault, and the v1 multisig itself. Not yet written.
- [ ] Signer identity, independence, and conflict-of-interest disclosure for the v2 multisig — same unresolved item as `WHITEPAPER.md` §15.3, since it's the same three people as v1.

Public addresses and transaction data only. No private keys, seed phrases, or personal information belong in this file or this repository, ever.
