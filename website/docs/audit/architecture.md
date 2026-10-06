# Audit architecture summary

The full description is in `docs/aretia-swings/final-architecture-report.md`. Summary for auditors:

```
Browser (wallet page)
  walletSwings.ts (UI)  ->  AretiaRouter  ->  DexProvider (Jupiter | 0x | mock)
                                         ->  ChainAdapter (Solana | EVM)  ->  user's own wallet signs
  New Tokens / search   ->  /api/swings-tokens  ->  TokenRegistryService  ->  Supabase (service role)
Server
  /api/swings-0x        ->  0x API (key in env)
  /api/swings-discover  ->  workers (GeckoTerminal source + on-chain enrichers)  ->  Supabase
```

Data flow rules: providers return data only; the wallet signs; the router orchestrates; the server holds the only credentials.
