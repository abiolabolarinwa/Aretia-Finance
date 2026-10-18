/**
 * Finding a token by its pasted address when no search index knows it yet. A token made on Aretia a minute ago is on the
 * chain but not in GeckoTerminal, DexScreener or Jupiter, so a search by name or address comes back empty. The chain itself
 * is the one source that always has it: read the mint (Solana) or the contract (the EVM networks) and build the result
 * from what is there. Nothing about price, pool or safety is claimed: only that the token exists, and what it calls itself.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { normalizeTokenRef } from '../swings/core/token.js';
import { isSolanaAddress } from './walletTools.js';
import type { SearchHit } from '../swings/tokens/globalSearch.js';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The EVM networks a pasted 0x address is looked for on. */
export const EVM_LOOKUP_CHAINS = ['bnb', 'ethereum', 'polygon'] as const satisfies readonly ChainId[];

/**
 * Which networks a pasted string could be an address on. A Solana mint is base58 and cannot be an EVM address, and the
 * reverse; an EVM address could be on any EVM network, so all of them are asked. Anything else: none.
 */
export function addressCandidates(text: string): ChainId[] {
  const q = text.trim();
  if (EVM_ADDRESS.test(q)) return normalizeTokenRef('ethereum', q) ? [...EVM_LOOKUP_CHAINS] : [];
  if (isSolanaAddress(q)) return ['solana'];
  return [];
}

/** The hit for a Solana mint read from the chain, or null when it is not a mint. Pure so it can be tested. */
export function solanaHitFromMint(address: string, decimals: number, supply: bigint, metadata: { name: string; symbol: string } | null): SearchHit {
  const symbol = metadata?.symbol.trim().slice(0, 20) || `${address.slice(0, 4)}…${address.slice(-4)}`;
  return { chain: 'solana', address, symbol, name: metadata?.name.trim().slice(0, 60) ?? '', icon: null, decimals, liquidityUsd: null, priceUsd: null, fresh: true, risk: null };
}

/** Looks the address up on the chain(s) it could belong to. Empty when nothing is there; never throws. */
export async function lookupAddress(text: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const q = text.trim();
  const chains = addressCandidates(q);
  const out: SearchHit[] = [];
  await Promise.all(
    chains.map(async (chain) => {
      try {
        if (signal?.aborted) return;
        if (chain === 'solana') {
          const [{ fetchAccount, loadWeb3 }, { parseMintAccount }, { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID }] = await Promise.all([import('./walletSend'), import('./walletLaunchChain'), import('./walletTools')]);
          const [web3, acc] = await Promise.all([loadWeb3(), fetchAccount(q)]);
          if (!acc || (acc.owner !== TOKEN_PROGRAM_ID && acc.owner !== TOKEN_2022_PROGRAM_ID)) return;
          // Both token programs share the base mint layout; the reader only accepts the Token-2022 owner, so say that.
          const facts = parseMintAccount(web3, TOKEN_2022_PROGRAM_ID, acc.data);
          if (facts) out.push(solanaHitFromMint(q, facts.decimals, facts.supply, facts.metadata));
          return;
        }
        const { publicRead, readErc20 } = await import('../swings/chains/evmSession.js');
        const facts = await readErc20(publicRead(chain), q.toLowerCase());
        if (facts) out.push({ chain, address: q.toLowerCase(), symbol: facts.symbol, name: facts.name, icon: null, decimals: facts.decimals, liquidityUsd: null, priceUsd: null, fresh: true, risk: null });
      } catch {
        // a network not answering leaves the others
      }
    }),
  );
  return out.sort((a, b) => CHAINS[a.chain].name.localeCompare(CHAINS[b.chain].name));
}
