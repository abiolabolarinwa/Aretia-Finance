/**
 * Launch Box, the pure parts: what counts as an Aretia-created token, how a chain is read incrementally, and how the list is filtered and sorted.
 * No network, no database. The indexer (indexer.ts) and the page both use this file, so the rules are written once.
 */
import { keccak256 } from '../core/keccak.js';
import { cleanText as clean, isUnsafeName } from '../tokens/safeText.js';

export type LaunchChain = 'solana' | 'bnb' | 'ethereum' | 'polygon';
export const LAUNCH_CHAINS: readonly LaunchChain[] = ['solana', 'bnb', 'ethereum', 'polygon'];
export type EvmLaunchChain = Exclude<LaunchChain, 'solana'>;
export const isLaunchChain = (v: unknown): v is LaunchChain => typeof v === 'string' && (LAUNCH_CHAINS as readonly string[]).includes(v);

/** The Aretia token factories (lower-case), the same as walletLaunchEvmCore.ts. A TokenCreated log counts only from its own chain's factory. */
export const EVM_FACTORIES: Readonly<Record<EvmLaunchChain, string>> = {
  bnb: '0xc3eb98c45795cffb10b61178332cc6fcbbc0385c',
  ethereum: '0x951a22270faa7d1c25efad2356c414cbddaba324',
  polygon: '0xca1aa427ba5906d00377a835dd9b36b049034f0c',
};
/** The Aretia curve contract, the same address on all three chains (walletCurveEvmCore.ts). */
export const EVM_CURVE = '0x4e85bc5bd6f08fa87ceb749372e34226556837e8';

export const SOLANA_FEE_WALLET = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
export const SOLANA_FEE_LAMPORTS = 50_000_000n;
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export const selector = (signature: string): string => '0x' + hex(keccak256(enc.encode(signature))).slice(0, 8);
/** keccak256("TokenCreated(address,address,string,string,uint8,uint256)") */
export const TOKEN_CREATED_TOPIC = '0x' + hex(keccak256(enc.encode('TokenCreated(address,address,string,string,uint8,uint256)')));

export const tokenKey = (chain: LaunchChain, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;

/** One indexed token as stored. */
export interface LaunchRecord {
  chain: LaunchChain;
  address: string;
  name: string;
  symbol: string;
  decimals: number | null;
  /** Smallest units, decimal string. */
  supply: string | null;
  creator: string | null;
  /** Milliseconds. */
  createdAt: number | null;
  tx: string | null;
  source: 'factory' | 'nonce' | 'solana-fee';
}

/**
 * Text from the chain made safe to store and show: NFC, control, zero-width, bidirectional, invisible-operator and stacking
 * combining characters out, trimmed, cut to length (tokens/safeText.ts has the full list).
 */
export function cleanText(s: string, max: number): string {
  return clean(s, max);
}

// ---------------------------------------------------------------- EVM

export interface RpcLog {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
}

const word = (data: string, i: number): string | null => (data.length >= 2 + (i + 1) * 64 ? data.slice(2 + i * 64, 2 + (i + 1) * 64) : null);

function readAbiString(data: string, offsetBytes: bigint): string | null {
  if (offsetBytes > 100_000n) return null;
  const at = Number(offsetBytes) * 2;
  const lenHex = data.slice(2 + at, 2 + at + 64);
  if (lenHex.length !== 64) return null;
  const len = BigInt('0x' + lenHex);
  if (len > 1024n) return null;
  const start = 2 + at + 64;
  const body = data.slice(start, start + Number(len) * 2);
  if (body.length !== Number(len) * 2) return null;
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(body.match(/../g) ?? [], (x) => Number.parseInt(x, 16)));
}

/** Reads an ABI-encoded `string` that is the whole return value of a call such as name() or symbol(). */
export function decodeStringReturn(data: unknown): string | null {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return null;
  const off = word(data, 0);
  return off === null ? null : readAbiString(data, BigInt('0x' + off));
}
/** Reads a single unsigned integer return value (decimals(), totalSupply()). */
export function decodeUintReturn(data: unknown): bigint | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(data)) return null;
  return BigInt(data);
}

export interface DecodedCreated extends LaunchRecord {
  blockNumber: number;
  logIndex: number;
}

/**
 * Reads one TokenCreated log. It accepts only a log emitted by the approved factory of that chain with the right event topic and exactly the
 * indexed token and creator topics; anything else, or data that does not decode, is null. Name and symbol are cleaned; createdAt is filled in
 * later from the block time.
 */
export function decodeTokenCreated(chain: EvmLaunchChain, log: RpcLog): DecodedCreated | null {
  if (typeof log.address !== 'string' || log.address.toLowerCase() !== EVM_FACTORIES[chain]) return null;
  const topics = log.topics;
  if (!Array.isArray(topics) || topics.length !== 3 || String(topics[0]).toLowerCase() !== TOKEN_CREATED_TOPIC) return null;
  const t1 = String(topics[1]).toLowerCase();
  const t2 = String(topics[2]).toLowerCase();
  if (!/^0x0{24}[0-9a-f]{40}$/.test(t1) || !/^0x0{24}[0-9a-f]{40}$/.test(t2)) return null;
  const token = '0x' + t1.slice(-40);
  const creator = '0x' + t2.slice(-40);
  const data = typeof log.data === 'string' ? log.data : '';
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) return null;
  const w = (i: number): bigint | null => {
    const x = word(data, i);
    return x === null ? null : BigInt('0x' + x);
  };
  const offName = w(0);
  const offSymbol = w(1);
  const decimals = w(2);
  const supply = w(3);
  if (offName === null || offSymbol === null || decimals === null || supply === null || decimals > 255n) return null;
  const name = readAbiString(data, offName);
  const symbol = readAbiString(data, offSymbol);
  if (name === null || symbol === null) return null;
  const block = typeof log.blockNumber === 'string' ? Number.parseInt(log.blockNumber, 16) : NaN;
  const logIndex = typeof log.logIndex === 'string' ? Number.parseInt(log.logIndex, 16) : 0;
  const tx = typeof log.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash) ? log.transactionHash.toLowerCase() : null;
  if (!Number.isSafeInteger(block) || block < 0) return null;
  return { chain, address: token, name: cleanText(name, 64), symbol: cleanText(symbol, 32), decimals: Number(decimals), supply: supply.toString(), creator, createdAt: null, tx, source: 'factory', blockNumber: block, logIndex: Number.isFinite(logIndex) ? logIndex : 0 };
}

/** The block range to read next. `cursor` is the last block fully handled (null on the first run). Null when there is nothing new that is confirmed yet. */
export function evmWindow(cursor: string | null, latest: number, confirmations: number, span: number, firstLookback: number): { from: number; to: number } | null {
  const safe = latest - confirmations;
  if (!Number.isSafeInteger(safe) || safe < 0) return null;
  const last = cursor !== null && /^\d{1,12}$/.test(cursor) ? Number(cursor) : null;
  // A cursor ahead of the chain (a wrong node) is not trusted: read again from a bounded look-back instead of standing still.
  const from = last === null || last > safe ? Math.max(0, safe - firstLookback) : last + 1;
  if (from > safe) return null;
  return { from, to: Math.min(from + span - 1, safe) };
}

/** The address a CREATE from `deployer` at contract nonce `n` makes (the factory makes each token with `new`). Lower-case. */
export function createAddress(deployer: string, n: bigint): string {
  const a = deployer.slice(2).toLowerCase();
  let nonce: string;
  if (n === 0n) nonce = '80';
  else if (n <= 0x7fn) nonce = n.toString(16).padStart(2, '0');
  else {
    const h = n.toString(16);
    const body = h.length % 2 === 0 ? h : '0' + h;
    nonce = (0x80 + body.length / 2).toString(16) + body;
  }
  const payloadLen = 1 + 20 + nonce.length / 2;
  const encoded = (0xc0 + payloadLen).toString(16) + '94' + a + nonce;
  return '0x' + hex(keccak256(Uint8Array.from(encoded.match(/../g) ?? [], (x) => Number.parseInt(x, 16)))).slice(24);
}

// ---------------------------------------------------------------- Solana

export interface ParsedKey {
  pubkey: string;
  signer?: boolean;
}
export interface ParsedIx {
  programId?: string;
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
}
/** A transaction as `getTransaction` returns it with encoding "jsonParsed". Only the fields read here. */
export interface ParsedTx {
  blockTime?: number | null;
  meta?: { err?: unknown } | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: (ParsedKey | string)[]; instructions?: ParsedIx[] } };
}

export interface SolanaLaunch {
  mint: string;
  creator: string;
  signature: string;
  /** Seconds, from the block. Null if the node gave none. */
  blockTime: number | null;
  decimals: number | null;
}

const lamports = (v: unknown): bigint | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v);
  return null;
};
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Decides whether a transaction is an Aretia Solana token creation. It must have succeeded and contain, as top-level instructions,
 * BOTH a System transfer of exactly 0.05 SOL to the Aretia fee wallet from a signer AND a Token-2022 InitializeMint for a mint that the
 * same transaction created (System CreateAccount owned by Token-2022). A transaction that pays the fee but makes no new mint, or makes
 * a mint but does not pay, or makes more than one mint, is refused, and so is a mint whose mint authority is not the payer or that has
 * a freeze authority. Names and symbols are never read from the transaction. The mint account itself is then checked against the
 * on-chain programs' rule by the indexer (tokens/token2022.ts `mintRuleProblems`).
 *
 * What this cannot prove: someone could build a transaction of exactly that shape without using the Launch page. It would be listed;
 * the token is real and was created in a transaction that paid Aretia the fee, but it did not come from Aretia's own page.
 */
export function acceptSolanaLaunch(tx: ParsedTx | null | undefined, signature: string, feeWallet: string = SOLANA_FEE_WALLET): SolanaLaunch | null {
  if (!tx || !tx.meta || (tx.meta.err !== null && tx.meta.err !== undefined)) return null;
  const message = tx.transaction?.message;
  if (!message || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions)) return null;
  const signers = new Set<string>();
  for (const k of message.accountKeys) if (typeof k === 'object' && k && k.signer === true && typeof k.pubkey === 'string') signers.add(k.pubkey);
  if (signers.size === 0) return null;

  let payer: string | null = null;
  const created = new Set<string>();
  const inits: { mint: string; decimals: number | null; mintAuthority: unknown; freezeAuthority: unknown }[] = [];
  for (const ix of message.instructions) {
    const p = typeof ix.parsed === 'object' && ix.parsed ? ix.parsed : null;
    if (!p || typeof p.type !== 'string' || !p.info) continue;
    const info = p.info;
    if (ix.programId === SYSTEM_PROGRAM) {
      if (p.type === 'transfer' && info.destination === feeWallet && typeof info.source === 'string' && signers.has(info.source) && lamports(info.lamports) === SOLANA_FEE_LAMPORTS) payer ??= info.source;
      if (p.type === 'createAccount' && info.owner === TOKEN_2022_PROGRAM && typeof info.newAccount === 'string' && BASE58.test(info.newAccount)) created.add(info.newAccount);
    } else if (ix.programId === TOKEN_2022_PROGRAM && (p.type === 'initializeMint' || p.type === 'initializeMint2') && typeof info.mint === 'string' && BASE58.test(info.mint)) {
      inits.push({ mint: info.mint, decimals: typeof info.decimals === 'number' ? info.decimals : null, mintAuthority: info.mintAuthority, freezeAuthority: info.freezeAuthority });
    }
  }
  if (payer === null) return null;
  const mints = inits.filter((i) => created.has(i.mint));
  if (mints.length !== 1 || inits.length !== 1) return null;
  const only = mints[0]!;
  // Aretia's Launch page makes the creator (the fee payer) the mint authority, to be given up once the supply is minted, and sets no
  // freeze authority. Anything else is not an Aretia launch.
  if (only.mintAuthority !== payer || (only.freezeAuthority !== undefined && only.freezeAuthority !== null)) return null;
  return { mint: only.mint, creator: payer, signature, blockTime: typeof tx.blockTime === 'number' ? tx.blockTime : null, decimals: only.decimals };
}

/** Where the Solana reader is. Signatures are listed newest first, so two edges are kept: the newest one handled and how far back it has reached. */
export interface SolanaState {
  /** The newest signature fully handled; the next forward read stops at it. */
  head: string | null;
  /** The oldest signature reached by the backwards read. */
  tail: string | null;
  /** True once the backwards read has reached the start of the wallet's history. */
  done: boolean;
  /** A forward read that took more than one page: where it continues from, and the newest signature it saw. */
  fwd: { newest: string; before: string } | null;
}
export const EMPTY_SOLANA_STATE: SolanaState = { head: null, tail: null, done: false, fwd: null };

export function parseSolanaState(cursor: string | null): SolanaState {
  if (!cursor) return { ...EMPTY_SOLANA_STATE };
  try {
    const v = JSON.parse(cursor) as Partial<SolanaState>;
    const sig = (x: unknown): string | null => (typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(x) ? x : null);
    const newest = sig(v.fwd?.newest);
    const before = sig(v.fwd?.before);
    return { head: sig(v.head), tail: sig(v.tail), done: v.done === true, fwd: newest && before ? { newest, before } : null };
  } catch {
    return { ...EMPTY_SOLANA_STATE };
  }
}
export const serializeSolanaState = (s: SolanaState): string => JSON.stringify(s);

export interface SigPage {
  signature: string;
}
/** The next forward read (new activity since `head`), or null when there is no head yet (the backwards read starts at the newest). */
export function planForward(s: SolanaState): { before?: string; until: string } | null {
  if (s.head === null) return null;
  return { ...(s.fwd ? { before: s.fwd.before } : {}), until: s.head };
}
export function applyForward(s: SolanaState, page: readonly SigPage[], limit: number): SolanaState {
  const newest = s.fwd?.newest ?? page[0]?.signature ?? null;
  if (page.length >= limit && newest !== null) return { ...s, fwd: { newest, before: page[page.length - 1]!.signature } };
  return { ...s, head: newest ?? s.head, fwd: null };
}
/** The next backwards read (older history), or null when the start of the history has been reached. */
export function planBackfill(s: SolanaState): { before?: string } | null {
  if (s.done) return null;
  return s.tail ? { before: s.tail } : {};
}
export function applyBackfill(s: SolanaState, page: readonly SigPage[], limit: number): SolanaState {
  const head = s.head ?? page[0]?.signature ?? null;
  const tail = page.length > 0 ? page[page.length - 1]!.signature : s.tail;
  return { ...s, head, tail, done: page.length < limit };
}

// ---------------------------------------------------------------- market merge, filter, sort

export interface CurveView {
  status: 'trading' | 'soldOut' | 'migrated' | 'aborted';
  /** Share of the curve's tokens already sold, 0 to 100. */
  progressPct: number;
}
export interface PoolView {
  dex: string;
  address: string;
  url: string;
  /** The token the pool prices against, as the market source names it. */
  quoteSymbol?: string | null;
  /** False when that is not a main stablecoin or the wrapped native coin: the price is then in a token of unknown worth. */
  quoteMajor?: boolean;
}
export interface LaunchView {
  chain: LaunchChain;
  address: string;
  name: string;
  symbol: string;
  decimals: number | null;
  supply: string | null;
  creator: string | null;
  createdAt: number | null;
  tx: string | null;
  priceUsd: number | null;
  change24h: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  capUsd: number | null;
  capKind: 'mcap' | 'fdv' | null;
  pool: PoolView | null;
  curve: CurveView | null;
  /** "ok": DexScreener has a pool for it. "none": it answered and has none. "unavailable": it could not be asked. */
  market: 'ok' | 'none' | 'unavailable';
  /** Whether the curve could be read from the chain (false: unknown, not "no curve"). */
  curveRead: boolean;
}

export type Tab = 'new' | 'trending' | 'curve' | 'pool';
export interface Filter {
  tab: Tab;
  chain: LaunchChain | '';
  query: string;
}
export type SortKey = 'age' | 'price' | 'change' | 'volume' | 'liquidity' | 'cap';
export interface Sort {
  key: SortKey | null;
  dir: 'asc' | 'desc';
}

export function filterLaunches(rows: readonly LaunchView[], f: Filter): LaunchView[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) => {
    // A name that is abusive or dressed up with look-alike letters is kept off the list, as on every other Aretia list.
    if (isUnsafeName(r.symbol, r.name)) return false;
    if (f.chain && r.chain !== f.chain) return false;
    if (f.tab === 'curve' && !(r.curve && (r.curve.status === 'trading' || r.curve.status === 'soldOut'))) return false;
    if (f.tab === 'pool' && !r.pool) return false;
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || r.symbol.toLowerCase().includes(q) || r.address.toLowerCase().includes(q) || (r.creator ?? '').toLowerCase() === q;
  });
}

const sortValue = (r: LaunchView, key: SortKey): number | null => {
  switch (key) {
    case 'age': return r.createdAt;
    case 'price': return r.priceUsd;
    case 'change': return r.change24h;
    case 'volume': return r.volume24hUsd;
    // On a curve the column shows progress; a pool's liquidity otherwise.
    case 'liquidity': return r.liquidityUsd ?? (r.curve ? r.curve.progressPct : null);
    case 'cap': return r.capUsd;
  }
};

/** Sorts a copy. Missing values always go last, either way round. Stable. For age, "desc" means newest first. */
export function sortLaunches(rows: readonly LaunchView[], key: SortKey, dir: 'asc' | 'desc'): LaunchView[] {
  return rows
    .map((r, i) => ({ r, i, v: sortValue(r, key) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return (dir === 'asc' ? a.v - b.v : b.v - a.v) || a.i - b.i;
    })
    .map((x) => x.r);
}

/** The order a tab shows by default: Trending by 24 hour volume, the others newest first. */
export function defaultSort(tab: Tab): Sort {
  return tab === 'trending' ? { key: 'volume', dir: 'desc' } : { key: 'age', dir: 'desc' };
}

/** Rows for a tab with the person's sort applied (or the tab's own order when they have not chosen one). */
export function viewLaunches(rows: readonly LaunchView[], f: Filter, sort: Sort | null): LaunchView[] {
  const picked = filterLaunches(rows, f);
  const s = sort && sort.key ? sort : defaultSort(f.tab);
  return sortLaunches(picked, s.key!, s.dir);
}

/** The token page for a row. */
export const tokenPageUrl = (chain: LaunchChain, address: string, origin = 'https://aretiafinance.org'): string => `${origin}/token#/${chain}/${chain === 'solana' ? address : address.toLowerCase()}`;
