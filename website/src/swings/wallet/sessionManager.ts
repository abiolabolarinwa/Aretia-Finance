/**
 * The Swings wallet session manager: several wallets at once, without ever mixing their accounts.
 *
 *   Wallet A: Solana   address ...
 *   Wallet B: Ethereum address ...
 *   Wallet C: Base     address ...
 *
 * What it guarantees:
 *  - each connected wallet keeps its own session; nothing is shared or merged between wallets;
 *  - one wallet is "active" (the one the user is acting with), and the active account and chain are always read from
 *    that wallet's own session, never remembered separately, so they cannot go stale;
 *  - anything that is about to sign takes a LEASE: a note of exactly which wallet, account and chain, and which session
 *    revision it saw. If the wallet changes in any way afterwards (another account, another network, a disconnect), the
 *    lease no longer matches and signing is refused until the user starts again;
 *  - what is saved for reconnection is only public: which wallet providers were connected and which address they had. No
 *    key, seed phrase or signature is ever stored, and reconnecting never shows a prompt.
 */
import { SwingsError, type ChainId } from '../core/types.js';
import { sessionProblems, type ExecutionExpectation } from './safety.js';
import type { SessionChange, WalletAdapter, WalletSession } from './types.js';

export type ManagerEvent =
  | { type: 'session'; providerId: string; change: SessionChange; session: WalletSession }
  | { type: 'active-changed'; providerId: string | null }
  | { type: 'restored'; providerId: string; session: WalletSession };

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A note of which wallet, account and chain an action was prepared for, and what the session looked like then. */
export interface ExecutionLease {
  providerId: string;
  address: string;
  chain: ChainId;
  revision: number;
}

interface Entry {
  adapter: WalletAdapter;
  off: () => void;
}

/** What is saved between page loads. Public information only. */
interface SavedState {
  version: 1;
  active: string | null;
  wallets: { providerId: string; address: string | null }[];
}

const STORAGE_KEY = 'aretia-swings-wallets';

export class WalletSessionManager {
  private readonly wallets = new Map<string, Entry>();
  private activeId: string | null = null;
  private readonly listeners = new Set<(e: ManagerEvent) => void>();

  constructor(private readonly storage: KeyValueStorage | null = null) {}

  // ------------------------------------------------------------------ events

  subscribe(listener: (e: ManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: ManagerEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  // ------------------------------------------------------------------ wallets

  /** Makes a wallet known to the manager. It is not connected yet. Adding the same provider again replaces it. */
  add(adapter: WalletAdapter): void {
    this.wallets.get(adapter.providerId)?.off();
    const off = adapter.onChange((change, session) => {
      this.emit({ type: 'session', providerId: adapter.providerId, change, session });
      if (change === 'disconnected' && this.activeId === adapter.providerId) this.pickNextActive();
      this.save();
    });
    this.wallets.set(adapter.providerId, { adapter, off });
  }

  /** Connects a known wallet (the wallet shows its own prompt) and makes it the active one. */
  async connect(providerId: string): Promise<WalletSession> {
    const entry = this.wallets.get(providerId);
    if (!entry) throw new SwingsError('invalid', 'That wallet is not available.');
    const session = await entry.adapter.connect();
    this.setActive(providerId);
    this.save();
    return session;
  }

  async disconnect(providerId: string): Promise<void> {
    const entry = this.wallets.get(providerId);
    if (!entry) return;
    await entry.adapter.disconnect();
    if (this.activeId === providerId) this.pickNextActive();
    this.save();
  }

  async disconnectAll(): Promise<void> {
    for (const id of [...this.wallets.keys()]) await this.disconnect(id);
    this.storage?.removeItem(STORAGE_KEY);
  }

  /** Removes a wallet entirely (it is also disconnected). */
  async remove(providerId: string): Promise<void> {
    await this.disconnect(providerId);
    this.wallets.get(providerId)?.off();
    this.wallets.delete(providerId);
    this.save();
  }

  // ------------------------------------------------------------------ reading

  /** Every wallet's current session, connected or not. */
  sessions(): WalletSession[] {
    return [...this.wallets.values()].map((e) => e.adapter.getSession());
  }

  connectedSessions(): WalletSession[] {
    return this.sessions().filter((s) => s.state === 'connected');
  }

  get active(): WalletAdapter | null {
    return this.activeId ? (this.wallets.get(this.activeId)?.adapter ?? null) : null;
  }

  /** The active wallet's own session. The active account and chain are read from here, never kept separately. */
  get activeSession(): WalletSession | null {
    return this.active?.getSession() ?? null;
  }

  /** The wallet that should act on a chain: the active one if it fits, otherwise another connected wallet that does. */
  walletFor(chain: ChainId): WalletAdapter | null {
    const fits = (a: WalletAdapter): boolean => {
      const s = a.getSession();
      if (s.state !== 'connected') return false;
      return s.chainType === 'solana' ? chain === 'solana' : chain !== 'solana' && (s.chain === chain || s.capabilities.switchNetwork);
    };
    const active = this.active;
    if (active && fits(active)) return active;
    return [...this.wallets.values()].map((e) => e.adapter).find(fits) ?? null;
  }

  setActive(providerId: string | null): void {
    if (providerId !== null && !this.wallets.has(providerId)) throw new SwingsError('invalid', 'That wallet is not available.');
    if (this.activeId === providerId) return;
    this.activeId = providerId;
    this.emit({ type: 'active-changed', providerId });
    this.save();
  }

  private pickNextActive(): void {
    const next = [...this.wallets.values()].find((e) => e.adapter.isConnected())?.adapter.providerId ?? null;
    this.activeId = next;
    this.emit({ type: 'active-changed', providerId: next });
  }

  // ------------------------------------------------------------------ leases

  /**
   * Notes which wallet, account and chain an action is being prepared for. The wallet must be connected and on that
   * chain right now; the lease then pins the session revision.
   */
  lease(chain: ChainId, providerId?: string): ExecutionLease {
    const adapter = providerId ? this.wallets.get(providerId)?.adapter : this.walletFor(chain);
    if (!adapter) throw new SwingsError('invalid', 'No connected wallet can act on that network.');
    const s = adapter.getSession();
    if (s.state !== 'connected' || !s.address) throw new SwingsError('invalid', 'That wallet is not connected.');
    return { providerId: adapter.providerId, address: s.address, chain, revision: s.revision };
  }

  /**
   * Re-reads the wallet and checks it still matches the lease in every way. Resolves to the wallet when it does, and
   * throws when anything changed, so a stale action cannot reach the signing step.
   */
  async redeem(lease: ExecutionLease, extra: Pick<ExecutionExpectation, 'allowedDestinations'> = {}): Promise<WalletAdapter> {
    const adapter = this.wallets.get(lease.providerId)?.adapter;
    if (!adapter) throw new SwingsError('invalid', 'That wallet is no longer available.');
    const session = await adapter.refresh();
    const problems = sessionProblems(session, { address: lease.address, chain: lease.chain, revision: lease.revision, ...extra });
    if (problems.length > 0) throw new SwingsError('invalid', problems[0]!);
    return adapter;
  }

  // ------------------------------------------------------------------ reconnection

  private save(): void {
    if (!this.storage) return;
    try {
      const wallets = this.connectedSessions().map((s) => ({ providerId: s.providerId, address: s.address }));
      if (wallets.length === 0) return this.storage.removeItem(STORAGE_KEY);
      const state: SavedState = { version: 1, active: this.activeId, wallets };
      this.storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage can be blocked or full. Reconnection is a convenience; the session itself is unaffected.
    }
  }

  private saved(): SavedState | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as Partial<SavedState>;
      if (v.version !== 1 || !Array.isArray(v.wallets)) return null;
      const wallets = v.wallets.filter((w): w is { providerId: string; address: string | null } => !!w && typeof w.providerId === 'string' && (typeof w.address === 'string' || w.address === null));
      return { version: 1, active: typeof v.active === 'string' ? v.active : null, wallets };
    } catch {
      return null;
    }
  }

  /**
   * After a page load: quietly reattaches to the wallets that were connected, with NO prompt. A wallet is restored only if
   * it is still authorised and still on the same account; if the account differs from the one saved, it is left
   * disconnected and the user connects again deliberately. Returns the providers that were restored.
   */
  async restore(): Promise<string[]> {
    const saved = this.saved();
    if (!saved) return [];
    const restored: string[] = [];
    for (const w of saved.wallets) {
      const entry = this.wallets.get(w.providerId);
      if (!entry) continue;
      const session = await entry.adapter.restore().catch(() => null);
      if (!session || session.state !== 'connected') continue;
      const same = w.address === null || (session.address !== null && session.address.toLowerCase() === w.address.toLowerCase());
      if (!same) {
        await entry.adapter.disconnect().catch(() => undefined);
        continue;
      }
      restored.push(w.providerId);
      this.emit({ type: 'restored', providerId: w.providerId, session });
    }
    const wanted = saved.active && restored.includes(saved.active) ? saved.active : (restored[0] ?? null);
    if (wanted) this.setActive(wanted);
    this.save();
    return restored;
  }
}
