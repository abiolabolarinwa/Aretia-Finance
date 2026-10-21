# Fee-key monitor (EVM fee address)

Audit reference: `docs/audit/2026-10-full-review/REPORT.md`, finding **M-2**.

## Why this exists

The deployed `AretiaCurve` contracts (Ethereum, BNB Chain, Polygon) pay Aretia's EVM fee address,
`0xeb8725e16e504036c2166aa47804d88ecc4d0945`, inside every `buy` and `sell`, and a failed payment reverts the trade. The contracts
are immutable. Under EIP-7702 (live on all three chains) one signed authorisation can give that address code. Code there could:

- refuse every payment, so every buy and sell on every curve on that chain reverts, including sells after `abortMigration`
  (the holders' only exit);
- refuse selectively (for example by `tx.origin`), which turns the fee key into a censorship and honeypot switch.

So the fee key is a **privileged freeze key**, despite the contracts having no owner. Treat it that way.

## Rules for the fee key

1. Keep it cold (hardware wallet). It only ever receives.
2. **Never sign an EIP-7702 authorisation with it**, and never "upgrade it to a smart account" in a wallet app. Wallets now offer
   this as a feature; decline it for this key.
3. Do not reuse it for anything else.

## The monitor

`website/scripts/fee-key-monitor.mjs` asks each chain for `eth_getCode(feeAddress)`. Read-only; it holds no key.

```
cd website
node scripts/fee-key-monitor.mjs
ETHEREUM_RPC_URL=… BNB_RPC_URL=… POLYGON_RPC_URL=… node scripts/fee-key-monitor.mjs   # your own nodes
```

| Exit | Meaning |
|---|---|
| 0 | No code on any chain. |
| 1 | **ALERT**: code at the fee address on at least one chain. An EIP-7702 delegation shows as `0xef0100` + the delegate address. |
| 2 | A chain could not be read (or the node was on the wrong chain). Nothing is proven for it; run again. |
| 3 | Chains could not be read 3 runs in a row (`FEE_MONITOR_STATE` keeps the count): the monitor is blind. |

Node URLs are never printed, only the provider's domain (`https://…alchemy.com/…`), because a keyed URL is a secret.

### The scheduled workflow

`.github/workflows/fee-key-monitor.yml` runs it every hour (and on demand: Actions, fee-key-monitor, Run workflow).

- **Exit 1 (code found)**: it opens an issue labelled `security` with the table of results (or comments on the open one with the same
  title) and the run fails. The issue is the alert: everyone who watches the repository's issues sees it, unlike a failed run, which
  notifies only people who turned on failed-workflow notifications. Watch the repository (at least Issues) and keep a notification route
  for issues labelled `security`.
- **Exit 2 (unreadable)**: a warning only. The count of unreadable runs in a row is kept between runs in the Actions cache; on the third
  in a row the run exits 3, opens or comments on a "cannot read the chains" issue labelled `security`, and fails, so a monitor that has
  gone blind is not silent. A good run resets the count. (If the cache is evicted the count starts again from zero, which delays this
  alert, never the code alert.)
- The workflow needs `issues: write` (set in the file) and creates the `security` label if it does not exist.
- Keyed nodes: set repository **secrets** (not variables) `ETHEREUM_RPC_URL`, `BNB_RPC_URL`, `POLYGON_RPC_URL`. Without them the public
  nodes are used.
- **Scheduled workflows run only from the default branch.** The hourly check starts once this file is merged to `main`; on another branch
  only a manual run works.
- **GitHub turns scheduled workflows off after 60 days without activity** in a public repository (no commits). It emails the person who
  last changed the workflow before it does. Re-enable it from the Actions tab (fee-key-monitor, Enable workflow) or push any commit. Check
  that the workflow still shows recent runs as part of the monthly operations review.
- The actions it uses are pinned by version tag (`@v4`), not by commit SHA. Pin them to full SHAs, checked against each action's own
  repository, as a follow-up.

`website/scripts/curve-mainnet.mjs` (`prepare` and `verify`) makes the same check and stops if the fee address has code.

## If the alert fires

1. Confirm with a second node (`eth_getCode` on the block explorer's API as well).
2. If the key holder did not sign it, treat the key as compromised.
3. If the key is still controlled: sign a new EIP-7702 authorisation that delegates to the zero address (this clears the code), and
   check the monitor goes back to exit 0.
4. Turn the curve off on the site (the chain's curve flag) and post a notice: trading may be frozen until the code is removed.
5. Future contract versions should use pull payments for the protocol fee (see M-2's recommendation) so that this cannot happen.
