/**
 * Reads the tokens that watched wallets RECEIVED in a block range, from the chain's Transfer events.
 *
 * An ERC-20 token emits `Transfer(from, to, value)` with the topics [signature, from, to]; an NFT emits the same signature with a fourth topic (the
 * token id), which is ignored here. One `eth_getLogs` call can name many receivers at once (a list in the third topic), so a block range costs one call
 * per batch of wallets, not one per wallet. The range is cut into windows the node accepts, and a window the node refuses (too wide, or too many results)
 * is halved and tried again, down to a single block. Nothing is written here: the caller stores what comes back.
 */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface Log {
  address: string;
  topics: string[];
  blockNumber: string;
}

/** A JSON-RPC call that returns the result or throws. */
export type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

export interface Seen {
  firstBlock: number;
  lastBlock: number;
}

/** wallet (lower-case) -> token (lower-case) -> the first and last block it was received. */
export type ReceivedTokens = Map<string, Map<string, Seen>>;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const pad = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`;
const unpad = (topic: string): string => `0x${topic.slice(-40)}`;

export interface ScanOptions {
  /** The widest block range one call may cover (the node's own limit). */
  maxRange: number;
  /** How many wallets one call may name. */
  addressBatch: number;
  /** Called with the number of calls made so far; lets a caller stop a runaway scan by throwing. */
  onCall?: (calls: number) => void;
}

/** A refusal that a narrower range can fix (as opposed to a node that is down). */
const isTooBig = (e: unknown): boolean => /range|limit|too many|exceed|more than|10000|timeout|response size/i.test(e instanceof Error ? e.message : String(e));

export async function scanReceived(rpc: Rpc, wallets: readonly string[], fromBlock: number, toBlock: number, opts: ScanOptions): Promise<ReceivedTokens> {
  const out: ReceivedTokens = new Map();
  const list = [...new Set(wallets.map((w) => w.toLowerCase()))].filter((w) => ADDRESS.test(w));
  if (list.length === 0 || toBlock < fromBlock) return out;
  const maxRange = Math.max(1, Math.floor(opts.maxRange));
  const batchSize = Math.max(1, Math.floor(opts.addressBatch));
  let calls = 0;

  const fetchWindow = async (batch: string[], from: number, to: number): Promise<Log[]> => {
    opts.onCall?.(++calls);
    try {
      return await rpc<Log[]>('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TRANSFER_TOPIC, null, batch.map(pad)] }]);
    } catch (e) {
      if (!isTooBig(e) || from >= to) throw e;
      const mid = from + Math.floor((to - from) / 2);
      return [...(await fetchWindow(batch, from, mid)), ...(await fetchWindow(batch, mid + 1, to))];
    }
  };

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    for (let from = fromBlock; from <= toBlock; from += maxRange) {
      const to = Math.min(toBlock, from + maxRange - 1);
      for (const log of await fetchWindow(batch, from, to)) {
        if (!Array.isArray(log.topics) || log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) continue; // NFTs carry a fourth topic
        const wallet = unpad(log.topics[2]!.toLowerCase());
        const token = log.address.toLowerCase();
        if (!ADDRESS.test(wallet) || !ADDRESS.test(token) || !batch.includes(wallet)) continue;
        const block = Number.parseInt(log.blockNumber, 16);
        if (!Number.isSafeInteger(block)) continue;
        const tokens = out.get(wallet) ?? new Map<string, Seen>();
        const seen = tokens.get(token);
        tokens.set(token, seen ? { firstBlock: Math.min(seen.firstBlock, block), lastBlock: Math.max(seen.lastBlock, block) } : { firstBlock: block, lastBlock: block });
        out.set(wallet, tokens);
      }
    }
  }
  return out;
}
