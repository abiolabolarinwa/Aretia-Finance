/**
 * "Your pools": reading what a wallet owns from the chain. The program reads go through Meteora's SDK (the same pinned version the pool
 * card uses); turning what it returns into a PoolPosition is a pure function so it can be tested without a network.
 */
import type * as Web3 from '@solana/web3.js';
import type BN from 'bn.js';
import { parseMintAccount, type AccountReader } from './walletLaunchChain';
import { NATIVE_MINT, type PoolPosition, type PoolSide } from './walletYourPoolsCore';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './walletTools';
import type { PoolLibs } from './walletPoolTx';

/** The most positions listed at once. A wallet with more than this sees the first ones and a note. */
export const MAX_POSITIONS = 50;

export interface RawPosition {
  position: string;
  positionNft: string;
  positionNftAccount: string;
  pool: string;
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault: string;
  tokenBVault: string;
  feeA: bigint;
  feeB: bigint;
  unlocked: bigint;
  locked: bigint;
  vesting: bigint;
}

export interface MintLook {
  program: string;
  decimals: number;
  symbol: string;
}

/** Joins a raw position with what is known about its two tokens. */
export function positionFromChain(raw: RawPosition, a: MintLook, b: MintLook): PoolPosition {
  const side = (mint: string, vault: string, look: MintLook): PoolSide => ({ mint, vault, program: look.program, decimals: look.decimals, symbol: mint === NATIVE_MINT ? 'SOL' : look.symbol });
  return {
    pool: raw.pool,
    position: raw.position,
    positionNft: raw.positionNft,
    positionNftAccount: raw.positionNftAccount,
    a: side(raw.tokenAMint, raw.tokenAVault, a),
    b: side(raw.tokenBMint, raw.tokenBVault, b),
    feeA: raw.feeA,
    feeB: raw.feeB,
    unlocked: raw.unlocked,
    locked: raw.locked,
    vesting: raw.vesting,
  };
}

const big = (n: BN): bigint => BigInt(n.toString());
const short = (m: string): string => `${m.slice(0, 4)}…${m.slice(-4)}`;

/** Decimals, program and symbol of a mint: Token-2022 metadata when it has it, otherwise a shortened address. */
/** Tokens with no readable on-chain symbol that people know by name. */
const KNOWN_SYMBOLS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG': 'ACT',
};

export async function lookMint(web3: typeof Web3, fetchAccount: AccountReader, mint: string): Promise<MintLook> {
  if (mint === NATIVE_MINT) return { program: TOKEN_PROGRAM_ID, decimals: 9, symbol: 'SOL' };
  const known = KNOWN_SYMBOLS[mint];
  const acc = await fetchAccount(mint);
  if (!acc) return { program: TOKEN_PROGRAM_ID, decimals: 0, symbol: known ?? short(mint) };
  if (acc.owner === TOKEN_2022_PROGRAM_ID) {
    const facts = parseMintAccount(web3, acc.owner, acc.data);
    if (facts) return { program: TOKEN_2022_PROGRAM_ID, decimals: facts.decimals, symbol: facts.metadata?.symbol || known || short(mint) };
    // A Token-2022 mint with extensions this page does not read: the decimals are still at the same offset.
    return { program: TOKEN_2022_PROGRAM_ID, decimals: acc.data[44] ?? 0, symbol: known ?? short(mint) };
  }
  return { program: acc.owner, decimals: acc.data[44] ?? 0, symbol: known ?? short(mint) };
}

/** Every Meteora pool position the wallet owns, with its unclaimed fees. Reads only; nothing is sent. */
export async function readPositions(web3: typeof Web3, libs: PoolLibs, connection: Web3.Connection, fetchAccount: AccountReader, owner: string): Promise<{ positions: PoolPosition[]; truncated: boolean }> {
  const { sdk, cpAmm } = libs;
  const nfts = await sdk.getAllPositionNftAccountByOwner(connection, new web3.PublicKey(owner));
  const chosen = nfts.slice(0, MAX_POSITIONS);
  const poolCache = new Map<string, Awaited<ReturnType<typeof cpAmm.fetchPoolState>>>();
  const mintCache = new Map<string, MintLook>();
  const look = async (mint: string): Promise<MintLook> => {
    const hit = mintCache.get(mint);
    if (hit) return hit;
    const fresh = await lookMint(web3, fetchAccount, mint);
    mintCache.set(mint, fresh);
    return fresh;
  };
  const out: PoolPosition[] = [];
  for (const n of chosen) {
    try {
      const position = sdk.derivePositionAddress(n.positionNft);
      const state = await cpAmm.fetchPositionState(position);
      const poolKey = state.pool.toBase58();
      let pool = poolCache.get(poolKey);
      if (!pool) {
        pool = await cpAmm.fetchPoolState(state.pool);
        poolCache.set(poolKey, pool);
      }
      const fee = sdk.getUnClaimLpFee(pool, state);
      const raw: RawPosition = {
        position: position.toBase58(),
        positionNft: n.positionNft.toBase58(),
        positionNftAccount: n.positionNftAccount.toBase58(),
        pool: poolKey,
        tokenAMint: pool.tokenAMint.toBase58(),
        tokenBMint: pool.tokenBMint.toBase58(),
        tokenAVault: pool.tokenAVault.toBase58(),
        tokenBVault: pool.tokenBVault.toBase58(),
        feeA: big(fee.feeTokenA),
        feeB: big(fee.feeTokenB),
        unlocked: big(state.unlockedLiquidity),
        locked: big(state.permanentLockedLiquidity),
        vesting: big(state.vestedLiquidity),
      };
      out.push(positionFromChain(raw, await look(raw.tokenAMint), await look(raw.tokenBMint)));
    } catch {
      // A position that cannot be read (closed meanwhile, a pool this version does not understand) is left out rather than shown wrong.
    }
  }
  return { positions: out, truncated: nfts.length > MAX_POSITIONS };
}
