/**
 * Optional EVM signals from services that need an API key. Each returns null when the service is not
 * configured or answers unexpectedly, so the risk engine reports the signal as unavailable. These are
 * written against the services' documented shapes and exercised with fakes; they have NOT been run
 * against the live services (no keys were available when they were written).
 */
import { CHAINS, type ChainId } from '../core/types.js';

/** Etherscan API v2 (one key, many chains): is the contract's source code verified? */
export async function sourceVerified(fetchImpl: typeof fetch, chain: ChainId, address: string, apiKey: string | undefined): Promise<boolean | null> {
  const chainId = CHAINS[chain].evmChainId;
  if (!apiKey || chainId === null) return null;
  try {
    const q = new URLSearchParams({ chainid: String(chainId), module: 'contract', action: 'getsourcecode', address, apikey: apiKey });
    const res = await fetchImpl(`https://api.etherscan.io/v2/api?${q}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: string; result?: unknown };
    if (body.status !== '1' || !Array.isArray(body.result) || typeof body.result[0] !== 'object' || body.result[0] === null) return null;
    const src = (body.result[0] as { SourceCode?: unknown }).SourceCode;
    return typeof src === 'string' ? src.length > 0 : null;
  } catch {
    return null;
  }
}

const bps = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,5}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : null;
};

/** Buy and sell tax in basis points as 0x reports them for a token, or null if 0x does not say. */
export async function zeroXTokenTax(fetchImpl: typeof fetch, chain: ChainId, token: string, apiKey: string | undefined): Promise<{ buyBps: number | null; sellBps: number | null } | null> {
  const chainId = CHAINS[chain].evmChainId;
  if (!apiKey || chainId === null) return null;
  try {
    const q = new URLSearchParams({ chainId: String(chainId), sellToken: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', buyToken: token, sellAmount: '1000000000000000' });
    const res = await fetchImpl(`https://api.0x.org/swap/allowance-holder/price?${q}`, { headers: { '0x-api-key': apiKey, '0x-version': 'v2' } });
    if (!res.ok) return null;
    const meta = ((await res.json()) as { tokenMetadata?: { buyToken?: Record<string, unknown> } }).tokenMetadata?.buyToken;
    if (!meta) return null;
    const out = { buyBps: bps(meta.buyTaxBps), sellBps: bps(meta.sellTaxBps) };
    return out.buyBps === null && out.sellBps === null ? null : out;
  } catch {
    return null;
  }
}
