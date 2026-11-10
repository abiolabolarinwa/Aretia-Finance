/**
 * Token supply refresher: reads the total supply of the tokens the index already knows, so the Markets list can show a fully diluted value
 * (price x total supply). Never a market cap: how much of the supply is circulating is not on the chain.
 *
 * EVM chains with Multicall3: `totalSupply()` of up to 150 tokens in one node request. Solana: the supply held in the mint account, 100 mints
 * per `getMultipleAccounts`. Each pass takes the tokens never tried, then the ones tried longest ago (so a supply that changes, by minting
 * or burning, is read again after `staleMs`). A token that does not answer is recorded as unreadable with the time, so it is not asked
 * again on every pass.
 */
import type { MiChainConfig } from './chains.js';
import { MULTICALL_CHAINS, readTotalSupplies } from './reserves.js';
import { RpcError, type Read } from './rpc.js';
import type { MiStore } from './store.js';
import { parseMint } from './solana/accounts.js';
import { accounts } from './solana/engine.js';

export interface SupplyReport {
  chain: string;
  ok: boolean;
  skipped: 'unsupported' | null;
  considered: number;
  read: number;
  unreadable: number;
  error: string | null;
  durationMs: number;
}

export interface SupplyDeps {
  chain: MiChainConfig;
  read: Read;
  store: MiStore;
  now: () => number;
  /** Wall-clock budget for one pass, ms. */
  budgetMs: number;
  /** Tokens read per node request (default 150 on EVM, 100 on Solana). */
  batch?: number;
  /** Tokens considered per pass at most (default 600). */
  limit?: number;
  /** A supply is read again after this long (default 24 hours). */
  staleMs?: number;
}

const ZERO = /^0x0{40}$/;

export async function refreshSupplies(d: SupplyDeps): Promise<SupplyReport> {
  const t0 = d.now();
  const solana = d.chain.kind === 'solana';
  const r: SupplyReport = { chain: d.chain.id, ok: true, skipped: null, considered: 0, read: 0, unreadable: 0, error: null, durationMs: 0 };
  if (!solana && !MULTICALL_CHAINS.includes(d.chain.id)) return { ...r, skipped: 'unsupported' };
  try {
    const tokens = await d.store.tokensNeedingSupply(d.chain.id, t0 - (d.staleMs ?? 86_400_000), d.limit ?? 600);
    r.considered = tokens.length;
    const size = Math.max(1, Math.min(solana ? 100 : 150, d.batch ?? (solana ? 100 : 150)));
    const deadline = t0 + d.budgetMs;
    for (let i = 0; i < tokens.length && d.now() < deadline; i += size) {
      const group = tokens.slice(i, i + size);
      let supplies: (bigint | null)[];
      if (solana) {
        const got = await accounts(d.read, group.map((t) => t.address));
        supplies = group.map((t) => {
          const bytes = got.get(t.address);
          return bytes ? (parseMint(bytes)?.supply ?? null) : null;
        });
      } else {
        // The chain's own coin has no totalSupply(): it is recorded as unreadable, not asked about.
        const asked = group.map((t) => (ZERO.test(t.address) ? null : t.address));
        const answers = await readTotalSupplies(d.read, asked.filter((a): a is string => a !== null));
        let k = 0;
        supplies = asked.map((a) => (a === null ? null : (answers[k++] ?? null)));
      }
      const at = d.now();
      for (let k = 0; k < group.length; k++) {
        const s = supplies[k] ?? null;
        await d.store.setTokenSupply(group[k]!.key, s === null ? null : s.toString(), at);
        if (s === null) r.unreadable++;
        else r.read++;
      }
    }
  } catch (e) {
    r.ok = false;
    r.error = (e instanceof RpcError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : 'the supply refresh failed').slice(0, 300);
  }
  r.durationMs = d.now() - t0;
  return r;
}
