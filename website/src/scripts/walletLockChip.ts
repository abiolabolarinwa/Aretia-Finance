/**
 * The small chip that says what is known about a pool's liquidity lock (see swings/market/lockView.ts): a padlock or an open padlock, the short
 * words, and the full reason on hover. Shared by the Markets table, the docked panel and the token page, so all three say the same thing.
 */
import { LOCK_ICON, UNLOCK_ICON } from './walletIcons.js';
import type { LockView } from '../swings/market/lockView.js';

export function lockChip(v: LockView): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `wapp-mt__lockchip is-${v.kind}`;
  chip.title = v.title;
  chip.setAttribute('aria-label', `Liquidity lock: ${v.text}. ${v.title}`);
  const icon = document.createElement('span');
  icon.className = 'wapp-mt__lockicon';
  icon.innerHTML = v.kind === 'locked' || v.kind === 'timed' || v.kind === 'guarded' ? LOCK_ICON : UNLOCK_ICON;
  chip.append(icon, document.createTextNode(v.text));
  return chip;
}
