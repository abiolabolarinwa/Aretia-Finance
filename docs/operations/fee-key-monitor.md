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

`.github/workflows/fee-key-monitor.yml` runs it every hour. A failed run (exit 1) is the alert; exit 2 shows as a warning only.
Set repository variables `ETHEREUM_RPC_URL`, `BNB_RPC_URL`, `POLYGON_RPC_URL` to use keyed nodes instead of the public ones. Make
sure someone receives failed-workflow notifications for this repository.

`website/scripts/curve-mainnet.mjs` (`prepare` and `verify`) makes the same check and stops if the fee address has code.

## If the alert fires

1. Confirm with a second node (`eth_getCode` on the block explorer's API as well).
2. If the key holder did not sign it, treat the key as compromised.
3. If the key is still controlled: sign a new EIP-7702 authorisation that delegates to the zero address (this clears the code), and
   check the monitor goes back to exit 0.
4. Turn the curve off on the site (the chain's curve flag) and post a notice: trading may be frozen until the code is removed.
5. Future contract versions should use pull payments for the protocol fee (see M-2's recommendation) so that this cannot happen.
