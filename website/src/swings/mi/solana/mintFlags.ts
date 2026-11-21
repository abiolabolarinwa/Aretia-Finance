/**
 * What a Solana token's mint still allows (its mint authority and its freeze authority), read from the chain when a list needs it.
 *
 * The Solana lists keep only tokens that can be bought and sold safely, and the test that matters most is read from the token's mint account:
 * with a freeze authority its issuer can lock a buyer's tokens, with a mint authority it can print more (solana/buyable.ts). The market indexer
 * records these flags as it goes, but when it has not (a node that refused requests, a database column not added yet) a list must not fall back on
 * an outside service's opinion. So a list reads what is missing itself: mint accounts, 100 to a request, from the first node that answers.
 *
 * A mint read is kept for six hours (an authority is switched off, almost never on), a mint that cannot be read is retried after a minute, and a
 * failure of every node leaves the flags unknown, which a list treats as "not listed" (unknown is not safe), never as safe.
 */
import { flagsOf } from './buyable.js';
import { fromBase64, parseMint } from './accounts.js';

const BATCH = 100;
const CONCURRENCY = 4;
const KEEP_MS = 6 * 3_600_000;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 4_000;
export const PUBLIC_SOLANA_RPC = 'https://solana-rpc.publicnode.com';

const memory = new Map<string, { at: number; flags: number | null }>();

/** For tests. */
export function resetMintFlagMemory(): void {
  memory.clear();
}

export type MintFlagReader = (mints: readonly string[]) => Promise<Map<string, number | null>>;

interface Account {
  data: [string, string];
}

/** A reader over these nodes, tried in order for each batch: a node that errors or answers a wrong number of accounts is skipped. */
export function mintFlagReader(rpcUrls: readonly string[], fetchImpl: typeof fetch, now: () => number = Date.now, signal?: AbortSignal): MintFlagReader {
  const urls = rpcUrls.filter((u) => /^https:\/\/\S+$/.test(u));
  return async (mints) => {
    const t0 = now();
    const out = new Map<string, number | null>();
    const need: string[] = [];
    for (const m of new Set(mints)) {
      const hit = memory.get(m);
      if (hit && t0 - hit.at < (hit.flags === null ? RETRY_MS : KEEP_MS)) out.set(m, hit.flags);
      else need.push(m);
    }
    const batches: string[][] = [];
    for (let i = 0; i < need.length; i += BATCH) batches.push(need.slice(i, i + BATCH));
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const batch = batches[next++];
        if (!batch) return;
        let accounts: (Account | null)[] | null = null;
        for (const url of urls) {
          try {
            const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [batch, { encoding: 'base64', commitment: 'confirmed' }] }), signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) continue;
            const body = (await res.json()) as { result?: { value?: (Account | null)[] } };
            const value = body.result?.value;
            if (Array.isArray(value) && value.length === batch.length) {
              accounts = value;
              break;
            }
          } catch {
            // try the next node
          }
        }
        batch.forEach((mint, i) => {
          const acc = accounts?.[i];
          let flags: number | null = null;
          if (acc && Array.isArray(acc.data) && typeof acc.data[0] === 'string') {
            const info = parseMint(fromBase64(acc.data[0]));
            if (info) flags = flagsOf(info.mintAuthority, info.freezeAuthority);
          }
          memory.set(mint, { at: t0, flags });
          out.set(mint, flags);
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    if (memory.size > 20_000) for (const [k, v] of memory) if (t0 - v.at >= KEEP_MS) memory.delete(k);
    return out;
  };
}
