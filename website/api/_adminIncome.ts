/**
 * Income received at Aretia's fee wallets over a window, read from public nodes for the owner's admin page.
 *   Solana   each transaction that touched the fee wallet: the change in its SOL balance (exactly the flat fee = a token creation or
 *            pool opening, anything else = "other received") and in its USDC.
 *   EVM      every USDC and USDT `Transfer` to the fee address, from the chain's logs.
 * What it cannot see is said in `notes`: it reads only as far back as the node allows, and a chain's own coin received (for example
 * swap fees paid in BNB) cannot be itemised from a public node. For the full picture run scripts/revenue-report.mjs.
 */
export interface IncomeConfig {
  solanaWallet: string;
  solanaRpc: string;
  usdcMint: string;
  flatFeeLamports: bigint;
  evmAddress: string;
  chains: readonly { key: string; name: string; symbol: string; coingecko: string; rpc: string; blocksPerDay: number; usdc: readonly [string, number]; usdt: readonly [string, number] }[];
  /** Own node URLs by chain key (ETH_RPC_URL …), used instead of the free ones when set. */
  rpcOverride?: Record<string, string | undefined>;
}

export interface IncomeLine { wallet: string; chain: string; stream: string; amount: string; usd: number | null; note?: string }
export interface Income {
  lines: IncomeLine[];
  totalUsd: number;
  notes: string[];
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_SOL_TXS = 120;

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (!res.ok || body.error || body.result === undefined || body.result === null) throw new Error(`${method} failed`);
  return body.result;
}

const unit = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;
const fmt = (n: number, places = 4): string => n.toLocaleString('en-US', { maximumFractionDigits: places });

export interface SolTx {
  meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
}
interface TokenBal { owner?: string; mint: string; uiTokenAmount: { amount: string } }

/** One transaction's effect on the wallet: lamports in (negative = out) and USDC in the smallest unit. */
export function solanaEffect(tx: SolTx, wallet: string, usdcMint: string): { lamports: bigint; usdc: bigint } | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(wallet);
  const lamports = i >= 0 ? BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0) : 0n;
  const sum = (list: TokenBal[] | undefined): bigint => (list ?? []).filter((b) => b.owner === wallet && b.mint === usdcMint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return { lamports, usdc: sum(meta.postTokenBalances) - sum(meta.preTokenBalances) };
}

/** Sums SOL and USDC received from a list of effects: a deposit of exactly the flat fee is a launch fee, other deposits are "other". */
export function summariseSolanaIncome(effects: { lamports: bigint; usdc: bigint }[], flat: bigint): { launches: number; launchLamports: bigint; otherCount: number; otherLamports: bigint; usdcIn: bigint } {
  const out = { launches: 0, launchLamports: 0n, otherCount: 0, otherLamports: 0n, usdcIn: 0n };
  for (const e of effects) {
    if (e.lamports > 0n) {
      if (e.lamports === flat) {
        out.launches++;
        out.launchLamports += e.lamports;
      } else {
        out.otherCount++;
        out.otherLamports += e.lamports;
      }
    }
    if (e.usdc > 0n) out.usdcIn += e.usdc;
  }
  return out;
}

/** The total of the `value` words of ERC-20 Transfer logs. */
export function sumTransferLogs(logs: { data: string }[]): bigint {
  return logs.reduce((s, l) => s + BigInt(l.data.length >= 66 ? l.data.slice(0, 66) : '0x0'), 0n);
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function solanaIncome(fetchImpl: typeof fetch, cfg: IncomeConfig, since: number, prices: Record<string, number | null>, days: number): Promise<{ lines: IncomeLine[]; notes: string[] }> {
  const notes: string[] = [];
  const wallet = 'Solana fee wallet';
  try {
    const sigs = (await rpc(fetchImpl, cfg.solanaRpc, 'getSignaturesForAddress', [cfg.solanaWallet, { limit: 300 }])) as { signature: string; blockTime: number | null; err: unknown }[];
    const inWindow = sigs.filter((s) => !s.err && s.blockTime !== null && s.blockTime * 1000 >= since);
    const reachedStart = sigs.length < 300 || sigs.some((s) => s.blockTime !== null && s.blockTime * 1000 < since);
    const wanted = inWindow.slice(0, MAX_SOL_TXS);
    let failed = 0;
    const effects: { lamports: bigint; usdc: bigint }[] = [];
    await pool(wanted, 6, async (s) => {
      try {
        const tx = (await rpc(fetchImpl, cfg.solanaRpc, 'getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])) as SolTx;
        const e = solanaEffect(tx, cfg.solanaWallet, cfg.usdcMint);
        if (e) effects.push(e);
      } catch {
        failed++;
      }
    });
    const sum = summariseSolanaIncome(effects, cfg.flatFeeLamports);
    const sol = prices.solana ?? null;
    const usdOf = (lamports: bigint): number | null => (sol === null ? null : unit(lamports, 9) * sol);
    const lines: IncomeLine[] = [
      { wallet, chain: 'Solana', stream: 'Token creation / pool opening (flat 0.05 SOL)', amount: `${sum.launches} x 0.05 SOL = ${fmt(unit(sum.launchLamports, 9))} SOL`, usd: usdOf(sum.launchLamports) },
      { wallet, chain: 'Solana', stream: 'Other SOL received', amount: `${sum.otherCount} deposits = ${fmt(unit(sum.otherLamports, 9))} SOL`, usd: usdOf(sum.otherLamports), note: 'Swap fees, curve or pool shares, or transfers from people. Not itemised.' },
      { wallet, chain: 'Solana', stream: 'USDC received', amount: `${fmt(unit(sum.usdcIn, 6), 2)} USDC`, usd: unit(sum.usdcIn, 6) },
    ];
    if (!reachedStart || inWindow.length > MAX_SOL_TXS) notes.push(`Solana: more than ${wanted.length} transactions fall in the ${days} days, so only the newest ${wanted.length} are counted; the true income is higher.`);
    if (failed > 0) notes.push(`Solana: ${failed} transaction${failed === 1 ? '' : 's'} could not be read from the public node and are missing.`);
    return { lines, notes };
  } catch {
    return { lines: [], notes: ['Solana income could not be read from the public node.'] };
  }
}

async function evmIncome(fetchImpl: typeof fetch, cfg: IncomeConfig, chain: IncomeConfig['chains'][number], days: number): Promise<{ lines: IncomeLine[]; notes: string[] }> {
  const wallet = 'EVM fee address';
  const url = cfg.rpcOverride?.[chain.key]?.trim() || chain.rpc;
  const topic = '0x' + cfg.evmAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  try {
    const latest = Number(BigInt((await rpc(fetchImpl, url, 'eth_blockNumber', [])) as string));
    // Free nodes refuse wide log queries, so a shorter range is tried when the wanted one is refused.
    for (const d of [...new Set([days, Math.min(days, 7), 1])]) {
      try {
        const logs = (await rpc(fetchImpl, url, 'eth_getLogs', [{ fromBlock: '0x' + Math.max(0, latest - chain.blocksPerDay * d).toString(16), toBlock: 'latest', address: [chain.usdc[0], chain.usdt[0]], topics: [TRANSFER, null, topic] }])) as { address: string; data: string }[];
        const of = (token: string): bigint => sumTransferLogs(logs.filter((l) => l.address.toLowerCase() === token.toLowerCase()));
        const usdc = unit(of(chain.usdc[0]), chain.usdc[1]);
        const usdt = unit(of(chain.usdt[0]), chain.usdt[1]);
        return {
          lines: [{ wallet, chain: chain.name, stream: `USDC and USDT received (last ${d} day${d === 1 ? '' : 's'})`, amount: `${fmt(usdc, 2)} USDC, ${fmt(usdt, 2)} USDT`, usd: usdc + usdt, note: 'Includes the pool fee and any stablecoin sent to the address.' }],
          notes: d < days ? [`${chain.name}: the free node would only read the last ${d} day${d === 1 ? '' : 's'}, not ${days}. Set a provider URL (see docs/admin-page.md) for the full window.`] : [],
        };
      } catch {
        // try a shorter range
      }
    }
    return { lines: [], notes: [`${chain.name}: stablecoin income could not be read from the free node.`] };
  } catch {
    return { lines: [], notes: [`${chain.name}: the public node could not be reached.`] };
  }
}

/** Reads the income lines for all the fee wallets. Never throws: what could not be read is in `notes`. */
export async function readIncome(fetchImpl: typeof fetch, cfg: IncomeConfig, now: number, days: number, prices: Record<string, number | null>): Promise<Income> {
  const since = now - days * 86_400_000;
  const parts = await Promise.all([solanaIncome(fetchImpl, cfg, since, prices, days), ...cfg.chains.map((c) => evmIncome(fetchImpl, cfg, c, days))]);
  const lines = parts.flatMap((p) => p.lines);
  const notes = [...parts.flatMap((p) => p.notes), 'A chain\'s own coin received on EVM chains (for example swap fees paid in BNB or ETH) cannot be itemised from a public node, so it is not in these lines.'];
  return { lines, totalUsd: lines.reduce((s, l) => s + (l.usd ?? 0), 0), notes };
}
