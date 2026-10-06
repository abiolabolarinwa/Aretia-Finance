# External dependencies

None of the following were developed or audited by Aretia.

| Category | Dependency | Used for | Where |
|---|---|---|---|
| Routing infrastructure | Jupiter API (`lite-api.jup.ag`) | Solana quotes and swap instructions | `walletSwap.ts` |
| Routing infrastructure | 0x Swap API (`api.0x.org`, AllowanceHolder) | EVM quotes and transactions | `api/_swings0x.ts` |
| Token metadata / discovery | GeckoTerminal new-pools feed | Pool creation time, liquidity, volume, names | `tokens/sources/geckoTerminal.ts` |
| Token metadata | Jupiter token search; DexScreener (existing price features) | Search and prices | `walletSwap.ts`, `actPrice.ts` |
| RPC | Solana RPC via `/api/rpc` (provider behind `SOLANA_RPC_URL`, fallback publicnode); optional EVM RPC URLs; the user's wallet RPC for EVM reads | Reads, simulation, broadcast | `api/_rpcProxy.ts`, `chains/evm*.ts` |
| Indexing / database | Supabase (Postgres, PostgREST) | Token registry | `tokens/supabase.ts` |
| Hosting | Vercel | Site, functions, cron | `api/` |
| Public nodes | publicnode.com for Ethereum, BNB Chain, Polygon, Base and Solana (fallback) | Read-only EVM calls, simulation and token facts from the page | `chains/evmSession.ts` |
| Optional services | Etherscan API v2 (source verification), 0x price endpoint (token taxes) | Extra EVM risk signals when keys are set | `tokens/explorer.ts` |
| CI | GitHub Actions, CodeQL, gitleaks | Tests, SAST, secret scanning | `.github/workflows/` |
| Third-party contracts | Jupiter and DEX programs; 0x settlement contracts (addresses not yet configured); every swapped token | Executing swaps | n/a |
| Bridge infrastructure | None enabled. Wormhole NTT exists on testnet only | Future | `crosschain/types.ts` (interfaces) |
| npm packages | `@solana/web3.js`, `@bonfida/spl-name-service`, `astro`, `vitest`, `fast-check` and transitive packages | Runtime and tooling | `package.json` |
