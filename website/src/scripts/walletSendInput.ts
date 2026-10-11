/**
 * Checks on the Send form that need no network, so a typo is caught the moment Review is pressed instead of after the
 * transfer has been looked up. The full checks (balance, fees, recipient account) still run in planSend.
 */
import { isSolanaAddress, toSmallestUnit } from './walletTools';

export interface SendInput {
  /** The wallet sending. */
  from: string;
  /** What was typed in the recipient box. */
  target: string;
  amountText: string;
  /** The chosen token's decimals and exact balance (smallest unit), when they are known. */
  decimals: number | null;
  balanceRaw: string | null;
  symbol: string;
}

const looksLikeName = (v: string): boolean => /^[^\s@/:]+\.[a-z][a-z0-9-]*$/i.test(v) && !/^0x/i.test(v);

/** The first problem with what was typed, in plain words, or null when it is fit to look up. */
export function checkSendInput(i: SendInput): string | null {
  const target = i.target.trim();
  const amount = i.amountText.trim();
  if (!target) return 'Enter who to send to: a Solana address or a .sns name.';
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) return 'That is an Ethereum-style address. This sends on Solana, so it needs a Solana address or a .sns name.';
  if (isSolanaAddress(target)) {
    if (target === i.from) return 'That is your own address. Enter the address you want to send to.';
  } else if (!looksLikeName(target)) {
    return 'That is not a Solana address or a .sns name. Check it for a missing or extra character.';
  }
  if (!amount) return 'Enter an amount.';
  if (!/^\d*\.?\d*$/.test(amount) || !/\d/.test(amount)) return `${amount} is not an amount. Use digits and one decimal point.`;
  if (i.decimals !== null) {
    const raw = toSmallestUnit(amount.startsWith('.') ? `0${amount}` : amount.replace(/\.$/, ''), i.decimals);
    if (raw === null) return `${i.symbol} allows at most ${i.decimals} decimal places.`;
    if (BigInt(raw) === 0n) return 'The amount must be more than zero.';
    if (i.balanceRaw !== null && BigInt(raw) > BigInt(i.balanceRaw)) return `You hold less ${i.symbol} than that.`;
  }
  return null;
}

/** One line for the asset list: symbol, name and balance. The short address only where two tokens share a symbol or there is no name. */
export function sendAssetLabel(h: { mint: string; symbol: string; name: string; amount: number }, all: readonly { mint: string; symbol: string }[], amount: string, nativeMint: string, short: (mint: string) => string): string {
  const duplicated = all.filter((x) => x.symbol === h.symbol).length > 1;
  const name = h.name && h.name.toLowerCase() !== h.symbol.toLowerCase() ? ` (${h.name})` : '';
  const tail = h.mint !== nativeMint && (duplicated || !h.name) ? ` · ${short(h.mint)}` : '';
  return `${h.symbol}${name} · ${amount}${tail}`;
}
