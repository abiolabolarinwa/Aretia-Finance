/**
 * Token permissions an Ethereum-style wallet has given to the swap venues Aretia knows. An approval lets a contract move your
 * token; swapping makes one, and most are never taken back. This reads, for each network, the allowance of the main tokens
 * (the wrapped coin and the stablecoins) to each venue's router and to Permit2, all in ONE call per network (Multicall3).
 *
 * The limit is stated in every result: Shield cannot list an approval to a contract it does not know, or for a token it is not
 * asked about, because that needs a full transaction index. So this finds the common ones, and says that is all it found.
 */
import { CHAINS, type ChainId } from '../core/types.js';
import { EVM_DEXES } from '../dex/entries.js';
import { HUB_TOKENS } from '../dex/hubs.js';
import type { EvmRead } from '../chains/evmSession.js';
import { selector } from '../engine/abi.js';
import type { Finding } from './types.js';

/** The same address on every network that has it, including Robinhood Chain. */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

/** At or above this an approval is "unlimited": no one approves 2^255 by accident. */
export const UNLIMITED = 1n << 255n;

export interface Spender {
  address: string;
  label: string;
}

export interface ApprovalToken {
  address: string;
  symbol: string;
  decimals: number;
}

export interface Approval {
  chain: ChainId;
  token: ApprovalToken;
  spender: Spender;
  allowance: bigint;
  unlimited: boolean;
}

/** The venues' routers on one network, and Permit2, each once. */
export function spendersFor(chain: ChainId): Spender[] {
  const seen = new Map<string, Spender>();
  for (const d of EVM_DEXES) if (d.chain === chain && d.router) if (!seen.has(d.router.toLowerCase())) seen.set(d.router.toLowerCase(), { address: d.router.toLowerCase(), label: d.name });
  seen.set(PERMIT2, { address: PERMIT2, label: 'Permit2 (a shared approval contract used by Uniswap and others)' });
  return [...seen.values()];
}

/** The tokens asked about on a network: the router's own hop tokens (wrapped coin, stablecoins), plus any the caller adds. */
export function tokensFor(chain: ChainId, extra: readonly ApprovalToken[] = []): ApprovalToken[] {
  const seen = new Map<string, ApprovalToken>();
  for (const h of HUB_TOKENS[chain] ?? []) seen.set(h.address.toLowerCase(), { address: h.address.toLowerCase(), symbol: h.symbol, decimals: h.decimals });
  for (const t of extra) seen.set(t.address.toLowerCase(), { ...t, address: t.address.toLowerCase() });
  return [...seen.values()];
}

// ------------------------------------------------------------------ Multicall3, by hand

const word = (n: bigint): string => n.toString(16).padStart(64, '0');
const addr = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const ALLOWANCE = '0x' + selector('allowance(address,address)');
const AGGREGATE3 = '0x' + selector('aggregate3((address,bool,bytes)[])');

/** `aggregate3` for a list of calls, none of which may stop the others by failing. */
export function encodeAggregate3(calls: readonly { target: string; data: string }[]): string {
  const bodies = calls.map((c) => {
    const data = c.data.replace(/^0x/, '');
    const len = data.length / 2;
    const padded = data + '0'.repeat((64 - (data.length % 64)) % 64);
    // (address target, bool allowFailure, bytes callData): the bytes sit after the three head words.
    return addr(c.target) + word(1n) + word(0x60n) + word(BigInt(len)) + padded;
  });
  let offset = BigInt(32 * calls.length);
  const offsets = bodies.map((b) => {
    const o = offset;
    offset += BigInt(b.length / 2);
    return word(o);
  });
  return AGGREGATE3 + word(0x20n) + word(BigInt(calls.length)) + offsets.join('') + bodies.join('');
}

/** What `aggregate3` returned: for each call, whether it worked and the first 32-byte word it gave back (null if it gave none). */
export function decodeAggregate3(hex: string): { success: boolean; first: bigint | null }[] {
  const h = hex.replace(/^0x/, '');
  const at = (i: number): bigint => BigInt('0x' + (h.slice(i * 2, i * 2 + 64) || '0'));
  const start = Number(at(0));
  const n = Number(at(start));
  const base = start + 32;
  const out: { success: boolean; first: bigint | null }[] = [];
  for (let i = 0; i < n; i++) {
    const item = base + Number(at(base + i * 32));
    const success = at(item) === 1n;
    const bytesAt = item + Number(at(item + 32));
    const len = Number(at(bytesAt));
    out.push({ success, first: success && len >= 32 ? at(bytesAt + 32) : null });
  }
  return out;
}

/** Every non-zero allowance of these tokens to these spenders, for one owner on one network, in one call. */
export async function readApprovals(chain: ChainId, owner: string, read: EvmRead, tokens: readonly ApprovalToken[] = tokensFor(chain), spenders: readonly Spender[] = spendersFor(chain)): Promise<Approval[]> {
  const pairs = tokens.flatMap((token) => spenders.map((spender) => ({ token, spender })));
  if (pairs.length === 0) return [];
  const calls = pairs.map((p) => ({ target: p.token.address, data: ALLOWANCE + addr(owner) + addr(p.spender.address) }));
  const result = decodeAggregate3(String(await read('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, 'latest'])));
  const out: Approval[] = [];
  result.forEach((r, i) => {
    if (!r.success || r.first === null || r.first === 0n) return;
    out.push({ chain, token: pairs[i]!.token, spender: pairs[i]!.spender, allowance: r.first, unlimited: r.first >= UNLIMITED });
  });
  return out;
}

export interface ApprovalFinding extends Finding {
  approval: Approval;
}

const amountText = (a: Approval): string => (a.unlimited ? 'unlimited' : (Number(a.allowance) / 10 ** a.token.decimals).toLocaleString('en-US', { maximumFractionDigits: 4 }));

/** Plain findings for each permission found. Unlimited ones are cautions; small ones are notes. */
export function describeApprovals(approvals: readonly Approval[]): ApprovalFinding[] {
  return approvals.map((a) => ({
    id: `approval-${a.chain}-${a.token.address}-${a.spender.address}`,
    severity: a.unlimited ? 'warn' : 'note',
    title: `${a.spender.label} can spend ${amountText(a)} ${a.token.symbol} on ${CHAINS[a.chain].name}.`,
    detail: a.unlimited ? 'You approved it to spend without a limit. That is how swaps work, but the permission stays after the swap. If you are not using this venue, take it back; if its contract is ever attacked, your balance is exposed.' : 'A permission left over from a swap. It only covers this amount.',
    approval: a,
  }));
}

/** `approve(spender, 0)`: the call that takes a permission back. */
export const revokeCall = (spender: string): string => '0x' + selector('approve(address,uint256)') + addr(spender) + word(0n);
