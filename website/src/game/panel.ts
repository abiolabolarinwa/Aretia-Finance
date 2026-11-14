/**
 * The Ultimate City Search page inside the wallet, in three stages: a welcome screen with a Play button (which signs the player in
 * with a wallet), a choice of city (five cities on one row, four on the next), and the game itself with a tab for each part (the
 * map, missions, progress, the leaderboard and, for an administrator, the console). Loaded only when the page is opened. Built with
 * textContent, never innerHTML.
 */
import { GameClient, type CityList, type GameSession } from './client.js';
import { allCities, cityById, type City, type Transport } from './cities.js';
import type { ExploreState } from './explore.js';
import type { HistoryPage, ProgressView } from './progress.js';
import type { BoardView, TeamBoardView, TeamView } from './boards.js';
import type { Period } from './periods.js';
import type { Call } from './admin.js';
import type { AnswerResult, ClueView, MissionSummary, MyTreasure, TreasureCard } from './missions.js';
import type { SignerOption } from './signers.js';
import { installTheme } from './theme.js';
import { browserStorage } from '../swings/history.js';

type Props = { class?: string; text?: string; attrs?: Record<string, string> };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

type Stage = 'welcome' | 'cities' | 'play';
type Tab = 'explore' | 'missions' | 'progress' | 'board' | 'admin';

export function initGame(root: HTMLElement): { onShow(): void } {
  installTheme();
  const client = new GameClient(browserStorage());
  // Anyone can see the cities; the list comes from the server so a newly added city appears without a release.
  void client.catalogue().then(() => draw()).catch(() => undefined);
  let session: GameSession | null = client.saved();
  let message = '';
  let busy = false;
  let signingId = '';
  let openingCity = '';
  let options: SignerOption[] | null = null;
  let list: CityList | null = null;
  /** True once the server has said which city the signed-in player is in, so the right stage is shown first time. */
  let listLoaded = false;
  /** The player pressed "Change city" and is choosing again. */
  let picking = false;
  let tab: Tab = 'explore';
  let isAdmin = false;
  let lastStage: Stage | null = null;

  // Each part of the game keeps its own element, so the map and the other views survive the screen being redrawn around them.
  const exploreHost = document.createElement('div');
  const missionHost = document.createElement('div');
  const progressHost = document.createElement('div');
  const boardsHost = document.createElement('div');
  const adminHost = document.createElement('div');
  const announceHost = document.createElement('div');
  let exploring: { city: string; destroy(): void } | null = null;
  let adminFor: GameSession | null = null;
  let adminView: { destroy(): void } | null = null;
  let boardsFor: GameSession | null = null;
  let boardsView: { refresh(): void; stop(): void } | null = null;
  let progressFor: GameSession | null = null;
  let progressView: { refresh(): void } | null = null;
  let missionsFor: string | null = null;

  function syncAdmin(): void {
    const s = session;
    if (adminFor === s) return;
    adminView?.destroy();
    adminFor = s;
    adminView = null;
    isAdmin = false;
    adminHost.replaceChildren();
    announceHost.replaceChildren();
    if (!s) return;
    const call: Call = <T,>(payload: Record<string, unknown>) => client.call<T>(s, payload);
    // Announcements are for everyone signed in.
    void call<{ announcements: { id: string; title: string; body: string }[] }>({ op: 'announcements' }).then((r) => {
      if (adminFor !== s) return;
      for (const a of r.announcements.slice(0, 3)) {
        const box = document.createElement('div');
        box.className = 'wapp__card';
        const h = document.createElement('strong');
        h.textContent = a.title;
        const p = document.createElement('p');
        p.className = 'wapp__fine';
        p.textContent = a.body;
        box.append(h, p);
        announceHost.append(box);
      }
    }).catch(() => undefined);
    // The console only appears for an administrator; the server decides, and checks again on every call.
    void client.isAdmin(s).then(async (yes) => {
      if (!yes || adminFor !== s) return;
      const m = await import('./admin.js');
      if (adminFor !== s) return;
      adminView = m.mountAdmin(adminHost, call);
      isAdmin = true;
      draw();
    }).catch(() => undefined);
  }

  function syncBoards(): void {
    const s = session;
    if (boardsFor === s) return;
    boardsView?.stop();
    boardsFor = s;
    boardsView = null;
    boardsHost.replaceChildren();
    if (!s) return;
    const call = <T,>(payload: Record<string, unknown>): Promise<T> => client.call<T>(s, payload);
    void import('./boards.js').then((m) => {
      if (boardsFor !== s) return;
      boardsView = m.mountBoards(boardsHost, () => (list?.selected ? (cityById(list.selected) ?? null) : null), {
        board: (city, period: Period) => call<BoardView>({ op: 'leaderboard', period, ...(city ? { city } : {}) }),
        teamBoard: (period: Period) => call<TeamBoardView>({ op: 'team-board', period }),
        team: () => call<TeamView>({ op: 'team' }),
        createTeam: (name) => call<TeamView>({ op: 'team-create', name }),
        joinTeam: (code) => call<TeamView>({ op: 'team-join', code }),
        leaveTeam: () => call<TeamView>({ op: 'team-leave' }),
      });
    }).catch(() => {
      boardsHost.textContent = 'The leaderboard could not be loaded. Try again.';
    });
  }

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

  missionHost.addEventListener('game-zone', (e) => {
    // A treasure zone shown from the missions tab is drawn on the map, so move to the map to see it.
    exploreHost.dispatchEvent(new CustomEvent('game-zone-show', { detail: (e as CustomEvent).detail }));
    tab = 'explore';
    draw();
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
        boardsView?.refresh();
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
    syncBoards();
    syncAdmin();
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

  /** Loads where the signed-in player is up to, then the right stage shows. */
  async function loadList(s: GameSession): Promise<void> {
    try {
      const l = await client.cities(s);
      if (session === s) list = l;
    } catch {
      // the stage falls back to choosing a city
    }
    listLoaded = true;
  }

  /** How long to wait for a wallet that has not answered before saying so. */
  const WALLET_WAIT_MS = 120_000;
  let attempt = 0;

  /** Says why a sign-in did not work in words a player can act on. */
  function whyNot(e: unknown): string {
    const m = e instanceof Error ? e.message : '';
    if (/declin|reject|denied|cancel|refus|user closed/i.test(m)) return 'You declined the request in your wallet. Press the wallet again when you are ready.';
    if (/lock|unlock/i.test(m)) return 'Your wallet looks locked. Unlock it and try again.';
    return m || 'Signing in did not work. Try again.';
  }

  async function signIn(o: SignerOption): Promise<void> {
    if (busy) return;
    busy = true;
    signingId = o.id;
    message = '';
    const mine = ++attempt;
    draw();
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Your wallet did not answer. Open it, check for a waiting request, and try again.')), WALLET_WAIT_MS));
      const s = await Promise.race([(async () => client.signIn(await o.make()))(), timeout]);
      if (mine !== attempt) return; // cancelled while waiting
      session = s;
      listLoaded = false;
      await loadList(s);
      picking = false;
      options = null;
    } catch (e) {
      if (mine !== attempt) return;
      message = whyNot(e);
    }
    busy = false;
    signingId = '';
    draw();
  }

  /** Stops waiting for a wallet, so another can be chosen. */
  function cancelSignIn(): void {
    attempt++;
    busy = false;
    signingId = '';
    message = 'Cancelled. Choose a wallet to try again.';
    draw();
  }

  /** Looks for the wallets this browser has, only when the player presses Play. */
  async function chooseWallet(): Promise<void> {
    if (busy) return;
    busy = true;
    message = '';
    draw();
    try {
      const m = await import('./signers.js');
      options = await m.signerOptions(await m.pageSignerEnv());
    } catch {
      options = [];
      message = 'Wallets could not be looked for. Try again.';
    }
    busy = false;
    draw();
  }

  async function signOut(everywhere: boolean): Promise<void> {
    if (session) await client.signOut(session, everywhere);
    session = null;
    options = null;
    list = null;
    listLoaded = false;
    picking = false;
    tab = 'explore';
    exploring?.destroy();
    exploring = null;
    exploreHost.replaceChildren();
    missionsFor = null;
    missionHost.replaceChildren();
    progressFor = null;
    progressView = null;
    progressHost.replaceChildren();
    boardsView?.stop();
    boardsFor = null;
    boardsView = null;
    boardsHost.replaceChildren();
    adminView?.destroy();
    adminFor = null;
    adminView = null;
    isAdmin = false;
    adminHost.replaceChildren();
    announceHost.replaceChildren();
    draw();
  }

  async function chooseCity(id: string): Promise<void> {
    if (!session || busy) return;
    if (list?.selected === id) {
      picking = false;
      draw();
      return;
    }
    busy = true;
    openingCity = id;
    message = '';
    draw();
    try {
      list = await client.selectCity(session, id);
      session = { ...session, profile: { ...session.profile, selectedCity: list.selected } };
      picking = false;
      tab = 'explore';
    } catch (e) {
      message = e instanceof Error ? e.message : 'That city could not be opened. Try again.';
    }
    busy = false;
    openingCity = '';
    draw();
  }

  // ---------------------------------------------------------------- the three stages

  const steps = (n: 1 | 2 | 3): HTMLElement => {
    const row = el('div', { class: 'ucs-steps' });
    ['1  Welcome', '2  Choose a city', '3  Play'].forEach((label, i) => {
      const s = el('span', { class: 'ucs-step' + (i + 1 < n ? ' done' : ''), text: label });
      if (i + 1 === n) s.setAttribute('aria-current', 'step');
      row.append(s);
    });
    return row;
  };

  function welcome(): HTMLElement {
    const hero = el('section', { class: 'ucs-dark ucs-hero' });
    hero.append(
      steps(1),
      el('span', { class: 'ucs-eyebrow', text: 'Aretia Finance' }),
      el('h1', { class: 'ucs-title' }, 'Welcome to ', el('span', { text: 'Ultimate City Search' })),
      el('p', { class: 'ucs-sub', text: 'Choose your city where you want to find your treasure.' }),
    );
    if (!options) {
      const play = el('button', { class: 'ucs-play', text: busy ? 'Looking for wallets…' : 'Play' });
      play.type = 'button';
      play.disabled = busy;
      play.addEventListener('click', () => void chooseWallet());
      hero.append(play);
    } else {
      const box = el('div', { class: 'ucs-wallets' }, el('h3', { text: 'Choose the wallet that will be your player' }));
      for (const o of options) {
        const b = el('button', { class: 'ucs-wallet', text: signingId === o.id ? 'Waiting for your wallet…' : o.label });
        b.type = 'button';
        b.disabled = busy;
        b.addEventListener('click', () => void signIn(o));
        box.append(b);
      }
      if (options.length === 0) box.append(el('p', { class: 'ucs-note', text: 'No wallet was found in this browser. Install one, or connect a Solana wallet in the sidebar (it can be a phone wallet through WalletConnect), then look again.' }));
      if (signingId) {
        box.append(el('p', { class: 'ucs-note', text: 'Look for a request from your wallet: a pop-up window, or the wallet icon in your browser toolbar. Approve the connection, then the signature. Signing is free and moves no money.' }));
        const stop = el('button', { class: 'ucs-btn', text: 'Cancel' });
        stop.type = 'button';
        stop.addEventListener('click', cancelSignIn);
        box.append(stop);
      } else {
        const again = el('button', { class: 'ucs-btn', text: 'Look again' });
        again.type = 'button';
        again.disabled = busy;
        again.addEventListener('click', () => void chooseWallet());
        box.append(again);
      }
      hero.append(box);
    }
    if (message) hero.append(el('p', { class: 'ucs-msg', text: message }));
    hero.append(el('p', { class: 'ucs-note', text: 'Signing in is a free message, never a transaction or an approval. This is a separate game: it does not use ACT or any token. Coins show game values, which are not cash unless a prize is announced in the game.' }));
    const strip = el('div', { class: 'ucs-strip' });
    for (const c of allCities().filter((x) => x.status !== 'inactive')) {
      const t = el('div', { class: 'ucs-thumb' });
      if (c.imageUrl) {
        const img = el('img', { attrs: { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' } });
        img.src = c.imageUrl;
        t.append(img);
      }
      t.append(el('span', { text: c.name }));
      strip.append(t);
    }
    hero.append(strip);
    return hero;
  }

  function cityCard(c: City): HTMLElement {
    const state = list?.cities.find((x) => x.id === c.id);
    const open = c.status === 'active' && (!state || state.status === 'active');
    const here = list?.selected === c.id;
    const p = state?.progress;
    const card = el('button', { class: 'ucs-city', attrs: { type: 'button', 'aria-current': String(here), 'aria-label': `${c.name}, ${c.country}` } });
    card.style.setProperty('--accent', c.tint[1]);
    card.disabled = busy || !open;
    if (c.imageUrl) {
      const img = el('img', { attrs: { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' } });
      img.src = c.imageUrl;
      card.append(img);
    } else card.style.background = `linear-gradient(160deg, ${c.tint[0]}, #0b0b18)`;
    card.append(el('span', { class: 'ucs-city-shade' }));
    const label = openingCity === c.id ? 'Opening…' : here ? 'You are here' : !open ? 'Coming soon' : p ? 'Return' : 'Enter';
    card.append(
      el('div', { class: 'ucs-city-body' },
        el('span', { class: 'ucs-city-country', text: c.country }),
        el('h3', { class: 'ucs-city-name', text: c.name }),
        el('p', { class: 'ucs-city-blurb', text: c.blurb }),
        el('span', { class: 'ucs-city-meta', text: p ? `${p.cityXp} XP · ${p.discoveries} found · ${p.completedMissions} missions` : c.landmarks.slice(0, 2).map((m) => m.name).join(' · ') }),
        el('span', { class: 'ucs-city-go', text: label }),
      ),
    );
    if (c.imageCredit) card.append(el('div', { class: 'ucs-credit', text: c.imageCredit }));
    card.addEventListener('click', () => void chooseCity(c.id));
    return card;
  }

  function citiesStage(): HTMLElement {
    const sec = el('section', { class: 'ucs-dark ucs-cities' });
    const shown = allCities().filter((c) => c.status !== 'inactive');
    sec.append(
      steps(2),
      el('div', { class: 'ucs-cities-head' }, el('span', { class: 'ucs-eyebrow', text: 'Step 2' }), el('h2', { text: 'Choose your city' }), el('p', { text: 'Where do you want to find your treasure?' })),
    );
    // Five cities on the first row, the rest (four, with the nine launch cities) on the next.
    const first = el('div', { class: 'ucs-row five' }, ...shown.slice(0, 5).map(cityCard));
    sec.append(first);
    if (shown.length > 5) sec.append(el('div', { class: 'ucs-row four' }, ...shown.slice(5).map(cityCard)));
    if (message) sec.append(el('p', { class: 'ucs-msg', text: message }));
    const foot = el('div', { class: 'ucs-bar' });
    foot.append(el('span', { class: 'ucs-chip', text: session ? `${short(session.address)} · Lv ${session.profile.explorerLevel} · ${session.profile.totalXp} XP` : '' }));
    const out = el('button', { class: 'ucs-btn', text: 'Sign out' });
    out.type = 'button';
    out.addEventListener('click', () => void signOut(false));
    foot.append(out);
    sec.append(foot);
    return sec;
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'explore', label: 'Explore' },
    { id: 'missions', label: 'Missions' },
    { id: 'progress', label: 'My progress' },
    { id: 'board', label: 'Leaderboard & team' },
  ];

  function playStage(): HTMLElement[] {
    const city = list?.selected ? cityById(list.selected) : undefined;
    const accent = city?.tint[1] ?? '#c9a227';
    const bar = el('section', { class: 'ucs-dark' });
    const head = el('div', { class: 'ucs-bar' });
    const dot = el('span', { class: 'ucs-bar-dot' });
    dot.style.background = accent;
    head.append(el('div', { class: 'ucs-bar-city' }, dot, el('div', {}, el('h2', { text: city?.name ?? 'Your city' }), el('small', { text: city ? `${city.country} · stage 3 of 3` : '' }))));
    const right = el('div', { class: 'ucs-bar-right' });
    right.append(el('span', { class: 'ucs-chip gold', text: `Lv ${session?.profile.explorerLevel ?? 1} · ${session?.profile.totalXp ?? 0} XP` }), el('span', { class: 'ucs-chip', text: session ? short(session.address) : '' }));
    const change = el('button', { class: 'ucs-btn', text: 'Change city' });
    change.type = 'button';
    change.addEventListener('click', () => {
      picking = true;
      draw();
    });
    const out = el('button', { class: 'ucs-btn', text: 'Sign out' });
    out.type = 'button';
    out.addEventListener('click', () => void signOut(false));
    const all = el('button', { class: 'ucs-btn', text: 'Sign out everywhere' });
    all.type = 'button';
    all.addEventListener('click', () => void signOut(true));
    right.append(change, out, all);
    head.append(right);
    const tabs = el('div', { class: 'ucs-tabs', attrs: { role: 'tablist' } });
    for (const t of [...TABS, ...(isAdmin ? [{ id: 'admin' as Tab, label: 'Admin' }] : [])]) {
      const b = el('button', { class: 'ucs-tab', text: t.label, attrs: { role: 'tab', 'aria-selected': String(t.id === tab) } });
      b.type = 'button';
      b.addEventListener('click', () => {
        tab = t.id;
        draw();
      });
      tabs.append(b);
    }
    bar.append(head, tabs);
    const body = el('div', { class: 'ucs-play-body' });
    const host = tab === 'explore' ? exploreHost : tab === 'missions' ? missionHost : tab === 'progress' ? progressHost : tab === 'board' ? boardsHost : adminHost;
    body.append(announceHost, host);
    if (message) body.prepend(el('p', { class: 'wapp__fine', text: message }));
    return [bar, body];
  }

  function currentStage(): Stage {
    if (!session) return 'welcome';
    if (!listLoaded || !list?.selected || picking) return 'cities';
    return 'play';
  }

  function draw(): void {
    const stage = currentStage();
    const nodes: HTMLElement[] = [];
    if (session && !listLoaded) nodes.push(el('section', { class: 'ucs-dark' }, el('p', { class: 'ucs-loading', text: 'Loading your game…' })));
    else if (stage === 'welcome') nodes.push(welcome());
    else if (stage === 'cities') nodes.push(citiesStage());
    else nodes.push(...playStage());
    root.replaceChildren(el('div', { class: 'ucs' + (stage !== lastStage ? ' ucs-fade' : '') }, ...nodes));
    lastStage = stage;
    syncExplore();
    // A map that was out of sight needs to measure itself again when it comes back.
    if (stage === 'play') requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  return {
    onShow() {
      draw();
      // Refresh from the server (it is the record; the browser only remembers the sign-in).
      if (session) {
        const s = session;
        void loadList(s).then(() => draw());
        void client.me(s).then((profile) => {
          if (session === s) {
            session = { ...s, profile };
            draw();
          }
        }).catch(() => {
          if (!client.saved()) {
            session = null;
            list = null;
            listLoaded = false;
            draw();
          }
        });
      }
    },
  };
}
