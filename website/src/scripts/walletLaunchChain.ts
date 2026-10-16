/**
 * Aretia Launch on the web wallet: reading a token back from the chain, comparing it with what the creator approved, and
 * remembering a half-finished creation so it can be finished.
 *
 * Reading is separate from the network (`parseMintAccount` is pure) so it can be tested against real account bytes.
 * Everything read from the chain is treated as untrusted text and shown with `textContent`, never as markup.
 */
import { TOKEN_2022_PROGRAM_ID, parseTokenAccount, ataAddress } from './walletTools';
import { distributionOf, configFromJson, configToJson, type LaunchConfig, type LaunchConfigJson } from './walletLaunchCore';
import type * as Web3 from '@solana/web3.js';

// ---------------------------------------------------------------- reading a mint

const TLV_METADATA_POINTER = 18;
const TLV_TOKEN_METADATA = 19;
const ACCOUNT_TYPE_MINT = 1;

export interface MintFacts {
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** The extension types present, in the order written. */
  extensions: number[];
  metadataPointer: { authority: string | null; address: string } | null;
  metadata: { updateAuthority: string | null; mint: string; name: string; symbol: string; uri: string; additionalFields: number } | null;
}

function base58(bytes: Uint8Array, web3: typeof Web3): string {
  return new web3.PublicKey(bytes).toBase58();
}
const allZero = (b: Uint8Array) => b.every((x) => x === 0);

/**
 * Reads a Token-2022 mint account. Returns null unless the data is a well-formed, initialised Token-2022 mint: a stricter
 * reader than the program's own, because a token this page will not describe exactly is a token it will not call verified.
 */
export function parseMintAccount(web3: typeof Web3, owner: string, data: Uint8Array): MintFacts | null {
  if (owner !== TOKEN_2022_PROGRAM_ID || data.length < 82 || data[45] !== 1) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const option = (at: number): string | null | undefined => {
    const tag = v.getUint32(at, true);
    if (tag === 0) return null;
    if (tag === 1) return base58(data.subarray(at + 4, at + 36), web3);
    return undefined;
  };
  const mintAuthority = option(0);
  const freezeAuthority = option(46);
  if (mintAuthority === undefined || freezeAuthority === undefined) return null;
  const facts: MintFacts = { decimals: data[44]!, supply: v.getBigUint64(36, true), mintAuthority, freezeAuthority, extensions: [], metadataPointer: null, metadata: null };
  if (data.length === 82) return facts;
  if (data.length <= 165 || data[165] !== ACCOUNT_TYPE_MINT) return null;

  let at = 166;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const str = (from: number, end: number): { value: string; next: number } | null => {
    if (from + 4 > end) return null;
    const len = v.getUint32(from, true);
    if (from + 4 + len > end) return null;
    try {
      return { value: decoder.decode(data.subarray(from + 4, from + 4 + len)), next: from + 4 + len };
    } catch {
      return null;
    }
  };
  while (at + 4 <= data.length) {
    const type = v.getUint16(at, true);
    const len = v.getUint16(at + 2, true);
    const start = at + 4;
    const end = start + len;
    if (type === 0 && len === 0) break; // padding
    if (end > data.length) return null;
    facts.extensions.push(type);
    if (type === TLV_METADATA_POINTER) {
      if (len !== 64) return null;
      const authority = data.subarray(start, start + 32);
      facts.metadataPointer = { authority: allZero(authority) ? null : base58(authority, web3), address: base58(data.subarray(start + 32, start + 64), web3) };
    } else if (type === TLV_TOKEN_METADATA) {
      if (len < 32 + 32 + 12 + 4) return null;
      const updateAuthority = data.subarray(start, start + 32);
      const name = str(start + 64, end);
      const symbol = name && str(name.next, end);
      const uri = symbol && str(symbol.next, end);
      if (!name || !symbol || !uri || uri.next + 4 > end) return null;
      facts.metadata = {
        updateAuthority: allZero(updateAuthority) ? null : base58(updateAuthority, web3),
        mint: base58(data.subarray(start + 32, start + 64), web3),
        name: name.value,
        symbol: symbol.value,
        uri: uri.value,
        additionalFields: v.getUint32(uri.next, true),
      };
    }
    at = end;
  }
  return facts;
}

// ---------------------------------------------------------------- comparing with what was approved

export type Phase = 'created' | 'complete';

/**
 * Differences between the chain and what the creator approved. Empty means they match.
 *  - `created`: after the first transaction: no supply yet, and the creator still holds the mint authority.
 *  - `complete`: after the second: the whole supply exists and nobody can mint more.
 */
export function compareMint(facts: MintFacts, config: LaunchConfig, mint: string, phase: Phase): string[] {
  const out: string[] = [];
  if (facts.decimals !== config.decimals) out.push(`Decimals: approved ${config.decimals}, on chain ${facts.decimals}.`);
  if (phase === 'created') {
    if (facts.supply !== 0n) out.push(`Supply: expected none yet, on chain ${facts.supply}.`);
    if (facts.mintAuthority !== config.creator) out.push('The mint authority is not the creator.');
  } else {
    if (facts.supply !== config.totalSupplyRaw) out.push(`Supply: approved ${config.totalSupplyRaw}, on chain ${facts.supply}.`);
    if (facts.mintAuthority !== null) out.push('Someone can still create more of this token: the mint authority was not given up.');
  }
  if (facts.freezeAuthority !== null) out.push('Someone can freeze holders of this token: a freeze authority is set.');
  if (!facts.metadataPointer || facts.metadataPointer.address !== mint || facts.metadataPointer.authority !== null)
    out.push('The metadata link is not the expected self-link with no authority.');
  const m = facts.metadata;
  if (!m) out.push('No name, symbol and link are stored on the token.');
  else {
    if (m.mint !== mint) out.push('The stored metadata belongs to another token.');
    if (m.name !== config.name) out.push(`Name: approved "${config.name}", on chain "${m.name}".`);
    if (m.symbol !== config.symbol) out.push(`Symbol: approved "${config.symbol}", on chain "${m.symbol}".`);
    if (m.uri !== config.metadataUri) out.push(`Link: approved "${config.metadataUri}", on chain "${m.uri}".`);
    const expectedUpdate = config.metadataMutable ? config.creator : null;
    if (m.updateAuthority !== expectedUpdate) out.push(config.metadataMutable ? 'The name, symbol and link are not changeable by the creator as approved.' : 'Someone can change the name, symbol and link.');
    if (m.additionalFields !== 0) out.push('Extra metadata fields are stored that were not approved.');
  }
  // Only the two extensions this page writes. Anything else (a transfer fee, a hook, a permanent delegate) would change what holders get.
  const extra = facts.extensions.filter((t) => t !== TLV_METADATA_POINTER && t !== TLV_TOKEN_METADATA);
  if (extra.length > 0) out.push(`The token has extensions that were not approved (type ${extra.join(', ')}).`);
  return out;
}

/** Differences between what each wallet holds and what was approved. */
export function compareBalances(web3: typeof Web3, config: LaunchConfig, mint: string, held: ReadonlyMap<string, bigint | null>): string[] {
  const out: string[] = [];
  for (const line of distributionOf(config)) {
    const ata = ataAddress(web3, line.owner, mint, TOKEN_2022_PROGRAM_ID);
    const amount = held.get(ata);
    if (amount === undefined || amount === null) out.push(`${line.owner} has no token account yet.`);
    else if (amount !== line.amount) out.push(`${line.owner}: approved ${line.amount}, holds ${amount}.`);
  }
  return out;
}

export function accountAmount(data: Uint8Array | null): bigint | null {
  if (!data) return null;
  return parseTokenAccount(data)?.amount ?? null;
}

// ---------------------------------------------------------------- a creation in progress

export type Stage = 'started' | 'created' | 'minted';

export interface PendingCreation {
  /** The new token's address. Its key was discarded after the first transaction, so this is all that is needed to finish. */
  mint: string;
  config: LaunchConfig;
  stage: Stage;
  step1: string | null;
  step2: string | null;
  at: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORE_NAME = 'aretia-launch-pending-v1';

type Stored = Omit<PendingCreation, 'config'> & { config: LaunchConfigJson };
const STAGES: Stage[] = ['started', 'created', 'minted'];

function readAll(storage: StorageLike): Record<string, Stored> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORE_NAME) ?? '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, Stored>) : {};
  } catch {
    return {};
  }
}

/** The unfinished creation for this wallet, if one is stored and still well-formed. */
export function loadPending(storage: StorageLike, creator: string): PendingCreation | null {
  const s = readAll(storage)[creator];
  if (!s || typeof s.mint !== 'string' || !STAGES.includes(s.stage) || typeof s.at !== 'number') return null;
  const config = configFromJson(s.config);
  if (!config || config.creator !== creator) return null;
  return { mint: s.mint, config, stage: s.stage, step1: typeof s.step1 === 'string' ? s.step1 : null, step2: typeof s.step2 === 'string' ? s.step2 : null, at: s.at };
}

export function savePending(storage: StorageLike, p: PendingCreation): void {
  const all = readAll(storage);
  all[p.config.creator] = { ...p, config: configToJson(p.config) };
  try {
    storage.setItem(STORE_NAME, JSON.stringify(all));
  } catch {
    /* storage full or blocked: the creation still works, it just cannot be resumed after a reload */
  }
}

export function clearPending(storage: StorageLike, creator: string): void {
  const all = readAll(storage);
  delete all[creator];
  try {
    storage.setItem(STORE_NAME, JSON.stringify(all));
  } catch {
    /* nothing to do */
  }
}

export type Resume =
  | { action: 'none'; reason: string }
  | { action: 'finish'; reason: string }
  | { action: 'verify'; reason: string }
  | { action: 'stop'; reason: string };

/**
 * What to do with a stored creation, given what the chain shows for its token.
 *  - `finish`: the token exists with no supply and the creator still holds the mint authority: run the second transaction.
 *  - `verify`: the whole supply exists and the authority is gone: nothing to send, just check it.
 *  - `none`: the token was never created; the stored record can be dropped.
 *  - `stop`: anything else. Nothing is sent, because a second mint could add supply to a token that already has some.
 */
export function assessPending(pending: PendingCreation, facts: MintFacts | null): Resume {
  if (!facts) return { action: 'none', reason: 'The token was not created on chain, so nothing was spent on it except the network fee.' };
  const config = pending.config;
  if (facts.supply === 0n && facts.mintAuthority === config.creator) {
    const diffs = compareMint(facts, config, pending.mint, 'created');
    return diffs.length === 0
      ? { action: 'finish', reason: 'The token exists but has no supply yet. Finishing it creates the supply and gives up the mint authority.' }
      : { action: 'stop', reason: `The token on chain differs from what you approved: ${diffs.join(' ')}` };
  }
  if (facts.supply === config.totalSupplyRaw && facts.mintAuthority === null) return { action: 'verify', reason: 'The whole supply already exists and the mint authority is gone.' };
  return { action: 'stop', reason: 'The token is in a state this page will not touch: some supply exists, or someone else holds the mint authority.' };
}

/** Reads a token's accounts in one place, for the page's own use. `fetchAccount` is supplied by walletSend. */
export interface AccountReader {
  (address: string): Promise<{ owner: string; data: Uint8Array } | null>;
}

export async function readMint(web3: typeof Web3, fetchAccount: AccountReader, mint: string): Promise<MintFacts | null> {
  const acc = await fetchAccount(mint);
  return acc ? parseMintAccount(web3, acc.owner, acc.data) : null;
}

export async function readBalances(web3: typeof Web3, fetchAccount: AccountReader, config: LaunchConfig, mint: string): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  await Promise.all(
    distributionOf(config).map(async (line) => {
      const ata = ataAddress(web3, line.owner, mint, TOKEN_2022_PROGRAM_ID);
      const acc = await fetchAccount(ata);
      out.set(ata, acc && acc.owner === TOKEN_2022_PROGRAM_ID ? accountAmount(acc.data) : null);
    }),
  );
  return out;
}
