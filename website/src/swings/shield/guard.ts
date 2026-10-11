/**
 * Shield's guard for Pay: the checks that run on a recipient before the wallet is asked to sign. It adds to the account check Pay
 * already had (is it a person's wallet or a program, has it ever been used) three that need what only this device knows: is it
 * an address you have sent to or saved, is it a copy-cat of one, or is it the first time.
 */
import { findLookalikes, isKnown } from './lookalike.js';
import type { Finding, KnownAddress } from './types.js';

const short = (v: string): string => (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);

export interface Guard {
  findings: Finding[];
  /** True when the person must tick a box saying they compared the whole address before the send can go on. */
  needsAck: boolean;
}

export function guardRecipient(address: string, known: readonly KnownAddress[], own: string | null): Guard {
  const findings: Finding[] = [];
  if (own && own === address) return { findings: [{ id: 'own', severity: 'info', title: 'This is the wallet you have connected.', detail: 'You would be sending to yourself.' }], needsAck: false };
  const hit = isKnown(address, known);
  if (hit) {
    findings.push(hit.trusted ? { id: 'trusted', severity: 'ok', title: `Saved as "${hit.label ?? 'trusted'}".`, detail: 'You saved this address on purpose.' } : { id: 'sent-before', severity: 'ok', title: 'You have sent to this address before.', detail: 'It is in your own history on this device.' });
    return { findings, needsAck: false };
  }
  const copies = findLookalikes(address, known);
  for (const l of copies.slice(0, 2)) {
    findings.push({
      id: 'lookalike',
      severity: 'bad',
      title: `This address imitates ${l.known.label ? `"${l.known.label}"` : short(l.known.address)}, but it is not the same.`,
      detail: `It starts with the same ${l.prefix} and ends with the same ${l.suffix} characters, then differs in the middle. That is address poisoning: a scammer makes a copy-cat so you paste theirs instead. Compare every character with the address you meant to use.`,
    });
  }
  if (copies.length === 0) findings.push({ id: 'first-time', severity: 'note', title: 'You have not sent to this address before.', detail: 'First payments are where mistakes and scams happen. If you can, send a small amount first and ask the recipient to confirm it arrived.' });
  return { findings, needsAck: copies.length > 0 };
}
