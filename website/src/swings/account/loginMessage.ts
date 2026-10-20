/**
 * The message a person signs to prove they control a wallet address. It follows Sign-In with Ethereum (EIP-4361) for EVM
 * wallets and its Solana counterpart (Sign In With Solana) for Solana wallets, so wallets that understand those formats show
 * it as a sign-in and check that the domain in it is the site asking. It says what signing does and does not do, and carries a
 * time and a single-use nonce the server issued, so an old or phished signature is useless. Signing it costs nothing and
 * cannot move funds: it is not a transaction. Shared by the page (to build it) and the server (to read it back and check every
 * line), so the two can never disagree.
 */
import { toChecksumAddress } from '../core/keccak.js';

export type WalletFamily = 'solana' | 'evm';

export const LOGIN_WINDOW_MS = 5 * 60_000;

export const LOGIN_STATEMENT = 'Sign in to Aretia Wallet to save your favourite tokens and swap history to this address. This is not a transaction: it costs nothing and cannot move your funds.';

export interface LoginFields {
  family: WalletFamily;
  /** As the wallet reports it. EVM addresses are written in their EIP-55 form and compared lower-case. */
  address: string;
  /** The site's host (RFC 3986 authority), e.g. "aretiafinance.org". */
  domain: string;
  issuedAt: number;
  /** The single-use value the server issued for this sign-in. */
  nonce: string;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

/** The URI line: https for a real site, http only for a local development host. */
export const loginUri = (domain: string): string => `${LOCAL_HOST.test(domain) ? 'http' : 'https'}://${domain}`;

const writtenAddress = (f: Pick<LoginFields, 'family' | 'address'>): string => (f.family === 'evm' && /^0x[0-9a-fA-F]{40}$/.test(f.address) ? toChecksumAddress(f.address) : f.address);

export function loginMessage(f: LoginFields): string {
  const evm = f.family === 'evm';
  return [
    `${f.domain} wants you to sign in with your ${evm ? 'Ethereum' : 'Solana'} account:`,
    writtenAddress(f),
    '',
    LOGIN_STATEMENT,
    '',
    `URI: ${loginUri(f.domain)}`,
    'Version: 1',
    `Chain ID: ${evm ? '1' : 'mainnet'}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${new Date(f.issuedAt).toISOString()}`,
  ].join('\n');
}

/** Reads a message back into its fields, or null if it is not exactly the message `loginMessage` makes. */
export function parseLoginMessage(message: string): LoginFields | null {
  const lines = message.split('\n');
  if (lines.length !== 10) return null;
  const head = /^([A-Za-z0-9.-]+(?::\d{1,5})?) wants you to sign in with your (Ethereum|Solana) account:$/.exec(lines[0]!);
  if (!head) return null;
  const family: WalletFamily = head[2] === 'Ethereum' ? 'evm' : 'solana';
  const address = lines[1]!;
  const nonce = lines[8]?.startsWith('Nonce: ') ? lines[8].slice(7) : '';
  const issued = lines[9]?.startsWith('Issued At: ') ? lines[9].slice(11) : '';
  if (!address || !/^[0-9a-f]{16,64}$/.test(nonce)) return null;
  const issuedAt = Date.parse(issued);
  if (!Number.isFinite(issuedAt)) return null;
  const fields: LoginFields = { family, address, domain: head[1]!, issuedAt, nonce };
  // Every line must be the one the builder writes: no extra text, nothing reordered, an EVM address in its checksummed form.
  return loginMessage(fields) === message ? fields : null;
}
