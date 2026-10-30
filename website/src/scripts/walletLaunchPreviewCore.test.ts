import { describe, expect, it } from 'vitest';
import { NO_PREVIEW_VALUES, previewValues, type PreviewValues } from './walletLaunchPreviewCore';

const typed: PreviewValues = { name: 'Master', symbol: 'MAS', supply: '1000000000', share: { label: 'Your share', value: '10%' } };

describe('the Launch preview card values', () => {
  it('shows what the form holds while the form is on the page, and remembers it', () => {
    const r = previewValues(typed, NO_PREVIEW_VALUES);
    expect(r.shown).toEqual(typed);
    expect(r.remembered).toEqual(typed);
  });

  it('keeps showing the last values once the form has left the page (review and created screens)', () => {
    const r = previewValues(null, typed);
    expect(r.shown).toEqual(typed);
    expect(r.remembered).toEqual(typed);
  });

  it('shows the empty form when it comes back empty (Create another), not the old token', () => {
    const r = previewValues(NO_PREVIEW_VALUES, typed);
    expect(r.shown).toEqual(NO_PREVIEW_VALUES);
    expect(r.remembered).toEqual(NO_PREVIEW_VALUES);
  });

  it('shows nothing before anything was typed and the form is not there', () => {
    expect(previewValues(null, NO_PREVIEW_VALUES).shown).toEqual(NO_PREVIEW_VALUES);
  });
});
