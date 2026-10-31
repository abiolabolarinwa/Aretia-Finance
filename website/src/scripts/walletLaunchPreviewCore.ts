/**
 * What the Launch preview card shows. It reads the create form, but the form leaves the page once the review and the "created" screens
 * replace it, so the card keeps the last values it saw while the form was there and shows those until the form comes back.
 */
export interface PreviewValues {
  name: string;
  symbol: string;
  supply: string;
  share: { label: string; value: string } | null;
}

export const NO_PREVIEW_VALUES: PreviewValues = { name: '', symbol: '', supply: '', share: null };

/** `live` is what the form holds now, or null when the form is not on the page. Returns what to draw and what to remember. */
export function previewValues(live: PreviewValues | null, remembered: PreviewValues): { shown: PreviewValues; remembered: PreviewValues } {
  const shown = live ?? remembered;
  return { shown, remembered: live ?? remembered };
}

/** The parts of a Token-2022 mint read with `jsonParsed` that the preview needs. */
export interface ParsedMint {
  supply?: unknown;
  decimals?: unknown;
  extensions?: { extension?: unknown; state?: { name?: unknown; symbol?: unknown } }[];
}

/** The name, symbol and whole-token supply of a created token, from its mint read off the network; null when it is not readable. */
export function previewFromMint(info: ParsedMint | null | undefined): PreviewValues | null {
  if (!info || typeof info.supply !== 'string' || !/^\d+$/.test(info.supply) || typeof info.decimals !== 'number' || info.decimals < 0 || info.decimals > 18) return null;
  const meta = (info.extensions ?? []).find((e) => e.extension === 'tokenMetadata')?.state;
  const name = typeof meta?.name === 'string' ? meta.name : '';
  const symbol = typeof meta?.symbol === 'string' ? meta.symbol.toUpperCase() : '';
  if (name === '' && symbol === '') return null;
  return { name, symbol, supply: (BigInt(info.supply) / 10n ** BigInt(info.decimals)).toString(), share: null };
}
