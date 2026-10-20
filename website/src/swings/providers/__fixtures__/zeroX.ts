/**
 * Test-only builders for 0x calldata: AllowanceHolder `exec(operator, token, amount, target, data)` wrapping a Settler
 * `execute((recipient, buyToken, minAmountOut), actions, zid)`, ABI-encoded the way 0x's API returns them.
 */
const w = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
const num = (n: bigint): string => w(n.toString(16));
const bytes = (hex: string): string => {
  const body = hex.replace(/^0x/, '');
  return num(BigInt(body.length / 2)) + body.padEnd(Math.ceil(body.length / 64) * 64, '0');
};

/** A test stand-in for the current 0x Settler. */
export const TEST_SETTLER = '0x5e771e5e771e5e771e5e771e5e771e5e771e5e77';

export function settlerExecute(o: { recipient: string; buyToken: string; minAmountOut: bigint; actions?: string[] }): string {
  const actions = o.actions ?? ['0xc1fb425e' + '00'.repeat(64)];
  const encoded = actions.map(bytes);
  let offset = BigInt(actions.length * 32);
  const offsets: string[] = [];
  for (const e of encoded) {
    offsets.push(num(offset));
    offset += BigInt(e.length / 2);
  }
  return '0x1fff991f' + w(o.recipient) + w(o.buyToken) + num(o.minAmountOut) + num(0xa0n) + w('ab'.repeat(32)) + num(BigInt(actions.length)) + offsets.join('') + encoded.join('');
}

export function allowanceHolderExec(o: { operator?: string; token: string; amount: bigint; target?: string; data: string }): string {
  return '0x2213bc0b' + w(o.operator ?? TEST_SETTLER) + w(o.token) + num(o.amount) + w(o.target ?? TEST_SETTLER) + num(0xa0n) + bytes(o.data);
}

/** The whole 0x transaction data for a swap paying `minAmountOut` of `buyToken` to `recipient`. */
export function zeroXSwapData(o: { token: string; amount: bigint; recipient: string; buyToken: string; minAmountOut: bigint; operator?: string; target?: string }): string {
  return allowanceHolderExec({ operator: o.operator, token: o.token, amount: o.amount, target: o.target, data: settlerExecute({ recipient: o.recipient, buyToken: o.buyToken, minAmountOut: o.minAmountOut }) });
}

/** An eth_call answer from the Settler registry naming `settler`. */
export const registryAnswer = (settler: string): string => '0x' + w(settler.toLowerCase());
