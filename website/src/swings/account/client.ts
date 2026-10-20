/**
 * The page's side of "save to my wallet": sign a plain message once, keep the session token the server answers with, and
 * send favourites and swap history under it. The token is kept in this browser, per address, for as long as the server
 * allows (seven days). Nothing here ever sees a key: the wallet signs, the page only passes the signature on.
 */
import { loginMessage, type WalletFamily } from './loginMessage.js';
import type { StorageLike } from '../history.js';
import type { HistoryItem } from '../history.js';

export interface Signer {
  family: WalletFamily;
  address: string;
  /** Signs the message with the wallet. Solana: the signature as base64. Ethereum-style: the `personal_sign` hex. */
  sign(message: string): Promise<string>;
}

export interface Session {
  owner: string;
  address: string;
  token: string;
  expiresAt: number;
}

export interface SavedFavourite {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  icon: string | null;
  addedAt: number;
}

const KEY = 'aretia-account-sessions-v1';

/**
 * `Authorization` for a request about `address` (e.g. a ramp payment link), from the sign-in saved in this browser, or nothing
 * when that address has not signed in. The family is read from the address's shape.
 */
export function authorizationFor(storage: StorageLike | null, address: unknown, now: number = Date.now()): Record<string, string> {
  if (typeof address !== 'string' || address.length === 0) return {};
  const family: WalletFamily = /^0x[0-9a-fA-F]{40}$/.test(address) ? 'evm' : 'solana';
  const s = new AccountClient(storage, undefined, () => now, () => '').session(family, address);
  return s ? { authorization: `Bearer ${s.token}` } : {};
}

export class AccountClient {
  constructor(
    private readonly storage: StorageLike | null,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
    private readonly domain: () => string = () => location.host,
  ) {}

  private readAll(): Record<string, Session> {
    try {
      const raw = this.storage?.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Session>) : {};
    } catch {
      return {};
    }
  }

  private writeAll(all: Record<string, Session>): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(all));
    } catch {
      // not remembered: the person signs in again next time
    }
  }

  /** The saved session for an address, if it is still valid. */
  session(family: WalletFamily, address: string): Session | null {
    const owner = family === 'evm' ? `evm:${address.toLowerCase()}` : `solana:${address}`;
    const s = this.readAll()[owner];
    return s && typeof s.token === 'string' && s.expiresAt > this.now() ? s : null;
  }

  signOut(family: WalletFamily, address: string): void {
    const owner = family === 'evm' ? `evm:${address.toLowerCase()}` : `solana:${address}`;
    const all = this.readAll();
    delete all[owner];
    this.writeAll(all);
  }

  async signIn(signer: Signer): Promise<Session> {
    // The nonce is issued by the server and works once, so a signature cannot be replayed.
    const n = await this.fetchImpl('/api/swings-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'nonce' }) });
    const issued = (await n.json().catch(() => null)) as { nonce?: string; message?: string } | null;
    if (!n.ok || typeof issued?.nonce !== 'string' || !/^[0-9a-f]{16,64}$/.test(issued.nonce)) throw new Error(issued?.message ?? 'Signing in is not available right now. Try again.');
    const message = loginMessage({ family: signer.family, address: signer.address, domain: this.domain(), issuedAt: this.now(), nonce: issued.nonce });
    const signature = await signer.sign(message);
    const res = await this.fetchImpl('/api/swings-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'login', message, signature }) });
    const body = (await res.json().catch(() => null)) as { token?: string; expiresAt?: number; owner?: string; address?: string; message?: string } | null;
    if (!res.ok || !body?.token || typeof body.expiresAt !== 'number' || !body.owner) throw new Error(body?.message ?? 'Signing in did not work. Try again.');
    const session: Session = { owner: body.owner, address: signer.address, token: body.token, expiresAt: body.expiresAt };
    this.writeAll({ ...this.readAll(), [session.owner]: session });
    return session;
  }

  /** One call under a session. A refused session is forgotten so the page asks to sign in again. */
  async call<T>(session: Session, payload: Record<string, unknown>, path = '/api/swings-account'): Promise<T> {
    const res = await this.fetchImpl(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }, body: JSON.stringify(payload) });
    if (res.status === 401) {
      const all = this.readAll();
      delete all[session.owner];
      this.writeAll(all);
      throw new Error('Your sign-in has ended. Sign in again to keep saving.');
    }
    const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!res.ok || !body) throw new Error((body as { message?: string } | null)?.message ?? 'Your saved data could not be reached.');
    return body;
  }

  /** Ends every session of this address, on every device (the server raises the address's session version). */
  async signOutEverywhere(session: Session): Promise<void> {
    await this.call(session, { op: 'sign-out-all' }).catch(() => undefined);
    const all = this.readAll();
    delete all[session.owner];
    this.writeAll(all);
  }

  get(session: Session): Promise<{ favourites: SavedFavourite[]; trades: HistoryItem[] }> {
    return this.call(session, { op: 'get' });
  }

  setFavourite(session: Session, fav: { chain: string; address: string; symbol: string; name: string; icon: string | null }, on: boolean): Promise<unknown> {
    return this.call(session, { op: 'favourite', ...fav, on });
  }

  saveTrades(session: Session, items: HistoryItem[]): Promise<unknown> {
    return this.call(session, { op: 'trades', items });
  }
}
