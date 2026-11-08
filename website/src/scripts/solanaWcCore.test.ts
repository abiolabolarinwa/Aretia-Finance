import { describe, expect, it } from 'vitest';
import {
  addressFromWcAccount,
  applySignature,
  base58Decode,
  base58Encode,
  createWcSolanaWallet,
  fromBase64,
  signatureSlot,
  signedFromReply,
  toBase64,
  WC_WALLET_LINKS,
  type WcSolanaProvider,
} from './solanaWcCore';

const enc = (s: string) => new TextEncoder().encode(s);
const key = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (n * 7 + i + 1) & 0xff);
const A = key(1);
const B = key(2);
const addrA = base58Encode(A);

/** A legacy transaction with two signers (A then B) and one empty signature slot each. */
function twoSignerTx(versioned = false): Uint8Array {
  const sigs = new Uint8Array(1 + 2 * 64);
  sigs[0] = 2;
  const message = [...(versioned ? [0x80] : []), 2, 0, 1, 2, ...A, ...B, ...new Uint8Array(32).fill(9), 0];
  return Uint8Array.from([...sigs, ...message]);
}

describe('base58', () => {
  it('round-trips and matches a known value', () => {
    expect(base58Encode(enc('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(new TextDecoder().decode(base58Decode('2NEpo7TZRRrLZSi2U'))).toBe('Hello World!');
    const bytes = Uint8Array.from([0, 0, 1, 2, 3, 250, 251]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(base58Decode(addrA)).toEqual(A);
  });
  it('refuses characters outside the alphabet', () => {
    expect(() => base58Decode('0OIl')).toThrow();
  });
});

describe('signing slots', () => {
  it('finds the slot of each required signer, legacy and versioned', () => {
    for (const v of [false, true]) {
      const tx = twoSignerTx(v);
      expect(signatureSlot(tx, A)).toEqual({ index: 0, offset: 1 });
      expect(signatureSlot(tx, B)).toEqual({ index: 1, offset: 65 });
    }
  });
  it('refuses an account that is not a signer, and a cut-short transaction', () => {
    expect(() => signatureSlot(twoSignerTx(), key(3))).toThrow('not a signer');
    expect(() => signatureSlot(twoSignerTx().subarray(0, 100), B)).toThrow();
  });
  it('places a signature in the right slot and leaves the rest alone', () => {
    const tx = twoSignerTx();
    const sig = new Uint8Array(64).fill(7);
    const out = applySignature(tx, B, sig);
    expect(out.subarray(65, 129)).toEqual(sig);
    expect(out.subarray(1, 65)).toEqual(new Uint8Array(64));
    expect(out.subarray(129)).toEqual(tx.subarray(129));
    expect(tx.subarray(65, 129)).toEqual(new Uint8Array(64)); // the input is not changed
    expect(() => applySignature(tx, B, new Uint8Array(10))).toThrow('wrong size');
  });
});

describe('the wallet’s answer to a signing request', () => {
  it('uses the signature when the wallet sends only that', () => {
    const tx = twoSignerTx();
    const sig = new Uint8Array(64).fill(5);
    expect(signedFromReply(tx, A, { signature: base58Encode(sig) }).subarray(1, 65)).toEqual(sig);
  });
  it('accepts a full signed transaction only if the message is the same', () => {
    const tx = twoSignerTx();
    const signed = applySignature(tx, A, new Uint8Array(64).fill(3));
    expect(signedFromReply(tx, A, { transaction: toBase64(signed) })).toEqual(signed);
    const changed = Uint8Array.from(signed);
    changed[changed.length - 5] ^= 1;
    expect(() => signedFromReply(tx, A, { transaction: toBase64(changed) })).toThrow('changed the transaction');
    expect(() => signedFromReply(tx, A, {})).toThrow('did not return');
  });
  it('round-trips base64', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe('wc accounts and links', () => {
  it('reads the address from a WalletConnect account string', () => {
    expect(addressFromWcAccount(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${addrA}`)).toBe(addrA);
    expect(addressFromWcAccount('eip155:1:0xabc')).toBeNull();
    expect(addressFromWcAccount('solana:x:not-base58!')).toBeNull();
  });
  it('builds an encoded deep link per wallet', () => {
    expect(WC_WALLET_LINKS.find((w) => w.id === 'phantom')!.href('wc:abc@2?x=1&y=2')).toBe('phantom://wc?uri=wc%3Aabc%402%3Fx%3D1%26y%3D2');
  });
});

function fakeProvider(opts: { signReply?: unknown; session?: boolean } = {}) {
  const handlers = new Map<string, (...a: never[]) => void>();
  const calls: { method: string; params: unknown }[] = [];
  const p = {
    session: opts.session ? { namespaces: { solana: { accounts: [`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${addrA}`] } } } : undefined,
    on(event: string, cb: (...a: never[]) => void) {
      handlers.set(event, cb);
    },
    async connect() {
      (handlers.get('display_uri') as (u: string) => void)('wc:pair@2');
      p.session = { namespaces: { solana: { accounts: [`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${addrA}`] } } };
    },
    async disconnect() {
      p.session = undefined;
    },
    async request(args: { method: string; params: unknown }) {
      calls.push(args);
      return opts.signReply;
    },
  };
  return { p: p as unknown as WcSolanaProvider & { session: unknown }, calls, handlers };
}

describe('the Wallet Standard wallet', () => {
  const shown: string[] = [];
  const mk = (f: ReturnType<typeof fakeProvider>) => createWcSolanaWallet({ provider: async () => f.p, showPairing: (uri) => (shown.push(uri), { close: () => shown.push('closed') }) }, 'data:image/svg+xml,x');

  it('connects through the pairing dialog and exposes the account Aretia’s wallet.js expects', async () => {
    const w = mk(fakeProvider());
    const { accounts } = await w.features['standard:connect'].connect();
    expect(shown).toContain('wc:pair@2');
    expect(shown.at(-1)).toBe('closed');
    expect(accounts[0]!.address).toBe(addrA);
    expect(accounts[0]!.chains).toContain('solana:mainnet');
    expect(accounts[0]!.publicKey).toEqual(A);
    expect(w.chains).toEqual(['solana:mainnet']);
  });
  it('restores a saved session silently, and returns nothing when there is none', async () => {
    expect((await mk(fakeProvider({ session: true })).features['standard:connect'].connect({ silent: true })).accounts).toHaveLength(1);
    expect((await mk(fakeProvider()).features['standard:connect'].connect({ silent: true })).accounts).toHaveLength(0);
  });
  it('signs a transaction and a message through the wallet', async () => {
    const tx = twoSignerTx();
    const sig = new Uint8Array(64).fill(4);
    const f = fakeProvider({ session: true, signReply: { signature: base58Encode(sig) } });
    const w = mk(f);
    const { accounts } = await w.features['standard:connect'].connect();
    const [out] = await w.features['solana:signTransaction'].signTransaction({ account: accounts[0]!, transaction: tx });
    expect(out!.signedTransaction.subarray(1, 65)).toEqual(sig);
    expect(f.calls[0]).toEqual({ method: 'solana_signTransaction', params: { transaction: toBase64(tx) } });
    const [m] = await w.features['solana:signMessage'].signMessage({ account: accounts[0]!, message: enc('hi') });
    expect(m!.signature).toEqual(sig);
    expect(f.calls[1]).toEqual({ method: 'solana_signMessage', params: { message: base58Encode(enc('hi')), pubkey: addrA } });
  });
  it('refuses to sign for an account that is not connected', async () => {
    const f = fakeProvider({ session: true, signReply: {} });
    const w = mk(f);
    await expect(w.features['solana:signMessage'].signMessage({ account: { address: addrA }, message: enc('x') })).rejects.toThrow('not connected');
  });
  it('tells listeners when the session ends', async () => {
    const f = fakeProvider();
    const w = mk(f);
    const seen: number[] = [];
    w.features['standard:events'].on('change', (p) => seen.push(p.accounts?.length ?? -1));
    await w.features['standard:connect'].connect();
    (f.handlers.get('session_delete') as () => void)();
    expect(seen).toEqual([1, 0]);
    expect(w.accounts).toHaveLength(0);
  });
});
