# ARETIA SWINGS: AUDIT READINESS

**Not ready for an external audit.** This lists what would be handed over, what is missing, and the order to fix it.

## Ready to review now (Aretia-written, tested)
| Area | Files | Evidence |
|---|---|---|
| Constant-product maths (Uniswap V2 and Raydium CPMM roundings) | `engine/amm.ts` | Property tests; V2 equals the venue router bit for bit on four chains; CPMM equals the real program's output |
| Pool store, price engine, health, registry | `engine/{liquidity,price,health,registry}.ts` | Unit tests |
| Routing, scoring, split | `engine/routing.ts` | Unit and property tests; live agreement with the router on Ethereum |
| ABI encoding and calldata | `engine/abi.ts`, `execution/evmV2Builder.ts`, `dex/evmV3.ts` | Selectors checked against known values; round-trip property tests; real routers accept the output |
| EVM venues | `dex/{evmV2,evmV3,directEvm,entries,hubs}.ts` | Live: contracts exist, pairs found, router accepts transactions, V3 pays the quoter's amount |
| Solana venues | `solana/{raydiumCpmm,meteoraDamm,builder,simulate,directSolana}.ts` | Live: real programs accept the transactions; CPMM pays exactly the local quote; DAMM v2 buys ACT in the real launch pools |
| EVM indexer | `indexer/evmIndexer.ts` | Unit tests; live decoding of real factory events on four chains |
| Keccak and checksums | `core/keccak.ts` | Published vectors |

## Not ready or not built
- Solana majors liquidity (Orca, Meteora DLMM, Raydium AMM v4), Solana multi-hop, a Solana indexer, PancakeSwap V3, Curve, Balancer, Aerodrome.
- Atomic split execution, ACT buyback execution.
- **Any real signed swap on any chain.** All evidence is simulation and read-only; nothing has moved funds.
- Local concentrated-liquidity maths (V3 and DAMM v2 rely on the venue's own quoting).
- Outlier-pool warnings in routing; decoded EVM calldata on the review screen.
- Database applied and discovery run against it; external audit.

## Freeze
Nothing is committed, so there is no commit to freeze. Before an audit: commit, run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:live`, then tag the commit and send auditors only that tag.

## Third-party versus Aretia code
Aretia wrote the engine, adapters and builders. Uniswap V2, PancakeSwap V2 and QuickSwap V2 contracts and every token are third-party and were not audited by Aretia. Jupiter and 0x code remains in the repository as non-core benchmarking and migration integrations and is out of scope for the standalone engine.

## Suggested order
1. Run small real swaps (your own wallet, small amounts) on each chain, one at a time, starting with Base and Solana. This is the evidence everything else lacks.
2. Show the decoded EVM calldata on the review screen.
3. Integrate the Solana venues that hold the majors' liquidity (Orca, Meteora DLMM, Raydium AMM v4) so Aretia can compete with an aggregator on SOL and USDC.
4. Build the Solana indexer and apply the database.
5. Add atomic split execution only if the gain justifies the contract it needs.
