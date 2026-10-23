/**
 * The description and links of a token, drawn the same way on the public token page and in the Launch page's preview, so what a
 * creator sees before creating is what holders see after. Text only (textContent); links open in a new tab with no referrer.
 * What a token's creator wrote is theirs: Aretia does not check it, and the block says so.
 */
export interface MetaText {
  description: string;
  website: string | null;
  x: string | null;
  telegram: string | null;
}

const LABELS: [keyof Pick<MetaText, 'website' | 'x' | 'telegram'>, string][] = [
  ['website', 'Website'],
  ['x', 'X'],
  ['telegram', 'Telegram'],
];

/** Null when there is nothing to show. `prefix` is the page's own class prefix ("tkp" or "lh-token"). `interactive` false draws links as plain text. */
export function metaBlock(meta: MetaText, prefix: string, interactive: boolean): HTMLElement | null {
  const links = LABELS.filter(([k]) => meta[k]);
  if (meta.description === '' && links.length === 0) return null;
  const box = document.createElement('div');
  box.className = `${prefix}-meta`;
  if (meta.description) {
    const p = document.createElement('p');
    p.className = `${prefix}-desc`;
    p.textContent = meta.description;
    box.append(p);
  }
  if (links.length > 0) {
    const row = document.createElement('p');
    row.className = `${prefix}-links`;
    for (const [k, label] of links) {
      const url = meta[k]!;
      if (interactive) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow ugc';
        a.textContent = label;
        a.title = url;
        row.append(a);
      } else {
        const s = document.createElement('span');
        s.textContent = label;
        s.title = url;
        row.append(s);
      }
    }
    box.append(row);
  }
  const note = document.createElement('p');
  note.className = `${prefix}-note`;
  note.textContent = 'Written by the token’s creator. Aretia does not check it.';
  box.append(note);
  return box;
}
