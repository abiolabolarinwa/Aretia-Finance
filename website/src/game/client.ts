/**
 * The page's side of Ultimate City Search sign-in. The wallet signs a free message that says it is for the game (it is not a
 * transaction and is not an approval); the server answers with a game session. The session is kept in this browser only so the
 * player need not sign again for seven days. It is a convenience: the player record lives on the server.
 */
import { loginMessage, type WalletFamily } from '../swings/account/loginMessage.js';
import type { Signer } from '../swings/account/client.js';

export interface GameProfile {
  playerId: string;
  displayName: string;
  avatar: string | null;
  explorerLevel: number;
  totalXp: number;
  totalDiscoveries: number;
  missionsCompleted: number;
}
export interface GameSession {
  token: string;
  expiresAt: number;
  network: WalletFamily;
  address: string;
  profile: GameProfile;
}
interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const KEY = 'aretia-game-session-v1';
const API = '/api/game';

export class GameClient {
  constructor(
    private readonly storage: Store | null,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
    private readonly domain: () => string = () => location.host,
  ) {}

  /** The saved session, if it has not expired. */
  saved(): GameSession | null {
    try {
      const raw = this.storage?.getItem(KEY);
      const s = raw ? (JSON.parse(raw) as GameSession) : null;
      return s && typeof s.token === 'string' && s.expiresAt > this.now() ? s : null;
    } catch {
      return null;
    }
  }

  forget(): void {
    try {
      this.storage?.removeItem(KEY);
    } catch {
      // nothing saved to remove
    }
  }

  private async post<T>(payload: Record<string, unknown>, token?: string): Promise<T> {
    const res = await this.fetchImpl(API, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
    const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (res.status === 401 && token) this.forget();
    if (!res.ok || !body) throw new Error((body as { message?: string } | null)?.message ?? 'The game could not be reached. Try again.');
    return body;
  }

  /** Signs in with the wallet that is connected. Never asks for a transaction, a key or a phrase. */
  async signIn(signer: Signer): Promise<GameSession> {
    const issued = await this.post<{ nonce?: string }>({ op: 'nonce' });
    if (typeof issued.nonce !== 'string' || !/^[0-9a-f]{16,64}$/.test(issued.nonce)) throw new Error('Signing in is not available right now. Try again.');
    const message = loginMessage({ purpose: 'game', family: signer.family, address: signer.address, domain: this.domain(), issuedAt: this.now(), nonce: issued.nonce });
    const signature = await signer.sign(message);
    const r = await this.post<{ token: string; expiresAt: number; network: WalletFamily; address: string; profile: GameProfile }>({ op: 'login', message, signature });
    const session: GameSession = { token: r.token, expiresAt: r.expiresAt, network: r.network, address: r.address, profile: r.profile };
    try {
      this.storage?.setItem(KEY, JSON.stringify(session));
    } catch {
      // not remembered: the player signs in again next time
    }
    return session;
  }

  async me(session: GameSession): Promise<GameProfile> {
    return (await this.post<{ profile: GameProfile }>({ op: 'me' }, session.token)).profile;
  }

  async signOut(session: GameSession, everywhere = false): Promise<void> {
    await this.post({ op: everywhere ? 'sign-out-all' : 'logout' }, session.token).catch(() => undefined);
    this.forget();
  }
}
