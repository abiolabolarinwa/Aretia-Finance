/**
 * The loading state of the whole site: the Aretia Finance mark, whose mouth opens and shuts while
 * something loads. The mark is /assets/logo-mark.svg. The styles are in styles/global.css (.aretia-mark).
 *
 * Two ways in:
 *  - `loadingBlock(text)` / `markSvg(size)` for a place that wants a loader on purpose;
 *  - `startLoadingMarks()` (see loadingMarks.ts), which puts the mark beside any "Loading…", "Checking…", "Searching…" style
 *    message the pages already show, so every loading state looks the same without each one being rewritten.
 */

/**
 * The mark on a 320-unit square: the outlined square behind, the navy tile in front, and the round shape in two jaws that open and
 * shut. The jaws are the two halves of a disc split along its middle, each turned about the disc's centre (180, 171).
 */
export const MARK_PIECES: readonly { id: 'back' | 'top' | 'bottom'; el: string; attrs: string }[] = [
  { id: 'back', el: 'rect', attrs: 'x="4" y="4" width="296" height="296"' },
  { id: 'top', el: 'path', attrs: 'd="M98 171A82 82 0 0 1 262 171Z"' },
  { id: 'bottom', el: 'path', attrs: 'd="M262 171A82 82 0 0 1 98 171Z"' },
];

/** The mark as SVG markup. `size` is in pixels, or any CSS length when a string. */
export function markSvg(size: number | string = 40): string {
  const s = typeof size === 'number' ? `${size}` : size;
  const piece = (id: string): string => {
    const p = MARK_PIECES.find((x) => x.id === id)!;
    return `<${p.el} class="aretia-mark__${p.id}" ${p.attrs}/>`;
  };
  return `<svg class="aretia-mark" viewBox="0 0 320 320" width="${s}" height="${s}" aria-hidden="true" focusable="false">${piece('back')}<rect class="aretia-mark__tile" x="26" y="26" width="290" height="290"/>${piece('top')}${piece('bottom')}</svg>`;
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
