/**
 * The Ultimate City Search page inside the wallet (milestone 2: welcome, wallet sign-in and the player's profile).
 * Loaded only when the page is opened. Built with textContent, never innerHTML.
 */
import { GameClient, type CityList, type GameSession } from './client.js';
import { CITIES, cityById, type City, type Transport } from './cities.js';
import type { ExploreState } from './explore.js';
import type { HistoryPage, ProgressView } from './progress.js';
import type { AnswerResult, ClueView, MissionSummary, MyTreasure, TreasureCard } from './missions.js';
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
  let list: CityList | null = null;
  // The exploration view keeps its own element so the map survives the page being redrawn around it.
  const exploreHost = document.createElement('div');
  let exploring: { city: string; destroy(): void } | null = null;
  const progressHost = document.createElement('div');
  let progressFor: GameSession | null = null;
  let progressView: { refresh(): void } | null = null;

  function syncProgress(): void {
    const s = session;
    if (progressFor === s) return;
    progressFor = s;
    progressView = null;
    progressHost.replaceChildren();
    if (!s) return;
    void import('./progress.js').then((m) => {
      if (progressFor !== s) return;
      progressView = m.mountProgress(progressHost, {
        progress: () => client.call<ProgressView>(s, { op: 'progress' }),
        history: (before) => client.call<HistoryPage>(s, { op: 'history', ...(before === undefined ? {} : { before }) }),
        setName: (name) => client.call<{ displayName: string }>(s, { op: 'set-profile', name }),
      });
    }).catch(() => {
      progressHost.textContent = 'Your profile could not be loaded. Try again.';
    });
  }
  const missionHost = document.createElement('div');
  let missionsFor: string | null = null;
  missionHost.addEventListener('game-zone', (e) => {
    exploreHost.dispatchEvent(new CustomEvent('game-zone-show', { detail: (e as CustomEvent).detail }));
  });
  exploreHost.addEventListener('game-city-changed', () => {
    const s = session;
    if (!s) return;
    void client.cities(s).then((l) => {
      list = l;
      draw();
    }).catch(() => undefined);
  });

  function syncMissions(want: string | null): void {
    if (missionsFor === want) return;
    missionsFor = want;
    missionHost.replaceChildren();
    const s = session;
    const city = want ? cityById(want) : undefined;
    if (!s || !city) return;
    const call = <T,>(payload: Record<string, unknown>): Promise<T> => client.call<T>(s, payload);
    void import('./missions.js').then((m) => {
      if (missionsFor !== city.id) return;
      m.mountMissions(missionHost, city, {
        missions: (c) => call<{ missions: MissionSummary[] }>({ op: 'missions', city: c }),
        start: (id) => call<ClueView>({ op: 'mission-start', mission: id }),
        clue: (id) => call<ClueView>({ op: 'clue', mission: id }),
        hint: (id) => call<ClueView>({ op: 'hint', mission: id }),
        answer: (id, answer) => call<AnswerResult>({ op: 'answer', mission: id, answer }),
        abandon: (id) => call<unknown>({ op: 'mission-abandon', mission: id }),
        treasures: () => call<{ treasures: MyTreasure[] }>({ op: 'treasures' }),
        collect: (id) => call<{ discovered: boolean; xp: number; treasure: TreasureCard & { verification: string } }>({ op: 'collect', treasure: id }),
      }, () => {
        progressView?.refresh();
        void client.me(s).then((profile) => {
          if (session === s) session = { ...s, profile };
          draw();
        }).catch(() => undefined);
      });
    }).catch(() => {
      missionHost.textContent = 'Missions could not be loaded. Try again.';
    });
  }

  function syncExplore(): void {
    const want = session && list?.selected ? list.selected : null;
    syncProgress();
    syncMissions(want);
    if (exploring && exploring.city === want) return;
    exploring?.destroy();
    exploring = null;
    exploreHost.replaceChildren();
    const s = session;
    const city = want ? cityById(want) : undefined;
    if (!s || !city) return;
    const mine = { city: city.id, destroy() {} };
    exploring = mine;
    void import('./explore.js').then(async (m) => {
      const api = {
        state: () => client.state(s) as Promise<ExploreState>,
        travel: (c: string, mode: Transport, to: [number, number]) => client.travel(s, c, mode, to),
        fly: (to: string) => client.fly(s, to),
      };
      const view = await m.mountExplore(exploreHost, city, api);
      if (exploring === mine) mine.destroy = view.destroy;
      else view.destroy();
    }).catch(() => {
      exploreHost.textContent = 'The map could not be loaded. Try again.';
    });
  }

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
    list = null;
    exploring?.destroy();
    exploring = null;
    exploreHost.replaceChildren();
    missionsFor = null;
    missionHost.replaceChildren();
    progressFor = null;
    progressView = null;
    progressHost.replaceChildren();
    draw();
  }

  async function chooseCity(id: string): Promise<void> {
    if (!session || busy) return;
    busy = true;
    message = '';
    draw();
    try {
      list = await client.selectCity(session, id);
      session = { ...session, profile: { ...session.profile, selectedCity: list.selected } };
    } catch (e) {
      message = e instanceof Error ? e.message : 'That city could not be opened. Try again.';
    }
    busy = false;
    draw();
  }

  function stat(label: string, value: string): HTMLElement {
    return el('div', {}, el('dt', { text: label }), el('dd', { text: value }));
  }

  const TRANSPORT_LABEL: Record<Transport, string> = { walk: 'Walk', run: 'Run', taxi: 'Taxi', car: 'Car', bus: 'Bus', train: 'Train', metro: 'Metro', ferry: 'Ferry', flight: 'Flights' };

  function cityCard(c: City): HTMLElement {
    const state = list?.cities.find((x) => x.id === c.id);
    const open = !state || state.status === 'active';
    const chosen = list?.selected === c.id;
    const card = el('article', { class: 'wapp__card' });
    card.style.borderTop = `4px solid ${c.tint[1]}`;
    card.style.background = `linear-gradient(135deg, ${c.tint[0]}33, transparent 60%)`;
    if (chosen) card.style.outline = `2px solid ${c.tint[1]}`;
    card.append(el('h3', { class: 'wapp__h2', text: c.name }), el('span', { class: 'wapp__eyebrow', text: c.country }), el('p', { text: c.blurb }));
    card.append(el('p', { class: 'wapp__fine', text: `Getting around: ${c.transport.map((t) => TRANSPORT_LABEL[t]).join(', ')}.` }));
    const p = state?.progress;
    card.append(el('p', { class: 'wapp__fine', text: p ? `Your progress: ${p.cityXp} XP, ${p.discoveries} discoveries, ${p.completedMissions} missions. Last visited ${new Date(p.lastVisitAt).toLocaleDateString()}.` : session ? 'Not visited yet.' : 'Sign in to start exploring.' }));
    card.append(el('p', { class: 'wapp__fine', text: 'Missions: none open yet. Treasure events: none yet.' }));
    const b = el('button', { class: chosen ? 'wapp__btn wapp__btn--ghost' : 'wapp__btn wapp__btn--primary', text: chosen ? 'You are here' : !open ? 'Not open yet' : p ? 'Return to ' + c.name : 'Enter ' + c.name });
    b.type = 'button';
    b.disabled = busy || !session || !open || chosen;
    b.addEventListener('click', () => void chooseCity(c.id));
    card.append(b);
    return card;
  }

  function cityNodes(): HTMLElement[] {
    const here = session && list?.selected ? cityById(list.selected) : undefined;
    const out: HTMLElement[] = [];
    const head = el('div', { class: 'wapp__card' }, el('h2', { class: 'wapp__h2', text: here ? `You are in ${here.name}` : 'Choose a city' }));
    head.append(el('p', { class: 'wapp__fine', text: here ? 'You can switch city at any time. Your progress in every city is kept.' : session ? 'Pick where your search begins. You can explore all nine with the same player.' : 'These are the nine cities. You can look around without signing in; progress is only kept for a signed-in wallet.' }));
    out.push(head);
    const grid = el('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px';
    grid.append(...CITIES.map(cityCard));
    out.push(grid);
    return session && list?.selected ? [head, exploreHost, missionHost, progressHost, grid] : session ? [...out, progressHost] : out;
  }

  function draw(): void {
    const intro = el('div', { class: 'wapp__card' }, el('h2', { class: 'wapp__h2', text: 'Ultimate City Search' }));
    intro.append(
      el('p', { text: 'A treasure hunt across nine cities: Lagos, New York, Nairobi, Hong Kong, London, Dubai, Paris, Miami and Nicosia. Follow clues, explore the map and find hidden treasures.' }),
      el('p', { class: 'wapp__fine', text: 'The game is being built in stages. Signing in, your player profile and the nine cities are ready. Maps, clues and treasures are not open yet, and nothing here can be won today.' }),
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
    root.replaceChildren(intro, card, ...cityNodes());
    syncExplore();
  }

  return {
    onShow() {
      draw();
      // Refresh the profile from the server (it is the record; the browser only remembers the sign-in).
      if (session) {
        const s = session;
        void client.cities(s).then((l) => {
          if (session) {
            list = l;
            draw();
          }
        }).catch(() => undefined);
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
