import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode } from './solanaWcCore';
import { connectUrl, decryptPayload, encryptPayload, newDappKeys, parseReturn, sharedKey, signUrl } from './walletDeeplinkCore';

describe('Phantom and Solflare app links', () => {
  it('asks to connect with this phone’s public key and the Aretia app’s return link', () => {
    const keys = newDappKeys();
    const u = new URL(connectUrl('phantom', keys, 'https://aretiafinance.org'));
    expect(u.origin + u.pathname).toBe('https://phantom.app/ul/v1/connect');
    expect(base58Decode(u.searchParams.get('dapp_encryption_public_key')!)).toEqual(keys.publicKey);
    expect(u.searchParams.get('redirect_link')).toBe('aretia://wallet/phantom/connect');
    expect(u.searchParams.get('cluster')).toBe('mainnet-beta');
    expect(new URL(connectUrl('solflare', keys, 'https://aretiafinance.org')).origin).toBe('https://solflare.com');
  });

  it('reads what the wallet sends back, encrypted for this phone only', () => {
    const app = newDappKeys();
    const wallet = nacl.box.keyPair();
    // The wallet encrypts with its secret key and the app's public key...
    const fromWallet = encryptPayload({ public_key: 'Addr', session: 's1' }, nacl.box.before(app.publicKey, wallet.secretKey));
    // ...and the app opens it with the wallet's public key and its own secret key.
    expect(decryptPayload(fromWallet.payload, fromWallet.nonce, sharedKey(wallet.publicKey, app))).toEqual({ public_key: 'Addr', session: 's1' });
    // A stranger's key cannot open it.
    expect(() => decryptPayload(fromWallet.payload, fromWallet.nonce, sharedKey(nacl.box.keyPair().publicKey, app))).toThrow();
  });

  it('sends a signing request the wallet can open', () => {
    const app = newDappKeys();
    const wallet = nacl.box.keyPair();
    const u = new URL(signUrl('phantom', app, sharedKey(wallet.publicKey, app), 'signTransaction', { transaction: base58Encode(new Uint8Array([1, 2, 3])), session: 's1' }));
    expect(u.pathname).toBe('/ul/v1/signTransaction');
    expect(u.searchParams.get('redirect_link')).toBe('aretia://wallet/phantom/signTransaction');
    const seen = decryptPayload<{ transaction: string; session: string }>(u.searchParams.get('payload')!, u.searchParams.get('nonce')!, nacl.box.before(app.publicKey, wallet.secretKey));
    expect(seen.session).toBe('s1');
    expect(base58Decode(seen.transaction)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('understands the return link, and a refusal', () => {
    const ok = parseReturn('aretia://wallet/solflare/connect?nonce=n&data=d&solflare_encryption_public_key=k')!;
    expect(ok.wallet).toBe('solflare');
    expect(ok.step).toBe('connect');
    expect(ok.params.get('data')).toBe('d');
    expect(ok.error).toBeNull();
    expect(parseReturn('aretia://wallet/phantom/signTransaction?errorCode=4001&errorMessage=User%20rejected')!.error).toBe('User rejected');
    expect(parseReturn('https://aretiafinance.org/wallet')).toBeNull();
    expect(parseReturn('aretia://wallet/metamask/connect')).toBeNull();
  });
});
