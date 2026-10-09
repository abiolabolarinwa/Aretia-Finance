/** Live proof, read only: Aretia's own scan finds the known pools of a token straight from the chain. */
import { describe, expect, it } from 'vitest';
import { scanPools, type ScanRpc } from './poolScan.js';

const rpc: ScanRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  const res = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.result === undefined) throw new Error(body.error?.message ?? 'no result');
  return body.result;
};

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('live: pools found from the chain', () => {
  it('finds BONK pools on Raydium AMM v4 and CLMM without asking DexScreener', async () => {
    const pools = await scanPools(rpc, BONK);
    console.log('BONK pools', pools.length, pools.slice(0, 6));
    expect(pools).toContain('Dwq4PxyBQ8dHPmP5u5H7bHsjHp46StGtkSy2gEVedDm');
    expect(pools.length).toBeGreaterThan(1);
  }, 120_000);
  it('skips the main coins', async () => {
    expect(await scanPools(rpc, 'So11111111111111111111111111111111111111112')).toEqual([]);
  });
});
