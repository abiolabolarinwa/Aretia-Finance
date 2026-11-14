/**
 * The wallets a player can sign in to the game with. Signing is a free message, never a transaction. The page offers three choices:
 * Phantom, MetaMask, and "Connect others" (every other wallet the browser has, the Solana wallet already connected in the sidebar, and
 * WalletConnect for phone and hardware wallets, shown as a QR code on the page itself). Options come from what the browser actually
 * has, and carry the wallet's own logo when the wallet supplies one.
 */
import type { Signer } from '../swings/account/client.js';

export type WalletKind = 'phantom' | 'metamask' | 'other';

export interface SignContext {
  /** Called with a WalletConnect address (wc:...) to show as a QR code. */
  onUri?: (uri: string) => void;
}

export interface SignerOption {
  id: string;
  label: string;
  family: 'evm' | 'solana';
  kind: WalletKind;
  /** The wallet's own logo (a data address or https address), when it supplies one. */
  icon: string | null;
  make(ctx?: SignContext): Promise<Signer>;
}

interface Connected {
  account: string;
  sign(messageHex: string): Promise<string>;
}

/** The parts of the page's wallet machinery this needs, so they can be replaced in a test. */
export interface SignerEnv {
  /** Ethereum-style wallets announced by the browser. */
  evmWallets(): Promise<{ id: string; name: string; icon?: string | null; rdns?: string | null }[]>;
  /** Connects to one of them and returns a function that signs a message with the first account. */
  connectEvm(id: string): Promise<Connected>;
  /** A WalletConnect project id, or '' when the site has none. */
  walletConnectProjectId: string;
  connectWalletConnect(onUri: (uri: string) => void): Promise<Connected>;
  /** The Solana wallet connected in the sidebar, if any. */
  sidebarSolana(): { address: string; name?: string | null; icon?: string | null; signMessage(m: Uint8Array): Promise<Uint8Array> } | null;
  /** Phantom or another injected Solana wallet. */
  injectedSolana(): { connect(): Promise<string>; isPhantom?: boolean; signMessage(m: Uint8Array): Promise<Uint8Array> } | null;
}

const hex = (m: string): string => '0x' + [...new TextEncoder().encode(m)].map((b) => b.toString(16).padStart(2, '0')).join('');
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const isProjectId = (v: string): boolean => /^[0-9a-f]{32}$/.test(v);
const safeIcon = (v: unknown): string | null => (typeof v === 'string' && /^(data:image\/(png|svg\+xml|webp|jpeg|gif);|https:\/\/)/.test(v) ? v : null);

export async function signerOptions(env: SignerEnv): Promise<SignerOption[]> {
  const out: SignerOption[] = [];
  const wallets = await env.evmWallets().catch(() => [] as { id: string; name: string; icon?: string | null; rdns?: string | null }[]);
  for (const w of wallets) {
    const rdns = (w.rdns ?? '').toLowerCase();
    // Phantom is offered through its Solana wallet below, so its Ethereum side is not listed a second time.
    if (rdns === 'app.phantom' || /^phantom$/i.test(w.name)) continue;
    const kind: WalletKind = rdns === 'io.metamask' || /^metamask$/i.test(w.name) ? 'metamask' : 'other';
    out.push({ id: `evm:${w.id}`, label: w.name, family: 'evm', kind, icon: safeIcon(w.icon), make: async () => {
      const c = await env.connectEvm(w.id);
      return { family: 'evm', address: c.account, sign: (m) => c.sign(hex(m)) };
    } });
  }
  const side = env.sidebarSolana();
  const sidePhantom = Boolean(side && /phantom/i.test(side.name ?? ''));
  if (side) {
    out.push({ id: 'solana:sidebar', label: sidePhantom ? 'Phantom' : `${side.name || 'Solana wallet'} (connected here)`, family: 'solana', kind: sidePhantom ? 'phantom' : 'other', icon: safeIcon(side.icon), make: async () => ({
      family: 'solana',
      address: side.address,
      sign: async (m) => base64(await side.signMessage(new TextEncoder().encode(m))),
    }) });
  }
  const injected = env.injectedSolana();
  if (injected && !side) {
    const phantom = injected.isPhantom !== false;
    out.push({ id: 'solana:injected', label: phantom ? 'Phantom' : 'Solana wallet in this browser', family: 'solana', kind: phantom ? 'phantom' : 'other', icon: null, make: async () => {
      const address = await injected.connect();
      return { family: 'solana', address, sign: async (m) => base64(await injected.signMessage(new TextEncoder().encode(m))) };
    } });
  }
  if (isProjectId(env.walletConnectProjectId)) {
    out.push({ id: 'evm:walletconnect', label: 'WalletConnect (scan with a phone or hardware wallet)', family: 'evm', kind: 'other', icon: null, make: async (ctx) => {
      const c = await env.connectWalletConnect((uri) => ctx?.onUri?.(uri));
      return { family: 'evm', address: c.account, sign: (m) => c.sign(hex(m)) };
    } });
  }
  return out;
}

/** The real thing, built from the page. Loaded only when a player chooses to sign in. */
export async function pageSignerEnv(): Promise<SignerEnv> {
  const [{ EvmSession }, wc] = await Promise.all([import('../swings/chains/evmSession.js'), import('../swings/wallet/walletConnect.js')]);
  const evm = new EvmSession();
  const projectId = String(import.meta.env.PUBLIC_WALLETCONNECT_PROJECT_ID ?? '');
  const sign = (account: string) => async (messageHex: string): Promise<string> => {
    if (!evm.adapter) throw new Error('The wallet is not connected.');
    return evm.adapter.signMessage(messageHex, account);
  };
  type Sol = { getState(): { account: { address: string } | null; walletName?: string | null; walletIcon?: string | null }; getWalletContextState(): unknown };
  type Phantom = { isPhantom?: boolean; connect(): Promise<{ publicKey: { toString(): string } }>; signMessage(m: Uint8Array, display?: string): Promise<{ signature: Uint8Array }> };
  const w = window as unknown as { AretiaWallet?: Sol; phantom?: { solana?: Phantom }; solana?: Phantom };
  return {
    async evmWallets() {
      const found = await evm.discover();
      return found.map((x) => ({ id: x.info.uuid, name: x.info.name, icon: x.info.icon, rdns: x.info.rdns }));
    },
    async connectEvm(id) {
      const account = await evm.connect(id);
      return { account, sign: sign(account) };
    },
    walletConnectProjectId: projectId,
    async connectWalletConnect(onUri) {
      if (!wc.isProjectId(projectId)) throw new Error('WalletConnect is not set up for this site yet.');
      const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
      const optional = wc.supportedEvmIds().filter((id) => id !== 1);
      // The code is drawn on the page itself (showQrModal off), so nothing depends on a pop-up appearing over the game.
      const provider = await EthereumProvider.init({ projectId, chains: [1], optionalChains: optional as [number, ...number[]], showQrModal: false, metadata: { name: 'Aretia Ultimate City Search', description: 'Sign in to play. A free message, never a transaction.', url: location.origin, icons: [] } });
      // An old session from another page could be dead; start a fresh one so the wallet is asked now.
      if (provider.session) await provider.disconnect().catch(() => undefined);
      provider.on('display_uri', (uri: string) => onUri(uri));
      await provider.connect();
      const account = provider.accounts[0];
      if (!account) throw new Error('The wallet shared no account.');
      return { account, sign: async (messageHex: string) => (await provider.request({ method: 'personal_sign', params: [messageHex, account] })) as string };
    },
    sidebarSolana() {
      const state = w.AretiaWallet?.getState();
      const ctx = w.AretiaWallet?.getWalletContextState() as { signMessage?: (m: Uint8Array) => Promise<Uint8Array> } | undefined;
      return state?.account?.address && ctx?.signMessage ? { address: state.account.address, name: state.walletName ?? null, icon: state.walletIcon ?? null, signMessage: ctx.signMessage } : null;
    },
    injectedSolana() {
      const p = w.phantom?.solana ?? w.solana;
      return p ? { isPhantom: Boolean(p.isPhantom), async connect() { return (await p.connect()).publicKey.toString(); }, async signMessage(m) { return (await p.signMessage(m, 'utf8')).signature; } } : null;
    },
  };
}
