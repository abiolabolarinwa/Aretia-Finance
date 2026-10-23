/**
 * Captures REAL logs from public nodes for every indexed factory, so decoder tests run on chain data rather than hand-made
 * bytes. For each adapter it saves: a few recent creation logs from the factory, and a few recent swap logs from a busy pool
 * of that factory (the pool of the chain's wrapped native coin and a dollar stablecoin). Output: src/swings/mi/fixtures/real-logs.json
 *
 *   node scripts/capture-mi-fixtures.mjs [specId ...]
 *
 * Re-running refreshes the file; a spec that cannot be captured (no busy pool, node refused) is recorded as `error`, never faked.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'swings', 'mi', 'fixtures', 'real-logs.json');

const RPC = {
  ethereum: ['https://ethereum-rpc.publicnode.com'],
  bnb: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],
  polygon: ['https://polygon-bor-rpc.publicnode.com'],
  base: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  arbitrum: ['https://arb1.arbitrum.io/rpc'],
  optimism: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  avalanche: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
};
const WNATIVE = {
  ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', bnb: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', polygon: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  base: '0x4200000000000000000000000000000000000006', arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', optimism: '0x4200000000000000000000000000000000000006', avalanche: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
};
const STABLE = {
  ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', bnb: '0x55d398326f99059ff775485246999027b3197955', polygon: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
  base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', arbitrum: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', optimism: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', avalanche: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
};

// The adapter list is read from the compiled catalogue's data by the caller: pass specs as JSON in MI_SPECS, or use this table.
const specs = JSON.parse(readFileSync(join(here, '..', 'src', 'swings', 'mi', 'fixtures', 'specs.json'), 'utf8'));

async function rpc(chain, method, params) {
  let last;
  for (const url of RPC[chain]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const body = await res.json();
        if (body.error) throw new Error(body.error.message);
        return body.result;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw last;
}
const pad = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const addr = (w) => '0x' + w.slice(-40);
const call = (chain, to, data) => rpc(chain, 'eth_call', [{ to, data }, 'latest']);
const hexn = (n) => '0x' + n.toString(16);

async function logsBack(chain, head, filter, want, stepBlocks) {
  const found = [];
  let to = head;
  for (let i = 0; i < (process.env.MI_WIDE ? 60 : 12) && found.length < want; i++) {
    const from = Math.max(0, to - stepBlocks + 1);
    try {
      const l = await rpc(chain, 'eth_getLogs', [{ ...filter, fromBlock: hexn(from), toBlock: hexn(to) }]);
      found.push(...l);
    } catch (e) {
      stepBlocks = Math.max(50, Math.floor(stepBlocks / 2));
      continue;
    }
    to = from - 1;
  }
  return found.slice(-want);
}

const result = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const only = process.argv.slice(2);
for (const s of specs) {
  if (only.length && !only.includes(s.id)) continue;
  const entry = { capturedAt: new Date().toISOString(), factory: s.factory, kind: s.kind };
  try {
    const head = Number.parseInt(await rpc(s.chain, 'eth_blockNumber', []), 16);
    entry.head = head;
    entry.factoryLogs = await logsBack(s.chain, head - 5, { address: s.factory, topics: [s.creationTopic] }, 3, process.env.MI_WIDE ? 50000 : 3000);
    if (entry.factoryLogs.length < 1) {
      // A quiet factory: ask the node for its whole history (rare events, so the answer is small), keep the newest few.
      try {
        const all = await rpc(s.chain, 'eth_getLogs', [{ address: s.factory, topics: [s.creationTopic], fromBlock: '0x0', toBlock: hexn(head - 5) }]);
        entry.factoryLogs = all.slice(-3);
      } catch (e) { /* recorded below as zero creations */ }
    }
    // A busy pool of this factory: wrapped native against the stablecoin.
    let pool = null;
    if (s.kind === 'v2') {
      const r = await call(s.chain, s.factory, '0xe6a43905' + pad(WNATIVE[s.chain]) + pad(STABLE[s.chain]));
      pool = addr(r);
    } else {
      for (const fee of [500, 3000, 2500, 100, 10000]) {
        const r = await call(s.chain, s.factory, '0x1698ee82' + pad(WNATIVE[s.chain]) + pad(STABLE[s.chain]) + fee.toString(16).padStart(64, '0'));
        const a = addr(r);
        if (!/^0x0{40}$/.test(a)) { const t = await logsBack(s.chain, head - 5, { address: a, topics: [s.swapTopic] }, 2, 500); if (t.length) { pool = a; entry.swapLogs = t; break; } }
      }
    }
    if (!pool || /^0x0{40}$/.test(pool)) throw new Error('no busy pool found');
    const t0 = addr(await call(s.chain, pool, '0x0dfe1681'));
    const t1 = addr(await call(s.chain, pool, '0xd21220a7'));
    const dec = async (t) => Number.parseInt(await call(s.chain, t, '0x313ce567'), 16);
    entry.pool = { address: pool, token0: t0, token1: t1, decimals0: await dec(t0), decimals1: await dec(t1) };
    if (!entry.swapLogs) entry.swapLogs = await logsBack(s.chain, head - 5, { address: pool, topics: [s.swapTopic] }, 2, 500);
    if (!entry.swapLogs.length && s.kind === 'v2') {
      // The wrapped-native/stable pair of this factory is quiet: take swaps from any pair that belongs to this factory.
      const any = await logsBack(s.chain, head - 5, { topics: [s.swapTopic] }, 400, 300);
      for (const l of any) {
        const f = addr(await call(s.chain, l.address, '0xc45a0155'));
        if (f.toLowerCase() === s.factory) {
          pool = l.address;
          entry.swapLogs = [l];
          const t0b = addr(await call(s.chain, pool, '0x0dfe1681'));
          const t1b = addr(await call(s.chain, pool, '0xd21220a7'));
          entry.pool = { address: pool, token0: t0b, token1: t1b, decimals0: await dec(t0b), decimals1: await dec(t1b) };
          break;
        }
      }
    }
    const blocks = [...new Set([...entry.factoryLogs, ...entry.swapLogs].map((l) => l.blockNumber))];
    entry.blockTimes = {};
    for (const b of blocks) entry.blockTimes[b] = Number.parseInt((await rpc(s.chain, 'eth_getBlockByNumber', [b, false])).timestamp, 16);
    console.log(s.id, 'ok', entry.factoryLogs.length, 'creations', entry.swapLogs.length, 'swaps');
  } catch (e) {
    entry.error = String(e.message ?? e);
    console.log(s.id, 'ERROR', entry.error);
  }
  result[s.id] = entry;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1));
