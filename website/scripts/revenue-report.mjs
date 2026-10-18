/* global process */
// Aretia's private revenue report. READ-ONLY: it asks public nodes what arrived at Aretia's fee addresses, adds it up, and writes a
// report to a folder on YOUR computer. It uses no key, sends nothing, and uploads nothing, so only whoever runs it (and can open that
// folder) sees the report. The fee addresses themselves are public on chain, so anyone could work the numbers out; what stays private
// is the report.
//
//   node scripts/revenue-report.mjs                    last 30 days, report in Documents\Aretia Revenue
//   node scripts/revenue-report.mjs --days 7           a different window
//   node scripts/revenue-report.mjs --out D:\private   a different folder (keep it out of the repository and out of any shared folder)
//
// Reading 30 days of events on Ethereum and BNB Chain needs a node that allows old log queries, which the free public ones do not. Give
// the script your own provider URL (Alchemy, Infura, QuickNode, Ankr ...) for each chain you want itemised; it is read from the
// environment, used only for these read-only queries, and never written anywhere:
//   $env:ETH_RPC_URL = "https://..."; $env:BNB_RPC_URL = "https://..."; $env:POLYGON_RPC_URL = "https://..."
// Without them, a chain's events are read as far as the free nodes allow, and the report says what it could not read.
//
// Each run adds one line to ledger.csv in that folder, so month-over-month is visible over time.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import {
  EVM_CHAINS, EVM_CURVE, EVM_FEE_ADDRESS, SOLANA_FEE_WALLET, SOLANA_USDC, addressTopic, buildReport, decodeTradedFee, decodeTransferValue, ledgerLine, renderHtml, renderText, summariseSolana,
} from './revenueReportCore.mjs';

const require = createRequire(import.meta.url);
const { keccak256, toHex } = require('viem');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const days = Number(arg('days', '30'));
if (!Number.isFinite(days) || days < 1 || days > 365) {
  console.error('Stop: --days must be a number from 1 to 365.');
  process.exit(1);
}
const outDir = arg('out', join(homedir(), 'Documents', 'Aretia Revenue'));
const notes = [];
const log = (m) => process.stderr.write(`${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(url, method, params, tries = 6) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(body.error.message ?? 'rpc error'), { rpc: true });
      return body.result;
    } catch (e) {
      if (e.rpc || attempt === tries - 1) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`${method}: gave up after retries`);
}

// ---------------------------------------------------------------- Solana

const SOL_RPC = 'https://api.mainnet-beta.solana.com';

async function readSolana() {
  const wallet = new PublicKey(SOLANA_FEE_WALLET);
  const ata = PublicKey.findProgramAddressSync(
    [wallet.toBytes(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes(), new PublicKey(SOLANA_USDC.mint).toBytes()],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  )[0].toBase58();
  const balanceLamports = BigInt((await rpc(SOL_RPC, 'getBalance', [SOLANA_FEE_WALLET])).value);
  let usdcBalance = 0n;
  try {
    usdcBalance = BigInt((await rpc(SOL_RPC, 'getTokenAccountBalance', [ata])).value.amount);
  } catch {
    // No USDC account yet: nothing held.
  }
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
  const sigs = [];
  let before;
  for (let page = 0; page < 20; page++) {
    const got = await rpc(SOL_RPC, 'getSignaturesForAddress', [SOLANA_FEE_WALLET, { limit: 1000, ...(before ? { before } : {}) }]);
    if (got.length === 0) break;
    for (const s of got) if (s.blockTime && s.blockTime >= cutoff && !s.err) sigs.push(s.signature);
    before = got[got.length - 1].signature;
    if (got[got.length - 1].blockTime && got[got.length - 1].blockTime < cutoff) break;
  }
  log(`Solana: ${sigs.length} transactions in the window`);
  const txs = [];
  for (let i = 0; i < sigs.length; i += 4) {
    const batch = await Promise.all(sigs.slice(i, i + 4).map((s) => rpc(SOL_RPC, 'getTransaction', [s, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null)));
    for (const tx of batch) {
      if (!tx?.meta) continue;
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const idx = keys.indexOf(SOLANA_FEE_WALLET);
      if (idx === -1) continue;
      const deltaLamports = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]);
      const usdc = (list) => (list ?? []).filter((b) => b.owner === SOLANA_FEE_WALLET && b.mint === SOLANA_USDC.mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
      txs.push({ deltaLamports, usdcDelta: usdc(tx.meta.postTokenBalances) - usdc(tx.meta.preTokenBalances) });
    }
  }
  return { balanceLamports, usdcBalance, summary: summariseSolana(txs) };
}

// ---------------------------------------------------------------- EVM

const TOKEN_CREATED = keccak256(toHex('TokenCreated(address,address,string,string,uint8,uint256)'));
const TRADED = keccak256(toHex('Traded(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256)'));
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
const hexN = (n) => '0x' + n.toString(16);

/**
 * eth_getLogs over a long range. A node refuses ranges that are too big, or refuses log queries altogether, so each slice is tried on
 * every node in turn and, if none accepts it, halved. Returns null if even a small slice cannot be read.
 */
async function logsChunked(urls, base, from, to) {
  const out = [];
  // Free nodes allow about 10,000 blocks per query, so start there and only shrink if a node says no.
  let step = Math.min(to - from + 1, 10_000);
  let at = from;
  let first = 0;
  while (at <= to) {
    const end = Math.min(at + step - 1, to);
    let got = null;
    for (let k = 0; k < urls.length && got === null; k++) {
      const url = urls[(first + k) % urls.length];
      try {
        got = await rpc(url, 'eth_getLogs', [{ ...base, fromBlock: hexN(at), toBlock: hexN(end) }], 2);
        first = (first + k) % urls.length;
      } catch {
        // try the next node
      }
    }
    if (got !== null) {
      out.push(...got);
      at = end + 1;
    } else {
      if (step <= 1000) return null;
      step = Math.max(Math.floor(step / 2), 1000);
    }
  }
  return out;
}

async function readEvmChain(baseChain) {
  const own = process.env[`${{ ethereum: 'ETH', bnb: 'BNB', polygon: 'POLYGON' }[baseChain.key]}_RPC_URL`];
  const chain = own ? { ...baseChain, logRpcs: [own, ...baseChain.logRpcs] } : baseChain;
  const latest = parseInt(await rpc(chain.rpc, 'eth_blockNumber', []), 16);
  const from = Math.max(latest - days * chain.blocksPerDay, 0);
  const nativeBalance = BigInt(await rpc(chain.rpc, 'eth_getBalance', [EVM_FEE_ADDRESS, 'latest']));
  const balanceOf = async (token) => BigInt(await rpc(chain.rpc, 'eth_call', [{ to: token, data: '0x70a08231' + EVM_FEE_ADDRESS.slice(2).padStart(64, '0') }, 'latest']));
  const stableBalance = { USDC: await balanceOf(chain.stables.USDC.address), USDT: await balanceOf(chain.stables.USDT.address) };

  const creationsLogs = await logsChunked(chain.logRpcs, { address: chain.factory, topics: [TOKEN_CREATED] }, from, latest);
  const tradedLogs = await logsChunked(chain.logRpcs, { address: EVM_CURVE, topics: [TRADED] }, from, latest);
  const stableIn = { USDC: 0n, USDT: 0n };
  for (const sym of ['USDC', 'USDT']) {
    const logs = await logsChunked(chain.logRpcs, { address: chain.stables[sym].address, topics: [TRANSFER, null, addressTopic(EVM_FEE_ADDRESS)] }, from, latest);
    if (logs === null) notes.push(`${chain.name}: ${sym} transfers could not be read from the public node, so that line may be missing. Set ${{ ethereum: 'ETH', bnb: 'BNB', polygon: 'POLYGON' }[chain.key]}_RPC_URL to a provider URL that allows old log queries.`);
    else for (const l of logs) stableIn[sym] += decodeTransferValue(l);
  }
  if (creationsLogs === null) notes.push(`${chain.name}: token creations could not be read from the public node, so that line may be missing. Set ${{ ethereum: 'ETH', bnb: 'BNB', polygon: 'POLYGON' }[chain.key]}_RPC_URL to a provider URL that allows old log queries.`);
  if (tradedLogs === null) notes.push(`${chain.name}: curve trades could not be read from the public node, so that line may be missing. Set ${{ ethereum: 'ETH', bnb: 'BNB', polygon: 'POLYGON' }[chain.key]}_RPC_URL to a provider URL that allows old log queries.`);
  let curveFees = 0n;
  for (const l of tradedLogs ?? []) curveFees += decodeTradedFee(l);
  log(`${chain.name}: ${creationsLogs?.length ?? '?'} creations, ${tradedLogs?.length ?? '?'} curve trades`);
  return { chain, creations: creationsLogs?.length ?? 0, curveTrades: tradedLogs?.length ?? 0, curveFees, stableIn, nativeBalance, stableBalance };
}

// ---------------------------------------------------------------- prices

async function readPrices() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,binancecoin,polygon-ecosystem-token&vs_currencies=usd');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = await res.json();
    return { SOL: b.solana?.usd, ETH: b.ethereum?.usd, BNB: b.binancecoin?.usd, POL: b['polygon-ecosystem-token']?.usd };
  } catch (e) {
    notes.push(`Prices could not be fetched (${e.message}), so coin amounts are shown but their dollar figures are n/a.`);
    return {};
  }
}

// ---------------------------------------------------------------- run

log(`Reading the last ${days} days. Read-only; nothing is sent.`);
const [solana, prices] = await Promise.all([readSolana(), readPrices()]);
const evm = [];
for (const chain of EVM_CHAINS) {
  try {
    evm.push(await readEvmChain(chain));
  } catch (e) {
    notes.push(`${chain.name} could not be read (${e.message}); it is left out of this report.`);
  }
}
const report = buildReport({ days, prices, solana, evm, notes, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') });

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const html = join(outDir, `revenue-${stamp}.html`);
writeFileSync(html, renderHtml(report), 'utf8');
writeFileSync(join(outDir, `revenue-${stamp}.json`), JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), 'utf8');
appendFileSync(join(outDir, 'ledger.csv'), ledgerLine(report), 'utf8');
console.log(renderText(report));
console.log(`\nSaved on this computer only: ${html}`);
