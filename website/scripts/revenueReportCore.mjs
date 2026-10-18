// The pure part of the private revenue report: what the fee addresses are, how a transfer is classified, how events are decoded,
// and how the numbers are totalled and printed. No network, no files, no keys. See revenue-report.mjs for the reading.

/** Where Aretia's fees land on Solana (MANAGEMENT_FEE.md). */
export const SOLANA_FEE_WALLET = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
/** The same address on every EVM chain (walletLaunchEvmCore.ts, FEE_ADDRESS). */
export const EVM_FEE_ADDRESS = '0xeb8725e16e504036c2166aa47804d88ecc4d0945';
/** The flat fee for a Solana token creation or a Meteora pool opening. */
export const SOLANA_FLAT_FEE_LAMPORTS = 50_000_000n;
/** The Aretia Curve, the same address on all three chains (walletCurveEvmCore.ts). */
export const EVM_CURVE = '0x4e85bc5bd6f08fa87ceb749372e34226556837e8';

const coin = (whole, frac = '') => BigInt(whole) * 10n ** 18n + (frac ? BigInt(frac.padEnd(18, '0')) : 0n);

/**
 * The three EVM chains with an Aretia token factory. `blocksPerDay` is approximate, only used to find where "30 days ago" is.
 * Factory addresses, creation fees and stablecoins are the ones in walletLaunchEvmCore.ts and walletPoolEvmCore.ts (a test keeps them equal).
 */
export const EVM_CHAINS = [
  {
    key: 'ethereum', name: 'Ethereum', chainId: 1, symbol: 'ETH', coingecko: 'ethereum', rpc: 'https://ethereum-rpc.publicnode.com', logRpcs: ['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com'], blocksPerDay: 7200,
    factory: '0x951a22270faa7d1c25efad2356c414cbddaba324', creationFeeWei: coin(0, '0042'),
    stables: { USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 }, USDT: { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 } },
  },
  {
    key: 'bnb', name: 'BNB Chain', chainId: 56, symbol: 'BNB', coingecko: 'binancecoin', rpc: 'https://bsc-rpc.publicnode.com', logRpcs: ['https://bsc.drpc.org', 'https://bsc-rpc.publicnode.com'], blocksPerDay: 28800,
    factory: '0xc3eb98c45795cffb10b61178332cc6fcbbc0385c', creationFeeWei: coin(0, '014'),
    stables: { USDC: { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 }, USDT: { address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 } },
  },
  {
    key: 'polygon', name: 'Polygon', chainId: 137, symbol: 'POL', coingecko: 'polygon-ecosystem-token', rpc: 'https://polygon-bor-rpc.publicnode.com', logRpcs: ['https://polygon.drpc.org', 'https://polygon-bor-rpc.publicnode.com'], blocksPerDay: 43200,
    factory: '0xca1aa427ba5906d00377a835dd9b36b049034f0c', creationFeeWei: coin(105),
    stables: { USDC: { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 }, USDT: { address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6 } },
  },
];

export const SOLANA_USDC = { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };

// ---------------------------------------------------------------- Solana

/**
 * One transaction's effect on the fee wallet, in lamports (positive = money in). A deposit of exactly the flat fee is a token creation
 * or a pool opening (they cost the same, so they cannot be told apart from the balance alone); any other deposit is something else:
 * swap fees, curve or pool shares, or a transfer from a person.
 */
export function classifySolana(deltaLamports) {
  if (deltaLamports <= 0n) return deltaLamports < 0n ? 'out' : 'none';
  return deltaLamports === SOLANA_FLAT_FEE_LAMPORTS ? 'launch-fee' : 'other-in';
}

/** Totals a list of { deltaLamports, usdcDelta } into streams. Amounts are bigints in the smallest unit. */
export function summariseSolana(txs) {
  const out = { launchFees: { count: 0, lamports: 0n }, otherIn: { count: 0, lamports: 0n }, out: { count: 0, lamports: 0n }, usdcIn: 0n, usdcOut: 0n };
  for (const t of txs) {
    const kind = classifySolana(t.deltaLamports);
    if (kind === 'launch-fee') {
      out.launchFees.count += 1;
      out.launchFees.lamports += t.deltaLamports;
    } else if (kind === 'other-in') {
      out.otherIn.count += 1;
      out.otherIn.lamports += t.deltaLamports;
    } else if (kind === 'out') {
      out.out.count += 1;
      out.out.lamports += -t.deltaLamports;
    }
    if ((t.usdcDelta ?? 0n) > 0n) out.usdcIn += t.usdcDelta;
    if ((t.usdcDelta ?? 0n) < 0n) out.usdcOut += -t.usdcDelta;
  }
  return out;
}

// ---------------------------------------------------------------- EVM

const word = (hex, i) => BigInt('0x' + hex.replace(/^0x/, '').slice(i * 64, (i + 1) * 64).padEnd(64, '0'));

/** The fee out of an AretiaCurve `Traded(token, trader, isBuy, coin, fee, tokens, vSol, vTok, realSol)` log: the third data word. */
export function decodeTradedFee(log) {
  return word(log.data, 2);
}

/** The amount out of an ERC-20 `Transfer(from, to, value)` log. */
export function decodeTransferValue(log) {
  return word(log.data, 0);
}

/** "0x" + the address left-padded to a 32-byte topic. */
export const addressTopic = (address) => '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** Creations times the flat fee. */
export const creationRevenue = (count, feeWei) => BigInt(count) * feeWei;

// ---------------------------------------------------------------- numbers for people

export function fromUnits(raw, decimals) {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals);
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** An amount as a number for dollar maths (floats are fine here: this is a report, not a ledger). */
export const toNumber = (raw, decimals) => Number(fromUnits(raw, decimals));

export const money = (usd) => (Number.isFinite(usd) ? `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a');

export function coinText(raw, decimals, symbol) {
  const n = toNumber(raw, decimals);
  const places = Math.abs(n) >= 1 ? 4 : 6;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: places })} ${symbol}`;
}

// ---------------------------------------------------------------- the report

/**
 * Builds the report object from what was read. `data` has: days, prices { SOL, ETH, BNB, POL } in USD (a missing price makes that chain's
 * dollar figures "n/a"), solana { balanceLamports, usdcBalance, summary }, and evm[] with per-chain readings.
 */
export function buildReport(data) {
  const rows = [];
  const priceOf = (symbol) => data.prices?.[symbol];
  const add = (chain, stream, amountText, usd, note = '') => rows.push({ chain, stream, amountText, usd, note });

  const sol = data.solana;
  const solUsd = priceOf('SOL');
  const usd = (raw, decimals, price) => (price === undefined ? NaN : toNumber(raw, decimals) * price);
  add('Solana', 'Token creation and pool opening (flat 0.05 SOL)', `${sol.summary.launchFees.count} x 0.05 SOL = ${coinText(sol.summary.launchFees.lamports, 9, 'SOL')}`, usd(sol.summary.launchFees.lamports, 9, solUsd), 'A creation and a pool opening cost the same, so they are counted together.');
  add('Solana', 'Other SOL received', `${sol.summary.otherIn.count} deposits = ${coinText(sol.summary.otherIn.lamports, 9, 'SOL')}`, usd(sol.summary.otherIn.lamports, 9, solUsd), 'Swap fees, curve or pool shares, or transfers from people. Not itemised.');
  add('Solana', 'USDC received', coinText(sol.summary.usdcIn, SOLANA_USDC.decimals, 'USDC'), usd(sol.summary.usdcIn, SOLANA_USDC.decimals, 1));

  for (const c of data.evm) {
    const px = priceOf(c.chain.symbol);
    add(c.chain.name, 'Token creation (flat fee)', `${c.creations} x ${coinText(c.chain.creationFeeWei, 18, c.chain.symbol)} = ${coinText(creationRevenue(c.creations, c.chain.creationFeeWei), 18, c.chain.symbol)}`, usd(creationRevenue(c.creations, c.chain.creationFeeWei), 18, px), 'Counted from the factory\'s creation events times the fee it charges.');
    add(c.chain.name, 'Aretia Curve fees (0.58%)', `${c.curveTrades} trades, fees ${coinText(c.curveFees, 18, c.chain.symbol)}`, usd(c.curveFees, 18, px));
    add(c.chain.name, 'Pool fee and other stablecoins received', `USDC ${coinText(c.stableIn.USDC, c.chain.stables.USDC.decimals, '')}, USDT ${coinText(c.stableIn.USDT, c.chain.stables.USDT.decimals, '')}`, usd(c.stableIn.USDC, c.chain.stables.USDC.decimals, 1) + usd(c.stableIn.USDT, c.chain.stables.USDT.decimals, 1), 'Every USDC or USDT transfer to the fee address, including the 10 USDC or USDT pool fee.');
  }

  const total = rows.reduce((s, r) => s + (Number.isFinite(r.usd) ? r.usd : 0), 0);
  const holdings = [{ chain: 'Solana', what: 'SOL', text: coinText(sol.balanceLamports, 9, 'SOL'), usd: usd(sol.balanceLamports, 9, solUsd) }, { chain: 'Solana', what: 'USDC', text: coinText(sol.usdcBalance, SOLANA_USDC.decimals, 'USDC'), usd: usd(sol.usdcBalance, SOLANA_USDC.decimals, 1) }];
  for (const c of data.evm) {
    const px = priceOf(c.chain.symbol);
    holdings.push({ chain: c.chain.name, what: c.chain.symbol, text: coinText(c.nativeBalance, 18, c.chain.symbol), usd: usd(c.nativeBalance, 18, px) });
    holdings.push({ chain: c.chain.name, what: 'USDC', text: coinText(c.stableBalance.USDC, c.chain.stables.USDC.decimals, 'USDC'), usd: usd(c.stableBalance.USDC, c.chain.stables.USDC.decimals, 1) });
    holdings.push({ chain: c.chain.name, what: 'USDT', text: coinText(c.stableBalance.USDT, c.chain.stables.USDT.decimals, 'USDT'), usd: usd(c.stableBalance.USDT, c.chain.stables.USDT.decimals, 1) });
  }
  const held = holdings.reduce((s, r) => s + (Number.isFinite(r.usd) ? r.usd : 0), 0);
  return { generatedAt: data.generatedAt, days: data.days, prices: data.prices, rows, total, holdings, held, notes: data.notes ?? [] };
}

const LIMITS = [
  'Native-coin income on EVM chains other than creation fees and curve fees (for example swap fees paid in BNB or ETH) cannot be itemised from a public node, so it only shows in the holdings.',
  'Solana deposits of exactly 0.05 SOL are counted as launch fees; everything else received is "other".',
  'Prices are from CoinGecko at the time of the report, so dollar figures move with the market.',
  'This is income received at the fee addresses, before any gas or costs, and not accounting or tax advice.',
];

export function renderText(r) {
  const lines = [`Aretia revenue, last ${r.days} days (generated ${r.generatedAt})`, ''];
  lines.push(`Income received: ${money(r.total)}`);
  for (const row of r.rows) lines.push(`  ${row.chain.padEnd(10)} ${row.stream.padEnd(52)} ${money(row.usd).padStart(12)}   ${row.amountText}`);
  lines.push('', `Held at the fee addresses now: ${money(r.held)}`);
  for (const h of r.holdings) lines.push(`  ${h.chain.padEnd(10)} ${h.what.padEnd(6)} ${h.text.padStart(24)} ${money(h.usd).padStart(12)}`);
  lines.push('', 'Limits:', ...[...LIMITS, ...r.notes].map((n) => `  - ${n}`));
  return lines.join('\n');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function renderHtml(r) {
  const row = (cells, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}>${cells.map((c, i) => `<td${i >= 2 ? ' class="r"' : ''}>${esc(c)}</td>`).join('')}</tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aretia revenue</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:32px auto;max-width:980px;padding:0 16px;color:#16142b}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p.s{color:#666;margin:0 0 18px}.big{font-size:34px;font-weight:700;margin:4px 0 0}table{border-collapse:collapse;width:100%}td,th{padding:8px 10px;border-top:1px solid #e4e2f2;vertical-align:top}th{text-align:left;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:#666}.r{text-align:right}tr.t td{font-weight:700;border-top:2px solid #16142b}small{color:#777;display:block}ul{color:#555;padding-left:20px}@media(prefers-color-scheme:dark){body{background:#12111f;color:#eceaf8}td,th{border-color:#2b2945}th,p.s,ul,small{color:#a9a6c4}}</style></head><body>
<h1>Aretia revenue</h1><p class="s">Last ${esc(r.days)} days. Generated ${esc(r.generatedAt)}. Private: this file is on your computer only.</p>
<div>Income received</div><div class="big">${esc(money(r.total))}</div>
<h2>Income by chain and stream</h2><table><tr><th>Chain</th><th>Stream</th><th class="r">Amount</th><th class="r">USD</th></tr>
${r.rows.map((x) => `<tr><td>${esc(x.chain)}</td><td>${esc(x.stream)}${x.note ? `<small>${esc(x.note)}</small>` : ''}</td><td class="r">${esc(x.amountText)}</td><td class="r">${esc(money(x.usd))}</td></tr>`).join('\n')}
${row(['', 'Total', '', money(r.total)], 't')}</table>
<h2>Held at the fee addresses now</h2><table><tr><th>Chain</th><th>Asset</th><th class="r">Amount</th><th class="r">USD</th></tr>
${r.holdings.map((h) => row([h.chain, h.what, h.text, money(h.usd)])).join('\n')}
${row(['', 'Total held', '', money(r.held)], 't')}</table>
<h2>Limits</h2><ul>${[...LIMITS, ...r.notes].map((n) => `<li>${esc(n)}</li>`).join('')}</ul></body></html>`;
}

/** One line for the running ledger (month-over-month): date, days, income, held. */
export const ledgerLine = (r) => `${r.generatedAt},${r.days},${r.total.toFixed(2)},${r.held.toFixed(2)}\n`;
