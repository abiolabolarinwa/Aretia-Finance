/** The owner allow-list (ADMIN_WALLETS), kept in a small file of its own so the Cloudflare game function does not pull in the rest of the admin code. */

/** One allow-list entry as the owner key a session carries (`evm:0x…` lower case, `solana:<address>`), or null when it is not an address. */
export function normaliseOwner(entry: string): string | null {
  const e = entry.trim();
  if (/^(evm:)?0x[0-9a-fA-F]{40}$/.test(e)) return `evm:${e.replace(/^evm:/, '').toLowerCase()}`;
  const sol = e.replace(/^solana:/, '');
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sol) ? `solana:${sol}` : null;
}

export function adminOwners(env: { ADMIN_WALLETS?: string }): Set<string> {
  const out = new Set<string>();
  for (const part of (env.ADMIN_WALLETS ?? '').split(/[\s,;]+/)) {
    const o = part ? normaliseOwner(part) : null;
    if (o) out.add(o);
  }
  return out;
}
