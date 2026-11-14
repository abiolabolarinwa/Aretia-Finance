/**
 * The Ultimate City Search page inside the wallet (milestone 2: welcome, wallet sign-in and the player's profile).
 * Loaded only when the page is opened. Built with textContent, never innerHTML.
 */
import { GameClient, type GameSession } from './client.js';
import type { Signer } from '../swings/account/client.js';
import { browserStorage } from '../swings/history.js';

interface Eth { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
interface Sol { connect(): Promise<{ publicKey: { toString(): string } }>; signMessage(m: Uint8Array, display?: string): Promise<{ signature: Uint8Array }> }

const hex = (m: string): string => '0x' + [...new TextEncoder().encode(m)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function evmSigner(): Promise<Signer> {
  const eth = (window as unknown as { ethereum?: Eth }).ethereum;
  if (!eth) throw new Error('No Ethereum-style wallet was found in this browser.');
  const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  if (!address) throw new Error('No account was shared.');
  return { family: 'evm', address, sign: async (m) => (await eth.request({ method: 'personal_sign', params: [hex(m), address] })) as string };
}

export async function solanaSigner(): Promise<Signer> {
  const w = window as unknown as { phantom?: { solana?: Sol }; solana?: Sol };
  const sol = w.phantom?.solana ?? w.solana;
  if (!sol) throw new Error('No Solana wallet was found in this browser.');
  const address = (await sol.connect()).publicKey.toString();
  return { family: 'solana', address, sign: async (m) => btoa(String.fromCharCode(...(await sol.signMessage(new TextEncoder().encode(m), 'utf8')).signature)) };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  e.append(...kids);
  return e;
}

const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function initGame(root: HTMLElement): { onShow(): void } {
  const client = new GameClient(browserStorage());
  let session: GameSession | null = client.saved();
  let message = '';
  let busy = false;

  async function signIn(make: () => Promise<Signer>): Promise<void> {
    if (busy) return;
    busy = true;
    message = '';
    draw();
    try {
      session = await client.signIn(await make());
    } catch (e) {
      message = e instanceof Error ? e.message : 'Signing in did not work. Try again.';
    }
    busy = false;
    draw();
  }

  async function signOut(everywhere: boolean): Promise<void> {
    if (session) await client.signOut(session, everywhere);
    session = null;
    draw();
  }

  function stat(label: string, value: string): HTMLElement {
    return el('div', {}, el('dt', { text: label }), el('dd', { text: value }));
  }

  function draw(): void {
    const intro = el('div', { class: 'wapp__card' }, el('h2', { class: 'wapp__h2', text: 'Ultimate City Search' }));
    intro.append(
      el('p', { text: 'A treasure hunt across nine cities: Lagos, New York, Nairobi, Hong Kong, London, Dubai, Paris, Miami and Nicosia. Follow clues, explore the map and find hidden treasures.' }),
      el('p', { class: 'wapp__fine', text: 'The game is being built in stages. Signing in and your player profile are ready. The cities, clues and treasures are not open yet, and nothing here can be won today.' }),
      el('p', { class: 'wapp__fine', text: 'It is a separate game. It does not use ACT or any token, and signing in is a free message, not a transaction or an approval.' }),
    );

    const card = el('div', { class: 'wapp__card' });
    if (session) {
      const p = session.profile;
      card.append(
        el('span', { class: 'wapp__eyebrow', text: 'Your player' }),
        el('dl', { class: 'wapp__rows' }, stat('Wallet', `${short(session.address)} (${session.network === 'evm' ? 'Ethereum-style' : 'Solana'})`), stat('Explorer level', String(p.explorerLevel)), stat('XP', String(p.totalXp)), stat('Discoveries', String(p.totalDiscoveries)), stat('Missions completed', String(p.missionsCompleted))),
      );
      const out = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Sign out' });
      out.type = 'button';
      out.addEventListener('click', () => void signOut(false));
      const all = el('button', { class: 'wapp__btn wapp__btn--ghost', text: 'Sign out everywhere' });
      all.type = 'button';
      all.addEventListener('click', () => void signOut(true));
      card.append(out, all);
    } else {
      card.append(el('span', { class: 'wapp__eyebrow', text: 'Sign in to play' }), el('p', { class: 'wapp__fine', text: 'Choose the wallet that will be your player. You can look around without signing in, but progress is only kept for a signed-in wallet.' }));
      for (const [label, make] of [['Sign in with an Ethereum-style wallet', evmSigner], ['Sign in with a Solana wallet', solanaSigner]] as const) {
        const b = el('button', { class: 'wapp__btn wapp__btn--primary', text: busy ? 'Waiting for your wallet…' : label });
        b.type = 'button';
        b.disabled = busy;
        b.addEventListener('click', () => void signIn(make));
        card.append(b);
      }
    }
    if (message) card.append(el('p', { class: 'wapp__fine', text: message }));
    root.replaceChildren(intro, card);
  }

  return {
    onShow() {
      draw();
      // Refresh the profile from the server (it is the record; the browser only remembers the sign-in).
      if (session) {
        const s = session;
        void client.me(s).then((profile) => {
          if (session === s) {
            session = { ...s, profile };
            draw();
          }
        }).catch(() => {
          if (!client.saved()) {
            session = null;
            draw();
          }
        });
      }
    },
  };
}
