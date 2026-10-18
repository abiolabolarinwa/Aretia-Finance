# Private revenue report

A command you run on your own computer. It reads what has arrived at Aretia's fee addresses, adds it up in dollars by chain and by stream,
and saves a report in a folder on that computer. It is **read-only** (no key, nothing sent) and **uploads nothing**, so only whoever runs
it and can open that folder sees the report. The fee addresses are public on chain, so anyone could work the numbers out for themselves;
what stays private is the report.

```bash
cd website
node scripts/revenue-report.mjs                 # last 30 days
node scripts/revenue-report.mjs --days 7
node scripts/revenue-report.mjs --out "D:\private-folder"
```

It writes `revenue-YYYY-MM-DD.html` (open it in a browser) and a `.json`, and adds one line to `ledger.csv` in the same folder, so month
over month builds up over time. The default folder is `Documents\Aretia Revenue`. Keep it out of the repository and out of any shared or
public folder.

## What it counts

| Chain | Counted |
|---|---|
| Solana (`2tcBrd1J…VZoX2`) | SOL deposits of exactly 0.05 SOL as launch fees (a token creation and a pool opening cost the same, so they are one line); every other SOL deposit as "other" (swap fees, curve or pool shares, transfers); USDC received |
| Ethereum, BNB Chain, Polygon (`0xeB87…0945`) | Token creations from the factory's events times the fee it charges; Aretia Curve fees from its `Traded` events (the 0.58%); every USDC and USDT transfer to the fee address (this includes the 10 USDC or USDT pool fee) |
| Held now | SOL, USDC, and each EVM chain's coin, USDC and USDT at the fee addresses |

## Limits (the report prints them too)

- **Old log queries need a good node.** Reading 30 days of events on Ethereum and BNB Chain needs a node that allows them; the free public
  ones refuse. Put your own provider URL in the environment for each chain (`ETH_RPC_URL`, `BNB_RPC_URL`, `POLYGON_RPC_URL`). It is used
  only for these read-only queries and is never saved. Without it the report says which lines it could not read.
- **Swap fees in a chain's own coin** (Swings, 0.58%) cannot be itemised from a public node, so they appear only in "held now".
- Dollar figures use CoinGecko prices at the time of the run; if prices cannot be fetched, coin amounts are shown with dollars as n/a.
- It reports income received before gas and costs. It is not accounting or tax advice.
