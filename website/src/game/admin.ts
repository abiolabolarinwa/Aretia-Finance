/**
 * The administrator's console, shown only to a signed-in wallet the server reports as an administrator. The server checks again on
 * every call, so showing or hiding this page protects nothing by itself. Built with textContent, never innerHTML.
 */
import { loadMapStyles } from './explore';
import { allCities, cityById, SCENES } from './cities.js';
import { placementProblem } from './exclusions.js';
import { DIFFICULTIES, TREASURE_CLASSES } from './rarity.js';
import type { Map as MlMap, Marker } from 'maplibre-gl';

export type Call = <T = Record<string, unknown>>(payload: Record<string, unknown>) => Promise<T>;
type Row = Record<string, unknown>;
type Tab = 'overview' | 'cities' | 'missions' | 'treasures' | 'claims' | 'reports' | 'announce' | 'audit';

const TABS: [Tab, string][] = [['overview', 'Overview'], ['cities', 'Cities'], ['missions', 'Missions'], ['treasures', 'Treasures'], ['claims', 'Claims'], ['reports', 'Reports'], ['announce', 'Announcements'], ['audit', 'Audit log']];
const CLUE_TYPES = ['riddle', 'historical', 'geographical', 'architectural', 'numerical', 'cryptographic', 'visual', 'pattern', 'observation', 'trail', 'mystery'];
const KINDS = ['long', 'daily', 'weekly', 'event', 'team'];
const ENVIRONMENTS = ['none', 'underwater', 'underground', 'vault'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
const btn = (label: string, cls: string, on: () => void): HTMLButtonElement => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', on);
  return b;
};
const usd = (v: unknown): string => `$${Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const when = (ms: unknown): string => (ms ? new Date(Number(ms)).toLocaleString() : '—');

function field(label: string, input: HTMLElement): HTMLElement {
  const wrap = el('label');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:13px';
  wrap.append(el('span', 'wapp__fine', label), input);
  return wrap;
}
function text(value = '', placeholder = ''): HTMLInputElement {
  const i = el('input');
  i.type = 'text';
  i.value = value;
  i.placeholder = placeholder;
  return i;
}
function select(options: readonly string[], value = ''): HTMLSelectElement {
  const s = el('select');
  for (const o of options) s.append(new Option(o, o));
  if (value) s.value = value;
  return s;
}
function area(rows = 3): HTMLTextAreaElement {
  const a = el('textarea');
  a.rows = rows;
  return a;
}
const grid = (...kids: HTMLElement[]): HTMLElement => {
  const g = el('div');
  g.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin:8px 0';
  g.append(...kids);
  return g;
};

export function mountAdmin(host: HTMLElement, call: Call): { destroy(): void } {
  let tab: Tab = 'overview';
  let message = '';
  let map: MlMap | null = null;
  const markers: Marker[] = [];
  const state: { city: string; mission: string; editCity: string; pick: [number, number] | null } = { city: 'paris', mission: '', editCity: '', pick: null };

  const body = el('div');
  const card = el('div', 'wapp__card');
  card.append(el('h2', 'wapp__h2', 'Administrator console'), el('p', 'wapp__fine', 'Every change here is written to the audit log. Nothing in this console pays anyone.'));
  const tabs = el('div');
  tabs.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
  card.append(tabs);
  host.replaceChildren(card, body);

  function drawTabs(): void {
    tabs.replaceChildren(...TABS.map(([id, label]) => btn(label, id === tab ? 'wapp__btn wapp__btn--primary' : 'wapp__btn wapp__btn--ghost', () => { tab = id; void show(); })));
  }

  async function act(fn: () => Promise<unknown>, done = 'Saved.'): Promise<void> {
    try {
      await fn();
      message = done;
    } catch (e) {
      message = e instanceof Error ? e.message : 'That did not work.';
    }
    await show();
  }

  const note = (): HTMLElement | null => (message ? el('p', 'wapp__fine', message) : null);

  async function show(): Promise<void> {
    drawTabs();
    map?.remove();
    map = null;
    markers.length = 0;
    const pane = el('div');
    const n = note();
    if (n) pane.append(n);
    try {
      if (tab === 'overview') await overview(pane);
      else if (tab === 'cities') await cities(pane);
      else if (tab === 'missions') await missions(pane);
      else if (tab === 'treasures') await treasures(pane);
      else if (tab === 'claims') await claims(pane);
      else if (tab === 'reports') await reports(pane);
      else if (tab === 'announce') await announce(pane);
      else await audit(pane);
    } catch (e) {
      pane.append(el('p', '', e instanceof Error ? e.message : 'This page could not be loaded.'));
    }
    body.replaceChildren(pane);
    message = '';
  }

  async function overview(pane: HTMLElement): Promise<void> {
    const o = await call<Row & { prizes: Row; prizesEnabled: boolean }>({ op: 'admin-overview' });
    const c = el('div', 'wapp__card');
    c.append(el('h3', 'wapp__h2', 'Players and activity'));
    const dl = el('dl', 'wapp__rows');
    for (const [k, v] of [['Players', o.players], ['New in 7 days', o.newPlayers7d], ['Active in 24 hours', o.activePlayers24h], ['Actions in 24 hours', o.activities24h], ['Live missions', o.missionsActive]] as const) dl.append(el('div').appendChild(el('dt', '', k)).parentElement!.appendChild(el('dd', '', String(v ?? 0))).parentElement!);
    c.append(dl);
    const p = o.prizes;
    const pc = el('div', 'wapp__card');
    pc.append(el('h3', 'wapp__h2', `Prizes (cash payouts are ${o.prizesEnabled ? 'ON' : 'OFF'})`));
    const pd = el('dl', 'wapp__rows');
    for (const [k, v] of [['Treasures still hidden', p.committedHiddenUsd], ['Found, awaiting verification', p.pendingVerificationUsd], ['Claims awaiting a decision', p.claimsPendingUsd], ['Approved, not yet paid', p.claimsApprovedUnpaidUsd], ['Paid', p.paidUsd], ['Remaining obligations', p.remainingObligationsUsd], ['Funded reserve', p.reserveUsd], ['Shortfall', p.shortfallUsd]] as const) pd.append(el('div').appendChild(el('dt', '', k)).parentElement!.appendChild(el('dd', '', usd(v))).parentElement!);
    pc.append(pd, el('p', 'wapp__fine', 'Game values are denominations, not market prices or a promise of cash. Hidden value counts every unfound treasure as potentially winnable.'));
    const amount = text('', 'Amount in US dollars');
    const memo = text('', 'Note');
    pc.append(grid(field('Reserve entry (negative to take out)', amount), field('Note', memo)), btn('Record reserve entry', 'wapp__btn wapp__btn--ghost', () => void act(() => call({ op: 'admin-reserve', amountUsd: Number(amount.value), note: memo.value }), 'Reserve entry recorded.')));
    const s = await call<{ flagged: Row[] }>({ op: 'admin-suspicious' });
    const sc = el('div', 'wapp__card');
    sc.append(el('h3', 'wapp__h2', 'Suspicious activity (last 24 hours)'));
    if (s.flagged.length === 0) sc.append(el('p', 'wapp__fine', 'Nothing flagged.'));
    for (const f of s.flagged) sc.append(el('p', 'wapp__fine', `${String(f.player)} · ${String(f.reason)}`));
    pane.append(c, pc, sc);
  }

  async function cities(pane: HTMLElement): Promise<void> {
    const list = await call<{ cities: Row[] }>({ op: 'admin-city-list' });
    const c = el('div', 'wapp__card');
    c.append(el('h3', 'wapp__h2', 'Cities'), el('p', 'wapp__fine', 'A new city starts as "coming soon" and is invisible to players until you open it. It has no automatic placement exclusions (airports and the like), so check each treasure place yourself.'));
    for (const x of list.cities) c.append(el('p', 'wapp__fine', String(x.name) + ', ' + String(x.country) + ' · ' + String(x.status) + ' · scene ' + String(x.scene) + ' · ' + (x.landmarks as unknown[]).length + ' landmarks'), btn('Edit', 'wapp__btn wapp__btn--ghost', () => { state.editCity = String(x.id); void show(); }));
    const cur = list.cities.find((x) => x.id === state.editCity) as (Row & { bounds: number[]; center: number[]; transport: string[]; tint: string[]; landmarks: { name: string; lng: number; lat: number }[] }) | undefined;
    const f = {
      id: text(String(cur?.id ?? ''), 'accra'),
      name: text(String(cur?.name ?? '')),
      country: text(String(cur?.country ?? '')),
      west: text(String(cur?.bounds[0] ?? '')), south: text(String(cur?.bounds[1] ?? '')), east: text(String(cur?.bounds[2] ?? '')), north: text(String(cur?.bounds[3] ?? '')),
      lng: text(String(cur?.center[0] ?? '')), lat: text(String(cur?.center[1] ?? '')),
      blurb: area(2),
      tint0: text(String(cur?.tint[0] ?? '#1b1f3a')), tint1: text(String(cur?.tint[1] ?? '#c9a227')),
      scene: select(SCENES, String(cur?.scene ?? 'skyline')),
      status: select(['coming_soon', 'active', 'inactive'], String(cur?.status ?? 'coming_soon')),
      image: text(String(cur?.imageUrl ?? ''), 'https address of a photograph you may use'),
      credit: text(String(cur?.imageCredit ?? ''), 'Who made it, and the licence'),
      landmarks: area(4),
      order: text(String(cur?.sortOrder ?? '100')),
    };
    f.blurb.value = String(cur?.blurb ?? '');
    f.landmarks.value = (cur?.landmarks ?? []).map((m) => m.name + ' | ' + m.lng + ' | ' + m.lat).join('\n');
    const ways = ['walk', 'run', 'taxi', 'car', 'bus', 'train', 'metro', 'ferry', 'flight'];
    const boxes = ways.map((w) => {
      const b = el('input');
      b.type = 'checkbox';
      b.checked = cur ? cur.transport.includes(w) : ['walk', 'run', 'taxi', 'car', 'bus', 'flight'].includes(w);
      const l = el('label', 'wapp__fine');
      l.append(b, ' ' + w + ' ');
      return { w, b, l };
    });
    const form = el('div', 'wapp__card');
    form.append(el('h3', 'wapp__h2', cur ? 'Edit ' + String(cur.name) : 'New city'), grid(field('Id (lower-case letters and dashes)', f.id), field('Name', f.name), field('Country', f.country), field('West', f.west), field('South', f.south), field('East', f.east), field('North', f.north), field('Start longitude', f.lng), field('Start latitude', f.lat), field('Colour 1', f.tint0), field('Colour 2', f.tint1), field('3D scene', f.scene), field('Status', f.status), field('List order', f.order)), field('Description', f.blurb));
    const wrap = el('div');
    wrap.append(...boxes.map((x) => x.l));
    form.append(el('span', 'wapp__fine', 'Ways of getting around (walking and flights are required)'), wrap, field('Landmarks, one per line: name | longitude | latitude', f.landmarks), grid(field('Photograph', f.image), field('Photograph credit and licence', f.credit)));
    const save = (): void => void act(() => call({
      op: 'admin-city-save', id: f.id.value.trim(), name: f.name.value, country: f.country.value,
      bounds: [Number(f.west.value), Number(f.south.value), Number(f.east.value), Number(f.north.value)], center: [Number(f.lng.value), Number(f.lat.value)],
      blurb: f.blurb.value, transport: boxes.filter((x) => x.b.checked).map((x) => x.w), tint: [f.tint0.value.trim(), f.tint1.value.trim()], scene: f.scene.value, status: f.status.value,
      imageUrl: f.image.value.trim() || null, imageCredit: f.credit.value.trim() || null, sortOrder: Number(f.order.value),
      landmarks: f.landmarks.value.split('\n').map((l) => l.split('|').map((p) => p.trim())).filter((p) => p[0]).map((p) => ({ name: p[0], lng: Number(p[1]), lat: Number(p[2]) })),
    }), 'City saved.');
    form.append(btn('Save city', 'wapp__btn wapp__btn--primary', save), btn('New city', 'wapp__btn wapp__btn--ghost', () => { state.editCity = ''; void show(); }));
    pane.append(c, form);
  }

  async function missions(pane: HTMLElement): Promise<void> {
    const city = select(allCities().map((c) => c.id), state.city);
    city.addEventListener('change', () => { state.city = city.value; state.mission = ''; void show(); });
    const list = await call<{ missions: Row[] }>({ op: 'admin-mission-list', city: state.city });
    const c = el('div', 'wapp__card');
    c.append(el('h3', 'wapp__h2', 'Missions'), field('City', city));
    for (const m of list.missions) c.append(el('p', 'wapp__fine', `${String(m.id)} · ${String(m.title)} · ${String(m.difficulty)} · ${String(m.status)} `), btn('Edit', 'wapp__btn wapp__btn--ghost', () => { state.mission = String(m.id); void show(); }));
    const m = list.missions.find((x) => x.id === state.mission) ?? {};
    const f = {
      id: text(String(m.id ?? ''), 'paris-first-steps'),
      title: text(String(m.title ?? '')),
      description: area(2),
      difficulty: select(DIFFICULTIES, String(m.difficulty ?? 'beginner')),
      kind: select(KINDS, String(m.kind ?? 'long')),
      environment: select(ENVIRONMENTS, String(m.environment ?? 'none')),
      status: select(['draft', 'active', 'closed'], String(m.status ?? 'draft')),
      xp: text(String(m.xp_reward ?? 100)),
      opens: text(m.opens_at ? new Date(Number(m.opens_at)).toISOString() : '', 'ISO time, or blank'),
      closes: text(m.closes_at ? new Date(Number(m.closes_at)).toISOString() : '', 'ISO time, or blank'),
      treasure: text(String(m.treasure_id ?? ''), 'Treasure id, or blank'),
    };
    f.description.value = String(m.description ?? '');
    const time = (v: string): number | null => (v.trim() ? Date.parse(v) : null);
    const form = el('div', 'wapp__card');
    form.append(el('h3', 'wapp__h2', state.mission ? `Edit ${state.mission}` : 'New mission'), grid(field('Id', f.id), field('Title', f.title), field('Difficulty', f.difficulty), field('Kind', f.kind), field('Setting (a 3D scene to read the clue in)', f.environment), field('Status', f.status), field('XP reward', f.xp), field('Opens', f.opens), field('Closes', f.closes), field('Treasure id', f.treasure)), field('Description', f.description));
    form.append(btn('Save mission', 'wapp__btn wapp__btn--primary', () => void act(() => call({ op: 'admin-mission-save', id: f.id.value, city: state.city, title: f.title.value, description: f.description.value, difficulty: f.difficulty.value, kind: f.kind.value, environment: f.environment.value, status: f.status.value, xpReward: Number(f.xp.value), opensAt: time(f.opens.value), closesAt: time(f.closes.value), treasureId: f.treasure.value.trim() || null }), 'Mission saved.')));
    pane.append(c, form);
    if (state.mission) await clues(pane);
  }

  async function clues(pane: HTMLElement): Promise<void> {
    const list = await call<{ clues: Row[] }>({ op: 'admin-clue-list', mission: state.mission });
    const c = el('div', 'wapp__card');
    c.append(el('h3', 'wapp__h2', `Clues for ${state.mission}`), el('p', 'wapp__fine', 'Answers are stored as hashes and cannot be shown again. To change one, type a new answer.'));
    for (const k of list.clues) c.append(el('p', 'wapp__fine', `Step ${String(k.seq)} · ${String(k.type)} · ${String(k.content)}`));
    const seq = text(String(list.clues.length + 1));
    const type = select(CLUE_TYPES, 'riddle');
    const content = area(3);
    const hints = area(3);
    const answer = text('', 'The answer');
    answer.autocomplete = 'off';
    c.append(grid(field('Step number (edit an existing one, or add the next)', seq), field('Type', type)), field('Clue text', content), field('Hints, one per line, gentlest first', hints), field('Answer', answer));
    c.append(btn('Save clue', 'wapp__btn wapp__btn--primary', () => void act(() => call({ op: 'admin-clue-save', mission: state.mission, seq: Number(seq.value), type: type.value, content: content.value, hints: hints.value.split('\n').map((h) => h.trim()).filter(Boolean), answer: answer.value }), 'Clue saved.')), btn('Remove last clue', 'wapp__btn wapp__btn--ghost', () => void act(() => call({ op: 'admin-clue-delete', mission: state.mission }), 'Clue removed.')));
    pane.append(c);
  }

  async function treasures(pane: HTMLElement): Promise<void> {
    const city = select(allCities().map((c) => c.id), state.city);
    city.addEventListener('change', () => { state.city = city.value; state.pick = null; void show(); });
    const list = await call<{ treasures: Row[] }>({ op: 'admin-treasure-list', city: state.city });
    const c = el('div', 'wapp__card');
    c.append(el('h3', 'wapp__h2', 'Treasure placement'), field('City', city), el('p', 'wapp__fine', 'Click the map to choose a spot. Every discovery is simulated, so choose public, lawful, safe, accessible places only: never private property, restricted areas, airports, military sites or anywhere dangerous. Zones near airports and the Nicosia buffer zone are refused automatically.'));
    const box = el('div');
    box.style.cssText = 'height:min(55vh,460px);min-height:300px;border-radius:12px;overflow:hidden;margin:8px 0';
    c.append(box);
    const status = el('p', 'wapp__fine', 'No spot chosen yet.');
    const cls = select(TREASURE_CLASSES.map((k) => k.id), 'lutetium');
    const radius = text('60');
    const season = text('launch');
    const cap = text('', 'Optional supply cap for this class');
    const safe = el('input');
    safe.type = 'checkbox';
    const safeLabel = el('label', 'wapp__fine');
    safeLabel.append(safe, ' I confirm this is a public, lawful, safe place and nobody has to enter private or restricted ground.');
    c.append(status, grid(field('Class', cls), field('Zone size in metres (10 to 500)', radius), field('Season', season), field('Supply cap', cap)), safeLabel, el('br'));
    c.append(btn('Place treasure', 'wapp__btn wapp__btn--primary', () => {
      if (!state.pick) return void act(() => Promise.reject(new Error('Click the map first.')));
      void act(() => call({ op: 'admin-treasure-place', city: state.city, class: cls.value, lng: state.pick![0], lat: state.pick![1], radiusM: Number(radius.value), season: season.value, supplyCap: cap.value.trim() ? Number(cap.value) : undefined, confirmSafe: safe.checked }), 'Treasure placed.');
    }));
    const t = el('div', 'wapp__card');
    t.append(el('h3', 'wapp__h2', 'Treasures in this city'));
    for (const x of list.treasures) {
      const line = el('p', 'wapp__fine', `${String(x.class_id)} · ${String(x.status)} · ${String(x.season)} · ${String(x.id)}`);
      t.append(line);
      if (x.status === 'hidden') t.append(btn('Withdraw', 'wapp__btn wapp__btn--ghost', () => void act(() => call({ op: 'admin-treasure-withdraw', id: x.id }), 'Withdrawn.')));
    }
    pane.append(c, t);
    const info = cityById(state.city)!;
    const ml = await import('maplibre-gl');
    await loadMapStyles();
    map = new ml.Map({ container: box, style: 'https://tiles.openfreemap.org/styles/liberty', center: info.center, zoom: 12, maxBounds: [info.bounds[0] - 0.05, info.bounds[1] - 0.05, info.bounds[2] + 0.05, info.bounds[3] + 0.05] });
    map.addControl(new ml.NavigationControl(), 'top-right');
    const dot = (color: string): HTMLElement => { const d = el('div'); d.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff`; return d; };
    for (const x of list.treasures) {
      const z = x.zone as { lng: number; lat: number } | null;
      if (z && x.status !== 'withdrawn') markers.push(new ml.Marker({ element: dot(x.status === 'found' ? '#888' : '#16a34a') }).setLngLat([z.lng, z.lat]).addTo(map));
    }
    const pick = new ml.Marker({ element: dot('#4f46e5') });
    map.on('click', (ev) => {
      state.pick = [ev.lngLat.lng, ev.lngLat.lat];
      pick.setLngLat(state.pick).addTo(map!);
      const problem = placementProblem({ city: state.city, lng: state.pick[0], lat: state.pick[1], radiusM: Number(radius.value) || 60 });
      status.textContent = `${state.pick[1].toFixed(5)}, ${state.pick[0].toFixed(5)}${problem ? ` · ${problem}` : ' · passes the automatic checks'}`;
    });
  }

  async function claims(pane: HTMLElement): Promise<void> {
    const q = await call<{ queue: Row[] }>({ op: 'admin-verify-queue' });
    const qc = el('div', 'wapp__card');
    qc.append(el('h3', 'wapp__h2', 'Finds waiting to be verified'));
    if (q.queue.length === 0) qc.append(el('p', 'wapp__fine', 'None.'));
    for (const r of q.queue) {
      const notes = text('', 'Notes');
      qc.append(el('p', 'wapp__fine', `${String(r.class)} in ${String(r.cityId)} · found ${when(r.discoveredAt)} · player ${String(r.playerId)}`), notes);
      const decide = (decision: string, reopen = false): void => void act(() => call({ op: 'admin-verify', playerId: r.playerId, treasureId: r.treasureId, decision, notes: notes.value, reopen }), 'Decision recorded.');
      qc.append(btn('Verify', 'wapp__btn wapp__btn--primary', () => decide('verified')), btn('Reject', 'wapp__btn wapp__btn--ghost', () => decide('rejected')), btn('Reject and put back in play', 'wapp__btn wapp__btn--ghost', () => decide('rejected', true)));
    }
    const cl = await call<{ claims: Row[] }>({ op: 'admin-claims' });
    const cc = el('div', 'wapp__card');
    cc.append(el('h3', 'wapp__h2', 'Prize claims'));
    if (cl.claims.length === 0) cc.append(el('p', 'wapp__fine', 'None.'));
    for (const r of cl.claims) {
      cc.append(el('p', 'wapp__fine', `${usd(r.amount_usd)} · ${String(r.claim_status)} · claimed ${when(r.created_at)} · player ${String(r.player_id)} ${r.payment_reference ? `· paid ref ${String(r.payment_reference)}` : ''}`));
      if (r.claim_status === 'pending') {
        const notes = text('', 'Eligibility and verification notes');
        cc.append(notes, btn('Approve', 'wapp__btn wapp__btn--primary', () => void act(() => call({ op: 'admin-claim-decide', id: r.id, decision: 'approved', notes: notes.value }), 'Claim approved.')), btn('Reject', 'wapp__btn wapp__btn--ghost', () => void act(() => call({ op: 'admin-claim-decide', id: r.id, decision: 'rejected', notes: notes.value }), 'Claim rejected.')));
      }
      if (r.claim_status === 'approved') {
        const ref = text('', 'Payment reference from your records');
        cc.append(ref, btn('Mark paid', 'wapp__btn wapp__btn--primary', () => void act(() => call({ op: 'admin-claim-paid', id: r.id, paymentReference: ref.value }), 'Marked paid.')));
      }
    }
    pane.append(qc, cc);
  }

  async function reports(pane: HTMLElement): Promise<void> {
    const r = await call<{ reports: Row[] }>({ op: 'admin-reports' });
    const c = el('div', 'wapp__card');
    c.append(el('h3', 'wapp__h2', 'Open reports'));
    if (r.reports.length === 0) c.append(el('p', 'wapp__fine', 'None.'));
    for (const x of r.reports) {
      c.append(el('p', 'wapp__fine', `${String(x.kind)} · ${when(x.created_at)} · ${String(x.details)}`), btn('Resolved', 'wapp__btn wapp__btn--primary', () => void act(() => call({ op: 'admin-report-resolve', id: x.id, status: 'resolved' }), 'Report resolved.')), btn('Dismiss', 'wapp__btn wapp__btn--ghost', () => void act(() => call({ op: 'admin-report-resolve', id: x.id, status: 'dismissed' }), 'Report dismissed.')));
    }
    pane.append(c);
  }

  async function announce(pane: HTMLElement): Promise<void> {
    const live = await call<{ announcements: Row[] }>({ op: 'announcements' });
    const c = el('div', 'wapp__card');
    c.append(el('h3', 'wapp__h2', 'Announcements'));
    for (const a of live.announcements) c.append(el('p', 'wapp__fine', `${String(a.title)} `), btn('End', 'wapp__btn wapp__btn--ghost', () => void act(() => call({ op: 'admin-announcement-end', id: a.id }), 'Announcement ended.')));
    const title = text('', 'Title');
    const bodyText = area(3);
    const ends = text('', 'ISO end time, or blank');
    c.append(grid(field('Title', title), field('Ends', ends)), field('Message', bodyText), btn('Publish', 'wapp__btn wapp__btn--primary', () => void act(() => call({ op: 'admin-announce', title: title.value, body: bodyText.value, expiresAt: ends.value.trim() ? Date.parse(ends.value) : null }), 'Published.')));
    pane.append(c);
  }

  async function audit(pane: HTMLElement): Promise<void> {
    const a = await call<{ entries: Row[] }>({ op: 'admin-audit' });
    const c = el('div', 'wapp__card');
    c.append(el('h3', 'wapp__h2', 'Audit log (newest first)'));
    for (const e of a.entries) c.append(el('p', 'wapp__fine', `${when(e.at)} · ${String(e.admin)} · ${String(e.action)} · ${String(e.target)}`));
    pane.append(c);
  }

  void show();
  return { destroy: () => map?.remove() };
}
