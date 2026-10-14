/**
 * How long each automatic step of a swap may take. A swap should read, build, send and confirm within about a minute of the
 * person pressing Swap, not counting the seconds they spend approving in their wallet. These are the limits; each step ends
 * in a clear answer at its limit rather than waiting on.
 *
 *   read a price      the first usable route, then at most QUOTE_GRACE_MS more for the others (a provider alone: up to its own limit)
 *   build and check   BUILD_TIMEOUT_MS
 *   wallet            the person's own time (not counted)
 *   send              the wallet's own sending, one call
 *   confirm           TRACK_TIMEOUT_MS, read every TRACK_INTERVAL_MS
 *   approval / fee    RECEIPT_TIMEOUT_MS each, only when the route needs one first (a wallet that batches skips them)
 */
/** After the first usable route arrives, how long the other providers get to beat it. */
export const QUOTE_GRACE_MS = 4_000;
/** Building and checking the transaction. */
export const BUILD_TIMEOUT_MS = 12_000;
/** How long the page waits for a sent swap to be confirmed before saying it is still pending (the swap itself is not affected). */
export const TRACK_TIMEOUT_MS = 45_000;
export const TRACK_INTERVAL_MS = 1_000;
/** A separate approval or fee transaction that must be mined before the swap is sent. */
export const RECEIPT_TIMEOUT_MS = 45_000;
/** A wallet's all-in-one batch (EIP-5792). */
export const BATCH_TIMEOUT_MS = 60_000;
