// The pure part of the owner's referral export: totals what each referrer is owed, per chain and coin, from rows read out of the
// database. No network, no files, no keys. See referral-export.mjs for the reading and docs/referrals.md for the rules.

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const NATIVE_OF = { ethereum: 'ETH', bnb: 'BNB', polygon: 'POL', base: 'ETH', arbitrum: 'ETH', optimism: 'ETH', avalanche: 'AVAX', robinhood: 'ETH' };
const KNOWN = {
  So11111111111111111111111111111111111111112: { symbol: 'SOL', decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18 },
  '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6 },
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6 },
};

/** The coin an asset id means on a chain: its symbol and decimals, or null when this script does not know it (the raw amount is then printed). */
export function assetInfo(chain, asset) {
  if (asset === NATIVE) return { symbol: NATIVE_OF[chain] ?? 'native', decimals: 18 };
  return KNOWN[asset] ?? KNOWN[String(asset).toLowerCase()] ?? null;
}

export function fromUnits(raw, decimals) {
  const n = BigInt(raw);
  const d = 10n ** BigInt(decimals);
  const frac = (n % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${n / d}${frac ? '.' + frac : ''}`;
}

/** The key one on-chain payment is known by: an EVM hash in any letter case is the same transaction; a Solana signature is case-sensitive. */
export const paymentKey = (r) => `${r.chain}|${r.chain === 'solana' ? r.tx : String(r.tx ?? '').toLowerCase()}|${r.asset}`;

/**
 * The credited rows that may be paid: one per on-chain payment (EVM hashes grouped by lower case, keeping the earliest credited row,
 * so a copy stored under another letter case before migration 0013 is never paid twice), and none listed in `notFinal` (keys from
 * `recheckRows` of payments that are no longer on chain or not final).
 */
export function payableRows(rows, notFinal = new Set()) {
  const seen = new Set();
  const out = [];
  const ordered = [...rows].sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0));
  for (const r of ordered) {
    if (r.status !== 'credited') continue;
    if (r.tx !== undefined) {
      const k = paymentKey(r);
      if (seen.has(k) || notFinal.has(k)) continue;
      seen.add(k);
    }
    out.push(r);
  }
  return out;
}

/**
 * Groups credit rows (as stored: chain, tx, asset, referrer, share_raw, fee_raw, status, paid_at, created_at) by referrer, chain and
 * coin. Only `credited` rows that have not been marked paid count as owed, once per payment; those of a revoked referrer are shown as
 * void, not owed.
 */
export function owedByReferrer(rows, revokedReferrers = [], notFinal = new Set()) {
  const revoked = new Set(revokedReferrers);
  const map = new Map();
  for (const r of payableRows(rows, notFinal)) {
    const k = `${r.referrer}|${r.chain}|${r.asset}`;
    const g = map.get(k) ?? { referrer: r.referrer, chain: r.chain, asset: r.asset, swaps: 0, fee: 0n, owed: 0n, paid: 0n, void: 0n };
    g.swaps += 1;
    g.fee += BigInt(r.fee_raw);
    const share = BigInt(r.share_raw);
    if (revoked.has(r.referrer)) g.void += share;
    else if (r.paid_at) g.paid += share;
    else g.owed += share;
    map.set(k, g);
  }
  return [...map.values()].sort((a, b) => a.referrer.localeCompare(b.referrer) || a.chain.localeCompare(b.chain) || a.asset.localeCompare(b.asset));
}

const cell = (g, field) => {
  const info = assetInfo(g.chain, g.asset);
  return info ? `${fromUnits(g[field], info.decimals)} ${info.symbol}` : `${g[field]} raw units of ${g.asset}`;
};
const bare = (referrer) => referrer.replace(/^[a-z]+:/, '');

/** The export as plain text for the owner: who to pay, on which chain, how much of which coin. */
export function renderExport(groups, now = new Date()) {
  const lines = [`Aretia referral payouts owed, as of ${now.toISOString()}`, 'Pay each referrer by hand on the named network, to the address shown, then mark the rows paid (see docs/referrals.md). Nothing here pays anyone.', ''];
  const live = groups.filter((g) => g.owed > 0n);
  if (live.length === 0) lines.push('Nothing is owed.');
  for (const g of live) lines.push(`${bare(g.referrer)}  [${g.chain}]  owed ${cell(g, 'owed')}  (${g.swaps} swaps, fees ${cell(g, 'fee')})`);
  const voided = groups.filter((g) => g.void > 0n);
  if (voided.length) lines.push('', 'Void (referrer revoked), do not pay:', ...voided.map((g) => `${bare(g.referrer)}  [${g.chain}]  ${cell(g, 'void')}`));
  return lines.join('\n');
}

export function renderCsv(groups) {
  const out = ['referrer,chain,asset,symbol,swaps,fee_raw,owed_raw,paid_raw,void_raw'];
  for (const g of groups) out.push([bare(g.referrer), g.chain, g.asset, assetInfo(g.chain, g.asset)?.symbol ?? '', g.swaps, g.fee, g.owed, g.paid, g.void].join(','));
  return out.join('\n') + '\n';
}

/** Public read nodes, the same as api/_referralVerify.ts EVM_READ_RPC, and its confirmation depths. */
export const EXPORT_RPC = {
  solana: 'https://solana-rpc.publicnode.com',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://optimism-rpc.publicnode.com',
  avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
  robinhood: 'https://robinhood-rpc.publicnode.com',
};
export const EXPORT_CONFIRMATIONS = { ethereum: 64, bnb: 30, polygon: 64, base: 60, arbitrum: 480, optimism: 60, avalanche: 1, robinhood: 480 };

/**
 * Before paying: asks the chain again about every unpaid credited payment. Returns the keys (`paymentKey`) of those that are not
 * there any more, failed, or are not final (Solana: not `finalized`; EVM: fewer than the confirmation depth). A payment that cannot
 * be read is counted as not final, so nothing unconfirmed is paid. `fetchImpl` and `rpc` are injectable for tests.
 */
export async function recheckRows(rows, fetchImpl = fetch, rpc = EXPORT_RPC) {
  const call = async (chain, method, params) => {
    const res = await fetchImpl(rpc[chain], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`node ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error('node error');
    return body.result ?? null;
  };
  const bad = new Set();
  const heads = new Map();
  for (const r of payableRows(rows.filter((x) => !x.paid_at))) {
    const k = paymentKey(r);
    try {
      if (r.chain === 'solana') {
        const st = (await call('solana', 'getSignatureStatuses', [[r.tx], { searchTransactionHistory: true }]))?.value?.[0];
        if (!st || st.err !== null || st.confirmationStatus !== 'finalized') bad.add(k);
        continue;
      }
      const receipt = await call(r.chain, 'eth_getTransactionReceipt', [String(r.tx).toLowerCase()]);
      if (!heads.has(r.chain)) heads.set(r.chain, BigInt(await call(r.chain, 'eth_blockNumber', [])));
      const depth = BigInt(EXPORT_CONFIRMATIONS[r.chain] ?? 64);
      if (!receipt || receipt.status !== '0x1' || !receipt.blockNumber || heads.get(r.chain) - BigInt(receipt.blockNumber) + 1n < depth) bad.add(k);
    } catch {
      bad.add(k);
    }
  }
  return bad;
}
