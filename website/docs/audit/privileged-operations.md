# Privileged operations

Everything an operator can do that changes what Swings does with other people's money or data.

| Operation | Where | Effect | Controls |
|---|---|---|---|
| Enable Solana for execution | `CHAINS.solana.executionEnabled` in `core/types.ts` | Lets the router quote and execute on it | Code change and review |
| Narrow or switch off EVM networks | `SWINGS_EVM_CHAINS` env variable | EVM networks are on by default; this allow-list limits them (`none` = all off), with no code change | Operator-only; default is all on; checklist in `setup.md` |
| Trust 0x contracts | `ZEROX_TRUSTED_CONTRACTS` in `providers/evm0x.ts` | Decides which contracts a swap may call or be approved to | Holds only the 0x AllowanceHolder from 0x's documentation; confirm on each explorer before enabling a chain |
| Turn on analytics | `PUBLIC_SWINGS_ANALYTICS=1` | Stores anonymous aggregate events | Allow-listed fields only; off by default |
| Turn on the ACT buyback | `DEFAULT_BUYBACK_POLICY.enabled` and per-chain `enabled` in `core/fee.ts` | Allocates 0.55% to buy ACT | Rate capped at 100 bps; refuses to run without treasury and executor addresses |
| Set fee recipient addresses | `DEFAULT_FEE_CONFIG.chains` | Where fee-related funds go | No defaults for EVM; Solana references the existing management-fee wallet |
| Mark a token "verified" | `token_registry.verified` | Changes a token's label | Manual database write; no code path sets it |
| Server secrets | Vercel env: `ZEROX_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `EVM_RPC_*`, `SOLANA_RPC_URL` | Access to paid APIs and the database | Sensitive variables; rotate if exposed |
| Run discovery | `GET /api/swings-discover` with the cron secret | Writes registry rows | Bearer secret |
| Existing Trade-tab fee wallet | `SWAP_FEE_WALLET` in `walletTools.ts` | Receives the 1% Trade fee | Existing; unchanged |
