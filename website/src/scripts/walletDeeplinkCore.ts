/**
 * Phantom and Solflare "deeplinks": the way an app (not a web page) asks these wallets to connect and sign. Aretia opens the
 * wallet app with a request, the person approves there, and the wallet opens the Aretia app again with the answer. Requests and
 * answers are encrypted with a key pair made on this phone for the session (X25519 + XSalsa20-Poly1305, the "box" of tweetnacl),
 * as both wallets' documentation describes. Aretia never sees a private key of the wallet.
 *
 * Everything here is pure (no page, no network) so it is tested without a phone. The page wiring is in walletDeeplink.ts.
 */
import nacl from 'tweetnacl';
import { base58Decode, base58Encode } from './solanaWcCore';

export type DeeplinkWallet = 'phantom' | 'solflare';

export const DEEPLINK_BASE: Readonly<Record<DeeplinkWallet, string>> = {
  phantom: 'https://phantom.app/ul/v1/',
  solflare: 'https://solflare.com/ul/v1/',
};
/** The name each wallet gives its public key in the answer to a connect request. */
export const ANSWER_KEY_PARAM: Readonly<Record<DeeplinkWallet, string>> = {
  phantom: 'phantom_encryption_public_key',
  solflare: 'solflare_encryption_public_key',
};
/** The address the wallet opens when it answers: the Aretia app's own link (declared in the Android and iPhone projects). */
export const RETURN_SCHEME = 'aretia';
export const returnLink = (wallet: DeeplinkWallet, step: string): string => `${RETURN_SCHEME}://wallet/${wallet}/${step}`;

export interface DappKeys {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export const newDappKeys = (): DappKeys => nacl.box.keyPair();

export function connectUrl(wallet: DeeplinkWallet, keys: DappKeys, appUrl: string): string {
  const q = new URLSearchParams({
    app_url: appUrl,
    dapp_encryption_public_key: base58Encode(keys.publicKey),
    redirect_link: returnLink(wallet, 'connect'),
    cluster: 'mainnet-beta',
  });
  return `${DEEPLINK_BASE[wallet]}connect?${q.toString()}`;
}

/** The shared key for one wallet session: the wallet's public key with this phone's secret key. */
export const sharedKey = (walletPublicKey: Uint8Array, keys: DappKeys): Uint8Array => nacl.box.before(walletPublicKey, keys.secretKey);

export function encryptPayload(payload: unknown, shared: Uint8Array): { nonce: string; payload: string } {
  const nonce = nacl.randomBytes(24);
  const boxed = nacl.box.after(new TextEncoder().encode(JSON.stringify(payload)), nonce, shared);
  return { nonce: base58Encode(nonce), payload: base58Encode(boxed) };
}

export function decryptPayload<T>(data: string, nonce: string, shared: Uint8Array): T {
  const opened = nacl.box.open.after(base58Decode(data), base58Decode(nonce), shared);
  if (!opened) throw new Error('The wallet’s answer could not be read.');
  return JSON.parse(new TextDecoder().decode(opened)) as T;
}

/** A request to sign: signTransaction (a serialised transaction) or signMessage (any bytes). */
export function signUrl(wallet: DeeplinkWallet, keys: DappKeys, shared: Uint8Array, method: 'signTransaction' | 'signMessage', body: Record<string, string>): string {
  const { nonce, payload } = encryptPayload(body, shared);
  const q = new URLSearchParams({
    dapp_encryption_public_key: base58Encode(keys.publicKey),
    nonce,
    redirect_link: returnLink(wallet, method),
    payload,
  });
  return `${DEEPLINK_BASE[wallet]}${method}?${q.toString()}`;
}

/** What a return link carries: the step it answers, and either the encrypted answer or the wallet's error. */
export interface ReturnAnswer {
  wallet: DeeplinkWallet;
  step: string;
  params: URLSearchParams;
  error: string | null;
}

export function parseReturn(url: string): ReturnAnswer | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${RETURN_SCHEME}:`) return null;
  // aretia://wallet/phantom/connect: the host is "wallet", the path names the wallet and the step.
  const parts = `${u.host}${u.pathname}`.split('/').filter(Boolean);
  if (parts[0] !== 'wallet' || (parts[1] !== 'phantom' && parts[1] !== 'solflare') || !parts[2]) return null;
  const code = u.searchParams.get('errorCode');
  const message = u.searchParams.get('errorMessage');
  return { wallet: parts[1], step: parts[2], params: u.searchParams, error: code ? message || `The wallet refused (${code}).` : null };
}
