# Move USDC: the Solana legs, step by step

Do this only after the first EVM-to-EVM move has worked (`docs/move-usdc-first-real-move.md`). The Solana legs are the least proven part: the burn is proven only by simulation against the real program, and the claim only by matching the accounts of real past claims (`src/swings/settlement/cctpSolana.live.ts`). No Solana move has been signed. Use **2 USDC** each way.

## 0. Check the builders against mainnet first (no money)
From a machine with open internet access: `npm run test:live`. The Solana file checks the derived accounts, the burn limit and fee recipient layouts, a simulated burn, and a rebuilt claim against a real one. If any of it fails, stop: do not sign anything.

## 1. What you need
- **A Solana wallet and an Ethereum-style wallet** for the same person. MetaMask holds both. Connect the Solana wallet with the **Connect wallet** button at the top of the page, and the Ethereum-style one in Move USDC.
- **Aretia's fee:** 0.1% of the amount entered, added on top (2 USDC pays 0.002 USDC). From Solana it is paid inside the burn transaction, to the fee wallet's USDC account, which the operator must have opened once (see `setup.md`, "The Move USDC fee"); otherwise moves from Solana are refused.
- **Solana to Base:** 2.002 USDC **in your standard USDC account** (the page counts only that account, because that is the one the burn takes from), and at least **0.01 SOL** for the network fee and the small deposit that stores the message record. Below about 0.006 SOL the page warns; at zero it refuses. That deposit (a few thousandths of a SOL) is not taken back by Aretia. Also a little ETH on Base to pay the claim.
- **Base to Solana:** 2 USDC and a little ETH on Base for the burn, and **about 0.005 SOL** on Solana for the claim (the fee, plus roughly 0.002 SOL to open your USDC account if you have never held USDC there).
- The destination account is always your own: the page uses the connected wallet on each side.

## 2. Move A: Solana to Base (standard)
Pay > Move USDC, From **Solana**, To **Base**, `2`, **Get quotes**. Standard attestation from Solana is about 25 seconds. Expect: no approval step, one burn to sign, a note about the message-record deposit, then a claim on Base.
1. **Start** > the Solana wallet opens a single transaction. Check it is a call to Circle's Token Messenger Minter (`CCTPV2vPZJS2…`) and nothing else: no extra transfers.
2. Status: "Waiting for your signature", then "Sent on Solana", then "Moving to Base" (a minute or less).
3. When it says "Ready to claim on Base", press **Claim on Base** and approve in the Ethereum-style wallet (switching to Base if asked). Then "Complete".
4. Check: about 2 USDC on Base, and on Solscan the burn transaction shows the USDC leaving your account.

## 3. Move B: Base to Solana (standard)
From **Base**, To **Solana**. Attestation from Base is about 19 minutes. Steps: approve if needed, burn on Base, wait (you can close the page; reopening Pay > Move USDC with both wallets connected brings the move back), then **Claim on Solana**, signed in the Solana wallet.
Check: the USDC arrives in your Solana USDC account; on Solscan the claim transaction names Circle's Message Transmitter.

## 4. Things that are specific to Solana
| Situation | What happens / what to do |
|---|---|
| Your USDC is in a non-standard token account | The page shows a smaller balance (only the standard account). Move it into the standard account first |
| The wallet takes more than about a minute to approve | The burn's blockhash may expire. Nothing is sent. The page asks whether the transaction was sent, after about 2 minutes of not seeing it |
| "Check your wallet: … has not shown as confirmed on Solana" | Look the signature up on Solscan. Not found: choose **The burn was not sent** (or **The claim was not sent**) and press Continue. Found: choose **… was sent** and paste the signature |
| Claim fails on Solana | Usually not enough SOL for the fee or the account rent. Add SOL, press Claim again. Nothing was minted, so it is safe to repeat |
| The wallet shows a different transaction than the page described | The page refuses to send it ("The wallet returned a different transaction"). Do not retry; tell me which wallet it was |
| Claim says the message "pays a different account" | Aretia claims only into the standard USDC account of the wallet the move was made for. Do not work around it |

## 5. Record it
In `docs/aretia-swings/readiness-attestations.json`, set `real-cctp-solana` to `{ "done": true, "date": "<date>", "note": "<both directions, amounts, burn and claim signatures/hashes, times, the SOL spent, anything odd>" }`. Note the actual SOL spent on the burn: the safety threshold (0.006 SOL) and the message-record deposit text are estimates to correct from this run.
