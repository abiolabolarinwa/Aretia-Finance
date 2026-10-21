# Proof-of-concept tests for the October 2026 full review

Each folder backs findings in `../REPORT.md`. Nothing here is part of the product or its test suites. These scripts **show** the problems; they are not regression tests (several assert the vulnerable behaviour).

| Folder | Findings | How to run |
|---|---|---|
| `swap/` | H-1, H-2 | from `website/`: `npx vitest run --config ../docs/audit/2026-10-full-review/poc/vitest.config.mjs swap` |
| `tx-builders/` | H-3 | same command, filter `tx-builders` |
| `api/` | M-1, M-6, M-11, L-3, L-4, I-21 | same command, filter `api` |
| `market/` | M-6, M-7, M-8, L-15, L-16 | same command, filter `market` (`vt.mjs`: `node market/vt.mjs` from `website/`) |
| `evm-curve/` | M-2, M-3, M-4, L-11 | `npm install` in the folder, then `node poc1.mjs` … `node poc4.mjs`, `node fuzz.mjs`. `compile.mjs` rebuilds the contracts with solc 0.8.26 and checks them byte for byte against the committed artifacts. |
| `evm-pool/` | M-2, M-9, L-19, I-5, I-8 | `npm install`, then `node poc.mjs` |
| `solana-curve/poc.rs` | L-8 | copy into `program/aretia-curve/tests/tests/`, then `ARETIA_CURVE_SO=../artifacts/aretia_curve.so cargo test --test poc -- --nocapture` |
| `solana-pool/poc.rs` | M-5, L-21, L-22, L-23, I-16 | copy into `program/aretia-pool/tests/tests/`, then `ARETIA_POOL_SO=../artifacts/aretia_pool.so cargo test --test poc -- --nocapture`. `poc_jit_launch_fee_capture` prints its fee figures and then fails a valuation assertion; the figures are what the report uses. |

Every web test above passed on commit `5e7fb23` (15 tests in 7 files). The EVM scripts run the committed bytecode in `@ethereumjs/vm` with the real Uniswap V2 factory, router and WETH9 builds from npm.
