/**
 * The wallets a player can sign in to the game with. Signing is a free message, never a transaction. Options come from what the
 * browser actually has: every Ethereum-style wallet that announces itself (MetaMask, Rabby, Coinbase Wallet and others), WalletConnect
 * for phone and hardware wallets (when the site has a WalletConnect project id), the Solana wallet already connected in the sidebar
 * (which covers Solana wallets connected through WalletConnect), and Phantom if it is installed.
 */
import type { Signer } from '../swings/account/client.js';

export interface SignerOption {
  id: string;
  label: string;
  family: 'evm' | 'solana';
  make(): Promise<Signer>;
}

/** The parts of the page's wallet machinery this needs, so they can be replaced in a test. */
export interface SignerEnv {
  /** Ethereum-style wallets announced by the browser. */
  evmWallets(): Promise<{ id: string; name: string }[]>;
  /** Connects to one of them and returns a function that signs a message with the first account. */
  connectEvm(id: string): Promise<{ account: string; sign(messageHex: string): Promise<string> }>;
  /** A WalletConnect project id, or '' when the site has none. */
  walletConnectProjectId: string;
  connectWalletConnect(): Promise<{ account: string; sign(messageHex: string): Promise<string> }>;
  /** The Solana wallet connected in the sidebar, if any. */
  sidebarSolana(): { address: string; signMessage(m: Uint8Array): Promise<Uint8Array> } | null;
  /** Phantom or another injected Solana wallet. */
  injectedSolana(): { connect(): Promise<string>; signMessage(m: Uint8Array): Promise<Uint8Array> } | null;
}

const hex = (m: string): string => '0x' + [...new TextEncoder().encode(m)].map((b) => b.toString(16).padStart(2, '0')).join('');
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const isProjectId = (v: string): boolean => /^[0-9a-f]{32}$/.test(v);

export async function signerOptions(env: SignerEnv): Promise<SignerOption[]> {
  const out: SignerOption[] = [];
  const wallets = await env.evmWallets().catch(() => [] as { id: string; name: string }[]);
  for (const w of wallets) {
    out.push({ id: `evm:${w.id}`, label: `${w.name} (Ethereum-style)`, family: 'evm', make: async () => {
      const c = await env.connectEvm(w.id);
      return { family: 'evm', address: c.account, sign: (m) => c.sign(hex(m)) };
    } });
  }
  if (isProjectId(env.walletConnectProjectId)) {
    out.push({ id: 'evm:walletconnect', label: 'WalletConnect (phone, hardware or any wallet app)', family: 'evm', make: async () => {
      const c = await env.connectWalletConnect();
      return { family: 'evm', address: c.account, sign: (m) => c.sign(hex(m)) };
    } });
  }
  const side = env.sidebarSolana();
  if (side) {
    out.push({ id: 'solana:sidebar', label: `Solana wallet connected here (${side.address.slice(0, 4)}…${side.address.slice(-4)})`, family: 'solana', make: async () => ({
      family: 'solana',
      address: side.address,
      sign: async (m) => base64(await side.signMessage(new TextEncoder().encode(m))),
    }) });
  }
  const phantom = env.injectedSolana();
  if (phantom && !side) {
    out.push({ id: 'solana:injected', label: 'Phantom or another Solana wallet in this browser', family: 'solana', make: async () => {
      const address = await phantom.connect();
      return { family: 'solana', address, sign: async (m) => base64(await phantom.signMessage(new TextEncoder().encode(m))) };
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
  type Sol = { getState(): { account: { address: string } | null }; getWalletContextState(): unknown };
  type Phantom = { connect(): Promise<{ publicKey: { toString(): string } }>; signMessage(m: Uint8Array, display?: string): Promise<{ signature: Uint8Array }> };
  const w = window as unknown as { AretiaWallet?: Sol; phantom?: { solana?: Phantom }; solana?: Phantom; ethereum?: { request(a: { method: string; params?: unknown[] }): Promise<unknown> } };
  return {
    async evmWallets() {
      const found = await evm.discover();
      return found.map((x) => ({ id: x.info.uuid, name: x.info.name }));
    },
    async connectEvm(id) {
      const account = await evm.connect(id);
      return { account, sign: sign(account) };
    },
    walletConnectProjectId: projectId,
    async connectWalletConnect() {
      const account = await wc.connectWalletConnect(evm, projectId);
      return { account, sign: sign(account) };
    },
    sidebarSolana() {
      const address = w.AretiaWallet?.getState().account?.address;
      const ctx = w.AretiaWallet?.getWalletContextState() as { signMessage?: (m: Uint8Array) => Promise<Uint8Array> } | undefined;
      return address && ctx?.signMessage ? { address, signMessage: ctx.signMessage } : null;
    },
    injectedSolana() {
      const p = w.phantom?.solana ?? w.solana;
      return p ? { async connect() { return (await p.connect()).publicKey.toString(); }, async signMessage(m) { return (await p.signMessage(m, 'utf8')).signature; } } : null;
    },
  };
}
