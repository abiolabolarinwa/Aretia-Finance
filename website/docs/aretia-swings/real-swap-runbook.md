# Real-swap runbook (staged rollout)

**Status, 10 October 2026:** one real swap has been signed and confirmed, on BNB Chain (0.0248417 BNB to ARK through PancakeSwap, with the 0.29% fee arriving at the EVM fee address in the same batched transaction). Nothing else has: not Solana, not Base or any other EVM network, not a sell, not a token-to-token swap with an approval. Everything else is proven by simulation against the real contracts and programs. This is the order to change that, with the smallest possible exposure at each step. It needs **your wallet and your funds**: nothing in this list can be done for you.

## Rules for every step
- Use **your own wallet**, a **fresh small balance** you can afford to lose entirely, and amounts of a few dollars.
- One chain, one pair, one direction at a time. Do not move to the next step until the current one is written up (before and after balances, transaction link, what you expected, what happened).
- If anything differs from what the review screen promised, **stop**, switch the chain off (below), and keep the transaction link.
- Turn on the staged-rollout brake first, so only your wallet can review and sign.

## 0. Before any real swap
1. Apply the database and run discovery (`docs/aretia-swings/setup.md`), so shadow comparisons are stored.
2. Set `SWINGS_CANARY_WALLETS` to your own wallet address (comma-separate more later). Redeploy. Anyone else can still get quotes, but nobody else can review or sign. The page only ever receives hashes of the list.
3. Test the 0.29% Aretia fee separately, last (step 7).
4. Leave `SWINGS_PROTECTED_SUBMIT` and `SWINGS_PUBLIC_API` **off** until step 8.
5. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run test:live` on the commit you are deploying. Record the commit.

## 1. Solana, SOL to USDC (the simplest route)
- Amount: about $2 of SOL. Slippage 0.5%.
- Check: the review screen names the venue and the minimum; the wallet's own prompt shows one transaction; after confirmation, your USDC rose by at least the minimum shown and your SOL fell by the amount plus fees and rent only.
- Write down: expected out, minimum, received, SOL spent, fee paid.

## 2. Solana, USDC to SOL
- Same size. This exercises unwrapping SOL.

## 3. Solana, a two-hop route and a program-priced venue
- Pick a pair where the router says "Two hops" (for example USDC to ACT), then a swap through Orca or Meteora DLMM.
- Confirm both hops happened in one transaction and no leftover of the intermediate token beyond dust.

## 4. One EVM chain, native coin to a stable
- EVM networks are on by default. Before this step set `SWINGS_CANARY_WALLETS` to your own wallet so nobody else can sign, and optionally `SWINGS_EVM_CHAINS=base` to test one network on its own. Start with **Base** (cheapest gas). Connect your EVM wallet. Amount about $2.
- Before signing, compare the approval spender and the router address with the chain's block explorer. Native sells need no approval.
- Then a token-to-token swap, which does need the exact-amount approval: confirm the approval is for exactly the amount, not unlimited.

## 5. Each remaining chain
Repeat step 4, one chain at a time: Ethereum (gas is dear, use the smallest sensible amount), BNB Chain, Polygon, Arbitrum, Optimism, Avalanche. With `SWINGS_EVM_CHAINS` set to the one chain you are testing, change it to the next one each time.

## 6. Splits
Splits trigger only for large trades on thin pools, so they are best proven by one deliberate test on a thin pair, small in absolute terms. Confirm one transaction, two legs, and that both legs' minimums are respected.

## 7. The Aretia fee (0.29%)
- Set `PUBLIC_ARETIA_EVM_FEE_ADDRESS` in Vercel (the address that receives EVM fees) and redeploy.
- With the canary wallet and tiny amounts: swap SOL on Solana and confirm 0.29% of the SOL entered arrives at the fee wallet, in the same transaction; sell a little USDC and confirm the fee arrives in USDC; on one EVM network confirm the fee transaction is sent and confirmed before the swap, and arrives at the EVM fee address.

## 8. Optional features
- Protected sending (`SWINGS_PROTECTED_SUBMIT=on`): test one small swap; confirm the tip is shown on the review screen and charged only on success.
- Public quote API (`SWINGS_PUBLIC_API=on`): it only quotes; test from an unrelated origin.

## Watching it work
Once swaps run, compare Aretia with the aggregators using the shadow data (anonymous, from `swings_events`):

```sql
select * from public.swings_shadow_summary order by comparisons desc;
```

`avg_diff_bps` below zero means Aretia was behind on average; `aretia_behind` counts how often.

## Kill switches (no code change)
- Set `SWINGS_EVM_CHAINS` to the chains you want on (or `none`) to switch the others off.
- Set `SWINGS_CANARY_WALLETS` to a wallet you control (or an address nobody holds) to stop everyone else.
- Set `SWINGS_AGGREGATORS=off` to remove Jupiter and 0x from routing.
- Set `SWINGS_PROTECTED_SUBMIT` or `SWINGS_PUBLIC_API` to anything but `on` to disable them.
- A venue can be marked maintenance in the registry.

## What a clean run proves, and what it does not
It proves the transaction Aretia builds does what the review screen says, once, on that chain, for that route. It does not prove the router is safe in general, and it is not an audit. The external review in `ARETIA_SWINGS_AUDIT_READINESS.md` is still required before real users' money moves.
