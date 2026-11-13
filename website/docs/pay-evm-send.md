# Pay: send from an Ethereum-style account

On by default since 2026-11-13: Pay > Send has a **Network** box (Solana plus every Ethereum-style network). To take it out again, build the site with `PUBLIC_PAY_EVM_SEND=0` (Cloudflare Pages build environment, then redeploy); without the box the page is exactly the Solana-only Send.

**No real transfer has been made with it yet.** It was switched on at the owner's request. Do the checks under "Before you switch it on for others" with small amounts as soon as you can, and set `PUBLIC_PAY_EVM_SEND=0` if anything looks wrong.

## What it does
- Sends a native coin (ETH, BNB, POL) or a token from the known list (USDC, USDT, DAI, USDG, wrapped coins) from the account the wallet shares, on Ethereum, BNB Chain, Polygon, Base or Robinhood Chain.
- Before the wallet is asked: the recipient must be a valid `0x` address with a correct capital-letter checksum (a bad one usually means a typo); the zero address, your own address and a token's own contract are refused; the balance and the network fee are checked (for the native coin, the fee comes on top of the amount); the network is asked to estimate the transfer, and a transfer it would reject is blocked with no transaction built. If the network cannot be reached, nothing passes by default.
- A recipient that is a smart contract is flagged and needs an explicit tick.
- Then the wallet is switched to the right network if needed, checked to still show the reviewed account, and asked to send. The page follows the receipt (a node that cannot answer is read as "not confirmed yet", never "failed") and links the explorer.
- Aretia holds no keys and takes no fee on this transfer.

## Not included
ENS and other names, tokens outside the known list (pasted contract addresses), batch sends, address book, gas sponsorship, Solana to Ethereum-style transfers (that is Move USDC).

## Checks to do now (it is already on)
No real transfer has been made with it. Do one yourself first, small, to an address you own:
1. Native coin on a cheap network (for example a few cents of BNB on BNB Chain): review shows the fee, the wallet asks, the page reports confirmed, the dashboard balance drops.
2. A stablecoin (for example 1 USDT): the review names the network and the full recipient address; confirm the token arrives.
3. Failures: a mistyped address, your own address, more than you hold, a native amount with no room for the fee, rejecting in the wallet, the wallet on the wrong network when you press Confirm.
4. Record the result with a date in `docs/aretia-swings/readiness-attestations.json`.
