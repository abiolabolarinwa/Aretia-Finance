/**
 * The message a person signs to prove they control a wallet address. It is plain words, names the site and the address,
 * says what signing does and does not do, and carries a time and a random value so an old signature is useless. Signing it
 * costs nothing and cannot move funds: it is not a transaction. Shared by the page (to build it) and the server (to read it
 * back and check every line), so the two can never disagree.
 */
export type WalletFamily = 'solana' | 'evm';

export const LOGIN_WINDOW_MS = 5 * 60_000;

export interface LoginFields {
  family: WalletFamily;
  /** As the wallet reports it. EVM addresses are compared lower-case. */
  address: string;
  domain: string;
  issuedAt: number;
  nonce: string;
}

export function loginMessage(f: LoginFields): string {
  return [
    'Aretia Wallet sign-in',
    'Signing this saves your favourite tokens and swap history to your wallet address, so they follow you to other devices.',
    'It is not a transaction. It costs nothing and cannot move your funds.',
    `Domain: ${f.domain}`,
    `Network family: ${f.family}`,
    `Address: ${f.address}`,
    `Issued: ${new Date(f.issuedAt).toISOString()}`,
    `Nonce: ${f.nonce}`,
  ].join('\n');
}

/** Reads a message back into its fields, or null if it is not exactly the message `loginMessage` makes. */
export function parseLoginMessage(message: string): LoginFields | null {
  const lines = message.split('\n');
  const get = (prefix: string): string | null => {
    const l = lines.find((x) => x.startsWith(prefix));
    return l ? l.slice(prefix.length) : null;
  };
  const family = get('Network family: ');
  const address = get('Address: ');
  const domain = get('Domain: ');
  const issued = get('Issued: ');
  const nonce = get('Nonce: ');
  if ((family !== 'solana' && family !== 'evm') || !address || !domain || !issued || !nonce) return null;
  const issuedAt = Date.parse(issued);
  if (!Number.isFinite(issuedAt) || !/^[0-9a-f]{16,64}$/.test(nonce)) return null;
  const fields: LoginFields = { family, address, domain, issuedAt, nonce };
  // Every line must be the one the builder writes: no extra text, nothing reordered.
  return loginMessage(fields) === message ? fields : null;
}
