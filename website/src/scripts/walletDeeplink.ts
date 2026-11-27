/**
 * Inside the Aretia app only: Phantom and Solflare as wallets the Connect picker (public/assets/wallet/wallet.js) lists like any
 * other. Connecting or signing opens the wallet app with an encrypted request (walletDeeplinkCore.ts); the person approves there and
 * the wallet opens the Aretia app again on its own link (aretia://wallet/...), which the Capacitor App plugin hands to this page.
 * The session (this phone's key pair, the wallet's public key and its session token) is kept on this phone so the wallet stays
 * connected the next time the app opens. No private key of the wallet ever reaches Aretia.
 */
import { isNativeApp } from '../lib/nativeApp';
import { base58Decode, base58Encode, WS_CHAIN, type StandardAccount } from './solanaWcCore';
import { ANSWER_KEY_PARAM, connectUrl, decryptPayload, newDappKeys, parseReturn, sharedKey, signUrl, type DappKeys, type DeeplinkWallet, type ReturnAnswer } from './walletDeeplinkCore';

interface Saved {
  pub: string;
  secret: string;
  walletPub: string;
  session: string;
  address: string;
}

const NAMES: Readonly<Record<DeeplinkWallet, string>> = { phantom: 'Phantom', solflare: 'Solflare' };
const ICONS: Readonly<Record<DeeplinkWallet, string>> = {
  phantom: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#ab9ff2"/><path d="M9 21c0-6.6 4.8-12 10.6-12C24 9 26 12 26 15.4 26 20 23 25 20 25c-1 0-1.4-.5-1.4-1.3 0-.2 0-.4.1-.7-1 1.7-2.9 3.2-4.7 3.2-1.3 0-2-.8-2-2 0-.4.1-.8.2-1.2C11 24.7 9 25.2 9 21z" fill="#fff"/></svg>'),
  solflare: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#ffef46"/><path d="M16 6l8 5-8 15-8-15z" fill="#02050a"/></svg>'),
};
const ACCOUNT_FEATURES = ['solana:signTransaction', 'solana:signMessage'];
const storeKey = (w: DeeplinkWallet): string => `aretia-deeplink-${w}`;

function load(w: DeeplinkWallet): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(w)) ?? 'null') as Saved | null;
    return v && typeof v.address === 'string' && typeof v.session === 'string' ? v : null;
  } catch {
    return null;
  }
}
function save(w: DeeplinkWallet, v: Saved | null): void {
  try {
    if (v) localStorage.setItem(storeKey(w), JSON.stringify(v));
    else localStorage.removeItem(storeKey(w));
  } catch {
    // storage unavailable: the wallet asks again next time
  }
}
const keysOf = (v: { pub: string; secret: string }): DappKeys => ({ publicKey: base58Decode(v.pub), secretKey: base58Decode(v.secret) });

/** Answers waiting for their return link, by wallet and step. */
const waiting = new Map<string, { resolve(a: ReturnAnswer): void; reject(e: Error): void }>();
/** The key pair of a connect request on its way, until the wallet answers. Kept on the phone too, as Android may close the app
 *  while the person is in the wallet; the answer then arrives when the app starts again. */
const pendingKey = (w: DeeplinkWallet): string => `aretia-deeplink-pending-${w}`;
function setPending(w: DeeplinkWallet, keys: DappKeys | null): void {
  try {
    if (keys) localStorage.setItem(pendingKey(w), JSON.stringify({ pub: base58Encode(keys.publicKey), secret: base58Encode(keys.secretKey) }));
    else localStorage.removeItem(pendingKey(w));
  } catch {
    // storage unavailable
  }
}
function getPending(w: DeeplinkWallet): DappKeys | null {
  try {
    const v = JSON.parse(localStorage.getItem(pendingKey(w)) ?? 'null') as { pub: string; secret: string } | null;
    return v ? keysOf(v) : null;
  } catch {
    return null;
  }
}

function open(url: string): void {
  // Inside the app, an address outside aretiafinance.org is handed to the phone, which opens the wallet app.
  window.location.href = url;
}

function ask(wallet: DeeplinkWallet, step: string, url: string): Promise<ReturnAnswer> {
  return new Promise((resolve, reject) => {
    waiting.get(`${wallet}:${step}`)?.reject(new Error('A newer request replaced this one.'));
    waiting.set(`${wallet}:${step}`, { resolve, reject });
    open(url);
  });
}

function createWallet(wallet: DeeplinkWallet) {
  const listeners = new Set<(p: { accounts?: readonly StandardAccount[] }) => void>();
  const accountOf = (address: string): StandardAccount => ({ address, publicKey: base58Decode(address), chains: [WS_CHAIN], features: ACCOUNT_FEATURES });
  let account: StandardAccount | null = (() => {
    const s = load(wallet);
    return s ? accountOf(s.address) : null;
  })();
  const emit = (): void => {
    for (const l of [...listeners]) l({ accounts: account ? [account] : [] });
  };

  async function connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }> {
    if (account) return { accounts: [account] };
    if (input?.silent) return { accounts: [] };
    const keys = newDappKeys();
    setPending(wallet, keys);
    const answer = await ask(wallet, 'connect', connectUrl(wallet, keys, 'https://aretiafinance.org'));
    const s = load(wallet);
    if (!s) throw new Error(answer.error ?? 'The wallet did not connect.');
    account = accountOf(s.address);
    emit();
    return { accounts: [account] };
  }

  async function sign(method: 'signTransaction' | 'signMessage', body: Record<string, string>): Promise<Record<string, string>> {
    const s = load(wallet);
    if (!s || !account) throw new Error('That wallet is not connected.');
    const keys = keysOf(s);
    const shared = sharedKey(base58Decode(s.walletPub), keys);
    const answer = await ask(wallet, method, signUrl(wallet, keys, shared, method, { ...body, session: s.session }));
    if (answer.error) throw new Error(answer.error);
    const data = answer.params.get('data');
    const nonce = answer.params.get('nonce');
    if (!data || !nonce) throw new Error('The wallet sent no answer.');
    return decryptPayload<Record<string, string>>(data, nonce, shared);
  }

  return {
    version: '1.0.0' as const,
    name: NAMES[wallet],
    icon: ICONS[wallet],
    chains: [WS_CHAIN],
    get accounts(): readonly StandardAccount[] {
      return account ? [account] : [];
    },
    features: {
      'standard:connect': { version: '1.0.0' as const, connect },
      'standard:disconnect': {
        version: '1.0.0' as const,
        async disconnect(): Promise<void> {
          account = null;
          save(wallet, null);
          emit();
        },
      },
      'standard:events': {
        version: '1.0.0' as const,
        on(event: 'change', listener: (p: { accounts?: readonly StandardAccount[] }) => void): () => void {
          if (event !== 'change') return () => undefined;
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      'solana:signTransaction': {
        version: '1.0.0' as const,
        supportedTransactionVersions: ['legacy', 0] as const,
        async signTransaction(...inputs: { account: { address: string }; transaction: Uint8Array }[]): Promise<{ signedTransaction: Uint8Array }[]> {
          const out: { signedTransaction: Uint8Array }[] = [];
          for (const input of inputs) {
            if (input.account.address !== account?.address) throw new Error('That account is not connected.');
            const reply = await sign('signTransaction', { transaction: base58Encode(input.transaction) });
            if (!reply.transaction) throw new Error('The wallet did not return the signed transaction.');
            out.push({ signedTransaction: base58Decode(reply.transaction) });
          }
          return out;
        },
      },
      'solana:signMessage': {
        version: '1.0.0' as const,
        async signMessage(...inputs: { account: { address: string }; message: Uint8Array }[]): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]> {
          const out: { signedMessage: Uint8Array; signature: Uint8Array }[] = [];
          for (const input of inputs) {
            if (input.account.address !== account?.address) throw new Error('That account is not connected.');
            const reply = await sign('signMessage', { message: base58Encode(input.message), display: 'utf8' });
            if (!reply.signature) throw new Error('The wallet did not return a signature.');
            out.push({ signedMessage: input.message, signature: base58Decode(reply.signature) });
          }
          return out;
        },
      },
    },
  };
}

/** A return link from a wallet: a connect answer is stored here (so it also works when the app was restarted meanwhile); every answer goes to whoever waits for it. */
export function handleReturn(url: string): void {
  const answer = parseReturn(url);
  if (!answer) return;
  if (answer.step === 'connect' && !answer.error) {
    const keys = getPending(answer.wallet);
    const walletPub = answer.params.get(ANSWER_KEY_PARAM[answer.wallet]);
    const data = answer.params.get('data');
    const nonce = answer.params.get('nonce');
    if (keys && walletPub && data && nonce) {
      try {
        const got = decryptPayload<{ public_key?: string; session?: string }>(data, nonce, sharedKey(base58Decode(walletPub), keys));
        if (got.public_key && got.session) save(answer.wallet, { pub: base58Encode(keys.publicKey), secret: base58Encode(keys.secretKey), walletPub, session: got.session, address: got.public_key });
      } catch {
        // unreadable: the connect fails below with the wallet's own words, or "did not connect"
      }
      setPending(answer.wallet, null);
    }
  }
  const w = waiting.get(`${answer.wallet}:${answer.step}`);
  waiting.delete(`${answer.wallet}:${answer.step}`);
  w?.resolve(answer);
}

interface AppPlugin {
  addListener(event: 'appUrlOpen', cb: (e: { url: string }) => void): unknown;
  getLaunchUrl?(): Promise<{ url?: string } | undefined>;
}

let started = false;

/** Adds Phantom and Solflare to the Connect picker, inside the Aretia app only. Safe to call more than once. */
export function initWalletDeeplinks(): void {
  if (started || !isNativeApp()) return;
  started = true;
  const app = (window as unknown as { Capacitor?: { Plugins?: { App?: AppPlugin } } }).Capacitor?.Plugins?.App;
  // Without the App plugin the wallet's answer could not reach this page, so the wallets are not offered.
  if (!app) return;
  app.addListener('appUrlOpen', (e) => handleReturn(e.url));
  // The app was started by the wallet's answer (it had been closed meanwhile): a connect is completed from the saved request.
  void app.getLaunchUrl?.().then((r) => {
    if (r?.url) handleReturn(r.url);
  }).catch(() => undefined);
  for (const w of ['phantom', 'solflare'] as const) {
    const wallet = createWallet(w);
    const callback = (api: { register(...wallets: unknown[]): () => void }): void => {
      api.register(wallet);
    };
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));
    window.addEventListener('wallet-standard:app-ready', (event) => callback((event as CustomEvent<{ register(...wallets: unknown[]): () => void }>).detail));
  }
}
