/**
 * Aretia Shield's checks. One entry point, `runCheck`, takes whatever was pasted and returns a Verdict. Every outside read
 * (the chains, DexScreener, the domain registry) comes in through `ShieldDeps`, so the checks are the same in the page and in
 * tests, and a read that fails becomes a line saying what Shield could not see, never a pass.
 *
 * What each check can honestly see:
 *  - a Solana address: whether the account exists and what owns it (a person's wallet, a program, a token, a token account),
 *    how long it has been active and how busy it is;
 *  - an EVM address: on each of the eight networks, whether it is a contract or a wallet and how many transactions it has sent;
 *  - a token: Aretia's own rating (the same engine as the Markets list), the market, and whether the liquidity is locked;
 *  - a link: the common impersonation tricks, and how old the domain is.
 * It cannot see who owns an address, and it has no scam-address database. Both are said in every result.
 */
import { CHAINS, EVM_NATIVE_ADDRESS, type ChainId, type TimeLock, type TokenLock, type TokenRisk } from '../core/types.js';
import { isFeeAsset } from '../core/feeAssets.js';
import { EVM_DEXES } from '../dex/entries.js';
import { bandOf } from '../market/rowRisk.js';
import type { PoolInfo } from '../charts/pool.js';
import { RISK_LABELS } from '../tokens/risk.js';
import { describeSafety } from '../tokens/safety.js';
import { readErc20, type EvmRead } from '../chains/evmSession.js';
import { classifyInput } from './classify.js';
import { checkSiteLink, registrationDate, siteParts } from './domain.js';
import { findLookalikes, isKnown } from './lookalike.js';
import { addressUrl, tokenUrl } from './links.js';
import { buildVerdict, failedVerdict } from './verdict.js';
import type { Band, Fact, Finding, KnownAddress, Subject, Verdict } from './types.js';

export interface ShieldDeps {
  now(): number;
  /** Solana JSON-RPC. */
  sol<T>(method: string, params: unknown[]): Promise<T>;
  /**
   * A second Solana node asked only for a wallet's transaction history. The main node may keep none and answer with an empty
   * list, which looks exactly like a wallet that has never been used, so an empty answer is checked here before it is believed.
   */
  solHistory?<T>(method: string, params: unknown[]): Promise<T>;
  /** A public-node reader for one EVM network. */
  evm(chain: ChainId): EvmRead;
  fetchJson(url: string): Promise<unknown>;
  /** The addresses the person knows (saved and sent-to), and their own connected wallet. */
  known: readonly KnownAddress[];
  own: string | null;
  /** Aretia's on-chain check of a token (the same one the Markets list uses). */
  assessToken(chain: ChainId, address: string, market: { liquidityUsd: number | null; volume24hUsd: number | null; ageMs: number | null; hasPool: boolean } | null): Promise<TokenRisk | null>;
  findPool(chain: ChainId, address: string): Promise<PoolInfo | null>;
  pairAgeMs(chain: ChainId, pool: string): Promise<number | null>;
  lock(chain: ChainId, pool: string): Promise<TokenLock | TimeLock | null>;
  resolveName(name: string): Promise<string>;
}

// ------------------------------------------------------------------ small helpers

const DAY = 86_400_000;

export function humanAge(ms: number): string {
  const days = Math.floor(ms / DAY);
  if (days < 1) return 'less than a day';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 730) return `${Math.floor(days / 30)} months`;
  return `${Math.floor(days / 365)} years`;
}

const usd = (n: number | null): string => (n === null ? 'unknown' : n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K` : `$${n.toFixed(2)}`);
const short = (v: string): string => (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);

/** What every result admits it cannot see. */
const ALWAYS_CANNOT = ['Who owns it: an address does not say, and Shield has no scam-address database.'];

/** The checks every address gets, whatever it is: is it yours, a known one, or an imitation of one. */
function knownAddressFindings(address: string, deps: ShieldDeps): Finding[] {
  const out: Finding[] = [];
  if (deps.own && deps.own.toLowerCase() === address.toLowerCase() && (deps.own === address || address.startsWith('0x'))) out.push({ id: 'own', severity: 'info', title: 'This is the wallet you have connected.', detail: 'You would be sending to yourself.' });
  const hit = isKnown(address, deps.known);
  if (hit) {
    out.push(hit.trusted ? { id: 'trusted', severity: 'ok', title: `Saved as "${hit.label ?? 'trusted'}".`, detail: 'You saved this address on purpose.' } : { id: 'sent-before', severity: 'ok', title: 'You have sent to this address before.', detail: 'It is in your own history on this device.' });
  } else {
    for (const l of findLookalikes(address, deps.known).slice(0, 2)) {
      out.push({
        id: 'lookalike',
        severity: 'bad',
        title: `It imitates ${l.known.label ? `"${l.known.label}"` : 'an address you sent to before'}.`,
        detail: `It starts with the same ${l.prefix} and ends with the same ${l.suffix} characters as ${short(l.known.address)}, but it is a different address. That is how address poisoning works: the copy is made to look right at a glance. Compare every character, or copy the address from your saved list.`,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ Solana

const KNOWN_PROGRAMS: Readonly<Record<string, string>> = {
  '11111111111111111111111111111111': 'the Solana System Program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'the SPL Token program',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'the Token-2022 program',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'the Associated Token Account program',
  ComputeBudget111111111111111111111111111111: 'the Compute Budget program',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'the Memo program',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'the Metaplex Token Metadata program',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter\'s swap program',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium\'s AMM program',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium\'s constant-product program',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca\'s Whirlpool program',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'the pump.fun program',
  Stake11111111111111111111111111111111111111: 'the Solana Stake program',
};

/** An address nobody holds the key to: whatever is sent there is gone for good. */
const BURN_ADDRESSES: Readonly<Record<string, string>> = { '1nc1nerator11111111111111111111111111111111': 'the Solana incinerator' };

const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

interface SolAccountInfo {
  value: { lamports: number; owner: string; executable: boolean; data: unknown } | null;
}
interface ParsedData {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}
interface SolSignature {
  signature: string;
  blockTime: number | null;
  err: unknown;
}

export async function checkSolana(address: string, deps: ShieldDeps, label: string | null = null): Promise<Verdict> {
  const subject: Subject = { kind: 'solana-wallet', chain: 'solana', value: address, label, icon: null };
  const findings: Finding[] = [];
  const couldNot = [...ALWAYS_CANNOT];
  const facts: Fact[] = [];
  const links = [{ label: 'Open on Solscan', url: addressUrl('solana', address) }];
  const now = deps.now();

  const burn = BURN_ADDRESSES[address];
  if (burn) {
    findings.push({ id: 'burn', severity: 'bad', title: `This is ${burn}: anything sent here is destroyed.`, detail: 'Nobody holds a key to it, so tokens or SOL sent here can never be recovered.' });
    return buildVerdict({ subject: { ...subject, label: burn }, findings, couldNot, links, now });
  }

  let account: SolAccountInfo['value'];
  try {
    account = (await deps.sol<SolAccountInfo>('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
  } catch {
    return failedVerdict(subject, 'The Solana network could not be reached.', now);
  }

  findings.push(...knownAddressFindings(address, deps));

  if (!account) {
    findings.push({ id: 'unused', severity: 'warn', title: 'This address has never been used.', detail: 'Nothing has ever been sent to it or from it. If you typed or pasted it, check it carefully: a mistyped address looks exactly like this. If you are paying a person for the first time, send a small amount first.' });
    return buildVerdict({ subject, findings, couldNot, facts, links, now });
  }

  facts.push({ label: 'SOL balance', value: `${(account.lamports / 1e9).toFixed(account.lamports >= 1e7 ? 3 : 6)} SOL` });
  const data = account.data as ParsedData | [string, string];
  const parsed = !Array.isArray(data) ? data : null;

  // A token: hand over to the token check, keeping what is known about the address itself.
  if (TOKEN_PROGRAMS.has(account.owner) && parsed?.parsed?.type === 'mint') {
    return checkToken('solana', address, deps);
  }
  if (TOKEN_PROGRAMS.has(account.owner) && parsed?.parsed?.type === 'account') {
    const info = parsed.parsed.info ?? {};
    const owner = typeof info.owner === 'string' ? info.owner : null;
    const mint = typeof info.mint === 'string' ? info.mint : null;
    findings.push({ id: 'token-account', severity: 'warn', title: 'This is a token account, not a wallet.', detail: `It holds one kind of token for a wallet${owner ? ` (${short(owner)})` : ''}. Sending SOL here may be lost, and tokens sent to the wrong kind of account can be stuck. To pay a person, use the address of their wallet.` });
    if (owner) facts.push({ label: 'Belongs to wallet', value: owner });
    if (mint) facts.push({ label: 'Holds token', value: mint });
    return buildVerdict({ subject: { ...subject, kind: 'solana-token-account' }, findings, couldNot, facts, links, now });
  }
  if (account.executable) {
    const name = KNOWN_PROGRAMS[address];
    findings.push({ id: 'program', severity: name ? 'info' : 'warn', title: name ? `This is ${name}.` : 'This is a program, not a person\'s wallet.', detail: name ? 'It is code that runs on Solana. You do not send money to it directly.' : 'It is code, not a person. Sending to it does not reach anyone, and an unknown program deserves a careful look before you interact with it.' });
    return buildVerdict({ subject: { ...subject, kind: 'solana-program', label: name ?? label }, findings, couldNot, facts, links, now });
  }
  if (account.owner !== SYSTEM_PROGRAM) {
    const name = KNOWN_PROGRAMS[account.owner];
    findings.push({ id: 'data-account', severity: 'warn', title: 'This account belongs to a program, not to a person.', detail: `It is owned by ${name ?? short(account.owner)}. It is not an ordinary wallet, so money sent to it may not reach a person.` });
    return buildVerdict({ subject, findings, couldNot, facts, links, now });
  }

  // An ordinary wallet: how long, and how busy.
  try {
    let sigs = await deps.sol<SolSignature[]>('getSignaturesForAddress', [address, { limit: 1000 }]);
    if (sigs.length === 0 && deps.solHistory) sigs = await deps.solHistory<SolSignature[]>('getSignaturesForAddress', [address, { limit: 1000 }]).catch(() => []);
    const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === 'number');
    if (sigs.length === 0) {
      findings.push({ id: 'no-history', severity: 'note', title: 'No transaction history was visible for it.', detail: 'It holds funds, so it has been used. Either it is very new, or the network nodes Shield asked do not keep history for it. Do not read this as a sign it is old or busy.' });
      couldNot.push('How old the wallet is and how busy: no history could be read.');
    } else {
      const full = sigs.length >= 1000;
      const oldest = Math.min(...times) * 1000;
      const age = times.length ? now - oldest : null;
      const newest = Math.max(...times) * 1000;
      facts.push({ label: 'Transactions seen', value: full ? '1,000 or more' : String(sigs.length) });
      if (age !== null) {
        facts.push({ label: full ? 'Active for at least' : 'First activity', value: full ? humanAge(age) : `${humanAge(age)} ago` });
        if (!full && age < DAY) findings.push({ id: 'age', severity: 'warn', title: 'Its first transaction was in the last day.', detail: 'Brand-new wallets are how scammers collect money: they are cheap to make and easy to abandon. Be sure you know who owns it.' });
        else if (!full && age < 7 * DAY) findings.push({ id: 'age', severity: 'note', title: `It is only ${humanAge(age)} old.`, detail: 'A young wallet has little track record. That is normal for a new user and common for a scam wallet.' });
        else if (age >= 365 * DAY) findings.push({ id: 'age', severity: 'ok', title: `It has been active for ${full ? 'at least ' : ''}${humanAge(age)}.`, detail: 'A long history is a point in its favour: throwaway wallets rarely last. It says nothing about who owns it today.' });
      }
      if (!full && sigs.length < 3) findings.push({ id: 'few-tx', severity: 'note', title: `It has only ${sigs.length} transaction${sigs.length === 1 ? '' : 's'}.`, detail: 'Very little history.' });
      else if (full) findings.push({ id: 'busy', severity: 'ok', title: 'It is very active: 1,000 or more transactions.', detail: 'A busy wallet is more likely a real user or service than a throwaway.' });
      if (now - newest > 365 * DAY) findings.push({ id: 'dormant', severity: 'note', title: 'It has been quiet for over a year.', detail: 'A long-dormant wallet that suddenly asks for money deserves a question: has its owner lost access?' });
    }
  } catch {
    couldNot.push('How old the wallet is and how busy: the transaction history could not be read just now.');
  }
  return buildVerdict({ subject, findings, couldNot, facts, links, now });
}

// ------------------------------------------------------------------ EVM

const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

interface EvmReading {
  chain: ChainId;
  code: string;
  nonce: number;
  balance: bigint;
}

const evmChains = (): ChainId[] => (Object.values(CHAINS).filter((c) => c.kind === 'evm').map((c) => c.id) as ChainId[]);

export async function checkEvm(address: string, deps: ShieldDeps, badChecksum = false): Promise<Verdict> {
  const value = address.toLowerCase();
  const subject: Subject = { kind: 'evm-wallet', chain: null, value, label: null, icon: null };
  const now = deps.now();
  const couldNot = [...ALWAYS_CANNOT];
  if (badChecksum) {
    return buildVerdict({
      subject,
      findings: [{ id: 'checksum', severity: 'bad', title: 'The capital letters in this address are wrong.', detail: 'Ethereum-style addresses carry a built-in spell check in their capital letters, and this one fails it. It was mistyped or changed after it was copied. Do not use it: copy the address again from the source.' }],
      couldNot,
      now,
    });
  }
  const readings = (
    await Promise.all(
      evmChains().map(async (chain): Promise<EvmReading | null> => {
        try {
          const read = deps.evm(chain);
          const [code, nonce, balance] = await Promise.all([read('eth_getCode', [value, 'latest']), read('eth_getTransactionCount', [value, 'latest']), read('eth_getBalance', [value, 'latest'])]);
          return { chain, code: String(code), nonce: Number.parseInt(String(nonce), 16) || 0, balance: BigInt(String(balance)) };
        } catch {
          return null;
        }
      }),
    )
  ).filter((r): r is EvmReading => r !== null);
  if (readings.length === 0) return failedVerdict(subject, 'None of the networks could be reached.', now);
  if (readings.length < evmChains().length) couldNot.push(`${evmChains().length - readings.length} of ${evmChains().length} networks did not answer, so activity there is not counted.`);

  const findings: Finding[] = knownAddressFindings(value, deps);
  const links = [{ label: 'Open on Etherscan', url: addressUrl('ethereum', value) }];
  const contracts = readings.filter((r) => r.code !== '0x' && r.code.length > 2);

  if (contracts.length > 0) {
    const first = contracts[0]!;
    const token = await readErc20(deps.evm(first.chain), value);
    if (token) {
      return checkToken(first.chain, value, deps);
    }
    const dex = EVM_DEXES.find((d) => d.router === value);
    const facts: Fact[] = [{ label: 'Contract on', value: contracts.map((c) => CHAINS[c.chain].name).join(', ') }];
    if (dex) findings.push({ id: 'known-router', severity: 'ok', title: `It is the ${dex.name} router on ${CHAINS[dex.chain].name}.`, detail: 'Aretia routes swaps through this contract and has checked its address on-chain.' });
    else findings.push({ id: 'contract', severity: 'warn', title: 'This is a smart contract, not a person\'s wallet.', detail: 'Sending money to a contract only makes sense if you know exactly what that contract does. Connecting a wallet to an unknown contract, or approving it to spend your tokens, is how wallets get drained.' });
    try {
      const impl = String(await deps.evm(first.chain)('eth_getStorageAt', [value, EIP1967_IMPLEMENTATION, 'latest']));
      if (/[1-9a-f]/i.test(impl.slice(2))) findings.push({ id: 'proxy', severity: 'note', title: 'It is upgradable: its code can be swapped for different code.', detail: 'A proxy contract points at code its owner can change. Whoever holds the upgrade key can change what it does after you have trusted it.' });
    } catch {
      couldNot.push('Whether the contract can be upgraded: the read failed.');
    }
    couldNot.push('What the contract does: Shield does not read its source code.');
    return buildVerdict({ subject: { ...subject, kind: 'evm-contract', label: dex?.name ?? null }, findings, couldNot, facts, links, now });
  }

  // A wallet: how much has it done, on how many networks?
  const active = readings.filter((r) => r.nonce > 0);
  const funded = readings.filter((r) => r.balance > 0n && r.nonce === 0);
  const facts: Fact[] = [];
  if (active.length > 0) {
    const total = active.reduce((n, r) => n + r.nonce, 0);
    facts.push({ label: 'Transactions sent', value: `${total.toLocaleString('en-US')} on ${active.map((r) => CHAINS[r.chain].name).join(', ')}` });
    if (total >= 100) findings.push({ id: 'busy', severity: 'ok', title: `It has sent ${total.toLocaleString('en-US')} transactions.`, detail: 'A busy wallet is more likely a real user than a throwaway.' });
    else if (total < 3) findings.push({ id: 'few-tx', severity: 'note', title: `It has only sent ${total} transaction${total === 1 ? '' : 's'}.`, detail: 'Very little history.' });
    else findings.push({ id: 'some-tx', severity: 'ok', title: `It has sent ${total} transactions.`, detail: 'It has been used, though not heavily.' });
  } else if (funded.length > 0) {
    findings.push({ id: 'receive-only', severity: 'note', title: 'It has received money but never sent any.', detail: 'It has never signed a transaction on the networks Shield looked at.' });
    facts.push({ label: 'Holds funds on', value: funded.map((r) => CHAINS[r.chain].name).join(', ') });
  } else {
    findings.push({ id: 'unused', severity: 'warn', title: 'This address has never been used on any of these networks.', detail: `Shield looked at ${readings.length} networks and found no transactions and no funds. If you typed or pasted it, check it carefully: a mistyped address looks exactly like this.` });
  }
  couldNot.push('How old the wallet is: that needs a full transaction index, which Shield does not use.');
  return buildVerdict({ subject, findings, couldNot, facts, links, now });
}

// ------------------------------------------------------------------ tokens

export async function checkToken(chain: ChainId, address: string, deps: ShieldDeps): Promise<Verdict> {
  const value = chain === 'solana' ? address : address.toLowerCase();
  const kind = chain === 'solana' ? 'solana-token' : 'evm-token';
  const now = deps.now();
  const findings: Finding[] = [];
  const couldNot = [...ALWAYS_CANNOT];
  const facts: Fact[] = [{ label: 'Network', value: CHAINS[chain].name }];

  const pool = await deps.findPool(chain, value).catch(() => null);
  const ageMs = pool ? await deps.pairAgeMs(chain, pool.pool).catch(() => null) : null;
  const market = pool ? { liquidityUsd: pool.liquidityUsd, volume24hUsd: pool.volume24hUsd, ageMs, hasPool: true } : null;
  const risk = await deps.assessToken(chain, value, market);
  let decimals: number | null = null;
  let tokenName: string | null = null;
  let tokenSymbol: string | null = null;
  try {
    if (chain === 'solana') {
      const acc = await deps.sol<SolAccountInfo>('getAccountInfo', [value, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const info = (acc.value?.data as ParsedData | undefined)?.parsed?.info;
      decimals = typeof info?.decimals === 'number' ? info.decimals : null;
    } else {
      const facts = await readErc20(deps.evm(chain), value);
      decimals = facts?.decimals ?? null;
      tokenName = facts?.name || null;
      tokenSymbol = facts?.symbol || null;
    }
  } catch {
    // The swap button simply does not appear without decimals.
  }
  const poolSymbol = pool ? (pool.targetIsBase === false ? pool.quoteSymbol : pool.baseSymbol) : undefined;
  const symbol = poolSymbol || tokenSymbol;
  const subject: Subject = { kind, chain, value, label: symbol ?? null, icon: pool?.icon ?? null, decimals, name: tokenName };

  // A major, widely used asset (a stablecoin, or a wrapped coin) is run by an issuer who can mint, pause or freeze BY DESIGN. Those powers
  // are real and are listed, but as notes: Shield does not tell people USDC is dangerous because Circle can freeze an address.
  const major = isFeeAsset(chain, value) && value !== EVM_NATIVE_ADDRESS;
  const view = describeSafety(risk);
  for (const c of view.concerns) findings.push({ id: `risk-${findings.length}`, severity: major ? 'note' : c.severe ? 'bad' : 'warn', title: c.text.includes(': ') ? c.text.slice(c.text.indexOf(': ') + 2) : c.text, detail: `From Aretia's token check${c.text.includes(': ') ? `: ${c.text.split(': ')[0]}` : ''}.${c.severe ? ' This is one of the more serious signals.' : ''}` });
  if (major) findings.push({ id: 'major', severity: 'ok', title: `${symbol ?? 'This token'} is a major asset that many wallets and venues use.`, detail: 'Stablecoins and wrapped coins are issued and run by a company or a protocol. Their admin powers (minting, pausing, freezing an address) are listed below as notes, not warnings: they are how those assets work, and they are real.' });
  if (view.passed > 0) findings.push({ id: 'passed', severity: 'ok', title: `${view.passed} check${view.passed === 1 ? '' : 's'} passed.`, detail: 'Things Shield looked at in the contract, the holders and the market, and found fine. A pass is not a guarantee.' });
  couldNot.push(...view.unchecked.map((u) => `${u}: could not be checked.`));
  if (!risk) couldNot.push('The token\'s contract and holders could not be read, so it has no rating.');

  if (!pool) {
    findings.push({ id: 'no-market', severity: 'warn', title: 'Shield found no trading pool for it.', detail: 'Without a market it may not be possible to sell, and any price you are shown is not real. Tokens that appear in a wallet with no market are usually spam.' });
  } else {
    facts.push({ label: 'Price', value: pool.priceUsd === null ? 'unknown' : `$${pool.priceUsd < 0.01 ? pool.priceUsd.toPrecision(3) : pool.priceUsd.toFixed(4)}` });
    facts.push({ label: 'Liquidity', value: usd(pool.liquidityUsd) });
    facts.push({ label: 'Volume (24 hours)', value: usd(pool.volume24hUsd) });
    if (ageMs !== null) facts.push({ label: 'Trading for', value: humanAge(ageMs) });
    try {
      const lock = await deps.lock(chain, pool.pool);
      if (lock?.kind === 'burned') findings.push({ id: 'lock', severity: 'ok', title: `${lock.pct.toFixed(0)}% of the liquidity is burned.`, detail: 'The liquidity tokens were sent to an address nobody controls, so the creator cannot pull the money out of the pool.' });
      else if (lock?.kind === 'time-locked') {
        const days = lock.until === null ? null : Math.ceil((lock.until - now) / DAY);
        findings.push({ id: 'lock', severity: days !== null && days < 14 ? 'note' : 'ok', title: `${lock.pct.toFixed(0)}% of the liquidity is locked${lock.until ? ` until ${new Date(lock.until).toISOString().slice(0, 10)}` : ''}.`, detail: days !== null && days < 14 ? 'The lock ends soon: afterwards the owner of the locked liquidity can take it out.' : `Held in ${lock.by}. A time lock ends; check the date.` });
      } else if (risk?.status !== 'established' && risk?.status !== 'verified') findings.push({ id: 'no-lock', severity: 'note', title: 'No locked or burned liquidity was found.', detail: 'Shield looks for burned liquidity and a few well-known lockers. If the creator holds the liquidity, they can remove it and leave holders with nothing. Not finding a lock is not proof there is none.' });
    } catch {
      couldNot.push('Whether the liquidity is locked: the check failed just now.');
    }
  }

  const links = [
    { label: chain === 'solana' ? 'Open on Solscan' : 'Open on the explorer', url: tokenUrl(chain, value) },
    ...(pool ? [{ label: 'See the chart', url: `https://dexscreener.com/${chain === 'bnb' ? 'bsc' : chain}/${encodeURIComponent(pool.pool)}` }] : []),
  ];
  const floor: Band | undefined = major ? undefined : risk ? bandOf(risk.status) : 'grey';
  return buildVerdict({ subject, findings, couldNot, facts, links, now, ...(floor ? { floor } : {}), ...(major ? { ratingLabel: 'Major asset' } : risk ? { ratingLabel: RISK_LABELS[risk.status] } : {}) });
}

// ------------------------------------------------------------------ links

export async function checkSite(text: string, deps: ShieldDeps): Promise<Verdict> {
  const c = classifyInput(text);
  const now = deps.now();
  if (c.kind !== 'site') return failedVerdict({ kind: 'site', chain: null, value: text, label: null, icon: null }, 'That is not a link Shield can read.', now);
  const parts = siteParts(c.url.hostname);
  const subject: Subject = { kind: 'site', chain: null, value: c.url.hostname, label: null, icon: null };
  let registeredAt: number | null = null;
  const couldNot = ['Whether the page itself is honest: Shield does not open it.', 'Scam-site blocklists: none is connected, so a page can be a known scam and still not be flagged here.'];
  try {
    registeredAt = registrationDate(await deps.fetchJson(`https://rdap.org/domain/${encodeURIComponent(parts.registrable)}`));
  } catch {
    // The registry did not answer.
  }
  if (registeredAt === null) couldNot.push('How old the domain is: its registration record could not be read.');
  const { findings, brand } = checkSiteLink(c.url, text, { registeredAt }, now);
  const facts: Fact[] = [{ label: 'Site', value: parts.registrable }, { label: 'Connection', value: c.url.protocol === 'https:' ? 'Encrypted (https)' : 'Not encrypted (http)' }];
  if (registeredAt !== null) facts.push({ label: 'Registered', value: `${new Date(registeredAt).toISOString().slice(0, 10)} (${humanAge(now - registeredAt)} ago)` });
  // Only the brand's own address is labelled with its name: a look-alike must not be shown as if it were the real thing.
  const official = findings.some((f) => f.id === 'official');
  return buildVerdict({ subject: { ...subject, label: official ? brand?.name ?? null : null }, findings, couldNot, facts, now });
}

// ------------------------------------------------------------------ the entry point

/** Checks whatever was pasted. */
export async function runCheck(text: string, deps: ShieldDeps): Promise<Verdict> {
  const c = classifyInput(text);
  const now = deps.now();
  const blank: Subject = { kind: 'unknown', chain: null, value: text.trim().slice(0, 120), label: null, icon: null };
  switch (c.kind) {
    case 'solana':
      return checkSolana(c.value, deps);
    case 'evm':
      return checkEvm(c.value, deps, c.badChecksum);
    case 'name': {
      try {
        const address = await deps.resolveName(c.value);
        const v = await checkSolana(address, deps, c.value);
        return { ...v, facts: [{ label: 'Name resolves to', value: address }, ...v.facts] };
      } catch {
        return buildVerdict({ subject: blank, findings: [{ id: 'name', severity: 'warn', title: `"${c.value}" did not resolve to an address.`, detail: 'Check the spelling, or ask the recipient for their address. A name that does not exist is a common way to send money into the void.' }], couldNot: ALWAYS_CANNOT, now });
      }
    }
    case 'site':
      return checkSite(c.value, deps);
    case 'transaction':
      return buildVerdict({ subject: blank, findings: [{ id: 'tx', severity: 'info', title: 'This looks like a transaction, not an address.', detail: 'A transaction shows what already happened. Shield checks where you are about to send, or what you are about to buy: paste an address, a token, or a link.' }], couldNot: [], now });
    default:
      return buildVerdict({ subject: blank, findings: [{ id: 'unknown', severity: 'info', title: 'Shield did not recognise that.', detail: 'Paste a Solana or Ethereum-style address, a token, or a link.' }], couldNot: [], now });
  }
}
