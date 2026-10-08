/**
 * Real token logos for the swap panel. A token's picture comes from whatever the screen already knows (the wallet's
 * own list, the registry); where it knows none, this looks one up. Lookups go to DexScreener, up to 30 tokens in one
 * request, and are remembered (in memory and in this browser) so a token is asked about once.
 *
 * Native coins use the network's own logo from Aretia's own files; no lookup is needed. A picture that fails to load
 * falls back to the token's first letters (the screen does that), and only https links are ever used.
 */
import { SOLANA_NATIVE_ADDRESS, EVM_NATIVE_ADDRESS, type ChainId } from '../core/types.js';
import { DEXSCREENER_CHAIN } from '../charts/pool.js';

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
/** Aretia's own token uses Aretia's own mark; no outside service has a picture for it. */
const ACT_MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const ACT_LOGO = '/assets/logo-mark.png';

/** The picture of each network's own coin (the layer-2 networks all use ether). */
export const NATIVE_COIN_LOGO: Readonly<Record<ChainId, string>> = {
  solana: '/assets/chains/solana.png',
  ethereum: '/assets/chains/ethereum.png',
  bnb: '/assets/chains/bnb.png',
  polygon: '/assets/chains/polygon.png',
  base: '/assets/chains/ethereum.png',
  arbitrum: '/assets/chains/ethereum.png',
  optimism: '/assets/chains/ethereum.png',
  avalanche: '/assets/chains/avalanche.png',
};

export const logoKey = (chain: ChainId, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;

/** The picture for a network's own coin, or null if the address is not that coin. */
export function nativeLogo(chain: ChainId, address: string): string | null {
  if (chain === 'solana') return address === ACT_MINT ? ACT_LOGO : address === WRAPPED_SOL || address === SOLANA_NATIVE_ADDRESS ? NATIVE_COIN_LOGO.solana : null;
  return address.toLowerCase() === EVM_NATIVE_ADDRESS.toLowerCase() ? NATIVE_COIN_LOGO[chain] : null;
}

const found = new Map<string, string>();
const missing = new Map<string, number>();
const STORE_KEY = 'aretia-swings-logos';
const MISS_MS = 10 * 60_000;
let loaded = false;

function restore(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    for (const [k, v] of Object.entries(data)) if (typeof v === 'string' && /^https:\/\//.test(v)) found.set(k, v);
  } catch {
    // the saved copy is a convenience only
  }
}

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries([...found].slice(-600))));
  } catch {
    // storage may be blocked or full
  }
}

/** The picture already known for a token, or null. Never waits. */
export function cachedLogo(chain: ChainId, address: string): string | null {
  restore();
  return nativeLogo(chain, address) ?? found.get(logoKey(chain, address)) ?? null;
}

/** Pictures in a DexScreener answer: the image belongs to each pair's first (base) token. Pure. */
export function parseDexLogos(body: unknown): { address: string; url: string }[] {
  if (!Array.isArray(body)) return [];
  const out: { address: string; url: string }[] = [];
  for (const p of body as { baseToken?: { address?: string }; info?: { imageUrl?: string } }[]) {
    const address = p?.baseToken?.address;
    const url = p?.info?.imageUrl;
    if (typeof address === 'string' && typeof url === 'string' && /^https:\/\//.test(url) && url.length < 500) out.push({ address, url });
  }
  return out;
}

/** Looks up pictures for tokens that have none yet. Resolves true when at least one new picture was found. */
export async function ensureLogos(chain: ChainId, addresses: readonly string[], fetchImpl: typeof fetch = (...a) => fetch(...a), now: () => number = Date.now): Promise<boolean> {
  restore();
  const wanted = [...new Set(addresses)].filter((a) => a && !cachedLogo(chain, a) && now() - (missing.get(logoKey(chain, a)) ?? -Infinity) > MISS_MS);
  let gotAny = false;
  for (let i = 0; i < wanted.length; i += 30) {
    const batch = wanted.slice(i, i + 30);
    const asked = new Set(batch.map((a) => logoKey(chain, a)));
    try {
      const res = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${DEXSCREENER_CHAIN[chain]}/${batch.map(encodeURIComponent).join(',')}`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      for (const { address, url } of parseDexLogos(await res.json())) {
        const k = logoKey(chain, address);
        if (asked.has(k) && !found.has(k)) {
          found.set(k, url);
          gotAny = true;
        }
      }
    } catch {
      // the batch is treated as "not found for now"
    }
    for (const k of asked) if (!found.has(k)) missing.set(k, now());
  }
  if (gotAny) persist();
  return gotAny;
}

/** Test helper: forget everything. */
export function resetLogos(): void {
  found.clear();
  missing.clear();
  loaded = false;
}
