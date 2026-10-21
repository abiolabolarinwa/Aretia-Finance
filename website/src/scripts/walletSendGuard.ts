/**
 * Shield's recipient guard as Pay applies it before the wallet is asked to sign, shared by the Solana and Ethereum-style
 * Send screens (audit L-24: the EVM Send used to skip it). Pure, so the gate can be tested without a page.
 */
import { guardRecipient, type Guard } from '../swings/shield/guard.js';
import type { KnownAddress } from '../swings/shield/types.js';

const isEvm = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

/** The guard for a recipient; EVM addresses are compared without regard to letter case (checksums vary). */
export function sendRecipientGuard(to: string, known: readonly KnownAddress[], own: string | null): Guard {
  const evm = isEvm(to);
  return guardRecipient(evm ? to.toLowerCase() : to, known, own && evm && isEvm(own) ? own.toLowerCase() : own);
}

/** Whether "Confirm in my wallet" must stay disabled: a blocker, a send in flight, or an acknowledgement not yet ticked. */
export function sendConfirmDisabled(s: { canGo: boolean; busy: boolean; needsAck: boolean; ack: boolean; guard: Guard | null; guardAck: boolean }): boolean {
  return !s.canGo || s.busy || (s.needsAck && !s.ack) || (!!s.guard?.needsAck && !s.guardAck);
}
