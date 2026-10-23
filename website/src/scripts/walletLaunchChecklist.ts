/**
 * The plain "before you sign" checklist on the Launch page: what is locked for good, what it costs in total in the chain's own coin,
 * and what the creator keeps. Pure text and arithmetic, built from the same numbers the review and the transaction use, so it can
 * never say something the transaction does not do. It never says a token is safe, audited or guaranteed.
 */
import { bpsText, estimateCost, pctToBps, type CostEstimate } from './walletLaunchCore';
import { fromSmallestUnit } from './walletTools';

export interface Checklist {
  /** What cannot be undone once the transaction is signed. */
  locked: string[];
  /** The cost lines, in the chain's coin, ending with the total. */
  cost: { label: string; value: string; total?: boolean }[];
  /** What the creator keeps, and what stays unlocked. */
  keeps: string[];
  /** One line saying how firm the cost numbers are. */
  costNote: string;
}

const grouped = (text: string): string => text.replace(/^(\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));

// ---------------------------------------------------------------- Solana

/** Solana rent: 6,960 lamports per byte for the account plus its 128-byte header (two years' worth, the rule the network applies). */
export const SOLANA_RENT_PER_BYTE = 6960n;
export const rentFor = (size: number): bigint => (BigInt(size) + 128n) * SOLANA_RENT_PER_BYTE;

export interface SolanaChecklistInput {
  symbol: string;
  /** The supply as the person wrote it, in whole tokens. */
  supplyText: string;
  nameChangeable: boolean;
  /** The creator's share, the treasury's share and the held-back rest, in basis points. Null while a percentage is not valid yet. */
  creatorBps: number | null;
  treasuryBps: number;
  cost: CostEstimate;
  /** True when `cost` was read from the network at review; false for the estimate on the form. */
  exact: boolean;
}

const sol = (lamports: bigint): string => `${fromSmallestUnit(lamports, 9)} SOL`;

export function solanaChecklist(i: SolanaChecklistInput): Checklist {
  const sym = i.symbol || 'the token';
  const reservedBps = i.creatorBps === null ? null : 10_000 - i.creatorBps - i.treasuryBps;
  const locked = [
    `The supply is fixed for good${i.supplyText ? ` at ${grouped(i.supplyText.replace(/,/g, ''))} ${sym}` : ''}. The right to create more is given up in the same transaction, so nobody, you included, can mint more.`,
    'The right to freeze a holder is given up too. Nobody can freeze anyone’s tokens.',
    i.nameChangeable ? 'Not locked: you chose to keep the right to change the name, symbol and details later.' : 'The name, symbol and details cannot be changed after creation.',
    'This transaction opens no pool. Any liquidity pool you open afterwards from this page is locked for good, so the liquidity can never be taken out.',
    'A created token cannot be deleted, and the fees below are not refunded.',
  ];
  const cost: Checklist['cost'] = [
    { label: 'Aretia fee', value: sol(i.cost.aretiaFee) },
    { label: 'Network fees', value: sol(i.cost.networkFee) },
    { label: `Deposits for ${1 + i.cost.accountCount} accounts (the token and ${i.cost.accountCount} wallet${i.cost.accountCount === 1 ? '' : 's'})`, value: sol(i.cost.mintDeposit + i.cost.tokenAccountDeposits) },
    { label: i.exact ? 'Total' : 'Total, about', value: sol(i.cost.total), total: true },
  ];
  const keeps: string[] = [];
  if (i.creatorBps !== null && reservedBps !== null) {
    keeps.push(`You receive ${bpsText(i.creatorBps)} as your share and ${bpsText(reservedBps)} held back, ${bpsText(i.creatorBps + reservedBps)} in all, in your own wallet.`);
    if (i.treasuryBps > 0) keeps.push(`${bpsText(i.treasuryBps)} goes to the treasury address you entered.`);
  } else keeps.push('Enter your share to see what you keep.');
  keeps.push('Nothing locks the tokens you keep. You could send or sell them at any time, and holders can see that.');
  return {
    locked,
    cost,
    keeps,
    costNote: i.exact
      ? 'Read from the network’s current rent. Your wallet shows the final amounts.'
      : 'An estimate from the network’s rent rule; the exact amounts are read from the network when you press Review.',
  };
}

/** The estimate shown on the form, before the network has been asked. Uses the same fee and rent rule the review does. */
export function estimateSolanaForm(f: { creatorPct: string; treasuryPct: string; treasuryAddress: string; mintBytes: number; tokenAccountBytes: number }): CostEstimate {
  const treasury = (pctToBps(f.treasuryPct) ?? 0) > 0 && f.treasuryAddress.trim() !== '';
  return estimateCost({ mintDeposit: rentFor(f.mintBytes), tokenAccountDeposit: rentFor(f.tokenAccountBytes), accountCount: treasury ? 2 : 1 });
}

// ---------------------------------------------------------------- Ethereum-style chains

export interface EvmChecklistInput {
  symbol: string;
  supplyText: string;
  coin: string;
  mode: 'locked' | 'plain';
  testnet: boolean;
  feeWei: bigint;
  /** Locked mode only: the coin put in the pool and the share of the supply that goes with it. */
  poolCoinWei: bigint;
  poolBps: number;
  /** Network gas, at most; null when it could not be estimated or has not been yet. */
  gasWei: bigint | null;
}

const coin = (wei: bigint, symbol: string): string => `${fromSmallestUnit(wei, 18)} ${symbol}`;

export function evmChecklist(i: EvmChecklistInput): Checklist {
  const sym = i.symbol || 'the token';
  const locked = [
    `The supply is fixed for good${i.supplyText ? ` at ${grouped(i.supplyText.replace(/,/g, ''))} ${sym}` : ''}. The token has no owner and no mint, pause, freeze or transfer-fee function.`,
    i.mode === 'locked'
      ? `${bpsText(i.poolBps)} of the supply and the ${i.coin} you put in go into a pool whose liquidity is locked for good. Nobody, you and Aretia included, can take it out.`
      : 'This transaction opens no pool. A pool you open afterwards from this page locks its liquidity for good.',
    'Name, symbol and decimals are set at creation and cannot be changed.',
    'A created token cannot be deleted, and the fee is not refunded.',
  ];
  const total = i.feeWei + (i.mode === 'locked' ? i.poolCoinWei : 0n) + (i.gasWei ?? 0n);
  const cost: Checklist['cost'] = [{ label: 'Aretia fee', value: coin(i.feeWei, i.coin) }];
  if (i.mode === 'locked') cost.push({ label: 'Coin for the locked pool', value: coin(i.poolCoinWei, i.coin) });
  cost.push({ label: 'Network gas, at most about', value: i.gasWei === null ? 'priced at Review' : coin(i.gasWei, i.coin) });
  cost.push({ label: i.gasWei === null ? 'Total so far' : 'Total, about', value: coin(total, i.coin), total: true });
  const keeps =
    i.mode === 'locked'
      ? [`You keep the other ${bpsText(10_000 - i.poolBps)} of the supply in your wallet. Nothing locks it, and you could sell it at any time.`]
      : ['You receive the whole supply in your wallet. Nothing locks it, and you could send or sell it at any time.'];
  if (i.testnet) keeps.push('This is a test network: the coins have no value.');
  return {
    locked,
    cost,
    keeps,
    costNote: i.gasWei === null ? 'Gas is priced from the network when you press Review. Your wallet shows the final amount.' : 'Gas is an upper estimate. Your wallet shows the final amount.',
  };
}
