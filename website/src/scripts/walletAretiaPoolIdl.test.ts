import { readFileSync } from 'node:fs';
import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { DISC, buildAddLiquidity, buildClaim, buildCreatePool, buildLock, buildRemoveLiquidity, buildSetRecipient, buildSwap, buildTransferPosition } from './walletAretiaPoolTx';
import { ARETIA_POOL_PROGRAM_ID_DEVNET, POOL_ACCOUNT_SIZE, POOL_TAG, POSITION_ACCOUNT_SIZE, POSITION_TAG } from './walletAretiaPoolCore';

const idl = JSON.parse(readFileSync(new URL('../../../program/aretia-pool/idl/aretia_pool.json', import.meta.url), 'utf8'));
const program = readFileSync(new URL('../../../program/aretia-pool/programs/aretia-pool/src/lib.rs', import.meta.url), 'utf8');
const A = '4joSwCz3iJypFANhYLWund75Rh6wZPLaCChpjqP2PopX';
const M = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const P = ARETIA_POOL_PROGRAM_ID_DEVNET;
const ix = (name: string) => idl.instructions.find((i: { name: string }) => i.name === name);
const SIZES: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, i64: 8, bool: 1, publicKey: 32 };
const size = (fields: { type: string }[]) => 8 + fields.reduce((n, f) => n + SIZES[f.type]!, 0);

describe('the IDL that integrators read matches the program and the web builders', () => {
  it('lists exactly the program’s instructions, with the tags Anchor computes', () => {
    const names = [...program.matchAll(/pub fn (\w+)\(ctx: Context/g)].map((m) => m[1]!);
    const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    expect(idl.instructions.map((i: { name: string }) => i.name)).toEqual(names.map(camel));
    const tags: Record<string, Uint8Array> = { createPool: DISC.createPool, swap: DISC.swap, addLiquidity: DISC.addLiquidity, removeLiquidity: DISC.removeLiquidity, claimFees: DISC.claimFees, transferPosition: DISC.transferPosition, setRecipient: DISC.setRecipient, lockLiquidity: DISC.lockLiquidity };
    for (const i of idl.instructions) expect(i.discriminator, i.name).toEqual([...tags[i.name]!]);
  });
  it('has the same number of accounts as each builder makes', () => {
    const p = { creator: A, mint: M, x0: 1n, y0: 0n, l0: 1n, feeBps: 25, lock: true, sniperBps: 0, decaySecs: 0, vx0: 0n };
    const l = { owner: A, mint: M, dl: 1n, tokens: 1n, sol: 1n };
    expect(ix('createPool').accounts).toHaveLength(buildCreatePool(web3, P, p).instructions.find((i) => i.programId.toBase58() === P)!.keys.length);
    expect(ix('swap').accounts).toHaveLength(buildSwap(web3, P, { trader: A, mint: M, isBuy: true, amountIn: 1n, minOut: 1n }).keys.length);
    expect(ix('addLiquidity').accounts).toHaveLength(buildAddLiquidity(web3, P, l).keys.length);
    expect(ix('removeLiquidity').accounts).toHaveLength(buildRemoveLiquidity(web3, P, l).keys.length);
    expect(ix('claimFees').accounts).toHaveLength(buildClaim(web3, P, A, M).keys.length);
    expect(ix('transferPosition').accounts).toHaveLength(buildTransferPosition(web3, P, A, M, M).keys.length);
    expect(ix('setRecipient').accounts).toHaveLength(buildSetRecipient(web3, P, A, M, M).keys.length);
    expect(ix('lockLiquidity').accounts).toHaveLength(buildLock(web3, P, A, M, 1n).keys.length);
  });
  it('describes the accounts with the sizes and tags the web code reads', () => {
    const pool = idl.accounts.find((a: { name: string }) => a.name === 'Pool');
    const pos = idl.accounts.find((a: { name: string }) => a.name === 'Position');
    expect(size(pool.type.fields)).toBe(POOL_ACCOUNT_SIZE);
    expect(size(pos.type.fields)).toBe(POSITION_ACCOUNT_SIZE);
    expect(pool.discriminator).toEqual([...POOL_TAG]);
    expect(pos.discriminator).toEqual([...POSITION_TAG]);
  });
  it('lists every event the program emits', () => {
    const emitted = [...program.matchAll(/pub struct (\w+) \{/g)].map((m) => m[1]!);
    for (const e of idl.events) expect(emitted, e.name).toContain(e.name);
    expect(idl.events.map((e: { name: string }) => e.name).sort()).toEqual(['Claimed', 'Created', 'LiquidityChanged', 'Locked', 'PositionTransferred', 'RecipientSet', 'Swapped']);
  });
});
