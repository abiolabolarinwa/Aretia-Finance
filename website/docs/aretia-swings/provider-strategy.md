# Provider strategy

All external services sit behind Aretia interfaces. Nothing in `router/` may import a provider.

```ts
interface LiquidityProvider {
  id: string;
  supports(chain: ChainId): boolean;
  getQuote(req: QuoteRequest): Promise<ProviderQuote>;   // must include expiresAt, minOut, fees
  buildTransaction(quote: ProviderQuote, user: string): Promise<UnsignedTx>;
  simulate(tx: UnsignedTx): Promise<SimulationResult>;   // optional per chain
  getSupportedTokens?(chain: ChainId): Promise<TokenRef[]>;
}
```

`execute()` is deliberately not on the provider. Signing and broadcasting belong to the user's wallet and the Execution Engine, so a provider can never move funds.

| Chain | Initial provider | Status |
|---|---|---|
| Solana | Jupiter (already integrated in `walletSwap.ts`) | Wrap as adapter |
| EVM x4 | An aggregator (candidates: 0x, 1inch, ParaSwap, OpenOcean, KyberSwap) | **Undecided; needs API key and terms review** |
| Any | Direct DEX provider (Uniswap v3, PancakeSwap, Raydium quoters) | Later; gives real provider competition |

Failover: providers are queried concurrently with a timeout. An error removes only that provider. If none return an executable quote, the UI says so. A materially worse route (more than a configured tolerance below the output already shown) is presented for explicit acceptance, never executed automatically.

Provider-supplied transactions are untrusted. They are decoded, checked against the quote (recipient, spender, amount, chain id, selector allow-list) and simulated before the wallet is asked to sign. This extends the approach already used in `judgeSwapSimulation`.
