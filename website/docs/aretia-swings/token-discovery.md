# Token discovery, registry and risk

**Identity:** `TokenRef = { chain: 'solana' | 'ethereum' | 'bnb' | 'polygon' | 'base', address }`, with key `chain:address`. EVM addresses are lower-cased and checksum-validated; Solana mints are base58 and case-sensitive. Symbols are display only and never keys. The existing `Holding`, `TokenInfo` and `KNOWN_TOKENS` are adapted to this type; there is no second identity system.

**Registry record:** logicalTokenId, chain, address, symbol, name, decimals, logo, riskScore, riskStatus, liquidity, volume, verifiedStatus, discoveredAt, updatedAt. Third-party metadata is stored with its source and treated as untrusted: on-chain decimals win over API decimals, names and symbols are length-limited, and everything is rendered as text.

**Detection (needs a backend, see architecture.md conflict 3):** incremental indexing from a stored cursor per chain.
- Solana: mint creation, metadata, pool creation, first swap.
- EVM: ERC-20 creation, factory `PairCreated`/`PoolCreated` events, first liquidity, first swap.

"Exists" and "tradable" are separate states. Tradable requires a pool with liquidity above a threshold.

**Risk engine:** produces a score plus a list of findings, each with evidence and weight. Labels: Established, New, Low, Moderate, Elevated, High Risk, Restricted. The word "safe" is never used.
- Solana checks: mint and freeze authority, holder and supply concentration, liquidity.
- EVM checks: owner, proxy, mint/blacklist/pause functions, transfer tax, holder concentration, liquidity. Honeypot detection needs simulation and is best effort.
