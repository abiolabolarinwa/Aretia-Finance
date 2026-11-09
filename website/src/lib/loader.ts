/**
 * The loading state of the whole site: the Aretia Finance mark, drawn as its three pieces, which slide together and apart while
 * something loads. The mark is traced from /assets/logo-mark.png. The styles are in styles/global.css (.aretia-mark).
 *
 * Two ways in:
 *  - `loadingBlock(text)` / `markSvg(size)` for a place that wants a loader on purpose;
 *  - `startLoadingMarks()` (see loadingMarks.ts), which puts the mark beside any "Loading…", "Checking…", "Searching…" style
 *    message the pages already show, so every loading state looks the same without each one being rewritten.
 */

/** The three pieces of the mark on a 128-unit square: the upper band, the left chevron and the lower bar. */
export const MARK_PIECES: readonly { id: 'a' | 'b' | 'c'; d: string }[] = [
  { id: 'a', d: 'M53 35 56 35 93 72 92 75 88 78 88 79 85 79 49 43 49 39Z' },
  { id: 'b', d: 'M41 47 44 47 62 65 62 68 46 84 42 85 38 81 38 77 48 68 48 65 36 54 37 51Z' },
  { id: 'c', d: 'M66 73 70 73 74 77 73 82 53 102 51 102 51 103 48 103 44 99 44 95Z' },
];

/** The mark as SVG markup. `size` is in pixels, or any CSS length when a string. */
export function markSvg(size: number | string = 40): string {
  const s = typeof size === 'number' ? `${size}` : size;
  const pieces = MARK_PIECES.map((p) => `<path class="aretia-mark__${p.id}" d="${p.d}"/>`).join('');
  return `<svg class="aretia-mark" viewBox="0 0 128 128" width="${s}" height="${s}" aria-hidden="true" focusable="false"><rect class="aretia-mark__tile" width="128" height="128" rx="28"/>${pieces}</svg>`;
}

/**
 * A loading placeholder for a whole area: the mark above a line of text, centred, announced to screen readers as a status.
 * Used where a list or chart has nothing to show yet.
 */
export function loadingBlock(text = 'Loading…', size = 44): HTMLElement {
  const box = document.createElement('div');
  box.className = 'aretia-loading aretia-loading--block';
  box.setAttribute('role', 'status');
  box.insertAdjacentHTML('afterbegin', markSvg(size));
  const label = document.createElement('span');
  label.className = 'aretia-loading__text';
  label.textContent = text;
  box.append(label);
  return box;
}
