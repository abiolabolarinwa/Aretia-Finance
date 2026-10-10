import { describe, expect, it } from 'vitest';
import { CHAINS } from './core/types.js';
import { liveFeeConfig } from './core/fee.js';
import { CHAIN_ADD_PARAMS } from './chains/evmWallet.js';
import { HUB_TOKENS } from './dex/hubs.js';
import { EVM_DEXES, WRAPPED_NATIVE } from './dex/entries.js';
import { isChainEnabled, runtime } from './runtime.js';

describe('swaps on Robinhood Chain', () => {
  it('are on only when the server says so, like every other EVM network', () => {
    expect(CHAINS.robinhood).toMatchObject({ evmChainId: 4663, nativeSymbol: 'ETH', kind: 'evm' });
    expect(isChainEnabled('robinhood', { ...runtime, evmChains: [] })).toBe(false);
    expect(isChainEnabled('robinhood', { ...runtime, evmChains: ['robinhood'] })).toBe(true);
    // Another chain being on does not turn it on.
    expect(isChainEnabled('robinhood', { ...runtime, evmChains: ['base'] })).toBe(false);
  });

  it('gives a wallet that does not know the network what it needs to add it', () => {
    const p = CHAIN_ADD_PARAMS[CHAINS.robinhood.evmChainId!];
    expect(p).toBeDefined();
    expect(p!.chainName).toBe('Robinhood Chain');
    expect(p!.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
    expect([...p!.rpcUrls, ...p!.blockExplorerUrls].every((u) => u.startsWith('https://'))).toBe(true);
  });

  it('can route through wrapped ether and USDG, and has a V3 and a V4 venue that name wrapped ether', () => {
    expect(HUB_TOKENS.robinhood).toEqual([
      { address: WRAPPED_NATIVE.robinhood, symbol: 'WETH', decimals: 18 },
      { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6, skipV4: true },
    ]);
    const venues = EVM_DEXES.filter((e) => e.chain === 'robinhood');
    expect(venues.map((v) => v.protocol).sort()).toEqual(['uniswap-v3', 'uniswap-v4']);
    expect(venues.every((v) => v.wrappedNative === WRAPPED_NATIVE.robinhood)).toBe(true);
  });

  it('pays the same Aretia fee as the other EVM networks, and is blocked rather than free when no fee address is set', () => {
    const address = '0x' + 'ab'.repeat(20);
    expect(liveFeeConfig(address).chains.robinhood).toEqual({ chainId: 'robinhood', treasuryAddress: address, enabled: true });
    const none = liveFeeConfig().chains.robinhood!;
    expect(none.enabled).toBe(true);
    expect(none.treasuryAddress).toBeUndefined();
  });
});
