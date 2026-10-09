/**
 * The Aretia fee on an EVM swap: a plain transfer of the fee, in the asset being sold, to the fee address, sent by the
 * user's own wallet just before the swap (after any approval). The native coin is sent as a value transfer; any other token
 * with a standard ERC-20 `transfer`. The transfer is its own transaction, so it is shown to the user as one.
 */
import { EVM_NATIVE_ADDRESS, SwingsError } from '../core/types.js';
import type { EvmSwapPayload } from './evm.js';

const TRANSFER_SELECTOR = '0xa9059cbb';
const pad32 = (hexNo0x: string): string => hexNo0x.padStart(64, '0');
const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

/** ERC-20 transfer(to, amount) calldata. */
export function encodeTransfer(to: string, amount: bigint): string {
  if (!isAddr(to)) throw new SwingsError('invalid', 'Invalid recipient address.');
  if (amount <= 0n || amount >= 1n << 256n) throw new SwingsError('invalid', 'Invalid transfer amount.');
  return TRANSFER_SELECTOR + pad32(to.slice(2).toLowerCase()) + pad32(amount.toString(16));
}

/** The fee transaction for a swap that sells `token` (the zero-style native address for the chain's own coin), or null when there is no fee. */
export function evmFeeTransfer(taker: string, token: string, fee: bigint, treasury: string): NonNullable<EvmSwapPayload['fee']> | null {
  if (fee <= 0n) return null;
  if (!isAddr(taker) || !isAddr(treasury)) throw new SwingsError('invalid', 'Invalid address.');
  const native = token.toLowerCase() === EVM_NATIVE_ADDRESS;
  return {
    tx: native ? { from: taker, to: treasury.toLowerCase(), value: '0x' + fee.toString(16) } : { from: taker, to: token.toLowerCase(), data: encodeTransfer(treasury, fee) },
    token: native ? EVM_NATIVE_ADDRESS : token.toLowerCase(),
    amount: fee,
    recipient: treasury.toLowerCase(),
  };
}
