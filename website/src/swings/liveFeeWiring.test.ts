import { describe, expect, it } from 'vitest';
import { createLiveRouter } from './live.js';
import { liveFeeConfig, planAretiaFee } from './core/fee.js';
import { SWAP_FEE_WALLET } from './core/solanaTools.js';
import { CHAINS, type ChainId } from './core/types.js';

// The web wallet builds its router in one place (`createLiveRouter`). The default fee config is OFF, so a provider built without
// `fee: feeConfig` would silently charge nothing. These tests read the router that the page really builds and fail if the fee is
// not switched on in every provider that is supposed to collect it. They do not make a network call.

const EVM_FEE_ADDRESS = '0xeB8725E16e504036c2166aa47804D88Ecc4D0945';
const deps = (evmFeeAddress?: string) => ({ heldOthers: () => [], knownToken: () => null, ...(evmFeeAddress ? { evmFeeAddress } : {}) });

type Anyish = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const inner = (o: unknown): Anyish => o as Anyish;
const providersOf = (router: unknown): Anyish[] => inner(router).providers as Anyish[];

describe('the web wallet router charges the Aretia fee', () => {
  it('runs the live fee policy: 0.58% on, every network, Solana to the owner fee wallet, EVM to the configured address', () => {
    const cfg = inner(createLiveRouter(deps(EVM_FEE_ADDRESS))).feeConfig;
    expect(cfg.policy).toEqual({ enabled: true, rateBps: 58 });
    for (const id of Object.keys(CHAINS) as ChainId[]) expect(cfg.chains[id].enabled, id).toBe(true);
    expect(cfg.chains.solana.treasuryAddress).toBe(SWAP_FEE_WALLET);
    for (const id of Object.keys(CHAINS) as ChainId[]) if (CHAINS[id].kind === 'evm') expect(cfg.chains[id].treasuryAddress, id).toBe(EVM_FEE_ADDRESS.toLowerCase());
    expect(cfg).toEqual(liveFeeConfig(EVM_FEE_ADDRESS));
  });

  it('plans a 0.58% fee for a swap on every network once the EVM fee address is set', () => {
    const cfg = inner(createLiveRouter(deps(EVM_FEE_ADDRESS))).feeConfig;
    for (const id of Object.keys(CHAINS) as ChainId[]) expect(planAretiaFee(1_000_000n, id, cfg), id).toMatchObject({ state: 'ready', fee: 5_800n, net: 994_200n });
  });

  it('pauses EVM swaps instead of letting them through free when no EVM fee address is set, and still charges on Solana', () => {
    const cfg = inner(createLiveRouter(deps())).feeConfig;
    for (const id of Object.keys(CHAINS) as ChainId[]) {
      const plan = planAretiaFee(1_000_000n, id, cfg);
      expect(plan.state, id).toBe(CHAINS[id].kind === 'evm' ? 'blocked' : 'ready');
    }
  });

  it('gives the same live fee config to every provider that builds the swap', () => {
    const router = createLiveRouter(deps(EVM_FEE_ADDRESS));
    const cfg = inner(router).feeConfig;
    const direct = providersOf(router).find((p) => p.id === 'aretia')!;
    const solana = providersOf(router).find((p) => p.id === 'aretia-sol')!;
    const chained = providersOf(router).find((p) => p.id === 'aretia-chain')!;
    expect(direct, 'direct EVM provider present').toBeTruthy();
    expect(solana, 'direct Solana provider present').toBeTruthy();
    expect(chained, 'chained EVM provider present').toBeTruthy();
    expect(direct.deps.fee).toBe(cfg);
    expect(solana.fee).toBe(cfg);
    expect(chained.deps.first.deps.fee).toBe(cfg);
  });

  it('lets only the Jupiter route stand outside the fee: every other provider collects it, and Jupiter cannot be used while it is on', () => {
    const router = createLiveRouter(deps(EVM_FEE_ADDRESS));
    const outside = providersOf(router).filter((p) => p.carriesAretiaFee !== true).map((p) => p.id);
    expect(outside).toEqual(['jupiter']);
    expect(providersOf(router).map((p) => p.id).sort()).toEqual(['0x', 'aretia', 'aretia-chain', 'aretia-sol', 'jupiter']);
  });
});
