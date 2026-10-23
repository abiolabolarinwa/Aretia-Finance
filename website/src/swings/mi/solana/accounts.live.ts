/** Live proof that the library-free Solana helpers agree with the real chain: PDA derivation, mint, metadata and Whirlpool layouts. */
import { describe, expect, it } from 'vitest';
import { makeRead } from '../rpc.js';
import { fromBase64, metadataAddress, parseMetadata, parseMint, parseWhirlpool } from './accounts.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const ORCA_SOL_USDC = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const read = makeRead(['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com']);
const account = async (a: string): Promise<Uint8Array | null> => {
  const r = (await read('getAccountInfo', [a, { encoding: 'base64', commitment: 'finalized' }])) as { value: { data: [string, string] } | null };
  return r.value ? fromBase64(r.value.data[0]) : null;
};

describe('solana accounts, live', () => {
  it('derives the real Metaplex metadata account of USDC and reads its fields', async () => {
    const pda = metadataAddress(USDC)!;
    process.stdout.write(`\nLIVE metadata PDA of USDC: ${pda}\n`);
    const d = await account(pda);
    expect(d).not.toBeNull();
    const m = parseMetadata(d!)!;
    expect(m.mint).toBe(USDC);
    expect(m.symbol).toBe('USDC');
  });
  it('reads USDC decimals from the mint and a Whirlpool from the chain', async () => {
    expect(parseMint((await account(USDC))!)!.decimals).toBe(6);
    const w = parseWhirlpool((await account(ORCA_SOL_USDC))!)!;
    process.stdout.write(`LIVE whirlpool ${JSON.stringify({ a: w.mintA, b: w.mintB, tick: w.tickSpacing })}\n`);
    expect([w.mintA, w.mintB].sort()).toEqual([USDC, WSOL].sort());
  });
});
