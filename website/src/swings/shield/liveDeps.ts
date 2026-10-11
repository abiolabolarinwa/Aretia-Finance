/**
 * The real reads behind Shield: Solana and EVM public nodes, DexScreener, the lock readers, the token rating engine and the
 * domain registry. Only what is checked goes out (an address, a token, a domain name); nothing about the wallet does.
 */
import { rpcCall, resolveName } from '../../scripts/walletSend.js';
import { DexScreenerPoolFinder } from '../charts/dexscreener.js';
import { fetchPairDetail } from '../charts/pairDetail.js';
import { publicRead } from '../chains/evmSession.js';
import { assessTokenSafety } from '../live.js';
import { checkLock } from '../market/lock.js';
import type { ShieldDeps } from './check.js';
import type { KnownAddress } from './types.js';

const finder = new DexScreenerPoolFinder();

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/rdap+json, application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Solana Foundation's public node, which keeps transaction history. Used only to read a wallet's history, and only when the main node says there is none. */
export async function historyCall<T>(method: string, params: unknown[]): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: controller.signal });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/** The main Solana read, and when it refuses (the public node blocks some methods, such as listing a wallet's token accounts) the Solana Foundation's node. */
export async function solRead<T>(method: string, params: unknown[]): Promise<T> {
  try {
    return await rpcCall<T>(method, params);
  } catch {
    return historyCall<T>(method, params);
  }
}

export function liveDeps(who: { own: string | null; known: readonly KnownAddress[] }): ShieldDeps {
  return {
    now: Date.now,
    sol: solRead,
    solHistory: historyCall,
    evm: (chain) => publicRead(chain),
    fetchJson,
    known: who.known,
    own: who.own,
    assessToken: assessTokenSafety,
    findPool: (chain, address) => finder.find(chain, address).catch(() => null),
    pairAgeMs: async (chain, pool) => (await fetchPairDetail(chain, pool).catch(() => null))?.ageMs ?? null,
    lock: (chain, pool) => checkLock(chain, pool, { evm: publicRead(chain), sol: rpcCall }, Date.now()),
    resolveName,
  };
}
