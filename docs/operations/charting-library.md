# TradingView charting library: pinned hash

Audit reference: `docs/audit/2026-10-full-review/REPORT.md`, finding **I-26** ("The TradingView library is fetched by a mutable tag
with no hash").

`website/scripts/fetch-charting-library.ts` downloads the licensed library from `tradingview/charting_library` at the tag `VERSION`
before each build. A tag can be moved, so the script hashes what it downloaded (`treeHash`: SHA-256 over every file's relative path and
its SHA-256, in sorted order, so the result does not depend on archive timestamps) and compares it with the pinned hash before it
installs anything. A mismatch is never installed; the wallet then uses its embedded fallback chart (or the build fails with
`TRADINGVIEW_REQUIRED=1`).

## Pinning (operator, once per version)

The library is private, so the hash cannot be computed from this public repository. With an account TradingView has approved:

1. `cd website && TRADINGVIEW_FORCE=1 node scripts/fetch-charting-library.ts` and note the printed `TRADINGVIEW_SHA256=…`.
2. Download again on a second machine (or check the files against the release) and confirm the same hash.
3. Put it in `PINNED_SHA256` in the script (or set `TRADINGVIEW_SHA256` as a Vercel build variable), together with `VERSION`.
4. Set `TRADINGVIEW_REQUIRE_HASH=1` on Vercel so an unpinned download is refused instead of installed with a warning.

Until a hash is pinned, every build prints a `WARNING: no pinned hash, installed unverified` line.
