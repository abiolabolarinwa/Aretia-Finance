/**
 * Direct integration with Uniswap-V2-style venues (Uniswap V2, PancakeSwap V2, QuickSwap V2, ...): pools are
 * found through the venue's own factory contract and read from the pair contracts. No aggregator is involved.
 * Pure given an `EvmRead` function, so it runs the same against a real node or a fake.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError, type ChainId, type TokenRef } from '../core/types.js';
import { selector, wordToAddress, wordToBigInt, words } from '../engine/abi.js';
import type { DexEntry } from '../engine/registry.js';
import type { LiquidityPool } from '../engine/types.js';

const ZERO = '0x' + '0'.repeat(40);
const SIG = {
  getPair: 'getPair(address,address)',
  token0: 'token0()',
  getReserves: 'getReserves()',
};
const pad = (addr: string): string => addr.slice(2).toLowerCase().padStart(64, '0');

/** What every venue adapter offers the engine: find the pool for a pair, as it is on-chain right now. */
export interface DexAdapter {
  readonly entry: DexEntry;
  getPool(a: TokenRef, b: TokenRef, options?: { block?: bigint }): Promise<LiquidityPool | null>;
}

export class EvmV2Adapter implements DexAdapter {
  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
    private readonly now: () => number = Date.now,
  ) {
    if (entry.mechanism !== 'evm-v2-router' || !entry.factory || !entry.router || entry.feePpm === undefined) {
      throw new SwingsError('invalid', `${entry.id} is not a complete V2 venue entry.`);
    }
  }

  private tag(block?: bigint): string {
    return block === undefined ? 'latest' : '0x' + block.toString(16);
  }

  private async call(to: string, data: string, block?: bigint): Promise<string> {
    const out = await this.read('eth_call', [{ to, data }, this.tag(block)]);
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new SwingsError('invalid', 'The node returned malformed data.');
    return out;
  }

  async getPool(a: TokenRef, b: TokenRef, options: { block?: bigint } = {}): Promise<LiquidityPool | null> {
    const chain: ChainId = this.entry.chain;
    const ta = normalizeTokenRef(chain, a.address);
    const tb = normalizeTokenRef(chain, b.address);
    if (!ta || !tb || ta.chain !== chain || tb.chain !== chain || ta.address === tb.address) throw new SwingsError('invalid', 'Invalid token pair for this network.');

    const pairWord = words(await this.call(this.entry.factory!, '0x' + selector(SIG.getPair) + pad(ta.address) + pad(tb.address), options.block))[0];
    const pairAddress = pairWord ? wordToAddress(pairWord) : ZERO;
    if (pairAddress === ZERO) return null;

    const [t0, reserves] = await Promise.all([this.call(pairAddress, '0x' + selector(SIG.token0), options.block), this.call(pairAddress, '0x' + selector(SIG.getReserves), options.block)]);
    const token0Address = wordToAddress(words(t0)[0] ?? '');
    const rw = words(reserves);
    if (rw.length < 2) throw new SwingsError('invalid', 'Malformed reserves.');
    const token0 = token0Address === ta.address ? ta : token0Address === tb.address ? tb : null;
    if (!token0) throw new SwingsError('invalid', 'The pair does not contain the requested tokens.');
    const token1 = token0 === ta ? tb : ta;
    const reserve0 = wordToBigInt(rw[0]!);
    const reserve1 = wordToBigInt(rw[1]!);
    return {
      ref: { chain, dex: this.entry.id, address: pairAddress },
      model: 'constant-product',
      token0,
      token1,
      reserve0,
      reserve1,
      feePpm: this.entry.feePpm!,
      updatedAt: this.now(),
      block: options.block ?? null,
      status: reserve0 > 0n && reserve1 > 0n ? 'active' : 'inactive',
    };
  }
}
