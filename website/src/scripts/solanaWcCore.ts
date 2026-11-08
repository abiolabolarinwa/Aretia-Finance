/**
 * WalletConnect for Solana, as a Wallet Standard wallet. Phone wallets (Phantom, Solflare, Backpack, Trust and others) cannot be
 * injected into the page of the Aretia app, so the app asks them through WalletConnect instead: Aretia shows the wallets, the
 * user approves in their own wallet app, and the signed result comes back. Aretia never sees a key.
 *
 * Everything here is pure or takes its collaborators as arguments, so it is tested without a phone or a network. The page
 * wiring (loading the library, the chooser dialog, registering with public/assets/wallet/wallet.js) is in solanaWc.ts.
 */

export const SOLANA_MAINNET_WC_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const WS_CHAIN = 'solana:mainnet';
export const WC_METHODS = ['solana_signTransaction', 'solana_signMessage'] as const;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const v = ALPHABET.indexOf(text[i]!);
    if (v < 0) throw new Error('Not a base58 string.');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Reads a Solana "short vector" length (1 to 3 bytes) at `offset`. */
function readShortVec(bytes: Uint8Array, offset: number): { value: number; size: number } {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const b = bytes[offset + i];
    if (b === undefined) throw new Error('The transaction is cut short.');
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, size: i + 1 };
  }
  throw new Error('The transaction has a bad length field.');
}

/**
 * Where in a serialised transaction the signature of `account` (32 bytes) goes: the position among the required signers, and the byte
 * offset of that signature slot. Throws if the account is not one of the required signers.
 */
export function signatureSlot(tx: Uint8Array, account: Uint8Array): { index: number; offset: number } {
  const sigs = readShortVec(tx, 0);
  const messageStart = sigs.size + sigs.value * 64;
  let p = messageStart;
  if (((tx[p] ?? 0) & 0x80) !== 0) p += 1; // a versioned message starts with 0x80 | version
  const required = tx[p];
  if (required === undefined) throw new Error('The transaction is cut short.');
  p += 3; // the three header counts
  const keys = readShortVec(tx, p);
  p += keys.size;
  for (let i = 0; i < Math.min(required, keys.value); i++) {
    const at = p + i * 32;
    if (at + 32 > tx.length) throw new Error('The transaction is cut short.');
    let same = account.length === 32;
    for (let j = 0; same && j < 32; j++) if (tx[at + j] !== account[j]) same = false;
    if (same) {
      if (i >= sigs.value) throw new Error('The transaction has no signature slot for this wallet.');
      return { index: i, offset: sigs.size + i * 64 };
    }
  }
  throw new Error('This wallet is not a signer of the transaction.');
}

/** The transaction with `signature` placed in the slot that belongs to `account`. Other signatures are left as they were. */
export function applySignature(tx: Uint8Array, account: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error('The wallet returned a signature of the wrong size.');
  const { offset } = signatureSlot(tx, account);
  const out = new Uint8Array(tx);
  out.set(signature, offset);
  return out;
}

/** What the wallet's answer to solana_signTransaction can look like, depending on the wallet. */
export interface SignTransactionReply {
  signature?: string;
  transaction?: string;
}

/** The signed transaction bytes, from a wallet's answer: a full signed transaction if it sent one, otherwise the signature placed into ours. */
export function signedFromReply(original: Uint8Array, account: Uint8Array, reply: SignTransactionReply): Uint8Array {
  if (typeof reply.transaction === 'string' && reply.transaction.length > 0) {
    const full = fromBase64(reply.transaction);
    // The answer must be the same transaction: only its signatures may differ.
    const a = readShortVec(original, 0);
    const b = readShortVec(full, 0);
    const msgA = original.subarray(a.size + a.value * 64);
    const msgB = full.subarray(b.size + b.value * 64);
    if (msgA.length !== msgB.length || msgA.some((v, i) => v !== msgB[i])) throw new Error('The wallet changed the transaction, so it was not used.');
    return full;
  }
  if (typeof reply.signature === 'string' && reply.signature.length > 0) return applySignature(original, account, base58Decode(reply.signature));
  throw new Error('The wallet did not return a signature.');
}

export interface WcNamespaces {
  solana: { methods: string[]; chains: string[]; events: string[] };
}

export const solanaNamespaces = (): WcNamespaces => ({ solana: { methods: [...WC_METHODS], chains: [SOLANA_MAINNET_WC_CHAIN], events: [] } });

/** The account address inside a WalletConnect account string "solana:<chain>:<address>". */
export function addressFromWcAccount(account: string): string | null {
  const parts = account.split(':');
  const addr = parts[2];
  return parts[0] === 'solana' && parts.length === 3 && addr && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) ? addr : null;
}

/** Deep links that open a phone wallet with a WalletConnect pairing address. Wallets that are not listed can use the plain wc: link. */
export interface WcWalletLink {
  id: string;
  name: string;
  /** The link to open, given the pairing address. */
  href(uri: string): string;
}

export const WC_WALLET_LINKS: readonly WcWalletLink[] = [
  { id: 'phantom', name: 'Phantom', href: (u) => `phantom://wc?uri=${encodeURIComponent(u)}` },
  { id: 'solflare', name: 'Solflare', href: (u) => `solflare://wc?uri=${encodeURIComponent(u)}` },
  { id: 'backpack', name: 'Backpack', href: (u) => `backpack://wc?uri=${encodeURIComponent(u)}` },
  { id: 'trust', name: 'Trust Wallet', href: (u) => `trust://wc?uri=${encodeURIComponent(u)}` },
];

/** The slice of WalletConnect's universal provider that Aretia uses. */
export interface WcSolanaProvider {
  session?: { namespaces?: Record<string, { accounts?: string[] }> } | undefined;
  on(event: 'display_uri', cb: (uri: string) => void): void;
  on(event: 'session_delete' | 'session_expire', cb: () => void): void;
  removeListener?(event: string, cb: (...a: never[]) => void): void;
  connect(args: { namespaces: WcNamespaces }): Promise<unknown>;
  disconnect(): Promise<void>;
  request<T>(args: { method: string; params: unknown }, chain?: string): Promise<T>;
}

export interface WcWalletDeps {
  /** Loads (and, on first use, creates) the WalletConnect provider. */
  provider(): Promise<WcSolanaProvider>;
  /** Shows the pairing address to the user (wallet buttons, a copy link); resolves nothing: `close` is called when pairing ends. */
  showPairing(uri: string, cancel: () => void): { close(): void };
}

export interface StandardAccount {
  address: string;
  publicKey: Uint8Array;
  chains: string[];
  features: string[];
}

const ACCOUNT_FEATURES = ['solana:signTransaction', 'solana:signMessage'];

function sessionAddress(p: WcSolanaProvider): string | null {
  const list = p.session?.namespaces?.solana?.accounts ?? [];
  for (const a of list) {
    const addr = addressFromWcAccount(a);
    if (addr) return addr;
  }
  return null;
}

/** A Wallet Standard wallet backed by WalletConnect. The page's wallet.js finds it like any other wallet. */
export function createWcSolanaWallet(deps: WcWalletDeps, icon: string) {
  let account: StandardAccount | null = null;
  const listeners = new Set<(p: { accounts?: readonly StandardAccount[] }) => void>();
  const emit = (): void => {
    for (const l of [...listeners]) l({ accounts: account ? [account] : [] });
  };
  const toAccount = (address: string): StandardAccount => ({ address, publicKey: base58Decode(address), chains: [WS_CHAIN], features: ACCOUNT_FEATURES });

  async function watch(p: WcSolanaProvider): Promise<void> {
    const gone = (): void => {
      account = null;
      emit();
    };
    p.on('session_delete', gone);
    p.on('session_expire', gone);
  }

  async function connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }> {
    const p = await deps.provider();
    const existing = sessionAddress(p);
    if (existing) {
      account = toAccount(existing);
      return { accounts: [account] };
    }
    if (input?.silent) return { accounts: [] };
    const pairing: { current: { close(): void } | null } = { current: null };
    let rejectCancel: (e: Error) => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancel = reject;
    });
    p.on('display_uri', (uri) => {
      pairing.current?.close();
      pairing.current = deps.showPairing(uri, () => rejectCancel(new Error('Connection cancelled.')));
    });
    try {
      await Promise.race([p.connect({ namespaces: solanaNamespaces() }), cancelled]);
    } finally {
      pairing.current?.close();
    }
    const addr = sessionAddress(p);
    if (!addr) throw new Error('The wallet did not share a Solana account.');
    account = toAccount(addr);
    void watch(p);
    emit();
    return { accounts: [account] };
  }

  async function disconnect(): Promise<void> {
    account = null;
    try {
      const p = await deps.provider();
      if (p.session) await p.disconnect();
    } finally {
      emit();
    }
  }

  async function signTransaction(...inputs: { account: { address: string }; transaction: Uint8Array }[]): Promise<{ signedTransaction: Uint8Array }[]> {
    const p = await deps.provider();
    const out: { signedTransaction: Uint8Array }[] = [];
    for (const input of inputs) {
      if (!account || input.account.address !== account.address) throw new Error('That account is not connected.');
      const reply = await p.request<SignTransactionReply>({ method: 'solana_signTransaction', params: { transaction: toBase64(input.transaction) } }, SOLANA_MAINNET_WC_CHAIN);
      out.push({ signedTransaction: signedFromReply(input.transaction, account.publicKey, reply) });
    }
    return out;
  }

  async function signMessage(...inputs: { account: { address: string }; message: Uint8Array }[]): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]> {
    const p = await deps.provider();
    const out: { signedMessage: Uint8Array; signature: Uint8Array }[] = [];
    for (const input of inputs) {
      if (!account || input.account.address !== account.address) throw new Error('That account is not connected.');
      const reply = await p.request<{ signature?: string }>({ method: 'solana_signMessage', params: { message: base58Encode(input.message), pubkey: account.address } }, SOLANA_MAINNET_WC_CHAIN);
      if (!reply?.signature) throw new Error('The wallet did not return a signature.');
      out.push({ signedMessage: input.message, signature: base58Decode(reply.signature) });
    }
    return out;
  }

  return {
    version: '1.0.0' as const,
    name: 'WalletConnect (phone wallets)',
    icon,
    chains: [WS_CHAIN],
    get accounts(): readonly StandardAccount[] {
      return account ? [account] : [];
    },
    features: {
      'standard:connect': { version: '1.0.0' as const, connect },
      'standard:disconnect': { version: '1.0.0' as const, disconnect },
      'standard:events': {
        version: '1.0.0' as const,
        on(event: 'change', listener: (p: { accounts?: readonly StandardAccount[] }) => void): () => void {
          if (event !== 'change') return () => undefined;
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      'solana:signTransaction': { version: '1.0.0' as const, supportedTransactionVersions: ['legacy', 0] as const, signTransaction },
      'solana:signMessage': { version: '1.0.0' as const, signMessage },
    },
  };
}

export type WcSolanaWallet = ReturnType<typeof createWcSolanaWallet>;
