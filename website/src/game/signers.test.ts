import { describe, expect, it } from 'vitest';
import { signerOptions, type SignerEnv } from './signers.js';

const PROJECT = 'a'.repeat(32);
const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';

function env(over: Partial<SignerEnv> = {}): SignerEnv & { signed: string[]; uris: string[] } {
  const signed: string[] = [];
  const uris: string[] = [];
  return {
    signed,
    uris,
    evmWallets: async () => [{ id: 'u-meta', name: 'MetaMask', icon: ICON, rdns: 'io.metamask' }, { id: 'u-rabby', name: 'Rabby Wallet', icon: ICON, rdns: 'io.rabby' }, { id: 'u-ph', name: 'Phantom', icon: ICON, rdns: 'app.phantom' }],
    connectEvm: async (id) => ({ account: `0x${id.length}`, sign: async (hex) => (signed.push(hex), `0xsig-${id}`) }),
    walletConnectProjectId: PROJECT,
    connectWalletConnect: async (onUri) => (onUri('wc:abc@2?relay-protocol=irn'), uris.push('shown'), { account: '0xwc', sign: async (hex) => (signed.push(hex), '0xwcsig') }),
    sidebarSolana: () => null,
    injectedSolana: () => null,
    ...over,
  };
}

describe('the wallets a player can sign in with', () => {
  it('sorts what the browser has into Phantom, MetaMask and others, with each wallet’s own logo', async () => {
    const side = { address: 'So1anaAddressExample1111111111111111111111', name: 'Phantom', icon: ICON, signMessage: async () => new Uint8Array([1, 2, 3]) };
    const o = await signerOptions(env({ sidebarSolana: () => side }));
    expect(o.map((x) => [x.label, x.kind])).toEqual([['MetaMask', 'metamask'], ['Rabby Wallet', 'other'], ['Phantom', 'phantom'], ['WalletConnect (scan with a phone or hardware wallet)', 'other']]);
    expect(o.find((x) => x.kind === 'metamask')?.icon).toBe(ICON);
    expect(o.find((x) => x.kind === 'phantom')?.icon).toBe(ICON);
  });

  it('lists Phantom once, through its Solana wallet, never again as an Ethereum wallet', async () => {
    const o = await signerOptions(env({ evmWallets: async () => [{ id: 'p', name: 'Phantom', rdns: 'app.phantom' }], walletConnectProjectId: '' }));
    expect(o).toEqual([]);
    const injected = { isPhantom: true, connect: async () => 'PhantomAddr', signMessage: async () => new Uint8Array([255, 254]) };
    const withInjected = await signerOptions(env({ evmWallets: async () => [], walletConnectProjectId: '', injectedSolana: () => injected }));
    expect(withInjected.map((x) => [x.label, x.kind])).toEqual([['Phantom', 'phantom']]);
    const p = await withInjected[0]!.make();
    expect(p.address).toBe('PhantomAddr');
    expect(await p.sign('x')).toBe('//4=');
  });

  it('calls a connected Solana wallet that is not Phantom an other wallet, and prefers the sidebar wallet to a second Phantom prompt', async () => {
    const side = { address: 'SolflareAddr111111111111111111111111111111', name: 'Solflare', signMessage: async () => new Uint8Array([1]) };
    const injected = { isPhantom: true, connect: async () => 'PhantomAddr', signMessage: async () => new Uint8Array([1]) };
    const o = await signerOptions(env({ evmWallets: async () => [], walletConnectProjectId: '', sidebarSolana: () => side, injectedSolana: () => injected }));
    expect(o.map((x) => [x.label, x.kind])).toEqual([['Solflare (connected here)', 'other']]);
  });

  it('signs a message as hex for an Ethereum-style wallet, with the account the wallet shared', async () => {
    const e = env();
    const meta = (await signerOptions(e)).find((x) => x.kind === 'metamask')!;
    const signer = await meta.make();
    expect(signer.family).toBe('evm');
    expect(signer.address).toBe('0x6');
    expect(await signer.sign('Hi')).toBe('0xsig-u-meta');
    expect(e.signed).toEqual(['0x4869']);
  });

  it('shows the WalletConnect code through the page, then signs through the same session', async () => {
    const e = env({ evmWallets: async () => [] });
    const options = await signerOptions(e);
    expect(options[0]!.id).toBe('evm:walletconnect');
    const shown: string[] = [];
    const signer = await options[0]!.make({ onUri: (u) => shown.push(u) });
    expect(shown).toEqual(['wc:abc@2?relay-protocol=irn']);
    expect(signer.address).toBe('0xwc');
    expect(await signer.sign('Hi')).toBe('0xwcsig');
    expect(e.signed).toEqual(['0x4869']);
  });

  it('offers WalletConnect only when the site has a project id', async () => {
    for (const bad of ['', 'nope', 'A'.repeat(32), 'a'.repeat(31)]) {
      expect((await signerOptions(env({ walletConnectProjectId: bad }))).some((o) => o.id === 'evm:walletconnect'), bad).toBe(false);
    }
  });

  it('signs a Solana message as base64 with the sidebar wallet', async () => {
    const side = { address: 'So1anaAddressExample1111111111111111111111', name: 'Phantom', signMessage: async () => new Uint8Array([1, 2, 3]) };
    const phantom = (await signerOptions(env({ sidebarSolana: () => side }))).find((x) => x.kind === 'phantom')!;
    const signer = await phantom.make();
    expect(signer).toMatchObject({ family: 'solana', address: 'So1anaAddressExample1111111111111111111111' });
    expect(await signer.sign('Hi')).toBe('AQID');
  });

  it('keeps only logos that are safe to show as an image', async () => {
    const o = await signerOptions(env({ evmWallets: async () => [{ id: 'a', name: 'A', icon: 'javascript:alert(1)' }, { id: 'b', name: 'B', icon: 'https://example.com/b.png' }, { id: 'c', name: 'C', icon: 'data:text/html;base64,AAAA' }], walletConnectProjectId: '' }));
    expect(o.map((x) => x.icon)).toEqual([null, 'https://example.com/b.png', null]);
  });

  it('gives an empty list, not an error, when the browser has no wallet at all, and survives a failed search', async () => {
    expect(await signerOptions(env({ evmWallets: async () => [], walletConnectProjectId: '' }))).toEqual([]);
    const failing = await signerOptions(env({ evmWallets: async () => { throw new Error('boom'); } }));
    expect(failing.map((o) => o.id)).toEqual(['evm:walletconnect']);
  });
});
