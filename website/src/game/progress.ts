/**
 * The player's own page: level and XP, achievements, per-city statistics and a history of everything they have done.
 * Everything shown is read from the server. Built with textContent, never innerHTML.
 */
import { cityById } from './cities.js';

export interface ProgressView {
  profile: { displayName: string };
  level: { current: number; xp: number; toNext: number };
  totals: { xp: number; discoveries: number; missionsCompleted: number; citiesVisited: number; flightsLanded: number; hintFreeCompletions: number };
  achievements: { id: string; title: string; description: string; xp: number; unlockedAt: number | null }[];
  cities: { id: string; visited: boolean; cityXp: number; discoveries: number; completedMissions: number; lastVisitAt: number | null }[];
  newlyUnlocked?: { id: string; title: string; xp: number }[];
}
export interface HistoryPage { items: { id: string; type: string; cityId: string | null; at: number; details: Record<string, unknown> }[]; next: number | null }
export interface ProgressApi {
  progress(): Promise<ProgressView>;
  history(before?: number): Promise<HistoryPage>;
  setName(name: string): Promise<{ displayName: string }>;
}

const WORDS: Record<string, string> = {
  wallet_connected: 'Connected a wallet', login: 'Signed in', logout: 'Signed out', city_selected: 'Entered a city', city_changed: 'Switched city',
  journey_started: 'Started a journey', flight_started: 'Took off', flight_landed: 'Landed', mission_started: 'Started a mission', mission_completed: 'Completed a mission',
  mission_abandoned: 'Gave up a mission', hint_requested: 'Asked for a hint', answer_correct: 'Answered correctly', answer_incorrect: 'Answered incorrectly',
  treasure_unlocked: 'Unlocked a treasure', treasure_discovered: 'Collected a treasure', achievement_unlocked: 'Earned an achievement', profile_updated: 'Changed the display name',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
const button = (label: string, cls: string, on: () => void): HTMLButtonElement => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', on);
  return b;
};
const row = (label: string, value: string): HTMLElement => el('div').appendChild(el('dt', '', label)).parentElement!.appendChild(el('dd', '', value)).parentElement!;

export function describeActivity(i: HistoryPage['items'][number]): string {
  const base = WORDS[i.type] ?? i.type.replace(/_/g, ' ');
  const city = i.cityId ? cityById(i.cityId)?.name : undefined;
  return city ? `${base} · ${city}` : base;
}

export function mountProgress(host: HTMLElement, api: ProgressApi): { refresh(): void } {
  let tab: 'overview' | 'achievements' | 'history' = 'overview';
  let data: ProgressView | null = null;
  let items: HistoryPage['items'] = [];
  let next: number | null = null;
  let message = '';

  async function load(): Promise<void> {
    data = await api.progress();
    if (tab === 'history' && items.length === 0) {
      const h = await api.history();
      items = h.items;
      next = h.next;
    }
  }

  function draw(): void {
    const card = el('div', 'wapp__card');
    card.append(el('h2', 'wapp__h2', data?.profile.displayName ? `${data.profile.displayName}'s profile` : 'My profile'));
    const tabs = el('div');
    tabs.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap';
    for (const [id, label] of [['overview', 'Overview'], ['achievements', 'Achievements'], ['history', 'History']] as const) {
      tabs.append(button(label, id === tab ? 'wapp__btn wapp__btn--primary' : 'wapp__btn wapp__btn--ghost', () => {
        tab = id;
        void (id === 'history' && items.length === 0 ? api.history().then((h) => { items = h.items; next = h.next; }) : Promise.resolve()).then(draw).catch(() => draw());
      }));
    }
    card.append(tabs);
    if (message) card.append(el('p', 'wapp__fine', message));
    if (!data) card.append(el('p', 'wapp__fine', 'Loading…'));
    else if (tab === 'overview') {
      const d = data;
      card.append(el('p', '', `Explorer level ${d.level.current} · ${d.level.xp} XP · ${d.level.toNext} XP to the next level`));
      const dl = el('dl', 'wapp__rows');
      dl.append(row('Missions completed', String(d.totals.missionsCompleted)), row('Treasures collected', String(d.totals.discoveries)), row('Cities visited', `${d.totals.citiesVisited} of 9`), row('Flights', String(d.totals.flightsLanded)), row('Missions without a hint', String(d.totals.hintFreeCompletions)));
      card.append(dl, el('span', 'wapp__eyebrow', 'By city'));
      const cities = el('dl', 'wapp__rows');
      for (const c of d.cities) cities.append(row(cityById(c.id)?.name ?? c.id, c.visited ? `${c.cityXp} XP · ${c.discoveries} found · ${c.completedMissions} missions` : 'Not visited'));
      card.append(cities);
      const input = el('input');
      input.type = 'text';
      input.maxLength = 24;
      input.placeholder = 'Display name';
      input.value = d.profile.displayName;
      const save = (): void => void api.setName(input.value).then((r) => { message = `Saved as ${r.displayName}.`; if (data) data.profile.displayName = r.displayName; draw(); }).catch((e: unknown) => { message = e instanceof Error ? e.message : 'That name was not saved.'; draw(); });
      const nameRow = el('div');
      nameRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      nameRow.append(input, button('Save name', 'wapp__btn wapp__btn--ghost', save));
      card.append(nameRow);
    } else if (tab === 'achievements') {
      for (const a of data.achievements) {
        const line = el('p', a.unlockedAt ? '' : 'wapp__fine', `${a.unlockedAt ? '★' : '☆'} ${a.title}: ${a.description} (${a.xp} XP)${a.unlockedAt ? ` · ${new Date(a.unlockedAt).toLocaleDateString()}` : ''}`);
        card.append(line);
      }
    } else {
      if (items.length === 0) card.append(el('p', 'wapp__fine', 'Nothing yet.'));
      for (const i of items) card.append(el('p', 'wapp__fine', `${new Date(i.at).toLocaleString()} · ${describeActivity(i)}`));
      if (next !== null) {
        const before = next;
        card.append(button('Older', 'wapp__btn wapp__btn--ghost', () => void api.history(before).then((h) => { items = items.concat(h.items); next = h.next; draw(); })));
      }
    }
    host.replaceChildren(card);
  }

  function refresh(): void {
    void load().then(() => {
      const n = data?.newlyUnlocked ?? [];
      if (n.length > 0) message = `Achievement unlocked: ${n.map((a) => `${a.title} (+${a.xp} XP)`).join(', ')}.`;
      draw();
    }).catch(() => {
      host.textContent = 'Your profile could not be loaded. Try again.';
    });
  }
  draw();
  refresh();
  return { refresh };
}
