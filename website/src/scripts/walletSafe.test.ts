import { describe, expect, it } from 'vitest';
import { isEvmAddress, judgeSafe, readSafeVault, SAFE_SINGLETONS, type SafeReadback } from './walletSafe';
import type { EvmRead } from '../swings/chains/evmSession';

const A = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const w = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0');
const addr = (a: string): string => a.slice(2).padStart(64, '0');
const ownersHex = (owners: string[]): string => `0x${w(32)}${w(owners.length)}${owners.map(addr).join('')}`;
const modulesHex = (modules: string[]): string => `0x${w(64)}${addr(A(1))}${w(modules.length)}${modules.map(addr).join('')}`;
const stringHex = (s: string): string => {
  const bytes = Buffer.from(s).toString('hex');
  return `0x${w(32)}${w(s.length)}${bytes.padEnd(64, '0')}`;
};
const SINGLETON = '0x41675c099f32341bf84bfc5382af534df5c7461a';

interface Chain {
  code?: string;
  owners?: string[];
  threshold?: number;
  nonce?: number;
  version?: string;
  modules?: string[];
  singleton?: string;
  revert?: boolean;
}

function fakeChain(c: Chain): EvmRead {
  return async (method, params) => {
    if (method === 'eth_getCode') return c.code ?? '0x6080';
    if (method === 'eth_getStorageAt') return `0x${addr(c.singleton ?? SINGLETON)}`;
    const data = (params[0] as { data: string }).data;
    if (c.revert) throw new Error('execution reverted');
    if (data.startsWith('0xa0e67e2b')) return ownersHex(c.owners ?? [A(11), A(12), A(13)]);
    if (data.startsWith('0xe75235b8')) return `0x${w(c.threshold ?? 2)}`;
    if (data.startsWith('0xaffed0e0')) return `0x${w(c.nonce ?? 5)}`;
    if (data.startsWith('0xffa1ad74')) return stringHex(c.version ?? '1.4.1');
    if (data.startsWith('0xcc2f8452')) return modulesHex(c.modules ?? []);
    throw new Error('unexpected call');
  };
}

describe('readSafeVault', () => {
  it('reads owners, threshold, nonce, version and singleton from the chain', async () => {
    const r = await readSafeVault(fakeChain({}), A(99));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.safe.owners).toEqual([A(11), A(12), A(13)]);
    expect(r.safe.threshold).toBe(2);
    expect(r.safe.nonce).toBe(5);
    expect(r.safe.version).toBe('1.4.1');
    expect(r.safe.modules).toEqual([]);
    expect(r.safe.singleton).toBe(SINGLETON);
  });

  it('reports an address with no code as not a vault', async () => {
    expect((await readSafeVault(fakeChain({ code: '0x' }), A(99))).status).toBe('no-contract');
  });

  it('reports a contract that reverts the Safe calls as not a Safe, not as a failure', async () => {
    expect((await readSafeVault(fakeChain({ revert: true }), A(99))).status).toBe('not-a-safe');
  });

  it('lets a node failure surface instead of calling the address a non-Safe', async () => {
    const read: EvmRead = async (method) => {
      if (method === 'eth_getCode') return '0x6080';
      throw new Error('The Ethereum network node could not be reached.');
    };
    await expect(readSafeVault(read, A(99))).rejects.toThrow(/could not be reached/);
  });

  it('rejects a threshold its signer list cannot meet', async () => {
    expect((await readSafeVault(fakeChain({ threshold: 5 }), A(99))).status).toBe('not-a-safe');
  });

  it('reads enabled modules', async () => {
    const r = await readSafeVault(fakeChain({ modules: [A(7)] }), A(99));
    expect(r.status === 'ok' && r.safe.modules).toEqual([A(7)]);
  });
});

describe('judgeSafe', () => {
  const base: SafeReadback = { address: A(99), owners: [A(1), A(2), A(3)], threshold: 2, nonce: 0, version: '1.4.1', modules: [], singleton: SINGLETON };
  it('says what was found for a standard vault, never "safe to use"', () => {
    const j = judgeSafe(base);
    expect(j.tone).toBe('on');
    expect(j.headline).toBe('2 of 3 signers must approve');
    expect(j.notes.join(' ')).not.toMatch(/safe to use/i);
  });
  it('flags a module, an unknown contract, another version and a single approval', () => {
    expect(judgeSafe({ ...base, modules: [A(7)] }).tone).toBe('warn');
    expect(judgeSafe({ ...base, singleton: A(5) }).tone).toBe('warn');
    expect(judgeSafe({ ...base, singleton: null }).tone).toBe('warn');
    expect(judgeSafe({ ...base, version: '1.3.0' }).tone).toBe('warn');
    expect(judgeSafe({ ...base, threshold: 1 }).notes.join(' ')).toMatch(/single signer/);
  });
  it('accepts the L2 singleton', () => {
    for (const s of Object.keys(SAFE_SINGLETONS)) expect(judgeSafe({ ...base, singleton: s }).tone).toBe('on');
  });
});

describe('isEvmAddress', () => {
  it('accepts 40 hex digits and nothing else', () => {
    expect(isEvmAddress(A(1))).toBe(true);
    expect(isEvmAddress('0x123')).toBe(false);
    expect(isEvmAddress(`${A(1)}00`)).toBe(false);
    expect(isEvmAddress('hello')).toBe(false);
  });
});
