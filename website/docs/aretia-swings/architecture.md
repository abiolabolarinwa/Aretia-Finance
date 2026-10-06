# Aretia Swings: architecture and Milestone 0 audit

Status: **audit complete, implementation not started.** Everything below was read from the repository, not assumed.

## 1. What "Aretia Wallet" is in this repository

There is no Rust/Node wallet core here. "Aretia Wallet" is two things:

| Piece | Where | Notes |
|---|---|---|
| Web wallet page (`/wallet`) | `website/src/pages/wallet/index.astro`, `src/scripts/wallet*.ts`, `public/assets/wallet/wallet.{js,css}` | Astro 7 static site on Vercel. Non-custodial: it never holds keys. |
| Browser extension (EIP-1193 provider, Wallet Standard, bridge interfaces, SafeSend `packages/`) | **Not in this repo.** Referenced by `src/data/site.ts` and a comment in `wallet/index.astro` (`packages/safesend/src/deployments.ts`). | Status "in development"; not published. |

## 2. Audit findings

| Area | Finding | Evidence |
|---|---|---|
| Wallet architecture | Browser page connects an existing Solana wallet through `window.AretiaWallet` (`wallet.js`, hand-rolled Wallet Standard). The page never signs; the wallet extension does. | `walletApp.ts:11,44`, `wallet.js` header |
| Chain abstraction | **None.** Everything is Solana: `@solana/web3.js` only, `isSolanaAddress`, SPL/Token-2022 constants. | `walletTools.ts`, `package.json` |
| Solana implementation | Mature: holdings, activity, send with simulation, swap with simulation-judged balances, `.sns` resolution. | `walletApp.ts`, `walletSend.ts`, `walletTools.ts` |
| EVM implementation | **None in this repo.** No viem/ethers, no EIP-6963 consumer, no `eth_*` code in `wallet.js` (0 matches). | grep, `node_modules` |
| Transaction service | `walletSend.ts`: `planSend`, `simulatePlan`, `signAndSubmit`, `waitForConfirmation`, `rpcCall` (via `/api/rpc`, falls back to publicnode). Reusable for the Solana adapter. | `walletSend.ts` |
| Provider architecture | Jupiter is hard-wired in `walletSwap.ts` (`lite-api.jup.ag`). No provider interface. A bridge-provider interface exists only in the extension, which is not in this repo. | `walletSwap.ts` |
| Asset architecture | `Holding`, `TokenInfo` keyed by Solana mint. `KNOWN_TOKENS` list. No chain-aware identity. | `walletApp.ts:60`, `walletTools.ts:116` |
| ACT asset and fee | ACT mint `7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG` (Token-2022, 1.5% transfer fee, mint authority revoked). ACT contracts also exist on BNB Chain and Polygon (bridging not live). Swap service fee: `SWAP_FEE_BPS=100`, `SWAP_FEE_WALLET`, `splitSwapFee` in `walletTools.ts`, charged as one extra transfer. | `walletTools.ts:282-296`, `PRODUCT.md` |
| Bridge architecture | Wormhole NTT, **testnet only** (Solana devnet and Sepolia). Not production. | `site.ts:51`, `PRODUCT.md` |
| UI / sidebar | Sidebar is `data-nav` buttons in `wallet/index.astro` (dashboard, trade, activity, send, shield, intent, safesend, universal). Views switch via `.wapp[data-view]` CSS and `[data-pane]`. Adding a view means one button, one pane and CSS rules. | `index.astro:64-110, 532-653` |
| State management | None formal: DOM, module-local variables, `window.AretiaWallet.subscribe`. | `walletApp.ts` |
| Storage | No persistence of wallet data. No database anywhere in the repo. | grep |
| API infrastructure | Vercel functions `api/rpc.ts` (allow-listed Solana JSON-RPC proxy, origin checks, per-IP limit) and `api/ramp.ts` (off by default; handler/entry split with injected `env`/`fetchImpl`). A good pattern to copy. | `api/*.ts`, `docs/*.md` |
| Testing | **No test runner installed** (no vitest/jest). Pure logic is already isolated in `walletTools.ts`, so it is testable once a runner is added. | `package.json` |
| Scripts | `typecheck` (`astro check`), `lint` (`eslint .`), `build` (`astro build`). No `test`. | `package.json` |
| Product status | `site.ts` is the single source of truth for per-product status; PRODUCT.md forbids marking things "live" without checking it. Wallet = `in-development`. | `PRODUCT.md` |

## 3. Reusable

- Sidebar/pane mechanism and the `wapp__*` design system (`wallet.css`, tokens in `src/styles/tokens.css`).
- `walletSend.ts` RPC/simulate/sign/confirm helpers and `walletTools.ts` pure helpers (bigint amounts, `toSmallestUnit`, `judgeSwapSimulation`, `splitSwapFee`).
- `walletSwap.ts` Jupiter integration becomes the first `LiquidityProvider` for Solana (move it, don't duplicate it).
- `api/_rpcProxy.ts` pattern for new EVM RPC and token-intel endpoints.
- `ACT` and `POOLS` in `src/data/site.ts`.

## 4. Architectural conflicts and gaps (decisions needed)

1. **No EVM wallet connection exists in the web wallet.** The page only speaks Solana Wallet Standard. EVM swaps need an EIP-6963/EIP-1193 connection layer that does not exist here. Four of the five chains are blocked on this.
2. **The extension (which has the EVM provider) is outside this repo.** Swings must either run on the web wallet (needs new EVM connect code) or be built where the extension lives.
3. **No backend datastore.** Milestones 8, 9, 13 (token discovery, indexer, registry) and 23 (analytics) need persistent storage and a long-running indexer. Vercel functions are stateless and short-lived; this needs a database and a worker, neither of which is in the repo.
4. **Fee architecture is Solana-only and hard-coded.** `SWAP_FEE_BPS`/`SWAP_FEE_WALLET` are constants in `walletTools.ts`, and the only fee wallet is a Solana address. It needs an `AretiaFeeConfig` with per-chain fee recipients. EVM fee recipient addresses do not exist yet; the owner must supply them.
5. **No tests.** A runner (Vitest) must be added before any milestone can be called done.
6. **Cross-chain** stays interface-only: Wormhole NTT is testnet, as the spec itself requires.
7. **Provider keys.** EVM aggregators (0x, 1inch, ParaSwap, etc.) typically need API keys. They must live server-side behind a proxy like `api/rpc.ts`, never in the browser.
8. **Token identity.** The spec's `chainId + address` identity must be introduced as one shared type, and `Holding`/`TokenInfo` adapted to it, not a parallel system.
9. **Secrets hygiene.** `../Wallets/` holds key files and `../mainnet-deploy-keypair.json` sits in the repo tree. This audit did not open them. They should be confirmed git-ignored before any more work lands.

## 5. Target architecture

New code under `website/src/swings/` (pure TypeScript, no DOM), UI in `src/scripts/walletSwings.ts`, server in `api/swings/`.

```
src/swings/
  core/        types.ts (TokenRef = {chain, address}), fee.ts (AretiaFeeConfig), errors.ts
  chains/      ChainAdapter + solana.ts, evm.ts (ethereum/bnb/polygon/base as configs)
  providers/   LiquidityProvider + jupiter.ts, (EVM aggregator adapters)
  router/      quote engine, ranking, failover
  execution/   build -> simulate -> sign -> broadcast -> monitor (no auto-retry)
  tokens/      registry, search, risk engine
  crosschain/  interfaces only
```

Rules carried over from the spec: core never imports chain- or provider-specific code; one `TokenRef`; fee in one config; no auto-retry of broadcasts; quotes carry an expiry and are rejected after it.

## 6. Proposed build order (each step leaves lint/typecheck/build green)

1. Add Vitest and a `test` script. Add `core/` types and `AretiaFeeConfig` (reading the existing constants), with tests.
2. Sidebar entry "Aretia Swings" and an honest shell pane: Solana swap routed to the existing Jupiter flow; other chains labelled "not enabled yet".
3. `ChainAdapter` and `LiquidityProvider` interfaces; wrap the existing Solana/Jupiter code as the first adapters with no behaviour change.
4. Quote engine, router and failover over those interfaces, tests first.
5. Token registry (in-memory/session) and search by `chain+address`; risk engine v1 for Solana (mint/freeze authority, holder concentration) using the RPC methods already allow-listed.
6. EVM: connection layer, one aggregator adapter, approvals, simulation (`eth_call`/`eth_estimateGas`), one chain at a time. **Blocked on decisions 1, 2, 4, 7.**
7. Discovery indexer and persistent registry. **Blocked on decision 3.**
8. Security review, observability, analytics, audit docs, production readiness.
