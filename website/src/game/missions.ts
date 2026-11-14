/**
 * Missions and treasures for the city the player is in: the list, the current clue with hints and an answer box, and the treasures
 * the player has unlocked. Every outcome comes from the server; this only shows it. Built with textContent, never innerHTML.
 */
import type { City } from './cities.js';

export interface MissionSummary {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  kind: string;
  environment?: string;
  needsTeam?: boolean;
  closesAt: number | null;
  xpReward: number;
  treasure: { coin: string; usd: number } | null;
  totalStages: number;
  progress: { status: string; stage: number } | null;
}
export interface ClueView {
  mission: { id: string; title: string; difficulty: string; cityId: string; environment?: string };
  status: string;
  stage: number;
  totalStages: number;
  clue: { type: string; content: string } | null;
  hintsUsed: number;
  hintsAvailable: number;
  hints: string[];
}
export interface Zone { lng: number; lat: number; radiusM: number }
export interface TreasureCard { id: string; cityId: string; class: string; coin: string; usd: number }
export interface AnswerResult { correct: boolean; completed?: boolean; attemptsLeft?: number; xp?: number; next?: ClueView; treasure?: (TreasureCard & { zone: Zone | null }) | null }
export interface MyTreasure extends TreasureCard { discovery: string; verification: string; claim: string; unlockedAt: number; discoveredAt: number | null; available: boolean; zone: Zone | null }

export interface MissionsApi {
  missions(city: string): Promise<{ missions: MissionSummary[] }>;
  start(mission: string): Promise<ClueView>;
  clue(mission: string): Promise<ClueView>;
  hint(mission: string): Promise<ClueView>;
  answer(mission: string, answer: string): Promise<AnswerResult>;
  abandon(mission: string): Promise<unknown>;
  treasures(): Promise<{ treasures: MyTreasure[] }>;
  collect(treasure: string): Promise<{ discovered: boolean; xp: number; treasure: TreasureCard & { verification: string } }>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
const button = (label: string, cls: string, on: () => void, disabled = false): HTMLButtonElement => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', on);
  return b;
};
const usd = (v: number): string => (v >= 1 ? `$${v.toLocaleString()}` : `$${v}`);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function mountMissions(host: HTMLElement, city: City, api: MissionsApi, onChange: () => void): { refresh(): void } {
  let list: MissionSummary[] = [];
  let mine: MyTreasure[] = [];
  let open: ClueView | null = null;
  let message = '';
  let busy = false;

  async function run<T>(fn: () => Promise<T>, then?: (v: T) => void): Promise<void> {
    if (busy) return;
    busy = true;
    message = '';
    draw();
    try {
      const v = await fn();
      then?.(v);
    } catch (e) {
      message = e instanceof Error ? e.message : 'That did not work. Try again.';
    }
    busy = false;
    draw();
  }

  async function reload(): Promise<void> {
    const [m, t] = await Promise.all([api.missions(city.id), api.treasures()]);
    list = m.missions;
    mine = t.treasures;
  }

  function showZone(z: Zone): void {
    host.dispatchEvent(new CustomEvent('game-zone', { bubbles: true, detail: z }));
  }

  function missionCard(m: MissionSummary): HTMLElement {
    const card = el('div', 'wapp__card');
    const done = m.progress?.status === 'completed';
    card.append(el('h3', 'wapp__h2', m.title), el('span', 'wapp__eyebrow', `${cap(m.difficulty)} · ${m.kind === 'team' ? 'team hunt' : m.kind} · ${m.totalStages} step${m.totalStages === 1 ? '' : 's'} · ${m.xpReward} XP`));
    if (m.description) card.append(el('p', '', m.description));
    if (m.treasure) card.append(el('p', 'wapp__fine', `Prize hidden at the end of the trail: ${m.treasure.coin} (game value ${usd(m.treasure.usd)}). Game values are not cash.`));
    if (m.kind === 'team') card.append(el('p', 'wapp__fine', m.needsTeam ? 'A team hunt is solved together. Make or join a team (under Team, below) with at least one other player.' : 'Your whole team shares the clues, hints and progress, and everyone gets the XP, with a fifth extra.'));
    if (m.closesAt) card.append(el('p', 'wapp__fine', `Closes ${new Date(m.closesAt).toLocaleString()}.`));
    const label = done ? 'Completed' : m.progress?.status === 'active' ? `Continue (step ${m.progress.stage})` : 'Start';
    card.append(button(label, done ? 'wapp__btn wapp__btn--ghost' : 'wapp__btn wapp__btn--primary', () => void run(() => (m.progress?.status === 'active' ? api.clue(m.id) : api.start(m.id)), (v) => (open = v)), done || busy || m.needsTeam === true));
    return card;
  }

  function clueCard(c: ClueView): HTMLElement {
    const card = el('div', 'wapp__card');
    card.append(el('h2', 'wapp__h2', c.mission.title), el('span', 'wapp__eyebrow', `Step ${c.stage} of ${c.totalStages} · ${cap(c.clue?.type ?? '')}`));
    card.append(el('p', '', c.clue?.content ?? ''));
    const env = c.mission.environment ?? 'none';
    if (env !== 'none') {
      const holder = el('div');
      let chamber: { destroy(): void } | null = null;
      const toggle = button('Enter the ' + (env === 'underwater' ? 'dive' : env === 'underground' ? 'mine' : 'vault'), 'wapp__btn wapp__btn--ghost', () => {
        if (chamber) {
          chamber.destroy();
          chamber = null;
          holder.replaceChildren();
          toggle.textContent = 'Enter again';
          return;
        }
        toggle.textContent = 'Leave';
        void Promise.all([import('./scene.js'), import('./sceneModel.js')]).then(async ([sc, sm]) => {
          if (!sm.isChamber(env)) return;
          const h = await sc.mountChamber(holder, env, c.mission.id);
          if (!h) holder.textContent = '3D cannot be drawn on this device.';
          else {
            chamber = h;
            holder.prepend(el('p', 'wapp__fine', h.model.caption));
          }
        }).catch(() => {
          holder.textContent = '3D could not be loaded. Try again.';
        });
      });
      card.append(toggle, holder);
    }
    for (const h of c.hints) card.append(el('p', 'wapp__fine', `Hint: ${h}`));
    const input = el('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = 'Your answer';
    input.autocomplete = 'off';
    input.disabled = busy;
    const send = (): void => {
      const text = input.value;
      void run(() => api.answer(c.mission.id, text), (r) => {
        if (!r.correct) message = `Not quite. ${r.attemptsLeft ?? 0} tries left for now.`;
        else if (r.completed) {
          open = null;
          message = `Mission complete: +${r.xp ?? 0} XP.${r.treasure ? ` You unlocked a ${r.treasure.coin}. Find it from the Treasures list below.` : ''}`;
          void reload().then(() => {
            draw();
            onChange();
          });
        } else if (r.next) open = r.next;
      });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    const row = el('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
    row.append(input, button('Answer', 'wapp__btn wapp__btn--primary', send, busy), button(c.hintsUsed < c.hintsAvailable ? `Hint (${c.hintsUsed}/${c.hintsAvailable})` : 'No more hints', 'wapp__btn wapp__btn--ghost', () => void run(() => api.hint(c.mission.id), (v) => (open = v)), busy || c.hintsUsed >= c.hintsAvailable), button('Back', 'wapp__btn wapp__btn--ghost', () => { open = null; draw(); }, busy), button('Give up', 'wapp__btn wapp__btn--ghost', () => void run(() => api.abandon(c.mission.id), () => { open = null; void reload().then(draw); }), busy));
    card.append(row, el('p', 'wapp__fine', 'Each hint costs 10% of the mission XP (to a floor of half).'));
    return card;
  }

  function treasuresCard(): HTMLElement {
    const card = el('div', 'wapp__card');
    card.append(el('h2', 'wapp__h2', 'My treasures'));
    if (mine.length === 0) card.append(el('p', 'wapp__fine', 'Nothing yet. Finish a mission with a prize to unlock its treasure.'));
    for (const t of mine) {
      const line = el('div');
      const state = t.discovery === 'discovered' ? `Collected · ${t.verification === 'verified' ? 'verified' : t.verification === 'pending' ? 'awaiting verification' : t.verification}` : t.available ? 'Unlocked: travel to the marked place to collect it' : 'Someone else reached it first';
      line.append(el('strong', '', `${t.coin} (game value ${usd(t.usd)})`), el('span', 'wapp__fine', ` · ${state}`));
      if (t.discovery === 'unlocked' && t.available && t.zone) {
        const z = t.zone;
        line.append(' ', button('Show on map', 'wapp__btn wapp__btn--ghost', () => showZone(z)), ' ', button('Collect', 'wapp__btn wapp__btn--primary', () => void run(() => api.collect(t.id), (r) => {
          message = `Collected: ${r.treasure.coin}, +${r.xp} XP.${r.treasure.verification === 'pending' ? ' It now waits for verification before it counts as a prize.' : ''}`;
          void reload().then(() => {
            draw();
            onChange();
          });
        }), busy));
      }
      card.append(line);
    }
    return card;
  }

  function draw(): void {
    const head = el('div', 'wapp__card');
    head.append(el('h2', 'wapp__h2', `Missions in ${city.name}`));
    if (message) head.append(el('p', '', message));
    const nodes: HTMLElement[] = [];
    if (open) nodes.push(head, clueCard(open));
    else {
      if (list.length === 0) head.append(el('p', 'wapp__fine', 'No missions are open here right now.'));
      nodes.push(head, ...list.map(missionCard));
    }
    nodes.push(treasuresCard());
    host.replaceChildren(...nodes);
  }

  function refresh(): void {
    void reload().then(draw).catch(() => {
      host.textContent = 'Missions could not be loaded. Try again.';
    });
  }
  draw();
  refresh();
  return { refresh };
}
