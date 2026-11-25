/**
 * The owner's side of free token profiles (docs/token-profiles.md), on the private owner page: requests waiting for review (tokens whose
 * sender does not control them, most pump.fun tokens), what is live, and tokens blocked after a removal. The server checks the owner on
 * every action (api/_tokenProfiles.ts answers 404 to anyone else); nothing here is trusted.
 */
const API = '/api/swings-profiles';

interface Row {
  id: number;
  chain: string;
  address: string;
  proof: string;
  submitted_by: string;
  description: string;
  website: string | null;
  x: string | null;
  telegram: string | null;
  discord: string | null;
  logo: string | null;
  created_at: number;
  updated_at: number;
}
interface Block {
  chain: string;
  address: string;
  blocked_at: number;
  reason: string | null;
}

const EXPLORER: Readonly<Record<string, string>> = {
  solana: 'https://solscan.io/token/',
  ethereum: 'https://etherscan.io/token/',
  bnb: 'https://bscscan.com/token/',
  polygon: 'https://polygonscan.com/token/',
  base: 'https://basescan.org/token/',
  robinhood: 'https://robinhoodchain.blockscout.com/token/',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

const when = (ms: number): string => new Date(ms).toLocaleString();

function link(url: string, text: string): HTMLAnchorElement {
  const a = el('a', text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow';
  return a;
}

/** One profile as the owner reviews it: the token, who sent it, the text and every link written out in full. */
function describe(r: Row): HTMLElement {
  const box = el('div', undefined, 'oa-tp');
  const head = el('p', undefined, 'oa-tp-head');
  head.append(el('strong', r.chain), document.createTextNode(' · '), link(`${EXPLORER[r.chain] ?? ''}${r.address}`, r.address));
  box.append(head, el('p', `Sent by ${r.submitted_by} · ${when(r.created_at)}${r.proof === 'authority' ? ' · controls the token' : ''}`, 'oa-note'));
  if (r.logo) {
    const img = el('img', undefined, 'oa-tp-logo');
    img.src = r.logo;
    img.alt = 'Logo';
    img.width = 48;
    img.height = 48;
    img.referrerPolicy = 'no-referrer';
    box.append(img);
  }
  if (r.description) box.append(el('p', r.description, 'oa-tp-desc'));
  const links = el('ul', undefined, 'oa-tp-links');
  for (const [label, url] of [['Website', r.website], ['X', r.x], ['Telegram', r.telegram], ['Discord', r.discord]] as const) {
    if (!url) continue;
    const li = el('li', `${label}: `);
    li.append(link(url, url));
    links.append(li);
  }
  if (links.childElementCount > 0) box.append(links);
  return box;
}

export function profilesSection(token: string): HTMLElement {
  const box = el('section', undefined, 'oa-section');
  box.id = 'oa-profiles';
  box.append(el('h2', 'Token profiles', 'oa-section-title'));
  box.append(el('p', 'Free profiles creators publish for their token’s page. Approve requests from wallets that do not control the token (most pump.fun tokens) after checking who sent them, for example that the sender created the token. Remove anything that impersonates, scams or is adult content: a removed token cannot post again until you allow it.', 'oa-note'));
  const status = el('p', undefined, 'oa-status');
  status.setAttribute('role', 'status');
  const body = el('div', undefined, 'oa-grid');
  box.append(status, body);

  const call = async (payload: Record<string, unknown>): Promise<unknown> => {
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
    const out = (await res.json().catch(() => null)) as { message?: string } | null;
    if (!res.ok) throw new Error(out?.message ?? 'That did not work. Sign in again and retry.');
    return out;
  };
  const button = (label: string, primary: boolean, act: () => Promise<void>): HTMLButtonElement => {
    const b = el('button', label, primary ? 'oa-btn oa-btn--primary' : 'oa-btn');
    b.type = 'button';
    b.addEventListener('click', () => {
      b.disabled = true;
      void act().then(load, (e: unknown) => {
        status.textContent = e instanceof Error ? e.message : 'That did not work.';
        status.classList.add('is-bad');
        b.disabled = false;
      });
    });
    return b;
  };

  async function load(): Promise<void> {
    status.textContent = 'Loading token profiles…';
    status.classList.remove('is-bad');
    try {
      const data = (await call({ op: 'admin-list' })) as { pending: Row[]; live: Row[]; blocks: Block[] };
      status.textContent = '';
      body.replaceChildren();

      const waiting = el('div', undefined, 'oa-card oa-card--wide');
      waiting.append(el('h2', `Waiting for review (${data.pending.length})`));
      if (data.pending.length === 0) waiting.append(el('p', 'Nothing is waiting.', 'oa-empty'));
      for (const r of data.pending) {
        const item = describe(r);
        const row = el('div', undefined, 'oa-row');
        row.append(
          button('Approve', true, async () => void (await call({ op: 'admin-approve', id: r.id }))),
          button('Reject', false, async () => void (await call({ op: 'admin-reject', id: r.id }))),
          button('Remove and block token', false, async () => void (await call({ op: 'admin-remove', chain: r.chain, address: r.address, reason: 'from review' }))),
        );
        item.append(row);
        waiting.append(item);
      }

      const live = el('div', undefined, 'oa-card oa-card--wide');
      live.append(el('h2', `Live (${data.live.length})`));
      if (data.live.length === 0) live.append(el('p', 'No profiles are live yet.', 'oa-empty'));
      for (const r of data.live) {
        const item = describe(r);
        item.append(button('Remove and block token', false, async () => void (await call({ op: 'admin-remove', chain: r.chain, address: r.address }))));
        live.append(item);
      }

      const blocked = el('div', undefined, 'oa-card oa-card--wide');
      blocked.append(el('h2', `Blocked tokens (${data.blocks.length})`));
      if (data.blocks.length === 0) blocked.append(el('p', 'No token is blocked.', 'oa-empty'));
      for (const b of data.blocks) {
        const item = el('div', undefined, 'oa-tp');
        const head = el('p', undefined, 'oa-tp-head');
        head.append(el('strong', b.chain), document.createTextNode(' · '), link(`${EXPLORER[b.chain] ?? ''}${b.address}`, b.address));
        item.append(head, el('p', `Blocked ${when(b.blocked_at)}${b.reason ? ` · ${b.reason}` : ''}`, 'oa-note'), button('Allow again', false, async () => void (await call({ op: 'admin-unblock', chain: b.chain, address: b.address }))));
        blocked.append(item);
      }
      body.append(waiting, live, blocked);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : 'Token profiles could not be loaded.';
      status.classList.add('is-bad');
    }
  }
  void load();
  return box;
}
