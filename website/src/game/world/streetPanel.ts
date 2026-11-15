/**
 * A "Street photo" panel inside the walk-and-drive view: Mapillary's real photograph of the street nearest the player, in Mapillary's
 * own viewer, refreshed as the player moves. The photograph belongs to Mapillary contributors (CC BY-SA 4.0), so the credit and a link
 * to the original are always shown with it. Where there is no photograph close by, the panel says so rather than showing something else.
 */
import { MAPILLARY_CREDIT, embedUrl, isMapillaryToken, nearestImage, pageUrl, type StreetImage } from '../street.js';

export interface StreetPanelOptions {
  /** The Mapillary client token; without a valid one the panel explains that street photos are not set up. */
  token: string;
  /** Where the player is now, as longitude and latitude. */
  position(): [number, number];
  fetchImpl?: typeof fetch;
}

export interface StreetPanel {
  readonly open: boolean;
  /** Opens or closes the panel; returns a short message when it cannot open (for the toast), otherwise ''. */
  toggle(): string;
  /** Called every frame with the time in ms: looks again when the player has moved on, at most every few seconds. */
  tick(nowMs: number): void;
  destroy(): void;
}

/** Re-search when the player is this far (metres) from where the last search was made, and no more often than this (ms). */
export const REFRESH_DISTANCE_M = 35;
export const REFRESH_EVERY_MS = 3000;

const metresBetween = (a: [number, number], b: [number, number]): number => {
  const dx = (a[0] - b[0]) * 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dz = (a[1] - b[1]) * 110_540;
  return Math.hypot(dx, dz);
};

export function makeStreetPanel(wrap: HTMLElement, o: StreetPanelOptions): StreetPanel {
  const box = document.createElement('div');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Street photo');
  box.style.cssText = 'position:absolute;left:14px;top:64px;width:min(380px,46%);background:rgba(0,0,0,.78);border:1px solid rgba(255,255,255,.35);border-radius:14px;padding:8px;color:#fff;font:500 12px system-ui,sans-serif;display:none;z-index:3';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px';
  const title = document.createElement('strong');
  title.textContent = 'Street photo';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close street photo');
  close.style.cssText = 'cursor:pointer;background:transparent;border:0;color:#fff;font-size:20px;line-height:1;padding:0 4px';
  head.append(title, close);
  const body = document.createElement('div');
  const foot = document.createElement('div');
  foot.style.cssText = 'margin-top:6px;opacity:.85';
  box.append(head, body, foot);
  wrap.append(box);

  let open = false;
  let searchedAt: [number, number] | null = null;
  let lastSearch = -Infinity;
  let searching = false;
  let shown = '';
  let destroyed = false;
  let frame: HTMLIFrameElement | null = null;

  const say = (text: string): void => {
    frame = null;
    shown = '';
    const p = document.createElement('p');
    p.style.margin = '6px 2px';
    p.textContent = text;
    body.replaceChildren(p);
    foot.replaceChildren();
  };

  const show = (image: StreetImage, from: [number, number]): void => {
    const away = Math.round(metresBetween([image.lng, image.lat], from));
    if (shown !== image.id || !frame) {
      shown = image.id;
      frame = document.createElement('iframe');
      frame.src = embedUrl(image.id);
      frame.title = 'Street-level photograph near the player';
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
      frame.style.cssText = 'width:100%;height:min(30vh,240px);min-height:160px;border:0;border-radius:10px;background:#111';
      body.replaceChildren(frame);
    }
    const link = document.createElement('a');
    link.href = pageUrl(image.id, image.lng, image.lat);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.color = '#fff';
    link.textContent = 'Open on Mapillary';
    foot.replaceChildren(document.createTextNode(`Taken about ${away} m from you · ${MAPILLARY_CREDIT} · `), link);
  };

  async function search(): Promise<void> {
    if (searching || destroyed) return;
    searching = true;
    const here = o.position();
    try {
      const found = await nearestImage(o.token, here[0], here[1], o.fetchImpl);
      if (destroyed || !open) return;
      if (!found.failed) searchedAt = here; // a failed search is tried again after a few seconds, wherever the player is
      if (found.failed) say('Street photos could not be reached just now. It will try again in a moment.');
      else if (!found.image) say('There is no street photo within about 120 metres of here. Walk or drive along a main street and it will appear.');
      else show(found.image, here);
    } finally {
      searching = false;
    }
  }

  const toggle = (): string => {
    if (!isMapillaryToken(o.token)) return 'Street photos need a Mapillary key, which this site has not been given.';
    open = !open;
    box.style.display = open ? 'block' : 'none';
    if (open) {
      say('Looking for a photo near you…');
      searchedAt = null;
      lastSearch = -Infinity;
    }
    return '';
  };
  close.addEventListener('click', () => {
    open = false;
    box.style.display = 'none';
  });

  return {
    get open() {
      return open;
    },
    toggle,
    tick(nowMs) {
      if (!open || searching || nowMs - lastSearch < REFRESH_EVERY_MS) return;
      const here = o.position();
      if (searchedAt && metresBetween(here, searchedAt) < REFRESH_DISTANCE_M) return;
      lastSearch = nowMs;
      void search();
    },
    destroy() {
      destroyed = true;
      box.remove();
    },
  };
}
