/* global process */
// Fee-key monitor (audit M-2). READ-ONLY: it holds no key and sends nothing.
//
// The deployed Aretia curves (and the token factories and pools) pay the EVM fee address inside every trade, and a failed payment
// reverts the trade. Under EIP-7702 one signed authorisation can give that address code, which could then refuse the payment and freeze
// every buy and sell on every curve, permanently, since the contracts cannot be changed. This script asks each chain whether the fee
// address has any code, and exits non-zero with an alert if it does on any of them.
//
//   node scripts/fee-key-monitor.mjs
//   ETHEREUM_RPC_URL=... BNB_RPC_URL=... POLYGON_RPC_URL=... node scripts/fee-key-monitor.mjs     (your own nodes)
//   FEE_ADDRESS=0x... node scripts/fee-key-monitor.mjs                                             (another address)
//
//   FEE_MONITOR_STATE=state.json FEE_MONITOR_REPORT=report.md node scripts/fee-key-monitor.mjs                (as the workflow runs it)
//
// Exit codes: 0 no code anywhere; 1 code found (ALERT); 2 a chain could not be read (check again, it proves nothing either way);
// 3 chains could not be read UNREADABLE_LIMIT runs in a row (FEE_MONITOR_STATE keeps the count between runs): the monitor is blind.
// Node URLs are never printed (a keyed URL is a secret): only their host. Run on a schedule (.github/workflows/fee-key-monitor.yml,
// hourly). See docs/operations/fee-key-monitor.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Aretia's EVM fee address, the same on every network (walletLaunchEvmCore.ts FEE_ADDRESS, curve-mainnet.mjs). */
export const FEE_ADDRESS = '0xeb8725e16e504036c2166aa47804d88ecc4d0945';

export const CHAINS = [
  { key: 'ethereum', name: 'Ethereum', chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', env: 'ETHEREUM_RPC_URL' },
  { key: 'bnb', name: 'BNB Chain', chainId: 56, rpc: 'https://bsc-rpc.publicnode.com', env: 'BNB_RPC_URL' },
  { key: 'polygon', name: 'Polygon', chainId: 137, rpc: 'https://polygon-bor-rpc.publicnode.com', env: 'POLYGON_RPC_URL' },
];

/** What an `eth_getCode` answer means for the fee address. Pure. */
export function classifyCode(code) {
  if (typeof code !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(code)) return { state: 'unreadable', detail: 'the node gave no code answer' };
  const c = code.toLowerCase();
  if (c === '0x') return { state: 'clean', detail: 'no code' };
  if (c.startsWith('0xef0100') && c.length === 2 + 46) return { state: 'alert', detail: `EIP-7702 delegation to 0x${c.slice(8)}` };
  return { state: 'alert', detail: `contract code (${(c.length - 2) / 2} bytes, starting ${c.slice(0, 18)})` };
}

/**
 * A node URL as it may be printed: the scheme and the provider's domain only, since a provider's key often sits in the path, the query
 * or a sub-domain. Pure.
 */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    const labels = u.hostname.split('.');
    return `${u.protocol}//${labels.length > 2 ? `…${labels.slice(-2).join('.')}` : u.hostname}/…`;
  } catch {
    return '(a node URL)';
  }
}

/** Removes every appearance of the node URL (and its unredacted host and path) from a message. Pure. */
export function redactIn(text, url) {
  let out = String(text);
  if (url) {
    out = out.split(url).join(redactUrl(url));
    try {
      const u = new URL(url);
      const rest = `${u.pathname}${u.search}`;
      if (rest.length > 1) out = out.split(rest).join('/…');
      if (u.hostname.split('.').length > 2) out = out.split(u.hostname).join(redactUrl(url).replace(/^[a-z]+:\/\/|\/…$/g, ''));
    } catch {
      // not a URL: nothing more to hide
    }
  }
  return out;
}

async function rpc(url, method, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** Checks one chain. Never throws: a node that fails is reported as unreadable. */
export async function checkChain(chain, address, url) {
  try {
    const id = Number.parseInt(await rpc(url, 'eth_chainId', []), 16);
    if (id !== chain.chainId) return { chain, state: 'unreadable', detail: `the node at ${redactUrl(url)} is chain ${id}, not ${chain.chainId}` };
    const r = classifyCode(await rpc(url, 'eth_getCode', [address, 'latest']));
    return { chain, ...r };
  } catch (e) {
    return { chain, state: 'unreadable', detail: redactIn(e instanceof Error ? e.message : String(e), url) };
  }
}

/** Runs in a row that could not read every chain before the monitor stops treating it as a warning and fails (exit 3). */
export const UNREADABLE_LIMIT = 3;

/** The count of unreadable runs in a row after this run's exit code, and the exit code to report. Pure. */
export function nextUnreadable(previous, code) {
  const before = Number.isSafeInteger(previous) && previous > 0 ? previous : 0;
  if (code !== 2) return { count: 0, code };
  const count = before + 1;
  return { count, code: count >= UNREADABLE_LIMIT ? 3 : 2 };
}

function readCount(file) {
  try {
    return existsSync(file) ? Number(JSON.parse(readFileSync(file, 'utf8')).unreadableRuns) : 0;
  } catch {
    return 0;
  }
}

/** The run as Markdown, for the issue the workflow opens. No node URLs. Pure. */
export function reportOf(address, results, code, unreadableRuns) {
  const head = code === 1 ? `**ALERT**: the Aretia fee address \`${address}\` has code.` : code === 3 ? `**The monitor is blind**: some chains could not be read ${unreadableRuns} runs in a row.` : code === 2 ? 'Some chains could not be read this run.' : 'No code on any chain.';
  return [head, '', '| Chain | State | Detail |', '|---|---|---|', ...results.map((r) => `| ${r.chain.name} | ${r.state} | ${String(r.detail).replace(/\|/g, '/')} |`), '', 'See docs/operations/fee-key-monitor.md.', ''].join('\n');
}

/** The exit code for a set of results: any alert wins, then any unreadable chain. Pure. */
export const exitCodeOf = (results) => (results.some((r) => r.state === 'alert') ? 1 : results.some((r) => r.state === 'unreadable') ? 2 : 0);

async function main() {
  const address = (process.env.FEE_ADDRESS || FEE_ADDRESS).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    console.error('Stop: FEE_ADDRESS is not an address.');
    process.exit(2);
  }
  const results = await Promise.all(CHAINS.map((c) => checkChain(c, address, process.env[c.env]?.trim() || c.rpc)));
  for (const r of results) console.log(`  ${r.state === 'clean' ? 'ok   ' : r.state === 'alert' ? 'ALERT' : 'retry'} ${r.chain.name}: ${r.detail}`);
  const stateFile = process.env.FEE_MONITOR_STATE?.trim();
  const { count, code } = nextUnreadable(stateFile ? readCount(stateFile) : 0, exitCodeOf(results));
  if (stateFile) {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ unreadableRuns: count }) + '\n');
  }
  const reportFile = process.env.FEE_MONITOR_REPORT?.trim();
  if (reportFile) writeFileSync(reportFile, reportOf(address, results, code, count));
  if (code === 3) console.error(`\nThe chains could not all be read ${count} runs in a row: the monitor cannot see the fee address. Check the node URLs.`);
  else if (code === 1) {
    console.error(`\nALERT: the Aretia fee address ${address} has code on ${results.filter((r) => r.state === 'alert').map((r) => r.chain.name).join(', ')}.`);
    console.error('Every buy and sell on the Aretia curves on that chain pays this address and reverts if the payment fails: the code can freeze or censor trading.');
    console.error('Act now: see docs/operations/fee-key-monitor.md (revoke the delegation with a new 7702 authorisation to the zero address, and warn users).');
  } else if (code === 2) console.error('\nSome chains could not be read. Nothing is proven for them; run again.');
  else console.log(`\nNo code at ${address} on any chain.`);
  process.exitCode = code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
