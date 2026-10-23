# Test fixtures

`aretia_curve.so` is the web wallet's bonding-curve program (Aretia-Finance, `program/aretia-curve/artifacts/aretia_curve.so`),
built for its mainnet program id `CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu`. It is copied here unchanged so the order
program's venue adapter can be tested against the real curve in CI. `aretia_curve.so.sha256` is the checksum published beside it;
`tests/curve_venue.rs` checks the file against it, so a stale copy fails loudly.

To update: copy both files from the Aretia-Finance repository and re-run `cargo test`.

`meteora_cp_amm.so` is Meteora's DAMM v2 program (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`), built from the open-source repository
`MeteoraAg/damm-v2` at commit `5398b5c7c534de014091132da37c6478cce671a8` with `cargo build-sbf --manifest-path programs/cp-amm/Cargo.toml`
(Rust 1.94.0), so the order program can be tested against the real swap. It is NOT the binary running on mainnet; it is the same
source family and the same `swap` interface. `meteora_cp_amm.so.sha256` is its checksum; `tests/meteora_venue.rs` checks it.
