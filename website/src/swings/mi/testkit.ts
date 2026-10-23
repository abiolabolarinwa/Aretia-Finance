/**
 * A small simulated EVM node for tests: blocks with hashes and timestamps, logs, token contracts, V2 pair reserves, and a
 * reorg operation. It answers the JSON-RPC methods the indexer uses and nothing else, and it can be told to fail.
 */
import { RpcError, type Read } from './rpc.js';
import { TOPICS } from './dexes.js';

export interface FakeLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  transactionHash: string;
}
interface FakeBlock {
  number: number;
  hash: string;
  time: number;
  logs: FakeLog[];
}

const hex = (n: number | bigint): string => '0x' + n.toString(16);
const pad = (h: string): string => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
export const word = (n: bigint): string => n.toString(16).padStart(64, '0');
const encodeString = (s: string): string => {
  const b = Buffer.from(s, 'utf8').toString('hex');
  return '0x' + word(32n) + word(BigInt(s.length)) + b.padEnd(Math.ceil(b.length / 64) * 64, '0');
};

export class FakeChain {
  blocks: FakeBlock[] = [];
  tokens = new Map<string, { symbol: string; name: string; decimals: number } | 'broken'>();
  reserves = new Map<string, [bigint, bigint]>();
  balances = new Map<string, bigint>();
  version = 0;
  /** When set, the next N calls of any method throw a transport error. */
  failNext = 0;
  /** Reject getLogs ranges wider than this with a node error (like a public node). */
  maxLogRange = Number.POSITIVE_INFINITY;
  calls: string[] = [];
  private nonce = 0;

  constructor(
    public startBlock = 1000,
    public startTime = 1_700_000_000,
    public blockSeconds = 3,
  ) {
    this.blocks.push(this.makeBlock(startBlock, []));
  }

  get head(): number {
    return this.blocks[this.blocks.length - 1]!.number;
  }

  private makeBlock(number: number, logs: FakeLog[]): FakeBlock {
    const hash = '0x' + (BigInt(number) * 1_000_003n + BigInt(++this.nonce) * 7_919n).toString(16).padStart(64, '0');
    return { number, hash, time: this.startTime + (number - this.startBlock) * this.blockSeconds, logs };
  }

  /** Mines one block holding these logs (logIndex and transactionHash are assigned). */
  mine(logs: Omit<FakeLog, 'logIndex' | 'transactionHash'>[] = []): FakeBlock {
    const number = this.head + 1;
    const block = this.makeBlock(number, []);
    block.logs = logs.map((l, i) => ({ ...l, logIndex: i, transactionHash: '0x' + (BigInt(number) * 1000n + BigInt(i) + 1n).toString(16).padStart(64, 'a') }));
    this.blocks.push(block);
    return block;
  }
  mineEmpty(n: number): void {
    for (let i = 0; i < n; i++) this.mine([]);
  }

  /** Replaces every block above `forkAfter` with new ones (new hashes); the callback returns the logs for each new block number. */
  reorg(forkAfter: number, logsFor: (n: number) => Omit<FakeLog, 'logIndex' | 'transactionHash'>[] = () => []): void {
    const oldHead = this.head;
    this.blocks = this.blocks.filter((b) => b.number <= forkAfter);
    for (let n = forkAfter + 1; n <= oldHead; n++) this.mine(logsFor(n));
  }

  addToken(address: string, symbol: string, decimals: number, name = symbol): void {
    this.tokens.set(address.toLowerCase(), { symbol, name, decimals });
  }

  read: Read = async (method, params) => {
    this.calls.push(method);
    if (this.failNext > 0) {
      this.failNext--;
      throw new RpcError('simulated transport failure', 'transport');
    }
    switch (method) {
      case 'eth_blockNumber':
        return hex(this.head);
      case 'eth_getBlockByNumber': {
        const tag = params[0] as string;
        const wanted = Number.parseInt(tag, 16);
        let b = tag === 'latest' ? this.blocks[this.blocks.length - 1] : this.blocks.find((x) => x.number === wanted);
        // History from before the simulation began: empty blocks with fixed hashes.
        if (!b && wanted >= 0 && wanted < this.startBlock) b = { number: wanted, hash: '0x' + BigInt(wanted + 1).toString(16).padStart(64, '0'), time: this.startTime - (this.startBlock - wanted) * this.blockSeconds, logs: [] };
        return b ? { number: hex(b.number), hash: b.hash, timestamp: hex(b.time) } : null;
      }
      case 'eth_getLogs': {
        const f = params[0] as { address?: string | string[]; topics: string[]; fromBlock: string; toBlock: string };
        const from = Number.parseInt(f.fromBlock, 16);
        const to = Number.parseInt(f.toBlock, 16);
        if (to - from + 1 > this.maxLogRange) throw new RpcError('query returned more than 10000 results / range too large', 'node-error');
        const addrs = (Array.isArray(f.address) ? f.address : f.address ? [f.address] : []).map((a) => a.toLowerCase());
        const out: unknown[] = [];
        for (const b of this.blocks) {
          if (b.number < from || b.number > to) continue;
          for (const l of b.logs) {
            if (addrs.length && !addrs.includes(l.address.toLowerCase())) continue;
            if (f.topics[0] && l.topics[0] !== f.topics[0]) continue;
            out.push({ address: l.address, topics: l.topics, data: l.data, blockNumber: hex(b.number), blockHash: b.hash, transactionHash: l.transactionHash, logIndex: hex(l.logIndex), removed: false });
          }
        }
        return out;
      }
      case 'eth_getCode':
        return this.tokens.has((params[0] as string).toLowerCase()) ? '0x6001' : '0x';
      case 'eth_call': {
        const c = params[0] as { to: string; data: string };
        const to = c.to.toLowerCase();
        const sel = c.data.slice(0, 10);
        const tok = this.tokens.get(to);
        if (sel === '0x313ce567') {
          if (!tok || tok === 'broken') throw new RpcError('execution reverted', 'node-error');
          return '0x' + word(BigInt(tok.decimals));
        }
        if (sel === '0x95d89b41' || sel === '0x06fdde03') {
          if (!tok || tok === 'broken') throw new RpcError('execution reverted', 'node-error');
          return encodeString(sel === '0x95d89b41' ? tok.symbol : tok.name);
        }
        if (sel === '0x0902f1ac') {
          const r = this.reserves.get(to);
          if (!r) throw new RpcError('execution reverted', 'node-error');
          return '0x' + word(r[0]) + word(r[1]) + word(0n);
        }
        if (sel === '0x70a08231') {
          const holder = '0x' + c.data.slice(-40).toLowerCase();
          return '0x' + word(this.balances.get(`${to}|${holder}`) ?? 0n);
        }
        throw new RpcError('execution reverted', 'node-error');
      }
      default:
        throw new RpcError(`unsupported method ${method}`, 'node-error');
    }
  };
}

// ------------------------------------------------------------------ log builders

export const addrTopic = (a: string): string => '0x' + pad(a);

export function pairCreatedLog(factory: string, token0: string, token1: string, pair: string): Omit<FakeLog, 'logIndex' | 'transactionHash'> {
  return { address: factory, topics: [TOPICS.v2PairCreated, addrTopic(token0), addrTopic(token1)], data: '0x' + pad(pair) + word(1n) };
}

export function poolCreatedLog(factory: string, token0: string, token1: string, fee: number, pool: string): Omit<FakeLog, 'logIndex' | 'transactionHash'> {
  return { address: factory, topics: [TOPICS.v3PoolCreated, addrTopic(token0), addrTopic(token1), '0x' + word(BigInt(fee))], data: '0x' + word(60n) + pad(pool) };
}

export function v2SwapLog(pool: string, a: { in0?: bigint; in1?: bigint; out0?: bigint; out1?: bigint }, to: string): Omit<FakeLog, 'logIndex' | 'transactionHash'> {
  return { address: pool, topics: [TOPICS.v2Swap, addrTopic('0x' + 'aa'.repeat(20)), addrTopic(to)], data: '0x' + word(a.in0 ?? 0n) + word(a.in1 ?? 0n) + word(a.out0 ?? 0n) + word(a.out1 ?? 0n) };
}

const signed = (n: bigint): string => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0');
export function v3SwapLog(pool: string, amount0: bigint, amount1: bigint, to: string, topic = TOPICS.v3Swap, extraWords = 0): Omit<FakeLog, 'logIndex' | 'transactionHash'> {
  const tail = word(0n).repeat(extraWords);
  return { address: pool, topics: [topic, addrTopic('0x' + 'aa'.repeat(20)), addrTopic(to)], data: '0x' + signed(amount0) + signed(amount1) + word(1n << 96n) + word(1000n) + signed(0n) + tail };
}
