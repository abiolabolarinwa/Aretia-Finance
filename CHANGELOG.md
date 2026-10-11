# Changelog

Format: Keep a Changelog. Only user-visible, security-relevant or build-relevant changes.

## Unreleased
### Changed
- Swings: Solana primitives (`SWAP_FEE_WALLET`, `KNOWN_TOKENS`, `isSolanaAddress`, `ataAddress`, `TOKEN_PROGRAM_ID`, …) moved from `src/scripts/walletTools.ts` to `src/swings/core/solanaTools.ts`; the old path re-exports them. No value or behaviour change; pinned by `solanaTools.test.ts`.
### Security
- `mainnet/gen-deployer.sh` now refuses to overwrite an existing deployer key and creates new keys with `umask 077`.
- `convert-phantom-key.mjs` writes the keypair file with mode 0600.
- CI: `npm audit` for the website is now blocking at `high`; added `projects-ci` for SDKs/scripts/program test harnesses; added CODEOWNERS, SECURITY.md, PR template, dependabot.
