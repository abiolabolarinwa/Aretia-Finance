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
