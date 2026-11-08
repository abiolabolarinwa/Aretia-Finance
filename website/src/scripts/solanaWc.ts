/**
 * Page wiring for WalletConnect on Solana (see solanaWcCore.ts for what it does and why). Inside the Aretia app only: the website,
 * the browser extension and phone browsers keep connecting as they do today. It needs a WalletConnect project id
 * (PUBLIC_WALLETCONNECT_PROJECT_ID, free from the WalletConnect dashboard; the id is public by design). Without one, nothing is added.
 */
import { isNativeApp } from '../lib/nativeApp';
import { createWcSolanaWallet, WC_WALLET_LINKS, type WcSolanaProvider, type WcSolanaWallet } from './solanaWcCore';

const PROJECT_ID = String(import.meta.env.PUBLIC_WALLETCONNECT_PROJECT_ID ?? '');
const isProjectId = (v: string): boolean => /^[0-9a-f]{32}$/.test(v);

const ICON =
  'data:image/svg+xml;base64,' +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3b99fc"/><path d="M9.6 12.2c3.5-3.4 9.3-3.4 12.8 0l.4.4a.4.4 0 0 1 0 .6l-1.4 1.4a.2.2 0 0 1-.3 0l-.6-.6c-2.4-2.4-6.4-2.4-8.8 0l-.6.6a.2.2 0 0 1-.3 0l-1.4-1.4a.4.4 0 0 1 0-.6zm15.8 2.9 1.3 1.3a.4.4 0 0 1 0 .6l-5.7 5.6a.4.4 0 0 1-.6 0l-4-4a.1.1 0 0 0-.2 0l-4 4a.4.4 0 0 1-.6 0l-5.7-5.6a.4.4 0 0 1 0-.6l1.3-1.3a.4.4 0 0 1 .6 0l4 4a.1.1 0 0 0 .2 0l4-4a.4.4 0 0 1 .6 0l4 4a.1.1 0 0 0 .2 0l4-4a.4.4 0 0 1 .6 0z" fill="#fff"/></svg>');

let providerPromise: Promise<WcSolanaProvider> | null = null;

function loadProvider(): Promise<WcSolanaProvider> {
  providerPromise ??= import('@walletconnect/universal-provider').then(async (m) => {
    const UniversalProvider = (m.default ?? (m as unknown as { UniversalProvider: typeof m.default }).UniversalProvider) as unknown as { init(o: unknown): Promise<WcSolanaProvider> };
    return UniversalProvider.init({
      projectId: PROJECT_ID,
      metadata: { name: 'Aretia Finance', description: 'Markets, Pay, Launch and more from your own wallet. Aretia never holds your keys.', url: 'https://aretiafinance.org', icons: ['https://aretiafinance.org/assets/icons/icon-192.png'] },
    });
  });
  // A failed load must be retried next time, not remembered.
  providerPromise.catch(() => {
    providerPromise = null;
  });
  return providerPromise;
}

function showPairing(uri: string, cancel: () => void): { close(): void } {
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-label', 'Connect a phone wallet');
  dlg.style.cssText = 'max-width:min(22rem,calc(100vw - 2rem));padding:20px;border:1px solid var(--color-border-strong,#ccc);border-radius:16px;background:var(--color-bg,#fff);color:var(--color-strong,#111);font:inherit';
  const h = document.createElement('h2');
  h.textContent = 'Connect a phone wallet';
  h.style.cssText = 'margin:0 0 4px;font-size:1.05rem';
  const p = document.createElement('p');
  p.textContent = 'Pick your wallet app. It opens, you approve the connection there, and you come back here. Aretia never sees your keys.';
  p.style.cssText = 'margin:0 0 14px;font-size:.85rem;color:var(--color-muted,#555)';
  const list = document.createElement('div');
  list.style.cssText = 'display:grid;gap:8px';
  const button = 'min-height:44px;padding:0 16px;border-radius:999px;border:1px solid var(--color-border-strong,#ccc);background:var(--color-bg-alt,#f6f6f7);color:inherit;font:inherit;font-weight:600;text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center;cursor:pointer';
  for (const w of WC_WALLET_LINKS) {
    const a = document.createElement('a');
    a.href = w.href(uri);
    a.textContent = w.name;
    a.style.cssText = button;
    list.append(a);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy the link (other wallets)';
  copy.style.cssText = button;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(uri);
      copy.textContent = 'Copied. Paste it in your wallet’s WalletConnect screen.';
    } catch {
      copy.textContent = 'Could not copy on this device';
    }
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = button + ';background:transparent';
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    dlg.close();
    dlg.remove();
  };
  cancelBtn.addEventListener('click', () => {
    close();
    cancel();
  });
  dlg.addEventListener('cancel', () => {
    closed = true;
    cancel();
  });
  list.append(copy, cancelBtn);
  dlg.append(h, p, list);
  document.body.append(dlg);
  dlg.showModal();
  return { close };
}

interface RegisterApi {
  register(...wallets: unknown[]): () => void;
}

/** Wallet Standard registration: tell any listener now, and answer apps that announce themselves later. */
function registerWallet(wallet: WcSolanaWallet): void {
  const callback = (api: RegisterApi): void => {
    api.register(wallet);
  };
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback, bubbles: false, cancelable: false }));
  } catch {
    // an older browser without CustomEvent options: the app-ready listener below still covers it
  }
  try {
    window.addEventListener('wallet-standard:app-ready', (event) => callback((event as CustomEvent<RegisterApi>).detail));
  } catch {
    // nothing more to do
  }
}

let started = false;

/** Adds the WalletConnect wallet to the page, inside the Aretia app only. Safe to call more than once. */
export function initWalletConnectSolana(): void {
  if (started || !isNativeApp() || !isProjectId(PROJECT_ID)) return;
  started = true;
  registerWallet(createWcSolanaWallet({ provider: loadProvider, showPairing }, ICON));
}
