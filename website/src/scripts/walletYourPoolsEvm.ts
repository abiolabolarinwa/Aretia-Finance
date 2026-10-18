/**
 * The Ethereum-style part of the "Your pools" stage: the Aretia Pool positions a wallet holds on the chosen network, the fees each has
 * earned (claimable even while the liquidity is locked for good), and a Claim button. Rules are in walletYourPoolsEvmCore.ts, the chain
 * reads and the claim in walletYourPoolsEvmFlow.ts. Everything read from the chain is shown with textContent, never as markup.
 *
 * It lists only networks that have a deployed pool contract in EVM_POOL_ADDRESSES (and its deployment block), which is none until the
 * contract is deployed. Aretia takes nothing when fees are claimed.
 */
import type { EvmWalletAdapter } from '../swings/chains/evmWallet.js';
import { chainByKey, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { friendlyEvmError } from './walletLaunchEvmFlow';
import { readerFor } from './walletLaunchEvm';
import { EvmPoolError, type EvmPoolProgress } from './walletAretiaPoolEvmFlow';
import { rowClaimText, rowHasClaimable, rowLockText, rowName, type EvmPoolRow } from './walletYourPoolsEvmCore';
import { YourEvmPools, type YourEvmListing } from './walletYourPoolsEvmFlow';

export interface YourPoolsEvmHost {
  /** The network chosen on the Launch page (a LaunchEvmChainKey). */
  network(): string;
  getAccount(): string | null;
  connect(): Promise<{ adapter: EvmWalletAdapter }>;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const STEP_TEXT: Record<EvmPoolProgress, string> = {
  checking: 'Checking the claim…',
  approving: 'Approve it in your wallet…',
  'confirming-approve': 'Confirming…',
  sending: 'Approve it in your wallet…',
  confirming: 'Claiming on the network…',
  verifying: 'Reading it back…',
  done: 'Done',
};

const NO_WALLET = {
  getAccounts: async () => [],
  getChainId: async () => 0,
  switchChain: async () => undefined,
  sendTransaction: async (): Promise<string> => {
    throw new Error('Connect a wallet first.');
  },
};

export function createYourPoolsEvm(host: YourPoolsEvmHost, redraw: () => void): { draw(wrap: HTMLElement): void; load(): Promise<void>; reset(): void } {
  let listing: YourEvmListing | null = null;
  let loading = false;
  let error: string | null = null;
  let adapter: EvmWalletAdapter | null = null;
  const working = new Map<string, EvmPoolProgress>();
  const results = new Map<string, string[]>();
  const problems = new Map<string, string>();
  const keyOf = (r: EvmPoolRow): string => `${r.chain.key}:${r.token}`;

  /** Reads go through each network's own public node; signing goes through the connected wallet's adapter. */
  const engine = (): YourEvmPools =>
    new YourEvmPools({ adapter: adapter ?? NO_WALLET, read: async () => null, now: () => Date.now(), nowSeconds: () => Math.floor(Date.now() / 1000) }, (key: LaunchEvmChainKey) => readerFor(chainByKey(key)!));

  function drawRow(r: EvmPoolRow): HTMLElement {
    const k = keyOf(r);
    const li = h('li', `lh-pos${rowHasClaimable(r) ? ' has-fees' : ''}`);
    const top = h('div', 'lh-pos__top');
    const lock = rowLockText(r);
    top.append(h('h3', 'lh-pos__name', rowName(r)), h('span', `lh-pos__lock${lock === 'Locked for good' ? '' : ' is-open'}`, lock));
    const rows = h('dl', 'lh-pos__rows');
    const row = (key: string, v: string | HTMLElement): void => {
      const d = h('div');
      const dd = h('dd');
      if (typeof v === 'string') dd.textContent = v;
      else dd.append(v);
      d.append(h('dt', '', key), dd);
      rows.append(d);
    };
    row('Fees you can claim', rowClaimText(r));
    row('Fees are paid to', r.position.recipient ?? 'your own wallet');
    const a = h('a', '', short(r.token));
    a.href = `${r.chain.explorer}/address/${encodeURIComponent(r.token)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    row('Token', a);
    const actions = h('div', 'lh-pos__actions');
    const busy = working.get(k);
    const claim = h('button', 'wapp__btn wapp__btn--primary', busy ? STEP_TEXT[busy] : 'Claim fees');
    claim.type = 'button';
    claim.disabled = busy !== undefined || !rowHasClaimable(r);
    claim.addEventListener('click', () => void doClaim(r));
    actions.append(claim);
    if (!rowHasClaimable(r)) actions.append(h('p', 'lh-pos__note', 'Fees appear here as people trade.'));
    li.append(top, rows, actions);
    const problem = problems.get(k);
    if (problem) {
      const e = h('p', 'wapp__banner wapp__banner--warn', problem);
      e.setAttribute('role', 'alert');
      li.append(e);
    }
    const diff = results.get(k);
    if (diff) li.append(h('p', diff.length === 0 ? 'lh-pos__ok' : 'wapp__banner wapp__banner--warn', diff.length === 0 ? 'Claimed. The fees are in your wallet.' : diff.join(' ')));
    return li;
  }

  function draw(wrap: HTMLElement): void {
    const net = host.network();
    if (!engine().chainOf(net)) {
      wrap.append(h('p', 'lh-yp__none', 'Aretia Pool is not live on this network yet, so there are no pools to list here. Pools made on Uniswap or PancakeSwap keep their trading fees inside the pool, so there is nothing to claim for them.'));
      return;
    }
    const account = host.getAccount();
    if (!account) {
      wrap.append(h('p', 'lh-yp__none', `Connect an Ethereum-style wallet to see your Aretia Pool positions on ${chainByKey(net)?.name ?? 'this network'}.`));
      return;
    }
    wrap.append(h('p', 'wapp__fine', 'The trading fees your pools have earned are yours, even while the liquidity is locked. Claiming is free: Aretia takes nothing, and the fees go straight to your wallet (or to the wallet you named).'));
    if (error) {
      const e = h('p', 'wapp__banner wapp__banner--warn', error);
      e.setAttribute('role', 'alert');
      wrap.append(e);
    }
    if (listing?.failed.length) wrap.append(h('p', 'wapp__banner wapp__banner--warn', `Could not read ${listing.failed.join(', ')}. The list may be incomplete.`));
    if (loading && !listing) wrap.append(h('p', 'lh-yp__none', 'Looking for your pools…'));
    else if (listing && listing.rows.length === 0 && !error) wrap.append(h('p', 'lh-yp__none', 'No Aretia Pool positions yet. When you open a pool from the Launch page it appears here, with the fees it earns.'));
    if (listing && listing.rows.length > 0) {
      const list = h('ul', 'lh-yp__list');
      for (const r of listing.rows.filter((x) => x.chain.key === net)) list.append(drawRow(r));
      wrap.append(list);
      if (listing.truncated) wrap.append(h('p', 'wapp__fine', 'Showing the first 50 pools.'));
    }
    const refresh = h('button', 'wapp__btn wapp__btn--ghost', loading ? 'Refreshing…' : 'Refresh');
    refresh.type = 'button';
    refresh.disabled = loading;
    refresh.addEventListener('click', () => void load());
    wrap.append(refresh);
  }

  async function load(): Promise<void> {
    const account = host.getAccount();
    const net = host.network();
    if (!account || !engine().chainOf(net)) return redraw();
    loading = true;
    error = null;
    redraw();
    try {
      listing = await engine().list(account, [net]);
    } catch (e) {
      error = `Could not read your pools from the network: ${friendlyEvmError(e)}`;
    } finally {
      loading = false;
      redraw();
    }
  }

  async function doClaim(r: EvmPoolRow): Promise<void> {
    const account = host.getAccount();
    if (!account) return;
    const k = keyOf(r);
    problems.delete(k);
    results.delete(k);
    working.set(k, 'checking');
    redraw();
    try {
      if (!adapter) adapter = (await host.connect()).adapter;
      const { outcome, after } = await engine().claim(r, account, (p) => {
        working.set(k, p);
        redraw();
      });
      results.set(k, outcome.differences);
      if (after && listing) listing = { ...listing, rows: listing.rows.map((x) => (keyOf(x) === k ? after : x)) };
    } catch (e) {
      problems.set(k, e instanceof EvmPoolError ? e.message : friendlyEvmError(e));
    } finally {
      working.delete(k);
      redraw();
    }
  }

  return {
    draw,
    load,
    reset(): void {
      listing = null;
      error = null;
      adapter = null;
      working.clear();
      results.clear();
      problems.clear();
    },
  };
}
