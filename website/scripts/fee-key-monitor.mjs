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
// Exit codes: 0 no code anywhere; 1 code found (ALERT); 2 a chain could not be read (check again, it proves nothing either way).
// Run on a schedule (.github/workflows/fee-key-monitor.yml, hourly). See docs/operations/fee-key-monitor.md.
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
    if (id !== chain.chainId) return { chain, state: 'unreadable', detail: `the node at ${url} is chain ${id}, not ${chain.chainId}` };
    const r = classifyCode(await rpc(url, 'eth_getCode', [address, 'latest']));
    return { chain, ...r };
  } catch (e) {
    return { chain, state: 'unreadable', detail: e instanceof Error ? e.message : String(e) };
  }
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
  const code = exitCodeOf(results);
  if (code === 1) {
    console.error(`\nALERT: the Aretia fee address ${address} has code on ${results.filter((r) => r.state === 'alert').map((r) => r.chain.name).join(', ')}.`);
    console.error('Every buy and sell on the Aretia curves on that chain pays this address and reverts if the payment fails: the code can freeze or censor trading.');
    console.error('Act now: see docs/operations/fee-key-monitor.md (revoke the delegation with a new 7702 authorisation to the zero address, and warn users).');
  } else if (code === 2) console.error('\nSome chains could not be read. Nothing is proven for them; run again.');
  else console.log(`\nNo code at ${address} on any chain.`);
  process.exitCode = code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
