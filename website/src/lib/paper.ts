export type PaperTheme = 'brand' | 'mint' | 'ink' | 'light' | 'bright' | 'gold';

/** Order the papers repeat in, chosen so neighbours in a 2- or 3-column grid differ. */
export const PAPER_CYCLE: PaperTheme[] = ['light', 'brand', 'mint', 'ink', 'bright', 'light'];

export const paperTheme = (i: number, cycle: PaperTheme[] = PAPER_CYCLE): PaperTheme => cycle[i % cycle.length]!;
export const paperClass = (i: number, cycle?: PaperTheme[]): string => `paper paper--${paperTheme(i, cycle)}`;
export const twoDigits = (n: number): string => String(n).padStart(2, '0');
