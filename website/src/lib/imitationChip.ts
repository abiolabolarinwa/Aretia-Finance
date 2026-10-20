/**
 * The "Not the real one" chip, for every list that shows a token by name: Launch Box, Markets, the top-bar search and the swap
 * token picker. A token whose name or symbol is a well-known token's (after undoing look-alike letters) at another address gets
 * it, with the full warning as its tooltip and accessible name. Styled by `.wapp-lb__imitates` on the wallet page.
 *
 *   const chip = imitationChip(chain, address, symbol, name);   // an HTMLElement, or null when there is nothing to say
 *   if (chip) line.append(chip);
 */
import type { ChainId } from '../swings/core/types.js';
import { impersonationWarning } from '../swings/tokens/impersonation.js';

export const IMITATION_TEXT = '⚠ Not the real one';

export function imitationChip(chain: ChainId, address: string, symbol: string | null | undefined, name: string | null | undefined): HTMLElement | null {
  const warning = impersonationWarning(chain, address, symbol, name);
  if (!warning) return null;
  const chip = document.createElement('span');
  chip.className = 'wapp-lb__imitates';
  chip.textContent = IMITATION_TEXT;
  chip.title = warning;
  chip.setAttribute('role', 'img');
  chip.setAttribute('aria-label', warning);
  return chip;
}
