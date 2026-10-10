/**
 * The colour guide for Aretia's rating. The list shows a coloured chip, so people need one place that says what each
 * colour means. Two shapes of the same words: a short key for the list's filter bar, and a folded list for the panel.
 */
import { RATING_BANDS } from '../swings/market/rowRisk.js';

function span(cls: string, text = ''): HTMLSpanElement {
  const n = document.createElement('span');
  n.className = cls;
  if (text) n.textContent = text;
  return n;
}

/** One line of swatches ("● Green ● Yellow …") with the full meaning on hover and for screen readers. */
export function ratingKey(): HTMLElement {
  const box = span('wapp-key');
  box.setAttribute('role', 'note');
  box.title = RATING_BANDS.map((b) => `${b.name}: ${b.meaning}`).join('\n');
  box.append(span('wapp-key__lead', 'Rating colours'));
  for (const b of RATING_BANDS) {
    const item = span('wapp-key__item');
    item.append(span(`wapp-key__dot wapp-key__dot--${b.band}`), span('', b.name));
    box.append(item);
  }
  return box;
}

/** The same guide as a folded list, one colour per line. */
export function ratingGuide(): HTMLElement {
  const d = document.createElement('details');
  d.className = 'wapp-mp__more';
  const s = document.createElement('summary');
  s.textContent = 'What the colours mean';
  d.append(s);
  const list = document.createElement('ul');
  list.className = 'wapp-guide';
  for (const b of RATING_BANDS) {
    const li = document.createElement('li');
    li.append(span(`wapp-key__dot wapp-key__dot--${b.band}`), span('', `${b.name}. ${b.meaning}`));
    list.append(li);
  }
  const note = document.createElement('p');
  note.className = 'wapp-mp__note';
  note.textContent = 'A colour is a reading, not advice and not a promise. Green does not mean safe.';
  d.append(list, note);
  return d;
}
