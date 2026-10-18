/* global process, Buffer */
// "Verified by Aretia": the automated checks. READ-ONLY: it asks a public node about one token and prints a report. It uses no key,
// sends no transaction and writes nothing unless you ask it to.
//
//   node scripts/verify-token.mjs solana <mint>
//   node scripts/verify-token.mjs ethereum <token>        (also: bnb, polygon)
//   node scripts/verify-token.mjs solana <mint> --out evidence.txt     also save the report, to publish as the evidence link
//   (set SOLANA_RPC_URL / ETH_RPC_URL / BNB_RPC_URL / POLYGON_RPC_URL to use your own node)
//
// It checks the two things a computer can: the supply is fixed, and the special powers are given up. The other two checks (the project
// link matches the claim, a locked pool exists) are done and recorded by a person; the report lists them as still to do.
// Exit code 0 only when both automated checks pass. See docs/verified-badge.md.
import { writeFileSync } from 'node:fs';
import { EVM_CHAINS } from './revenueReportCore.mjs';
import { automatedPass, checkEvm, checkSolana, readSolanaMint, renderReport } from './verifyTokenCore.mjs';

const [chain, token] = process.argv.slice(2);
const outAt = process.argv.indexOf('--out');
const out = outAt === -1 ? null : process.argv[outAt + 1];
const fail = (m) => {
  console.error(`Stop: ${m}`);
  process.exit(2);
};
if (!chain || !token) fail('usage: node scripts/verify-token.mjs <solana|ethereum|bnb|polygon> <token address>');

async function rpc(url, method, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

let automated;
if (chain === 'solana') {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)) fail('that is not a Solana address.');
  const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const r = await rpc(url, 'getAccountInfo', [token, { encoding: 'base64', commitment: 'finalized' }]);
  if (!r?.value) fail('no account at that address on Solana mainnet.');
  const data = Uint8Array.from(Buffer.from(r.value.data[0], 'base64'));
  automated = checkSolana(readSolanaMint(r.value.owner, data));
} else {
  const c = EVM_CHAINS.find((x) => x.key === chain);
  if (!c) fail('the chain must be solana, ethereum, bnb or polygon.');
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) fail('that is not an address (0x followed by 40 letters and numbers).');
  const url = process.env[`${chain.toUpperCase()}_RPC_URL`] || c.rpc;
  const code = await rpc(url, 'eth_getCode', [token, 'latest']);
  const supply = async () => {
    try {
      const v = await rpc(url, 'eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']);
      return /^0x[0-9a-fA-F]{64}$/.test(v) ? BigInt(v).toString() : null;
    } catch {
      return null;
    }
  };
  const a = await supply();
  const b = await supply();
  automated = checkEvm(code, a, b);
}

const text = renderReport({ chain, token, when: new Date().toISOString(), automated });
console.log(text);
if (out) {
  writeFileSync(out, text, 'utf8');
  console.log(`Saved to ${out}`);
}
process.exitCode = automatedPass(automated) ? 0 : 1;
