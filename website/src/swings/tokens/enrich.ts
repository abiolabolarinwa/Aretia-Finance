/**
 * On-chain enrichment: reads the facts the risk engine needs straight from the chain, so the verdict
 * does not rest on a third-party token list. Anything that cannot be read is left undefined, which the
 * risk engine reports as unavailable.
 */
import { assessEvmToken, assessSolanaToken, type EvmRiskFacts, type SolanaRiskFacts } from './risk.js';
import type { TokenEnricher } from './discovery.js';
import type { TokenCandidate } from './registry.js';
import { CHAINS, type ChainId } from '../core/types.js';

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export interface MintFacts {
  decimals: number;
  supply: bigint;
  mintAuthoritySet: boolean;
  freezeAuthoritySet: boolean;
  hasExtensions: boolean;
}

/** Parses an SPL mint account: authorities are COption tags at byte 0 and 46, supply at 36, decimals at 44. */
export function parseMintFacts(owner: string, data: Uint8Array): MintFacts | null {
  if ((owner !== TOKEN && owner !== TOKEN_2022) || data.length < 82 || data[45] !== 1) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    decimals: data[44]!,
    supply: view.getBigUint64(36, true),
    mintAuthoritySet: view.getUint32(0, true) === 1,
    freezeAuthoritySet: view.getUint32(46, true) === 1,
    hasExtensions: owner === TOKEN_2022 && data.length > 82,
  };
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export class SolanaTokenEnricher implements TokenEnricher {
  constructor(
    private readonly rpc: Rpc,
    private readonly now: () => number = Date.now,
  ) {}

  /** Share of supply held by the top accounts that belong to ordinary wallets; null if owners could not be read. */
  private async walletShare(top: { address?: string; amount: string }[], supply: bigint): Promise<number | null> {
    const addresses = top.map((a) => a.address).filter((a): a is string => typeof a === 'string');
    if (addresses.length !== top.length || addresses.length === 0) return null;
    try {
      const accounts = await this.rpc<{ value: ({ data?: { parsed?: { info?: { owner?: string } } } } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const owners = accounts.value.map((a) => a?.data?.parsed?.info?.owner);
      if (owners.some((o) => typeof o !== 'string')) return null;
      const ownerAccounts = await this.rpc<{ value: ({ owner: string } | null)[] }>('getMultipleAccounts', [owners as string[], { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
      let held = 0n;
      top.forEach((a, i) => {
        const o = ownerAccounts.value[i];
        if (o !== null && o !== undefined && o.owner === SYSTEM_PROGRAM) held += BigInt(a.amount);
      });
      return Number((held * 10_000n) / supply) / 100;
    } catch {
      return null;
    }
  }

  async enrich(c: TokenCandidate) {
    const acct = await this.rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [c.ref.address, { encoding: 'base64', commitment: 'confirmed' }]);
    const mint = acct.value ? parseMintFacts(acct.value.owner, fromBase64(acct.value.data[0])) : null;
    if (!mint) return null; // not a token mint: nothing is claimed about it
    let top10Pct: number | null = null;
    let top10Basis: 'all' | 'wallets' = 'all';
    if (mint.supply > 0n) {
      try {
        const largest = await this.rpc<{ value: { address?: string; amount: string }[] }>('getTokenLargestAccounts', [c.ref.address, { commitment: 'confirmed' }]);
        const top = largest.value.slice(0, 10);
        const all = top.reduce((sum, a) => sum + BigInt(a.amount), 0n);
        top10Pct = Number((all * 10_000n) / mint.supply) / 100;
        // Pools and vaults inflate concentration. Drop accounts whose owner is program-controlled (the owner
        // account is missing or not owned by the System program) and say the figure is on that basis.
        const wallets = await this.walletShare(top, mint.supply);
        if (wallets !== null) {
          top10Pct = wallets;
          top10Basis = 'wallets';
        }
      } catch {
        top10Pct = null;
      }
    }
    const firstSeen = c.firstPoolAt ?? c.createdAt ?? null;
    const facts: SolanaRiskFacts = {
      mintAuthoritySet: mint.mintAuthoritySet,
      freezeAuthoritySet: mint.freezeAuthoritySet,
      hasExtensions: mint.hasExtensions,
      top10Pct,
      top10Basis,
      liquidityUsd: c.liquidityUsd ?? null,
      volume24hUsd: c.volume24hUsd ?? null,
      poolCount: c.pool ? 1 : null,
      ageHours: firstSeen === null ? null : Math.max(0, (this.now() - firstSeen) / 3_600_000),
    };
    return {
      risk: assessSolanaToken(facts, { now: this.now() }),
      decimals: mint.decimals,
      metadata: { program: acct.value!.owner === TOKEN_2022 ? 'token-2022' : 'spl-token', supply: mint.supply.toString(), mintAuthoritySet: mint.mintAuthoritySet, freezeAuthoritySet: mint.freezeAuthoritySet },
    };
  }
}

// EVM: bytecode heuristics. A 4-byte selector inside the code (as PUSH4) means the function probably
// exists. This can miss obfuscated code and can false-positive; the result says so.
const SELECTORS = {
  mint: ['40c10f19', 'a0712d68'],
  blacklist: ['f9f92be4', '44337ea1', 'e47d6060'],
  pause: ['8456cb59'],
  owner: ['8da5cb5b'],
  proxy: ['5c60da1b', '52d1902d'],
} as const;
const EIP1967_IMPL_SLOT = '360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1167_PREFIX = '363d3d373d3d3d363d73';

export const hasSelector = (code: string, selectors: readonly string[]): boolean => selectors.some((s) => code.includes('63' + s));

export function evmFactsFromCode(codeHex: string): Pick<EvmRiskFacts, 'canMint' | 'canBlacklist' | 'canPause' | 'isProxy'> & { hasOwnerFn: boolean } {
  const code = codeHex.toLowerCase().replace(/^0x/, '');
  return {
    canMint: hasSelector(code, SELECTORS.mint),
    canBlacklist: hasSelector(code, SELECTORS.blacklist),
    canPause: hasSelector(code, SELECTORS.pause),
    isProxy: code.startsWith(EIP1167_PREFIX) || code.includes(EIP1967_IMPL_SLOT) || hasSelector(code, SELECTORS.proxy),
    hasOwnerFn: hasSelector(code, SELECTORS.owner),
  };
}

const EIP1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZEPPELINOS_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';

/** The implementation address embedded in an EIP-1167 minimal proxy, or null if the code is not one. */
export function minimalProxyTarget(codeHex: string): string | null {
  const code = codeHex.toLowerCase().replace(/^0x/, '');
  return code.startsWith(EIP1167_PREFIX) && code.length >= EIP1167_PREFIX.length + 40 ? '0x' + code.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40) : null;
}

export class EvmTokenEnricher implements TokenEnricher {
  /** `rpc` must be bound to the chain the candidate is on; the enricher is created per chain. */
  constructor(
    private readonly rpc: Rpc,
    private readonly now: () => number = Date.now,
    private readonly extra: {
      sourceVerified?: (chain: ChainId, address: string) => Promise<boolean | null>;
      tax?: (chain: ChainId, address: string) => Promise<{ buyBps: number | null; sellBps: number | null } | null>;
    } = {},
  ) {}

  async enrich(c: TokenCandidate) {
    if (CHAINS[c.ref.chain].kind !== 'evm') return null;
    const code = await this.rpc<string>('eth_getCode', [c.ref.address, 'latest']);
    if (typeof code !== 'string' || code === '0x' || code.length < 10) return null; // no contract here
    let f = evmFactsFromCode(code);
    // A proxy holds almost no logic: what the token can do (mint, blacklist, pause) lives in the contract it
    // points to. Read that one too, or a proxied token would look cleaner than it is.
    let implementation: string | null = null;
    if (f.isProxy) {
      implementation = await this.implementationOf(c.ref.address, code);
      if (implementation) {
        try {
          const implCode = await this.rpc<string>('eth_getCode', [implementation, 'latest']);
          if (typeof implCode === 'string' && implCode.length > 10) {
            const g = evmFactsFromCode(implCode);
            f = { ...f, canMint: f.canMint || g.canMint, canBlacklist: f.canBlacklist || g.canBlacklist, canPause: f.canPause || g.canPause, hasOwnerFn: f.hasOwnerFn || g.hasOwnerFn };
          }
        } catch {
          implementation = null;
        }
      }
    }
    let owner: EvmRiskFacts['owner'] = null;
    if (f.hasOwnerFn) {
      try {
        const out = await this.rpc<string>('eth_call', [{ to: c.ref.address, data: '0x8da5cb5b' }, 'latest']);
        owner = /^0x0*$/.test(out) ? 'renounced' : 'set';
      } catch {
        owner = null;
      }
    }
    let decimals: number | undefined;
    try {
      const d = Number.parseInt(await this.rpc<string>('eth_call', [{ to: c.ref.address, data: '0x313ce567' }, 'latest']), 16);
      if (Number.isInteger(d) && d >= 0 && d <= 36) decimals = d;
    } catch {
      decimals = undefined;
    }
    const [verified, tax] = await Promise.all([this.extra.sourceVerified?.(c.ref.chain, c.ref.address) ?? null, this.extra.tax?.(c.ref.chain, c.ref.address) ?? null]);
    const firstSeen = c.firstPoolAt ?? c.createdAt ?? null;
    const facts: EvmRiskFacts = {
      sourceVerified: verified,
      buyTaxPct: tax?.buyBps != null ? tax.buyBps / 100 : null,
      sellTaxPct: tax?.sellBps != null ? tax.sellBps / 100 : null,
      owner,
      isProxy: f.isProxy,
      canMint: f.canMint,
      canBlacklist: f.canBlacklist,
      canPause: f.canPause,
      // Taxes, transfer restrictions, holders and source verification need a simulation, an indexer or an
      // explorer key. They stay unset, so the risk result lists them as unavailable instead of guessing.
      liquidityUsd: c.liquidityUsd ?? null,
      volume24hUsd: c.volume24hUsd ?? null,
      poolCount: c.pool ? 1 : null,
      ageHours: firstSeen === null ? null : Math.max(0, (this.now() - firstSeen) / 3_600_000),
    };
    return { risk: assessEvmToken(facts, { now: this.now() }), ...(decimals !== undefined ? { decimals } : {}), metadata: { analysis: 'bytecode-heuristic', owner, isProxy: f.isProxy ?? null, implementation } };
  }

  private async implementationOf(address: string, code: string): Promise<string | null> {
    const embedded = minimalProxyTarget(code);
    if (embedded) return embedded;
    for (const slot of [EIP1967_SLOT, ZEPPELINOS_SLOT]) {
      try {
        const v = await this.rpc<string>('eth_getStorageAt', [address, slot, 'latest']);
        if (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) && !/^0x0+$/.test(v)) return '0x' + v.slice(-40);
      } catch {
        // Try the next convention.
      }
    }
    return null;
  }
}
