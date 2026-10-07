// Only for `npm run typecheck:api`, which compiles the server functions and the engine without the page scripts.
// The real declaration of the wallet bridge lives in src/scripts/walletApp.ts.
interface Window {
  AretiaWallet?: { getWalletContextState(): unknown };
}
