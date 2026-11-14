/**
 * Leaderboards (global, this city; today, this week, this month, all time) and teams. Boards show display names and XP only; they
 * refresh by themselves while the page is open. Built with textContent, never innerHTML.
 */
import type { City } from './cities.js';
import type { Period } from './periods.js';

export interface BoardEntry { rank: number; name: string; xp: number; you?: boolean; members?: number }
export interface BoardView { scope: string; period: Period; endsAt: number | null; entries: BoardEntry[]; yourRank: number | null }
export interface TeamBoardView { period: Period; endsAt: number | null; entries: BoardEntry[] }
export interface TeamView {
  team: null | { name: string; joinCode: string; owner: boolean; members: { name: string; you: boolean; role: string }[]; xp: { all: number; week: number }; rank: { all: number | null; week: number | null } };
}
export interface BoardsApi {
  board(city: string | null, period: Period): Promise<BoardView>;
  teamBoard(period: Period): Promise<TeamBoardView>;
  team(): Promise<TeamView>;
  createTeam(name: string): Promise<TeamView>;
  joinTeam(code: string): Promise<TeamView>;
  leaveTeam(): Promise<TeamView>;
}

const LABEL: Record<Period, string> = { day: 'Today', week: 'This week', month: 'This month', all: 'All time' };
const REFRESH_MS = 30_000;

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

function table(entries: BoardEntry[], withMembers: boolean): HTMLElement {
  const box = el('div');
  if (entries.length === 0) return el('p', 'wapp__fine', 'No scores yet in this window. Be the first.');
  for (const e of entries) {
    const line = el('p', e.you ? '' : 'wapp__fine', `${e.rank}. ${e.name}${withMembers && e.members ? ` (${e.members})` : ''}: ${e.xp.toLocaleString()} XP${e.you ? '  ← you' : ''}`);
    if (e.you) line.style.fontWeight = '600';
    box.append(line);
  }
  return box;
}

export function mountBoards(host: HTMLElement, city: () => City | null, api: BoardsApi): { refresh(): void; stop(): void } {
  let scope: 'global' | 'city' = 'global';
  let period: Period = 'week';
  let board: BoardView | null = null;
  let teamBoard: TeamBoardView | null = null;
  let team: TeamView | null = null;
  let message = '';
  let timer = 0;

  async function load(): Promise<void> {
    const c = city();
    const [b, tb, t] = await Promise.all([api.board(scope === 'city' && c ? c.id : null, period), api.teamBoard(period), api.team()]);
    board = b;
    teamBoard = tb;
    team = t;
  }

  function reload(): void {
    void load().then(draw).catch(() => {
      message = 'The boards could not be loaded. Try again.';
      draw();
    });
  }

  function teamCard(): HTMLElement {
    const card = el('div', 'wapp__card');
    card.append(el('h2', 'wapp__h2', 'Team'));
    const t = team?.team;
    if (!t) {
      card.append(el('p', 'wapp__fine', 'Hunt with friends. A team’s score is the XP its members earn, and a team holds up to 20 players.'));
      const name = el('input');
      name.type = 'text';
      name.maxLength = 24;
      name.placeholder = 'New team name';
      const code = el('input');
      code.type = 'text';
      code.maxLength = 8;
      code.placeholder = 'Join code';
      const act = (fn: () => Promise<TeamView>): void => void fn().then((v) => { team = v; message = ''; reload(); }).catch((e: unknown) => { message = e instanceof Error ? e.message : 'That did not work.'; draw(); });
      const r1 = el('div');
      r1.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px';
      r1.append(name, button('Create team', 'wapp__btn wapp__btn--primary', () => act(() => api.createTeam(name.value))));
      const r2 = el('div');
      r2.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
      r2.append(code, button('Join team', 'wapp__btn wapp__btn--ghost', () => act(() => api.joinTeam(code.value))));
      card.append(r1, r2);
    } else {
      card.append(el('p', '', `${t.name} · ${t.members.length} member${t.members.length === 1 ? '' : 's'} · ${t.xp.week.toLocaleString()} XP this week${t.rank.week ? ` (rank ${t.rank.week})` : ''} · ${t.xp.all.toLocaleString()} XP in all`));
      card.append(el('p', 'wapp__fine', `Members: ${t.members.map((m) => `${m.name}${m.you ? ' (you)' : ''}${m.role === 'owner' ? ' ★' : ''}`).join(', ')}`));
      card.append(el('p', 'wapp__fine', `Join code, for people you invite: ${t.joinCode}`));
      card.append(button('Leave team', 'wapp__btn wapp__btn--ghost', () => void api.leaveTeam().then((v) => { team = v; reload(); }).catch(() => undefined)));
    }
    card.append(el('span', 'wapp__eyebrow', `Team standings · ${LABEL[period]}`), teamBoard ? table(teamBoard.entries, true) : el('p', 'wapp__fine', 'Loading…'));
    return card;
  }

  function draw(): void {
    const c = city();
    const card = el('div', 'wapp__card');
    card.append(el('h2', 'wapp__h2', 'Leaderboard'));
    const bar = el('div');
    bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px';
    bar.append(button('Global', scope === 'global' ? 'wapp__btn wapp__btn--primary' : 'wapp__btn wapp__btn--ghost', () => { scope = 'global'; reload(); }));
    if (c) bar.append(button(c.name, scope === 'city' ? 'wapp__btn wapp__btn--primary' : 'wapp__btn wapp__btn--ghost', () => { scope = 'city'; reload(); }));
    for (const p of ['day', 'week', 'month', 'all'] as const) bar.append(button(LABEL[p], p === period ? 'wapp__btn wapp__btn--primary' : 'wapp__btn wapp__btn--ghost', () => { period = p; reload(); }));
    card.append(bar);
    if (message) card.append(el('p', 'wapp__fine', message));
    if (!board) card.append(el('p', 'wapp__fine', 'Loading…'));
    else {
      if (board.endsAt) card.append(el('p', 'wapp__fine', `This board resets ${new Date(board.endsAt).toLocaleString()}.`));
      card.append(table(board.entries, false));
      if (board.yourRank !== null && !board.entries.some((e) => e.you)) card.append(el('p', 'wapp__fine', `Your rank: ${board.yourRank}`));
      if (board.yourRank === null) card.append(el('p', 'wapp__fine', 'You have no XP in this window yet.'));
    }
    host.replaceChildren(card, teamCard());
  }

  function stop(): void {
    window.clearInterval(timer);
  }
  timer = window.setInterval(() => {
    if (!host.isConnected) return stop();
    if (!document.hidden) reload();
  }, REFRESH_MS);
  draw();
  reload();
  return { refresh: reload, stop };
}
