/**
 * The city exploration view: an interactive map of the city the player is in, a satellite switch where a licensed provider is
 * configured, simulated journeys on the server's clock, and flights to the other cities. Loaded only when a city is open.
 *
 * Map data: OpenStreetMap contributors, as served by OpenFreeMap (free, no key; attribution is shown by the map). Satellite imagery
 * is shown only if the site is built with PUBLIC_SATELLITE_TILES (an XYZ tile URL the operator is licensed to use) and
 * PUBLIC_SATELLITE_ATTRIBUTION. Street-level imagery is not part of this view yet: it needs a provider account (see the plan).
 */
import type { Map as MlMap, Marker, StyleSpecification } from 'maplibre-gl';
import { allCities, cityById, type City, type Transport } from './cities.js';
import { along, distanceKm, flightDurationMs, flightKm, localDurationMs, LOCAL_MODES, type LngLat } from './travel.js';

export interface Journey { mode: string; from: LngLat; to: LngLat; departedAt: number; arrivesAt: number }
export interface Flight { from: string; to: string; departedAt: number; arrivesAt: number }
export interface ExploreState {
  serverNow: number;
  selected: string | null;
  flight: Flight | null;
  position: LngLat | null;
  travel: Journey | null;
}
export interface ExploreApi {
  state(): Promise<ExploreState>;
  travel(city: string, mode: Transport, to: LngLat): Promise<ExploreState>;
  fly(to: string): Promise<ExploreState>;
}

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const SAT_URL = (import.meta.env.PUBLIC_SATELLITE_TILES as string | undefined) ?? '';
const SAT_ATTR = (import.meta.env.PUBLIC_SATELLITE_ATTRIBUTION as string | undefined) ?? '';
const LABEL: Record<Transport, string> = { walk: 'Walk', run: 'Run', taxi: 'Taxi', car: 'Car', bus: 'Bus', train: 'Train', metro: 'Metro', ferry: 'Ferry', flight: 'Flight' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const fmt = (ms: number): string => `${Math.max(0, Math.ceil(ms / 1000))}s`;
const pad = (b: [number, number, number, number], d = 0.05): [number, number, number, number] => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];

export async function mountExplore(host: HTMLElement, city: City, api: ExploreApi): Promise<{ destroy(): void }> {
  const [maplibre] = await Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl.css')]);

  let state: ExploreState = await api.state();
  let offset = state.serverNow - Date.now();
  let mode: Transport = city.transport.find((t) => LOCAL_MODES.includes(t)) ?? 'walk';
  let dest: LngLat | null = null;
  let note = '';
  let busy = false;
  let satellite = false;
  let raf = 0;
  let destroyed = false;

  const bar = el('div', 'wapp__card');
  const modes = el('div');
  modes.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px';
  const status = el('p', 'wapp__fine');
  const go = el('button', 'wapp__btn wapp__btn--primary', 'Go');
  go.type = 'button';
  const sat = el('button', 'wapp__btn wapp__btn--ghost', 'Satellite');
  sat.type = 'button';
  const mapBox = el('div');
  mapBox.style.cssText = 'height:min(62vh,520px);min-height:320px;border-radius:12px;overflow:hidden';
  const flights = el('div', 'wapp__card');
  const actions = el('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center';
  actions.append(go, sat);
  bar.append(el('h2', 'wapp__h2', `Explore ${city.name}`), modes, actions, status);
  host.replaceChildren(bar, mapBox, flights);

  const lightStyle = STYLE_URL;
  const satStyle: StyleSpecification = { version: 8, sources: { sat: { type: 'raster', tiles: [SAT_URL], tileSize: 256, attribution: SAT_ATTR } }, layers: [{ id: 'sat', type: 'raster', source: 'sat' }] };
  const map: MlMap = new maplibre.Map({ container: mapBox, style: lightStyle, center: state.position ?? city.center, zoom: 12.5, pitch: 40, maxBounds: pad(city.bounds), attributionControl: { compact: true } });
  map.addControl(new maplibre.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibre.ScaleControl(), 'bottom-left');

  const dot = (color: string): HTMLElement => {
    const d = el('div');
    d.style.cssText = `width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 2px #0008`;
    return d;
  };
  const me: Marker = new maplibre.Marker({ element: dot('#c9a227') }).setLngLat(state.position ?? city.center).addTo(map);
  const target: Marker = new maplibre.Marker({ element: dot('#4f46e5') });
  const prize: Marker = new maplibre.Marker({ element: dot('#16a34a') });
  const showZone = (e: Event): void => {
    const z = (e as CustomEvent<{ lng: number; lat: number; radiusM: number }>).detail;
    prize.setLngLat([z.lng, z.lat]).addTo(map);
    map.flyTo({ center: [z.lng, z.lat], zoom: 16 });
    note = 'The green marker is where your treasure is. Travel there, then press Collect in your treasures list.';
    renderStatus();
  };
  host.addEventListener('game-zone-show', showZone);

  // Well-known public places in this city, to find your way by. Positions are approximate.
  for (const m of city.landmarks) {
    const pin = el('div');
    pin.title = m.name;
    pin.setAttribute('aria-label', m.name);
    pin.style.cssText = 'display:flex;flex-direction:column;align-items:center;font-size:11px;line-height:1.1;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none';
    const star = el('span', '', '◆');
    star.style.color = city.tint[1];
    pin.append(star, el('span', '', m.name));
    new maplibre.Marker({ element: pin }).setLngLat([m.lng, m.lat]).addTo(map);
  }

  const clock = (): number => Date.now() + offset;
  const moving = (): boolean => Boolean((state.travel && state.travel.arrivesAt > clock()) || (state.flight && state.flight.arrivesAt > clock()));

  function renderModes(): void {
    modes.replaceChildren(
      ...city.transport.filter((t) => LOCAL_MODES.includes(t)).map((t) => {
        const b = el('button', t === mode ? 'wapp__btn wapp__btn--primary' : 'wapp__btn wapp__btn--ghost', LABEL[t]);
        b.type = 'button';
        b.disabled = moving() || busy;
        b.addEventListener('click', () => {
          mode = t;
          renderModes();
          renderStatus();
        });
        return b;
      }),
    );
  }

  function renderFlights(): void {
    flights.replaceChildren(el('h2', 'wapp__h2', 'Fly to another city'), el('p', 'wapp__fine', 'A simulated journey, not a booking. It takes a short, fixed time, the same for every player.'));
    for (const c of allCities().filter((x) => x.status === 'active')) {
      if (c.id === city.id) continue;
      const km = flightKm(city.id, c.id)!;
      const b = el('button', 'wapp__btn wapp__btn--ghost', `${c.name} · ${Math.round(km).toLocaleString()} km · ${fmt(flightDurationMs(km))}`);
      b.type = 'button';
      b.disabled = moving() || busy;
      b.addEventListener('click', () => void act(() => api.fly(c.id)));
      flights.append(b);
    }
  }

  function renderStatus(): void {
    go.disabled = moving() || busy || !dest;
    sat.disabled = !SAT_URL;
    sat.title = SAT_URL ? '' : 'Satellite imagery is not enabled on this site yet.';
    sat.textContent = satellite ? 'Standard map' : 'Satellite';
    if (state.flight) status.textContent = `In flight to ${cityById(state.flight.to)?.name ?? ''}: lands in ${fmt(state.flight.arrivesAt - clock())}.`;
    else if (state.travel && state.travel.arrivesAt > clock()) status.textContent = `${LABEL[state.travel.mode as Transport] ?? 'Travelling'}: arrives in ${fmt(state.travel.arrivesAt - clock())}.`;
    else if (dest && state.position) status.textContent = `${LABEL[mode]} to the marked place: ${(distanceKm(state.position, dest)).toFixed(1)} km, about ${fmt(localDurationMs(distanceKm(state.position, dest), mode))}.`;
    else status.textContent = note || 'Click the map to choose where to go, pick how to get there, then press Go. Street-level imagery is not available yet.';
  }

  function apply(next: ExploreState): void {
    state = next;
    offset = next.serverNow - Date.now();
    if (!next.travel) target.remove();
    if (next.selected && next.selected !== city.id) {
      // The player landed in (or chose) another city: the page reopens this view for it.
      host.dispatchEvent(new CustomEvent('game-city-changed', { bubbles: true, detail: next.selected }));
    }
    renderModes();
    renderFlights();
    renderStatus();
  }

  async function act(run: () => Promise<ExploreState>): Promise<void> {
    if (busy) return;
    busy = true;
    note = '';
    renderStatus();
    try {
      apply(await run());
    } catch (e) {
      note = e instanceof Error ? e.message : 'That did not work. Try again.';
    }
    busy = false;
    renderModes();
    renderFlights();
    renderStatus();
  }

  map.on('click', (ev) => {
    if (moving() || busy) return;
    dest = [ev.lngLat.lng, ev.lngLat.lat];
    target.setLngLat(dest).addTo(map);
    renderStatus();
  });
  go.addEventListener('click', () => {
    if (dest) void act(() => api.travel(city.id, mode, dest!));
  });
  sat.addEventListener('click', () => {
    if (!SAT_URL) return;
    satellite = !satellite;
    map.setStyle(satellite ? satStyle : lightStyle);
    renderStatus();
  });

  let checked = false;
  function frame(): void {
    if (destroyed) return;
    const t = state.travel;
    if (t && t.arrivesAt > clock()) {
      me.setLngLat(along(t.from, t.to, clock() - t.departedAt, t.arrivesAt - t.departedAt));
      checked = false;
    } else if ((t || state.flight) && !checked) {
      // The time has passed: ask the server (the record), which finishes the journey or the landing.
      checked = true;
      void api.state().then((s) => {
        apply(s);
        if (s.position) me.setLngLat(s.position);
        dest = null;
        target.remove();
      }).catch(() => {
        checked = false;
      });
    }
    if (moving()) renderStatus();
    raf = requestAnimationFrame(frame);
  }

  renderModes();
  renderFlights();
  renderStatus();
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      destroyed = true;
      host.removeEventListener('game-zone-show', showZone);
      cancelAnimationFrame(raf);
      map.remove();
    },
  };
}
