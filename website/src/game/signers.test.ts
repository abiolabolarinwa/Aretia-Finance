import { describe, expect, it } from 'vitest';
import { signerOptions, type SignerEnv } from './signers.js';

const PROJECT = 'a'.repeat(32);

function env(over: Partial<SignerEnv> = {}): SignerEnv & { signed: string[] } {
  const signed: string[] = [];
  return {
    signed,
    evmWallets: async () => [{ id: 'u-meta', name: 'MetaMask' }, { id: 'u-rabby', name: 'Rabby' }],
    connectEvm: async (id) => ({ account: `0x${id.length}`, sign: async (hex) => (signed.push(hex), `0xsig-${id}`) }),
    walletConnectProjectId: PROJECT,
    connectWalletConnect: async () => ({ account: '0xwc', sign: async (hex) => (signed.push(hex), '0xwcsig') }),
    sidebarSolana: () => ({ address: 'So1anaAddressExample1111111111111111111111', signMessage: async () => new Uint8Array([1, 2, 3]) }),
    injectedSolana: () => null,
    ...over,
  };
}

describe('the wallets a player can sign in with', () => {
  it('lists every announced Ethereum-style wallet, WalletConnect, and the Solana wallet connected in the sidebar', async () => {
    const o = await signerOptions(env());
    expect(o.map((x) => x.label)).toEqual(['MetaMask (Ethereum-style)', 'Rabby (Ethereum-style)', 'WalletConnect (phone, hardware or any wallet app)', 'Solana wallet connected here (So1a…1111)']);
    expect(o.map((x) => x.family)).toEqual(['evm', 'evm', 'evm', 'solana']);
  });

  it('signs a message as hex for an Ethereum-style wallet, with the account the wallet shared', async () => {
    const e = env();
    const [meta] = await signerOptions(e);
    const signer = await meta!.make();
    expect(signer.family).toBe('evm');
    expect(signer.address).toBe('0x6');
    expect(await signer.sign('Hi')).toBe('0xsig-u-meta');
    expect(e.signed).toEqual(['0x4869']);
  });

  it('signs through WalletConnect the same way', async () => {
    const e = env({ evmWallets: async () => [] });
    const options = await signerOptions(e);
    expect(options[0]!.id).toBe('evm:walletconnect');
    const signer = await options[0]!.make();
    expect(signer.address).toBe('0xwc');
    expect(await signer.sign('Hi')).toBe('0xwcsig');
  });

  it('offers WalletConnect only when the site has a project id', async () => {
    for (const bad of ['', 'nope', 'A'.repeat(32), 'a'.repeat(31)]) {
      expect((await signerOptions(env({ walletConnectProjectId: bad }))).some((o) => o.id === 'evm:walletconnect'), bad).toBe(false);
    }
  });

  it('signs a Solana message as base64 with the sidebar wallet, and uses Phantom only when nothing is connected in the sidebar', async () => {
    const [, , , side] = await signerOptions(env());
    const signer = await side!.make();
    expect(signer).toMatchObject({ family: 'solana', address: 'So1anaAddressExample1111111111111111111111' });
    expect(await signer.sign('Hi')).toBe('AQID');
    const phantom = { connect: async () => 'PhantomAddr', signMessage: async () => new Uint8Array([255, 254]) };
    const both = await signerOptions(env({ injectedSolana: () => phantom }));
    expect(both.some((o) => o.id === 'solana:injected')).toBe(false);
    const only = await signerOptions(env({ sidebarSolana: () => null, injectedSolana: () => phantom, evmWallets: async () => [], walletConnectProjectId: '' }));
    expect(only.map((o) => o.id)).toEqual(['solana:injected']);
    const p = await only[0]!.make();
    expect(p.address).toBe('PhantomAddr');
    expect(await p.sign('x')).toBe('//4=');
  });

  it('gives an empty list, not an error, when the browser has no wallet at all, and survives a failed search', async () => {
    expect(await signerOptions(env({ evmWallets: async () => [], walletConnectProjectId: '', sidebarSolana: () => null }))).toEqual([]);
    const failing = await signerOptions(env({ evmWallets: async () => { throw new Error('boom'); } }));
    expect(failing.map((o) => o.id)).toEqual(['evm:walletconnect', 'solana:sidebar']);
  });
});
