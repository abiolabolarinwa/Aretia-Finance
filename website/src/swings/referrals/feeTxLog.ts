/**
 * Remembers, in memory only, the hashes of the separate transactions that paid the Aretia fee on an EVM network, so the page can
 * tell the server which transactions to read back when it reports a swap. Nothing is stored or sent from here.
 */
const recent: { chain: string; hash: string }[] = [];

export function noteFeeTx(chain: string, hash: string): void {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
  recent.push({ chain, hash });
  if (recent.length > 20) recent.shift();
}

/** The fee transactions noted for a chain since the last call, oldest first; they are forgotten once taken. */
export function takeFeeTxs(chain: string): string[] {
  const mine = recent.filter((r) => r.chain === chain).map((r) => r.hash);
  for (let i = recent.length - 1; i >= 0; i--) if (recent[i]!.chain === chain) recent.splice(i, 1);
  return mine;
}
