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

/**
 * Groups credit rows (as stored: chain, asset, referrer, share_raw, fee_raw, status, paid_at) by referrer, chain and coin.
 * Only `credited` rows that have not been marked paid count as owed; those of a revoked referrer are shown as void, not owed.
 */
export function owedByReferrer(rows, revokedReferrers = []) {
  const revoked = new Set(revokedReferrers);
  const map = new Map();
  for (const r of rows) {
    if (r.status !== 'credited') continue;
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
