/**
 * Finds which tokens an Ethereum-style address holds. A public node cannot be asked "what does this address own" (it can only be asked
 * about a token it already knows), and the open services that could answer have put their token-balance lists behind API keys or
 * payment. So the names of the tokens come from Rabby's public token list, which answers without a key and allows calls from a web
 * page. Only the contract addresses are taken from it: each one is then checked on-chain by loadEvmHoldings (balance, name, decimals),
 * so a wrong number from the list can never reach the dashboard.
 *
 * This is an outside service Aretia does not control: if it is down or changes, the dashboard still shows the native coins, the
 * well-known tokens and the tokens swapped through Aretia. The address being looked up is sent to it, as it is to the public nodes.
 */
import type { ChainId } from '../swings/core/types.js';
import type { ExtraToken } from './walletEvmHoldings';

/** Rabby's name for each network; one it does not list is not searched. */
const RABBY_CHAIN: Partial<Record<ChainId, string>> = { ethereum: 'eth', bnb: 'bsc', polygon: 'matic', base: 'base' };
const ENDPOINT = 'https://api.rabby.io/v1/user/token_list';
/** The most tokens taken from one network: the biggest holdings first, so a wallet full of dust cannot make the dashboard slow. */
export const MAX_PER_CHAIN = 40;
const TIMEOUT_MS = 8_000;

interface ListedToken {
  id?: unknown;
  amount?: unknown;
  price?: unknown;
}

/** The contract addresses in one network's answer, biggest dollar value first. Pure: anything that is not a contract address is dropped. */
export function tokensFromList(body: unknown, chain: ChainId, max = MAX_PER_CHAIN): ExtraToken[] {
  if (!Array.isArray(body)) return [];
  const rows: { address: string; value: number }[] = [];
  for (const t of body as ListedToken[]) {
    const id = typeof t?.id === 'string' ? t.id.toLowerCase() : '';
    // The network's own coin is listed under a plain name, not a contract address.
    if (!/^0x[0-9a-f]{40}$/.test(id)) continue;
    const amount = typeof t.amount === 'number' ? t.amount : 0;
    const price = typeof t.price === 'number' ? t.price : 0;
    rows.push({ address: id, value: amount * price });
  }
  return rows
    .sort((a, b) => b.value - a.value)
    .slice(0, max)
    .map((r) => ({ chain, address: r.address }));
}

export async function discoverEvmTokens(account: string, chains: readonly ChainId[], fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<ExtraToken[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) return [];
  const found = await Promise.allSettled(
    chains.map(async (chain) => {
      const slug = RABBY_CHAIN[chain];
      if (!slug) return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(`${ENDPOINT}?id=${account.toLowerCase()}&chain_id=${slug}&is_all=false`, { headers: { accept: 'application/json' }, signal: controller.signal });
        if (!res.ok) return [];
        return tokensFromList(await res.json(), chain);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return found.flatMap((f) => (f.status === 'fulfilled' ? f.value : []));
}
