/**
 * The wallet's side of referrals (docs/referrals.md): remember which swaps to report, report them once the person is signed in, and the
 * "Referrals" page where a referrer sees their own link and numbers. Reading the numbers needs the wallet-signed sign-in the account
 * features already use (a free message, never a transaction). Nothing here moves money; the owner pays referrers by hand.
 */
import { AccountClient, type Session, type Signer } from '../swings/account/client.js';
import { browserStorage } from '../swings/history.js';
import { CHAINS, EVM_NATIVE_ADDRESS, isChainId, type ChainId } from '../swings/core/types.js';
import { HUB_TOKENS } from '../swings/dex/hubs.js';
import { KNOWN_TOKENS } from './walletTools.js';
import { REFERRAL_CONFIG, captureFromSearch, readStoredRef, referralLink, referrerPercentOfVolume, type KeyValue } from '../swings/referrals/core.js';
import { takeFeeTxs } from '../swings/referrals/feeTxLog.js';

const QUEUE_KEY = 'aretia-referral-queue-v1';
const API = '/api/swings-referrals';
const MAX_AGE_MS = REFERRAL_CONFIG.maxTxAgeHours * 3_600_000;

interface Queued { chain: ChainId; txs: string[]; at: number }

let signerNow: () => Signer | null = () => null;
const account = new AccountClient(browserStorage());

/** The swap card hands over how to sign (the same signer the "Save to my wallet" button uses). */
export function registerReferralSigner(fn: () => Signer | null): void {
  signerNow = fn;
}

/** Stores the first-touch referrer from the page address. Called on every page; touches nothing when there is no `?ref=`. */
export function captureReferrer(): void {
  try {
    captureFromSearch(location.search, browserStorage() as KeyValue | null, Date.now());
  } catch {
    // no storage: no referral, nothing else changes
  }
}

const readQueue = (): Queued[] => {
  try {
    const v: unknown = JSON.parse(browserStorage()?.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(v) ? (v as Queued[]).filter((q) => q && isChainId(q.chain) && Array.isArray(q.txs) && typeof q.at === 'number') : [];
  } catch {
    return [];
  }
};
const writeQueue = (q: Queued[]): void => {
  try {
    browserStorage()?.setItem(QUEUE_KEY, JSON.stringify(q.slice(-20)));
  } catch {
    // not remembered: the swap is simply not reported
  }
};

/** Called when a swap has confirmed. Does nothing unless this browser arrived through a referral link. */
export function swapConfirmed(chain: ChainId, txId: string | undefined): void {
  if (!txId || !readStoredRef(browserStorage() as KeyValue | null, Date.now())) return;
  const txs = [...new Set([...takeFeeTxs(chain), txId])];
  writeQueue([...readQueue(), { chain, txs, at: Date.now() }]);
  void flushReferrals();
}

/** How many confirmed swaps are waiting to be reported (they are reported once the person has signed in). */
export const pendingReports = (): number => readQueue().filter((q) => Date.now() - q.at < MAX_AGE_MS).length;

let flushing = false;
/** Reports waiting swaps if the person is signed in. Safe to call any time. */
export async function flushReferrals(): Promise<void> {
  if (flushing) return;
  const sg = signerNow();
  const session = sg ? account.session(sg.family, sg.address) : null;
  if (!session) return;
  flushing = true;
  try {
    const ref = readStoredRef(browserStorage() as KeyValue | null, Date.now())?.ref;
    const keep: Queued[] = [];
    for (const item of readQueue()) {
      if (Date.now() - item.at >= MAX_AGE_MS) continue;
      const family = CHAINS[item.chain].kind === 'solana' ? 'solana' : 'evm';
      if (family !== sg!.family) {
        keep.push(item);
        continue;
      }
      try {
        const r = await account.call<{ results?: { result: string }[] }>(session, { op: 'record', ref, chain: item.chain, txs: item.txs, swapTx: item.txs[item.txs.length - 1] }, API);
        // A transaction the node could not show yet is tried again; everything else is final.
        if ((r.results ?? []).some((x) => x.result === 'pending' || x.result === 'unreadable')) keep.push(item);
      } catch {
        keep.push(item);
      }
    }
    writeQueue(keep);
  } finally {
    flushing = false;
  }
}

// ------------------------------------------------------------------------------------------------ the page

interface Mine {
  revoked: boolean;
  traders: number;
  activeTraders: number;
  tradersWithSwaps: number;
  notCounted: { capped: number; flagged: number; otherFamily: number };
  totals: { chain: string; asset: string; swaps: number; fee: string; volume: string; owed: string }[];
}

function units(raw: string, decimals: number): string {
  const n = BigInt(raw);
  const d = 10n ** BigInt(decimals);
  const whole = n / d;
  const frac = (n % d).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}

function assetLabel(chain: string, asset: string): { symbol: string; decimals: number } {
  if (!isChainId(chain)) return { symbol: asset.slice(0, 6), decimals: 0 };
  const info = CHAINS[chain];
  if (asset === EVM_NATIVE_ADDRESS) return { symbol: info.nativeSymbol, decimals: info.nativeDecimals };
  if (chain === 'solana') {
    const k = KNOWN_TOKENS.find((t) => t.mint === asset);
    return k ? { symbol: k.symbol, decimals: k.decimals } : { symbol: asset.slice(0, 6), decimals: 0 };
  }
  const h = HUB_TOKENS[chain]?.find((t) => t.address.toLowerCase() === asset.toLowerCase());
  return h ? { symbol: h.symbol, decimals: h.decimals } : { symbol: asset.slice(0, 6), decimals: 0 };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Draws the Referrals page into `root`. `getAddress` is the connected wallet (for the link); the numbers need the sign-in. */
export function initReferrals(root: HTMLElement): { onShow(): void } {
  let mine: Mine | null = null;
  /** Whose numbers and message are on the page; they are never shown beside another wallet's link. */
  let shownFor: string | null = null;
  let message = '';
  let busy = false;
  const who = (sg: Signer | null): string | null => (sg ? `${sg.family}:${sg.address}` : null);

  async function load(): Promise<void> {
    const sg = signerNow();
    if (!sg || busy) return;
    busy = true;
    message = '';
    draw();
    try {
      const session: Session = account.session(sg.family, sg.address) ?? (await account.signIn(sg));
      const got = await account.call<Mine>(session, { op: 'mine' }, API);
      // The wallet changed while this was loading: the answer belongs to the last one.
      if (who(signerNow()) !== who(sg)) return;
      mine = got;
      void flushReferrals();
    } catch (e) {
      if (who(signerNow()) !== who(sg)) return;
      message = e instanceof Error ? (/reject|declin|denied/i.test(e.message) ? 'The sign-in was declined, so nothing was loaded.' : e.message) : 'Your numbers could not be loaded.';
    } finally {
      busy = false;
      draw();
    }
  }

  function draw(): void {
    root.textContent = '';
    const sg = signerNow();
    if (who(sg) !== shownFor) {
      mine = null;
      message = '';
      shownFor = who(sg);
    }
    const card = el('div', 'wapp__card');
    card.append(el('h2', '', 'Referrals'));
    card.append(el('p', 'wapp__fine', `Share your link. When someone arrives through it and swaps in this wallet, you earn 20% of the Aretia swap fee they pay, about ${referrerPercentOfVolume()} of what they swap, for ${REFERRAL_CONFIG.windowDays} days from their first swap. They pay exactly the same 0.58% as anyone else: your share comes out of Aretia's fee, not on top of it.`));

    if (!sg) {
      card.append(el('p', '', 'Connect your wallet to get your link.'));
    } else {
      const link = referralLink(sg.address);
      const row = el('div', 'wapp-ref__link');
      const input = el('input');
      input.type = 'text';
      input.readOnly = true;
      input.value = link;
      input.setAttribute('aria-label', 'Your referral link');
      const copy = el('button', 'wapp__btn wapp__btn--ghost', 'Copy link');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(link).then(() => (copy.textContent = 'Copied'), () => input.select());
      });
      row.append(input, copy);
      card.append(row);
      card.append(el('p', 'wapp__fine', 'The link holds only your wallet address. Anyone can see it, so nothing private is in it.'));

      const pending = pendingReports();
      if (pending > 0 && !account.session(sg.family, sg.address)) card.append(el('p', 'wapp__banner wapp__banner--info', `${pending} of your swap${pending === 1 ? '' : 's'} came through a referral link and ${pending === 1 ? 'is' : 'are'} waiting to be counted. Sign in below (a free message, not a transaction) to count ${pending === 1 ? 'it' : 'them'} for the person who invited you.`));

      const btn = el('button', 'wapp__btn wapp__btn--primary', busy ? 'Waiting for your wallet…' : mine ? 'Refresh my numbers' : 'Show my numbers');
      btn.type = 'button';
      btn.disabled = busy;
      btn.addEventListener('click', () => void load());
      card.append(btn);
      if (message) card.append(el('p', 'wapp__banner wapp__banner--warn', message));

      if (mine) {
        if (mine.revoked) card.append(el('p', 'wapp__banner wapp__banner--warn', 'Referral earnings on this address have been switched off by Aretia, for example after misuse. Nothing is owed from now on.'));
        card.append(el('p', '', `People you brought: ${mine.traders} (${mine.activeTraders} still inside the ${REFERRAL_CONFIG.windowDays}-day window, ${mine.tradersWithSwaps} with swaps counted).`));
        if (mine.totals.length === 0) card.append(el('p', 'wapp__fine', 'Nothing owed yet.'));
        else {
          const table = el('table', 'wapp-tx__table');
          const head = el('tr');
          for (const h of ['Network', 'Coin', 'Swaps', 'Their volume (estimate)', 'You are owed']) head.append(el('th', '', h));
          table.append(head);
          for (const t of mine.totals) {
            const a = assetLabel(t.chain, t.asset);
            const tr = el('tr');
            const net = isChainId(t.chain) ? CHAINS[t.chain].name : t.chain;
            tr.append(el('td', '', net), el('td', '', a.symbol), el('td', 'num', String(t.swaps)), el('td', 'num', `${units(t.volume, a.decimals)} ${a.symbol}`), el('td', 'num', `${units(t.owed, a.decimals)} ${a.symbol}`));
            table.append(tr);
          }
          const wrap = el('div', 'wapp-tx');
          wrap.append(table);
          card.append(wrap);
        }
        const nc = mine.notCounted;
        if (nc.capped + nc.flagged + nc.otherFamily > 0) card.append(el('p', 'wapp__fine', `Not counted: ${nc.capped} over the daily limit, ${nc.flagged} that looked automated, ${nc.otherFamily} on a network your address cannot be paid on (an Ethereum-style address earns on Ethereum-style networks; a Solana address earns on Solana).`));
      }
    }

    const how = el('div', 'wapp-ref__how');
    how.append(el('h3', '', 'How and when you are paid'));
    how.append(el('p', 'wapp__fine', `Payouts are made by Aretia by hand, not automatically, on a schedule Aretia sets, in the coin each amount is owed in, to the address you signed in with, and only once what you are owed is worth at least about $${REFERRAL_CONFIG.minimumPayoutUsd}. This page shows what is recorded; it is not a balance you can withdraw.`));
    how.append(el('h3', '', 'Terms'));
    const ul = el('ul', 'wapp__fine');
    for (const t of [
      'There is no guarantee of any amount, or that the programme continues. Aretia can change the share, the window, the limits or stop it at any time; changes apply to swaps after the change.',
      'Only swaps that really paid the Aretia fee count, checked on the blockchain. Swaps by yourself, by wallets you control, or between people who invited each other do not count.',
      'Daily limits apply, and swaps that look automated earn nothing. Misuse voids all earnings on the address and can end it for good.',
      'Figures here are estimates for your information. Nothing on this page is financial, tax or legal advice, and you are responsible for any tax on what you receive.',
    ]) ul.append(el('li', '', t));
    how.append(ul);
    card.append(how);
    root.append(card);
  }

  const style = document.createElement('style');
  style.textContent = '.wapp-ref__link{display:flex;gap:8px;margin:12px 0}.wapp-ref__link input{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--color-border);border-radius:8px;font:inherit;font-size:13px}.wapp-ref__how{margin-top:20px}.wapp-ref__how h3{font-size:14px;margin:14px 0 6px}.wapp-ref__how ul{padding-left:18px}';
  document.head.append(style);
  draw();
  return {
    onShow(): void {
      draw();
      void flushReferrals();
    },
  };
}
