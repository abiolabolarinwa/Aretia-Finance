/**
 * The "Your pools" stage of the Launch page: the pools a wallet owns a position in, what it has earned in trading fees, and a Claim
 * button. This file only draws it and connects it to the wallet; the rules are in walletYourPoolsCore.ts, the claim transaction and its
 * check in walletYourPoolsTx.ts, the chain reads in walletYourPoolsChain.ts and the order of events in walletYourPoolsFlow.ts.
 *
 * Aretia takes nothing when fees are claimed here (see walletYourPoolsCore.ts). Everything read from the chain is shown with
 * textContent, never as markup.
 */
import { LaunchError, friendlyError } from './walletLaunchFlow';
import { RPC_URL, fetchAccount, loadWeb3, rpcFetch, signAndSubmitTransaction, simulateTransaction, waitForConfirmation } from './walletSend';
import { claimableText, hasClaimable, lockText, pairName, type PoolPosition } from './walletYourPoolsCore';
import { readPositions } from './walletYourPoolsChain';
import { YourPoolsFlow, type ClaimOutcome, type ClaimProgress } from './walletYourPoolsFlow';
import { createYourPoolsEvm, type YourPoolsEvmHost } from './walletYourPoolsEvm';

export interface YourPoolsHost {
  /** The connected Solana wallet, or null. */
  getAddress(): string | null;
  /** Re-reads balances after something was claimed. */
  refreshWallet(): void;
  /** Whether the Launch page is on Solana. The list is for Solana pools. */
  onSolana(): boolean;
  /** The Ethereum-style side: the chosen network and wallet, for Aretia Pool positions. Without it the list is Solana only. */
  evm?: YourPoolsEvmHost;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;
const STEP_TEXT: Record<ClaimProgress, string> = {
  checking: 'Checking the claim…',
  signing: 'Approve it in your wallet…',
  confirming: 'Claiming on Solana…',
  verifying: 'Reading it back…',
  done: 'Done',
};

export function initYourPools(host: YourPoolsHost): { onShow(): void; onWalletChange(): void } {
  const root = document.querySelector<HTMLElement>('[data-pools-root]');

  let positions: PoolPosition[] = [];
  let truncated = false;
  let loaded = false;
  let loading = false;
  let error: string | null = null;
  const working = new Map<string, ClaimProgress>();
  const results = new Map<string, ClaimOutcome>();
  const problems = new Map<string, string>();
  let flow: YourPoolsFlow | null = null;
  const evmPools = host.evm ? createYourPoolsEvm(host.evm, () => draw()) : null;

  async function flowFor(): Promise<YourPoolsFlow> {
    if (flow) return flow;
    const web3 = await loadWeb3();
    const [sdk, bn] = await Promise.all([import('@meteora-ag/cp-amm-sdk'), import('bn.js')]);
    // Through the site's own proxy first (it allows the token-account reads this needs), the public endpoint only as a fallback.
    const connection = new web3.Connection(RPC_URL, { fetch: rpcFetch as typeof fetch });
    const libs = { sdk, BN: bn.default, cpAmm: new sdk.CpAmm(connection) };
    flow = new YourPoolsFlow({
      web3,
      libs,
      readPositions: (owner) => readPositions(web3, libs, connection, fetchAccount, owner),
      latestBlockhash: async () => {
        const b = await connection.getLatestBlockhash('confirmed');
        return { blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight };
      },
      simulate: simulateTransaction,
      signAndSubmit: (tx) => signAndSubmitTransaction(tx),
      confirm: (signature) => waitForConfirmation(signature),
    });
    return flow;
  }

  // ---------------------------------------------------------------- drawing

  function drawPosition(p: PoolPosition): HTMLElement {
    const li = h('li', `lh-pos${hasClaimable(p) ? ' has-fees' : ''}`);
    const top = h('div', 'lh-pos__top');
    const locked = lockText(p);
    top.append(h('h3', 'lh-pos__name', pairName(p)), h('span', `lh-pos__lock${locked === 'Locked for good' ? '' : ' is-open'}`, locked));
    const rows = h('dl', 'lh-pos__rows');
    const row = (k: string, v: string | HTMLElement): void => {
      const d = h('div');
      const dd = h('dd');
      if (typeof v === 'string') dd.textContent = v;
      else dd.append(v);
      d.append(h('dt', '', k), dd);
      rows.append(d);
    };
    row('Fees you can claim', claimableText(p));
    const a = h('a', '', short(p.pool));
    a.href = `https://app.meteora.ag/dammv2/${encodeURIComponent(p.pool)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    row('Pool', a);

    const actions = h('div', 'lh-pos__actions');
    const busy = working.get(p.position);
    const claim = h('button', 'wapp__btn wapp__btn--primary', busy ? STEP_TEXT[busy] : 'Claim fees');
    claim.type = 'button';
    claim.disabled = busy !== undefined || !hasClaimable(p);
    claim.addEventListener('click', () => void doClaim(p));
    actions.append(claim);
    if (!hasClaimable(p)) actions.append(h('p', 'lh-pos__note', 'Fees appear here as people trade.'));
    li.append(top, rows, actions);

    const problem = problems.get(p.position);
    if (problem) {
      const e = h('p', 'wapp__banner wapp__banner--warn', problem);
      e.setAttribute('role', 'alert');
      li.append(e);
    }
    const result = results.get(p.position);
    if (result) {
      const ok = result.differences.length === 0;
      li.append(h('p', ok ? 'lh-pos__ok' : 'wapp__banner wapp__banner--warn', ok ? 'Claimed. The fees are in your wallet.' : result.differences.join(' ')));
    }
    return li;
  }

  function draw(): void {
    if (!root) return;
    root.textContent = '';
    const wrap = h('div', 'lh-yp');
    const head = h('div', 'lh-yp__head');
    head.append(h('h2', '', 'Your pools'));
    const back = h('button', 'lh-nav__back', '← Back to launch');
    back.type = 'button';
    back.addEventListener('click', () => root.dispatchEvent(new CustomEvent('lh:back', { bubbles: true })));
    head.append(back);
    wrap.append(head);

    if (!host.onSolana()) {
      if (evmPools) evmPools.draw(wrap);
      else wrap.append(h('p', 'lh-yp__none', 'This list is for Solana pools. Pools on BNB Chain, Ethereum and Polygon keep their trading fees inside the pool, so there is nothing to claim there. Switch the network to Solana to see yours.'));
      root.append(wrap);
      return;
    }
    const address = host.getAddress();
    if (!address) {
      wrap.append(h('p', 'lh-yp__none', 'Connect a Solana wallet to see the pools you own and the fees they have earned.'));
      root.append(wrap);
      return;
    }
    wrap.append(h('p', 'wapp__fine', 'The trading fees your pools have earned are yours. Claiming is free: Aretia takes nothing, and the fees go straight to your wallet.'));
    if (error) {
      const e = h('p', 'wapp__banner wapp__banner--warn', error);
      e.setAttribute('role', 'alert');
      wrap.append(e);
    }
    if (loading && !loaded) wrap.append(h('p', 'lh-yp__none', 'Looking for your pools…'));
    else if (loaded && positions.length === 0 && !error) wrap.append(h('p', 'lh-yp__none', 'No pools yet. When you open a pool from the Launch page it appears here, with the fees it earns.'));
    if (positions.length > 0) {
      const list = h('ul', 'lh-yp__list');
      for (const p of positions) list.append(drawPosition(p));
      wrap.append(list);
      if (truncated) wrap.append(h('p', 'wapp__fine', 'Showing the first 50 pools.'));
    }
    const refresh = h('button', 'wapp__btn wapp__btn--ghost', loading ? 'Refreshing…' : 'Refresh');
    refresh.type = 'button';
    refresh.disabled = loading;
    refresh.addEventListener('click', () => void load());
    wrap.append(refresh);
    root.append(wrap);
  }

  // ---------------------------------------------------------------- actions

  async function load(): Promise<void> {
    if (!host.onSolana()) {
      if (evmPools) await evmPools.load();
      else draw();
      return;
    }
    const owner = host.getAddress();
    if (!owner) {
      draw();
      return;
    }
    loading = true;
    error = null;
    draw();
    try {
      const r = await (await flowFor()).list(owner);
      positions = r.positions;
      truncated = r.truncated;
      loaded = true;
    } catch (e) {
      error = `Could not read your pools from the network: ${friendlyError(e)}`;
    } finally {
      loading = false;
      draw();
    }
  }

  async function doClaim(p: PoolPosition): Promise<void> {
    const owner = host.getAddress();
    if (!owner) return;
    problems.delete(p.position);
    results.delete(p.position);
    working.set(p.position, 'checking');
    draw();
    try {
      const outcome = await (await flowFor()).claim(owner, p, (s) => {
        working.set(p.position, s);
        draw();
      });
      results.set(p.position, outcome);
      if (outcome.after) positions = positions.map((x) => (x.position === p.position ? outcome.after! : x));
      host.refreshWallet();
    } catch (e) {
      problems.set(p.position, e instanceof LaunchError ? e.message : friendlyError(e));
    } finally {
      working.delete(p.position);
      draw();
    }
  }

  return {
    onShow(): void {
      draw();
      void load();
    },
    onWalletChange(): void {
      // A different wallet is a different person: nothing read or approved for the last one carries over.
      positions = [];
      loaded = false;
      error = null;
      evmPools?.reset();
      working.clear();
      results.clear();
      problems.clear();
      draw();
    },
  };
}
