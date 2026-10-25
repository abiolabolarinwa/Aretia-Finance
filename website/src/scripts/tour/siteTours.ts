import { TourEngine } from './engine';
import { injectTourStyles } from './styles';
import type { TourConfig } from './types';

/**
 * A short, user-started tour of the home page, to show the engine works outside the wallet. It never starts by itself.
 * The home page has no wallet attributes, so this uses the engine's defaults.
 */
export const SITE_HOME_TOUR: TourConfig = {
  id: 'site-home',
  title: 'Home page',
  version: 1,
  steps: [
    { title: 'Welcome to Aretia', body: 'A quick look at where things are. Aretia never holds your keys: your own wallet signs everything.' },
    { target: '.rail', title: 'Every service, one tap away', body: 'The Wallet, Swap, Markets, Pay and the rest are in this column.', placement: 'right' },
    { target: '.bar__nav', title: 'Find your way', body: 'Products, the token, developers and company pages are in the top menu.', placement: 'bottom' },
    { target: '.card__btn--primary', title: 'Open the wallet', body: 'Connect the wallet you already use. You see fees before you sign anything.', placement: 'top' },
  ],
};

export function initSiteTour(): TourEngine | null {
  if (typeof document === 'undefined') return null;
  injectTourStyles();
  const engine = new TourEngine();
  engine.register(SITE_HOME_TOUR);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'atour-help';
  btn.style.cssText = 'position:fixed;left:100px;bottom:16px;z-index:9990;background:var(--color-bg,#fff)';
  const q = document.createElement('b');
  q.setAttribute('aria-hidden', 'true');
  q.textContent = '?';
  btn.append(q, document.createTextNode('Take a tour'));
  btn.addEventListener('click', () => void (engine.list()[0]?.canResume ? engine.resume(SITE_HOME_TOUR.id) : engine.start(SITE_HOME_TOUR.id)));
  document.body.append(btn);
  return engine;
}
