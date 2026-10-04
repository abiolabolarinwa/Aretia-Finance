/**
 * Pure logic for the web wallet's Shield and Intent tabs (no DOM, no network), so it can be
 * tested on its own. Mirrors the Aretia Wallet extension's rules: `parseIntent` is the same
 * fixed-phrase parser (packages/intent), and `shieldFindings` the same Solana recipient check
 * (packages/chains/solana/src/shield.ts), minus anything that needs a signing wallet.
 */

// ------------------------------------------------------------------ addresses

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** True for a base58 string that decodes to exactly 32 bytes, i.e. a Solana public key. */
export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  const bytes: number[] = [];
  for (const ch of value) {
    let carry = BASE58.indexOf(ch);
    if (carry < 0) return false;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading '1' is one leading zero byte.
  for (const ch of value) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return bytes.length === 32;
}

// ------------------------------------------------------------------ Shield

/** The System Program id (32 zero bytes in base58), owner of every plain wallet account. */
export const SYSTEM_PROGRAM_ID = '1'.repeat(32);

export interface AccountSnapshot {
  /** False when `getAccountInfo` returned null: the address has never been funded or touched. */
  exists: boolean;
  executable: boolean;
  owner: string | null;
}

export interface Finding {
  severity: 'warning' | 'info';
  message: string;
}

export function shieldFindings(account: AccountSnapshot, ownAddress: string | null, checked: string): Finding[] {
  const findings: Finding[] = [];
  if (ownAddress !== null && ownAddress === checked) {
    findings.push({ severity: 'info', message: 'This is the address of the wallet you have connected.' });
  }
  if (!account.exists) {
    findings.push({
      severity: 'warning',
      message:
        'This address has no prior on-chain activity. Double-check it before sending, especially if you typed or pasted it.',
    });
    return findings;
  }
  if (account.executable || (account.owner !== null && account.owner !== SYSTEM_PROGRAM_ID)) {
    findings.push({
      severity: 'info',
      message: 'This is a program or token account, not a personal wallet. Sending to it may not reach a person.',
    });
  }
  return findings;
}

// ------------------------------------------------------------------ Intent

export type ParsedIntent =
  | { kind: 'send'; amount: string; assetSymbol: string; recipient: string }
  | { kind: 'swap'; amount: string; fromAssetSymbol: string; toAssetSymbol: string };

const AMOUNT = String.raw`\d+(?:\.\d+)?`;
const SYMBOL = String.raw`[A-Za-z][A-Za-z0-9]*`;
const RECIPIENT = String.raw`\S+?`;
const SWAP_RE = new RegExp(`^swap\\s+(${AMOUNT})\\s+(${SYMBOL})\\s+(?:for|to)\\s+(${SYMBOL})[.!?]?$`, 'i');
const SEND_RE = new RegExp(`^(?:send|pay)\\s+(${AMOUNT})\\s+(${SYMBOL})\\s+to\\s+(${RECIPIENT})[.!?]?$`, 'i');
const PAY_RE = new RegExp(`^pay\\s+(${RECIPIENT})\\s+(${AMOUNT})\\s+(${SYMBOL})[.!?]?$`, 'i');
const stripPunctuation = (v: string) => v.replace(/[.!?,]+$/, '');

/** A fixed set of phrasings, never a guess: anything else returns null. */
export function parseIntent(text: string): ParsedIntent | null {
  const t = text.trim();
  if (!t) return null;
  const swap = t.match(SWAP_RE);
  if (swap) return { kind: 'swap', amount: swap[1]!, fromAssetSymbol: swap[2]!.toUpperCase(), toAssetSymbol: swap[3]!.toUpperCase() };
  const send = t.match(SEND_RE);
  if (send) return { kind: 'send', amount: send[1]!, assetSymbol: send[2]!.toUpperCase(), recipient: stripPunctuation(send[3]!) };
  const pay = t.match(PAY_RE);
  if (pay) return { kind: 'send', amount: pay[2]!, assetSymbol: pay[3]!.toUpperCase(), recipient: stripPunctuation(pay[1]!) };
  return null;
}

export interface Candidate {
  mint: string;
  symbol: string;
  /** True for tokens the wallet holds. */
  held: boolean;
  amount: number | null;
  /** Decimal places of the token, or null when unknown. */
  decimals: number | null;
}

/** Tokens Intent can swap into even when the wallet holds none: real mints, never matched by name alone. */
export const KNOWN_TOKENS: ReadonlyArray<{ symbol: string; mint: string; decimals: number }> = [
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNyDF5N3xN6Z7ZtFg', decimals: 6 },
  { symbol: 'ACT', mint: '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG', decimals: 9 },
];

export interface HeldToken {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number | null;
}

/** Everything a symbol could mean: held tokens with that symbol, plus the one real mint for a known symbol. */
export function candidatesFor(symbol: string, holdings: readonly HeldToken[], includeKnown: boolean): Candidate[] {
  const upper = symbol.toUpperCase();
  const out: Candidate[] = holdings
    .filter((h) => h.symbol.toUpperCase() === upper)
    .map((h) => ({ mint: h.mint, symbol: h.symbol, held: true, amount: h.amount, decimals: h.decimals }));
  if (includeKnown) {
    for (const k of KNOWN_TOKENS) {
      if (k.symbol === upper && !out.some((c) => c.mint === k.mint)) out.push({ mint: k.mint, symbol: k.symbol, held: false, amount: null, decimals: k.decimals });
    }
  }
  return out;
}

/**
 * "0.001" -> "1000000" for a 9-decimal token, by string arithmetic (no floating point).
 * Returns null when the text is not a plain decimal number or has more decimal places than the token.
 */
export function toSmallestUnit(amount: string, decimals: number): string | null {
  const m = amount.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) return null;
  const digits = (m[1]! + fraction.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  return digits;
}
