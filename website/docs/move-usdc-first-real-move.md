# Move USDC: first real move, step by step

Goal: prove one real EVM-to-EVM move with Circle's CCTP, with a small amount, and record it. Nothing in Move USDC has moved real money yet (`real-cctp-move` is not done in `docs/aretia-swings/readiness-attestations.json`). Do this before anyone else uses it.

## 0. Before you start
- **Amount:** 2 USDC. The per-move cap in the page is 10,000 USDC of the amount entered (raised from 250 on 2026-10-21); keep the first real move small anyway.
- **Aretia's fee:** 0.1% of the amount entered, **added on top**, in USDC on the source network (2 USDC pays 0.002 USDC). The recipient receives the full amount entered. So hold a little more than the amount: 2.002 USDC for a standard move (plus Circle's few-thousandths fee on top for a fast one).
- **Operator:** `PUBLIC_ARETIA_EVM_FEE_ADDRESS` must be set in the build, or moves from EVM networks are refused ("the Aretia fee address for EVM networks is not set up yet"). For a move from Solana, the fee wallet's USDC account must already exist (see `MANAGEMENT_FEE.md`, "Move USDC fee").
- **Route (pick one):**
  - *Fastest first test:* **Polygon to Base**, standard. Polygon's standard attestation is about 8 seconds, so the whole move is a few minutes.
  - *The common route:* **Base to Polygon**, standard. Attestation is about 19 minutes; this also tests the long wait and coming back to the page.
- **You need:** the 2 USDC plus the fee (2.002 USDC) on the source network (native USDC, not bridged USDC.e), a little of the source network's coin for the burn fee (POL or ETH, cents), and **a little of the destination network's coin** (ETH on Base, POL on Polygon). The claim is a transaction you pay for on the destination. The page warns if the destination balance is zero.
- **Operator switches (Vercel, Runtime):** both networks must be on. `SWINGS_EVM_CHAINS` unset means all EVM networks are on; if you set it, list both (for example `polygon,base`). If `SWINGS_CANARY_WALLETS` is set, your wallet's address must be in it, or Start says the wallet is "not in that group yet".
- **Recovery copy:** optional. Without it the record lives in this browser only; **write down the Recovery code** shown on the status card.
- Use the same browser and wallet for the whole move.

## 1. Quote
Pay > **Move USDC**. Connect your Ethereum-style wallet (or it is picked up if already allowed). Choose From and To, enter `2`, press **Get quotes**.
Expect, per quote: the mechanism (standard or fast), "Amount: 2 USDC. You send 2.002 USDC on Polygon in all (the fees are added on top). The recipient gets at least 2 USDC on Base", the time, each fee on its own line (**Aretia fee (0.1%): 0.002 USDC, added on top**, **Circle fee**, network fees), the numbered steps with "(you sign)" marks, and the risks. Standard shows a Circle fee of **None**; fast shows a small USDC fee "at most …, added on top".
Check: the recipient gets the full amount entered; you send the amount plus the fees; the destination is your own account.

## 2. Start and sign
Press **Start: send 2.002 USDC (2 USDC arrives)**. A confirmation may appear (for example, no coin on the destination); read it before continuing. Your wallet then asks to **approve** the USDC allowance if needed (exactly the amount burned), then to send **Aretia's fee** (a USDC transfer of 0.002 to Aretia's fee address; it is sent only after the burn has been checked to go through), then to **burn** on the source network. From Solana there is one signature: the fee and the burn are one transaction.
Check in the wallet: the network, the amounts, that the approval and burn go to Circle's token messenger, and that the fee is a USDC transfer to Aretia's fee address (the page only allows Circle's own contracts and native USDC).
Status: "Waiting for your signature", then "Sent on Polygon" ("The funds have not arrived yet").

## 3. The wait
Status becomes **"Moving to Base"** with how long it usually takes and "You can close this page: the move is saved in this browser…". The page checks every 15 seconds.
- **Try closing the tab now** (on the long route) and reopen Pay > Move USDC after a few minutes with the same wallet connected. The page should show the same move again. If it does not, that is a bug: note it and use the recovery code.
- Nothing is in your destination account yet. Do not retry the move.

## 4. Claim
When Circle releases the funds, status becomes **"Ready to claim on Base"** with a **Claim on Base** button. Press it, approve in the wallet (switching to Base if asked: say yes, nothing is sent by switching). Status: "Your claim was sent. Waiting for it to confirm", then **"Complete: the funds are in your Base account."**
Check: the destination wallet really shows +about 2 USDC (the page only says Complete after the destination reports the value; confirm it in the wallet or on the explorer).

## 5. Failure cases to try once (only after a success)
| Case | Expect |
|---|---|
| Amount above your balance | "You have X USDC on …, which is less than …" before any quote |
| Amount equal to your balance (no room for the fee) | Start is refused: "less than the … USDC this move needs (the amount plus the fees, which are added on top). The most you can move with your balance is …" |
| The burn would fail (for example, USDC spent elsewhere after quoting) | "The USDC transfer would fail … so neither Aretia's fee nor the transfer was sent" |
| The burn fails or is declined after the fee was paid | Get a new quote for the same amount: the fee step is skipped ("confirmed" with the earlier fee hash); the fee is not charged twice |
| Same network both sides | "Choose two different networks." |
| Decline in the wallet at the burn | "You declined the request in your wallet. Nothing was sent." and the status goes back to "Ready to start" with a **Continue** button |
| Close the tab during the wait, reopen | The same move is shown (step 3) |
| Wallet on the wrong network at signing | The page asks to switch; declining stops cleanly |
| Reload while the wallet prompt is open | "Check your wallet": use **The … was not sent** or **was sent…** (then paste the hash from the wallet). Never press Start again for the same funds |

## 6. If it stalls
| Symptom | What to do |
|---|---|
| "Sent on …" for more than a few minutes | The source network is slow; check the hash on the explorer link in the card. Do not retry |
| "Moving to …" longer than twice the quoted time | Check Circle's status; the move is safe (the funds are burned and claimable later). Keep the recovery code and the hashes |
| "Ready to claim" but Claim fails | Usually no coin for the fee on the destination: add a little ETH there and press Claim again |
| "Did not complete … funds may be in transit" | Do not retry. Keep every hash and the recovery code, and look the burn up on the explorer |
| Nothing is shown after reopening | Restore with the recovery code (Recovery section on the same tab) |

## 7. Record it
In `docs/aretia-swings/readiness-attestations.json`, set `real-cctp-move` to `{ "done": true, "date": "<date>", "note": "<route, amount, burn hash, claim hash, total time, anything odd>" }`. Do the same for `real-cctp-fast` after one fast move, and `real-cctp-solana` after a Solana leg.

## After this works
Fast mode (small fee, seconds), then Solana to and from an EVM network (the least proven legs), then raise the cap only through a reviewed change to `MOVE_CAP_RAW`.
