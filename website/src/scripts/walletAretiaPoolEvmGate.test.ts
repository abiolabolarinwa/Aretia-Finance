import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import artifact from '../../../contracts-evm/AretiaPool.artifact.json';
import { EVM_POOL_ADDRESSES, POOL_FEE_TIERS, POOL_MAX, POOL_MIN_DL, POOL_MIN_L, POOL_MIN_X, POOL_PROTOCOL_SHARE_BPS, POOL_SCALE_BITS } from './walletAretiaPoolEvmCore';
import { FEE_ADDRESS, LAUNCH_EVM_CHAINS } from './walletLaunchEvmCore';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const source = () => read('../../../contracts-evm/AretiaPool.sol');
const constant = (name: string): bigint => {
  const m = new RegExp(`constant ${name}\\s*=\\s*([^;]+);`).exec(source());
  if (!m) throw new Error(`${name} not found`);
  const v = m[1]!.trim().replace(/_/g, '');
  const shift = /^1 << (\d+)$/.exec(v);
  if (shift) return 1n << BigInt(shift[1]!);
  const exp = /^1e(\d+)$/.exec(v);
  if (exp) return 10n ** BigInt(exp[1]!);
  return BigInt(v);
};

describe('the page keeps the EVM Aretia Pool off', () => {
  it('only contains the card when built with PUBLIC_ARETIA_POOL_EVM_ENABLED=1', () => {
    const page = read('../pages/wallet/index.astro');
    expect(page).toContain("const aretiaPoolEvmOn = import.meta.env.PUBLIC_ARETIA_POOL_EVM_ENABLED === '1';");
    const at = page.indexOf('data-evm-aretia-pool-root');
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(page.lastIndexOf('{aretiaPoolEvmOn', at), at)).toContain('{aretiaPoolEvmOn && (');
  });
  it('is not turned on by any build script in the repo', () => {
    expect(read('../../package.json')).not.toContain('PUBLIC_ARETIA_POOL_EVM_ENABLED');
  });
  it('is created in the Launch code only behind the flag, once', () => {
    const launch = read('./walletLaunchEvm.ts');
    expect(launch).toContain("import.meta.env.PUBLIC_ARETIA_POOL_EVM_ENABLED === '1' ? createEvmAretiaPool(");
    expect(launch.match(/createEvmAretiaPool\(/g)).toHaveLength(1);
  });
  it('has a deployed address only on BNB Chain (checked byte for byte), none on Ethereum or Polygon, and draws nothing that could send without one', () => {
    expect([EVM_POOL_ADDRESSES.ethereum, EVM_POOL_ADDRESSES.polygon]).toEqual([null, null]);
    expect(EVM_POOL_ADDRESSES.bnb).toBe('0x195fa7d999f567c8e198e961da8270911905753c');
    const card = read('./walletAretiaPoolEvm.ts');
    const at = card.indexOf('if (!chain) {', card.indexOf('draw(card, redraw, chainKey'));
    expect(at).toBeGreaterThan(-1);
    expect(card.slice(at, at + 800)).toContain('return;');
  });
  it('keeps the Your pools page flag-free but shows nothing for a chain without a contract', async () => {
    // A chain is listed only when it has a contract address AND a deployment block; the card file asks the engine, which asks the table.
    expect(read('./walletYourPoolsEvmFlow.ts')).toContain('evmPoolChain(key, this.addresses, this.factories)');
    expect(read('./walletYourPoolsEvm.ts')).toContain('engine().chainOf(net)');
    const { EVM_POOL_DEPLOY_BLOCKS } = await import('./walletAretiaPoolEvmCore');
    expect([EVM_POOL_DEPLOY_BLOCKS.ethereum, EVM_POOL_DEPLOY_BLOCKS.polygon]).toEqual([null, null]);
    expect(EVM_POOL_DEPLOY_BLOCKS.bnb).toBe(130024337);
  });
});

describe('the web constants equal the contract’s', () => {
  it('share, fee tiers, bounds and scale', () => {
    expect(constant('PROTOCOL_SHARE_BPS')).toBe(POOL_PROTOCOL_SHARE_BPS);
    expect(constant('FEE_LOW_BPS')).toBe(BigInt(POOL_FEE_TIERS[0]));
    expect(constant('FEE_HIGH_BPS')).toBe(BigInt(POOL_FEE_TIERS[1]));
    expect(constant('MIN_X')).toBe(POOL_MIN_X);
    expect(constant('MIN_L')).toBe(POOL_MIN_L);
    expect(constant('MIN_DL')).toBe(POOL_MIN_DL);
    expect(constant('MAX')).toBe(POOL_MAX);
    expect(constant('SCALE_BITS')).toBe(POOL_SCALE_BITS);
  });
  it('the creation fee and fee address the page expects are the token-creation fee and the owner’s address', () => {
    expect(FEE_ADDRESS).toBe('0xeb8725e16e504036c2166aa47804d88ecc4d0945');
    for (const c of LAUNCH_EVM_CHAINS) expect(c.feeAddress).toBe(FEE_ADDRESS);
    const byKey = Object.fromEntries(LAUNCH_EVM_CHAINS.map((c) => [c.key, c.feeWei]));
    expect(byKey.ethereum).toBe(4_200_000_000_000_000n);
    expect(byKey.bnb).toBe(14_000_000_000_000_000n);
    expect(byKey.polygon).toBe(105_000_000_000_000_000_000n);
  });
});

describe('the contract has no way to change anything after deployment', () => {
  it('the committed artifact was built from exactly this source', () => {
    const input = JSON.parse(read('../../../contracts-evm/AretiaPool.standard-input.json')) as { sources: Record<string, { content: string }>; settings: { optimizer: { enabled: boolean; runs: number }; evmVersion: string } };
    expect(input.sources['AretiaPool.sol']!.content).toBe(source());
    expect(input.settings).toMatchObject({ optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' });
    expect(artifact.compiler).toBe('solc 0.8.26, optimizer 200 runs, evm paris');
  });
  it('the only state-changing functions are the ones the page knows, and none is an admin function', () => {
    const abi = artifact.pool.abi as { type: string; name?: string; stateMutability?: string }[];
    const writes = abi.filter((e) => e.type === 'function' && e.stateMutability !== 'view' && e.stateMutability !== 'pure').map((e) => e.name).sort();
    expect(writes).toEqual(['addLiquidity', 'buy', 'claimFees', 'createPool', 'lockLiquidity', 'removeLiquidity', 'sell', 'setRecipient', 'transferPosition', 'withdrawProtocolFees']);
    expect(abi.filter((e) => e.type === 'receive' || e.type === 'fallback').map((e) => e.type)).toEqual(['receive']);
  });
  it('the source has no owner, proxy, delegatecall, selfdestruct, pause or upgrade path', () => {
    const code = source().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const word of ['onlyOwner', 'delegatecall', 'selfdestruct', 'pause', 'upgrade', 'initialize', 'setFee', 'setOwner', 'transferOwnership', 'ecrecover']) expect(code, word).not.toContain(word);
    // Every external function is either a trade, a position function, or a read.
    expect(code.match(/function \w+\([^)]*\)\s+external/g)!.length).toBeGreaterThan(8);
    // The fee address, factory and creation fee are immutable.
    for (const name of ['factory', 'feeRecipient', 'creationFee']) expect(code).toMatch(new RegExp(`immutable ${name}`));
  });
  it('is far below the 24,576-byte contract size limit', () => {
    expect((artifact.pool.bytecode.length - 2) / 2).toBeLessThan(24_576);
  });
});
