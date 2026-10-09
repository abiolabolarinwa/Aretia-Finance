import { describe, expect, it } from 'vitest';
import { EvmSession } from './evmSession.js';
import type { DiscoveredWallet } from './evmWallet.js';

const wallet = (name: string, accounts: string[], log: string[]): DiscoveredWallet =>
  ({
    info: { uuid: name, name, icon: '', rdns: name },
    provider: {
      request: async ({ method }: { method: string }) => {
        log.push(`${name}:${method}`);
        if (method === 'eth_accounts') return accounts;
        throw new Error('a prompt was opened');
      },
    },
  }) as unknown as DiscoveredWallet;

describe('reusing a wallet that is already connected', () => {
  it('takes the account the wallet already shared, with no prompt, from the wallet named in the sidebar', async () => {
    const log: string[] = [];
    const s = new EvmSession();
    s.wallets = [wallet('Rabby', ['0x' + '2'.repeat(40)], log), wallet('MetaMask', ['0x' + 'a'.repeat(40)], log)];
    expect(await s.resume('MetaMask')).toBe('0x' + 'a'.repeat(40));
    expect(s.walletName).toBe('MetaMask');
    expect(log).toEqual(['MetaMask:eth_accounts']);
  });

  it('does nothing when that wallet has not shared an account yet, and never borrows another wallet', async () => {
    const log: string[] = [];
    const s = new EvmSession();
    s.wallets = [wallet('Rabby', ['0x' + '2'.repeat(40)], log), wallet('MetaMask', [], log)];
    expect(await s.resume('MetaMask')).toBeNull();
    expect(s.account).toBeNull();
    expect(log).toEqual(['MetaMask:eth_accounts']);
  });

  it('keeps a wallet that is already connected', async () => {
    const s = new EvmSession();
    s.account = '0x' + '1'.repeat(40);
    expect(await s.resume('MetaMask')).toBe('0x' + '1'.repeat(40));
  });
});
