/**
 * Free token profiles: a description, links (website, X, Telegram, Discord) and a logo that a token's creator publishes for its page in
 * Markets (docs/token-profiles.md). Pure: no network, no page, no keys. Used by the server (api/_tokenProfiles.ts) to decide what is
 * accepted and by the page to check a form before sending it.
 *
 * Two things a profile can never do: cost money (there is no price, payment or paid tier anywhere in this feature), and change where a
 * token ranks (no list, sort or score reads profiles; a test checks that the market code never mentions them).
 *
 * Who may publish, decided by the owner on 2026-11-25:
 *   - a wallet that still controls the token (Solana: its mint authority or metadata update authority; Ethereum-style: the contract's
 *     owner(), or the wallet that created it through Aretia Launch) publishes at once;
 *   - anyone else (most pump.fun tokens have given up every authority) can send a request, which waits in the owner's admin page until
 *     the owner approves it.
 * What is refused automatically: tokens named like a well-known token at a different address, links that are not plain https web
 * addresses, link shorteners, look-alike (punycode) hosts, hosts that use a famous wallet or exchange name without being it, hosts named
 * like airdrop or claim pages, abusive words, and pictures not stored in Aretia's own bucket. The owner can remove anything else.
 */
import { DETAIL_LIMITS, cleanHttpsUrl, isTrustedAssetUrl, validateDetails } from '../launchmeta/core.js';
import { UNSAFE_CHARS, isOffensive } from '../tokens/safeText.js';
import { impersonationWarning } from '../tokens/impersonation.js';
import { CHAINS, type ChainId } from '../core/types.js';

export const PROFILE_CHAINS = Object.keys(CHAINS) as ChainId[];
export const PROFILE_LIMITS = { descriptionMax: DETAIL_LIMITS.descriptionMax, urlMax: DETAIL_LIMITS.urlMax, logoMax: 300 } as const;

export interface ProfileFields {
  description: string;
  website: string;
  x: string;
  telegram: string;
  discord: string;
  /** The public address of a picture already in Aretia's bucket (img/<sha256>.<ext>), or ''. */
  logo: string;
}
export const EMPTY_PROFILE: ProfileFields = { description: '', website: '', x: '', telegram: '', discord: '', logo: '' };

/** A profile as the public sees it. */
export interface PublicProfile {
  chain: ChainId;
  address: string;
  description: string;
  website: string | null;
  x: string | null;
  telegram: string | null;
  discord: string | null;
  logo: string | null;
  /** 'authority': published by a wallet that controls the token. 'review': approved by Aretia by hand. */
  proof: 'authority' | 'review';
  updatedAt: number;
}

export interface ProfileIssue {
  field: keyof ProfileFields;
  message: string;
}
export type ProfileCheck = { ok: true; value: ProfileFields } | { ok: false; issues: ProfileIssue[] };

// ---------------------------------------------------------------- addresses

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The token address in its stored form (Ethereum-style lower case), or null when it is not an address of that chain. */
export function profileAddress(chain: unknown, address: unknown): { chain: ChainId; address: string } | null {
  if (typeof chain !== 'string' || !(PROFILE_CHAINS as string[]).includes(chain) || typeof address !== 'string') return null;
  const a = address.trim();
  if (chain === 'solana') return SOLANA_ADDRESS.test(a) ? { chain, address: a } : null;
  return EVM_ADDRESS.test(a) ? { chain: chain as ChainId, address: a.toLowerCase() } : null;
}

/** The sign-in family a token's controller signs with. */
export const familyOf = (chain: ChainId): 'solana' | 'evm' => (chain === 'solana' ? 'solana' : 'evm');

// ---------------------------------------------------------------- links

const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rebrand.ly', 'ow.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 's.id', 'buff.ly', 'lnkd.in', 'shorte.st', 'v.gd', 'bl.ink', 'short.io', 'linktr.ee.co'];

/** Names of wallets, exchanges and tools that scam pages borrow, with the domains that really are them. */
const BRANDS: Readonly<Record<string, readonly string[]>> = {
  metamask: ['metamask.io'],
  phantom: ['phantom.app', 'phantom.com'],
  walletconnect: ['walletconnect.com', 'walletconnect.network', 'reown.com'],
  trustwallet: ['trustwallet.com'],
  uniswap: ['uniswap.org'],
  pancakeswap: ['pancakeswap.finance'],
  raydium: ['raydium.io'],
  pumpfun: ['pump.fun'],
  dexscreener: ['dexscreener.com'],
  coinbase: ['coinbase.com'],
  binance: ['binance.com'],
  aretia: ['aretiafinance.org'],
};
/** Words in a host that drainer and fake-airdrop pages use. */
const BAIT = ['airdrop', 'claim', 'giveaway', 'connectwallet', 'validate', 'rectify', 'synchronize', 'restore', 'recovery', 'migrate', 'migration'];

const hostOf = (url: string): string => new URL(url).hostname.toLowerCase();
const within = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Why a link that is already a clean https address is still refused, or null when it is acceptable. */
export function linkProblem(url: string): string | null {
  let host: string;
  try {
    host = hostOf(url);
  } catch {
    return 'Not a web address.';
  }
  if (host.split('.').some((l) => l.startsWith('xn--'))) return 'Addresses with look-alike letters are not accepted.';
  if (SHORTENERS.some((s) => within(host, s))) return 'Use the full address, not a link shortener.';
  const flat = host.replace(/[^a-z0-9]/g, '');
  for (const [brand, real] of Object.entries(BRANDS)) {
    if (flat.includes(brand) && !real.some((d) => within(host, d))) return `This address uses the ${brand} name but is not ${brand}’s site.`;
  }
  const words = host.split(/[.-]/);
  if (BAIT.some((b) => words.includes(b) || (b.length >= 6 && flat.includes(b)))) return 'Addresses named like airdrop, claim or wallet pages are not accepted.';
  return null;
}

const DISCORD_HOSTS = ['discord.gg', 'discord.com', 'discordapp.com'] as const;

// ---------------------------------------------------------------- text

/** A description made safe: NFC, invisible and stacking characters out (line breaks kept), at most two blank lines in a row, trimmed. */
export function cleanDescription(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(UNSAFE_CHARS, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Only a picture already in Aretia's own bucket, under img/, is accepted as a logo. */
export function cleanLogo(url: string): string | null {
  const t = url.trim();
  if (t === '') return '';
  if (t.length > PROFILE_LIMITS.logoMax || !isTrustedAssetUrl(t)) return null;
  return /\/img\/[0-9a-f]{64}\.(png|jpg|gif)$/.test(new URL(t).pathname) ? t : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Checks a submitted profile field by field. Every field is optional, but a profile must say something. */
export function validateProfile(raw: unknown): ProfileCheck {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const input: ProfileFields = { description: str(r.description), website: str(r.website), x: str(r.x), telegram: str(r.telegram), discord: str(r.discord), logo: str(r.logo) };
  const issues: ProfileIssue[] = [];
  if (Object.values(input).some((v) => v.length > 4000)) return { ok: false, issues: [{ field: 'description', message: 'That is far too long.' }] };
  const description = cleanDescription(input.description);
  // The Launch rules: description length and plain text, and the three link kinds it knows.
  const base = validateDetails({ description, website: input.website, x: input.x, telegram: input.telegram });
  const out: ProfileFields = { ...EMPTY_PROFILE, description };
  if (!base.ok) for (const i of base.issues) issues.push({ field: i.field as keyof ProfileFields, message: i.message });
  else Object.assign(out, base.value);
  if (description && isOffensive(description)) issues.push({ field: 'description', message: 'The description contains words Aretia does not show.' });

  const discord = input.discord.trim();
  if (discord !== '') {
    const clean = cleanHttpsUrl(discord, DISCORD_HOSTS);
    if (!clean) issues.push({ field: 'discord', message: `An https://discord.gg/… or https://discord.com/… link. Up to ${PROFILE_LIMITS.urlMax} characters.` });
    else out.discord = clean;
  }
  for (const field of ['website', 'x', 'telegram', 'discord'] as const) {
    if (!out[field] || issues.some((i) => i.field === field)) continue;
    const problem = linkProblem(out[field]);
    if (problem) issues.push({ field, message: problem });
  }
  const logo = cleanLogo(input.logo);
  if (logo === null) issues.push({ field: 'logo', message: 'Upload the logo here; links to pictures elsewhere are not accepted.' });
  else out.logo = logo;

  if (issues.length === 0 && Object.values(out).every((v) => v === '')) issues.push({ field: 'description', message: 'Add a description, a link or a logo.' });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
}

/** Refused when the token itself is named like a well-known token at another address: a profile would make the disguise look official. */
export function impersonationProblem(chain: ChainId, address: string, symbol: string | null, name: string | null): string | null {
  return impersonationWarning(chain, address, symbol, name) ? 'This token is named like a well-known token it is not, so it cannot have a profile.' : null;
}

// ---------------------------------------------------------------- ownership

/**
 * How a submission is published. `controllers` are the addresses that control the token, read from the chain by the server (never from
 * the browser); `owner` is the signed-in wallet's owner key (`solana:<address>` or `evm:0x…` lower case).
 *   'authority': the signed-in wallet is one of them, so the profile goes live at once.
 *   'review':    it is not (or the token has none), so it waits for the owner's approval.
 *   'wrong-family': a Solana token needs a Solana sign-in, an Ethereum-style token an Ethereum-style one.
 */
export function ownershipDecision(chain: ChainId, owner: string, controllers: readonly string[]): 'authority' | 'review' | 'wrong-family' {
  const family = familyOf(chain);
  if (!owner.startsWith(`${family}:`)) return 'wrong-family';
  const me = owner.slice(family.length + 1);
  const mine = family === 'evm' ? me.toLowerCase() : me;
  return controllers.some((c) => (family === 'evm' ? c.toLowerCase() : c) === mine) ? 'authority' : 'review';
}

// ---------------------------------------------------------------- reading control from the chain

/**
 * Authorities that belong to a launchpad's program rather than to a person: pump.fun keeps its own update authority on every token it makes.
 * Nobody can sign in as them, so a token whose only controller is one of these counts as having no controller (its creator goes to review).
 */
export const LAUNCHPAD_AUTHORITIES: ReadonlySet<string> = new Set(['TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM' /* pump.fun */]);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
const keyAt = (d: Uint8Array, o: number): string | null => {
  const k = d.subarray(o, o + 32);
  return k.length === 32 && k.some((b) => b !== 0) ? base58(k) : null;
};

/** SPL mint: the mint authority, when it has one (COption tag 1 at byte 0, key at 4). */
export function solanaMintAuthority(d: Uint8Array): string | null {
  if (d.length < 82 || d[45] !== 1) return null;
  const tag = d[0]! | (d[1]! << 8) | (d[2]! << 16) | (d[3]! << 24);
  return tag === 1 ? keyAt(d, 4) : null;
}

/** Metaplex metadata account (key 4 = MetadataV1): the update authority at byte 1. */
export function metaplexUpdateAuthority(d: Uint8Array): string | null {
  return d.length >= 65 && d[0] === 4 ? keyAt(d, 1) : null;
}

/** Token-2022 mint with the TokenMetadata extension (type 19): its update authority, the first 32 bytes of the value (all zero = none). */
export function token2022UpdateAuthority(d: Uint8Array): string | null {
  if (d.length <= 166 || d[165] !== 1) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 166;
  while (o + 4 <= d.length) {
    const type = v.getUint16(o, true);
    const len = v.getUint16(o + 2, true);
    o += 4;
    if (o + len > d.length) return null;
    if (type === 19 && len >= 64) return keyAt(d, o);
    o += len;
  }
  return null;
}

/** An address from a 32-byte ABI word (`owner()`), or null when the call answered nothing or the zero address (ownership given up). */
export function evmAddressWord(result: unknown): string | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) return null;
  if (!/^0x0{24}/.test(result)) return null;
  const a = '0x' + result.slice(26).toLowerCase();
  return /^0x0{40}$/.test(a) ? null : a;
}

/** A string from an ABI answer: `string` (offset, length, bytes) or the old `bytes32` form. Null when unreadable. */
export function evmAbiString(result: unknown): string | null {
  if (typeof result !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(result)) return null;
  const hex = result.slice(2);
  const bytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
  try {
    if (hex.length === 64) return new TextDecoder('utf-8', { fatal: true }).decode(bytes(hex)).replace(/\0+$/, '');
    if (hex.length < 128) return null;
    const offset = Number.parseInt(hex.slice(0, 64), 16);
    const at = offset * 2;
    const len = Number.parseInt(hex.slice(at, at + 64), 16);
    if (!Number.isSafeInteger(len) || len > 256 || at + 64 + len * 2 > hex.length) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes(hex.slice(at + 64, at + 64 + len * 2)));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- what the public sees

/** A stored row as the public sees it. Anything malformed is dropped rather than shown half-formed. */
export function publicProfile(row: unknown): PublicProfile | null {
  const r = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null;
  const where = r ? profileAddress(r.chain, r.address) : null;
  if (!r || !where) return null;
  const check = validateProfile({ description: r.description ?? '', website: r.website ?? '', x: r.x ?? '', telegram: r.telegram ?? '', discord: r.discord ?? '', logo: r.logo ?? '' });
  if (!check.ok) return null;
  const v = check.value;
  return {
    ...where,
    description: v.description,
    website: v.website || null,
    x: v.x || null,
    telegram: v.telegram || null,
    discord: v.discord || null,
    logo: v.logo || null,
    proof: r.proof === 'authority' ? 'authority' : 'review',
    updatedAt: typeof r.updated_at === 'number' ? r.updated_at : Number(r.updated_at) || 0,
  };
}
