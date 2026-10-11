import { describe, expect, it } from 'vitest';
import { ageText, assetIdFromInput, categoryLabel, chainLabel, classificationLabel, looksLikeEvmAddress, radarErrorText, scoreText, usdText } from './walletRadar';

const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const MINT = 'So11111111111111111111111111111111111111112';

describe('assetIdFromInput', () => {
  it('builds the id of an EVM token from the chosen chain, in lower case', () => {
    expect(assetIdFromInput(` ${PEPE} `, 'ethereum')).toBe(`ethereum:${PEPE.toLowerCase()}`);
    expect(assetIdFromInput(PEPE, 'base')).toBe(`base:${PEPE.toLowerCase()}`);
  });
  it('a Solana mint stands alone and ignores the EVM choice', () => {
    expect(assetIdFromInput(MINT, 'polygon')).toBe(`solana:${MINT}`);
  });
  it('rejects anything that is not an address', () => {
    for (const bad of ['', 'hello', '0x123', `${PEPE}0`, PEPE.replace('0x', '0z'), `${MINT}/../x`, 'O'.repeat(40), `solana:${MINT}`]) expect(assetIdFromInput(bad, 'ethereum')).toBeNull();
  });
  it('knows when the chain has to be asked for', () => {
    expect(looksLikeEvmAddress(PEPE)).toBe(true);
    expect(looksLikeEvmAddress(MINT)).toBe(false);
    expect(looksLikeEvmAddress('0x12')).toBe(false);
  });
});

describe('what the page says', () => {
  it('shows an unknown score as Unknown, never as zero', () => {
    expect(scoreText(null)).toBe('Unknown');
    expect(scoreText(undefined)).toBe('Unknown');
    expect(scoreText(NaN)).toBe('Unknown');
    expect(scoreText(0)).toBe('0');
    expect(scoreText(45.4)).toBe('45');
  });
  it('shows an unknown amount as Unknown and formats the rest', () => {
    expect(usdText(null)).toBe('Unknown');
    expect(usdText('5' as unknown)).toBe('Unknown');
    expect(usdText(1_667_643_578)).toBe('$1.67B');
    expect(usdText(29_641_638)).toBe('$29.64M');
    expect(usdText(265_226)).toBe('$265.2K');
    expect(usdText(12.345)).toBe('$12.35');
    expect(usdText(0.00000403)).toBe('$0.00000403');
  });
  it('labels classifications plainly and falls back to Unknown for one it does not know', () => {
    expect(classificationLabel('INSUFFICIENT_EVIDENCE')).toBe('Not enough evidence');
    expect(classificationLabel('MATURE')).toBe('Mature');
    expect(classificationLabel('SOMETHING_NEW')).toBe('Unknown');
    expect(classificationLabel(undefined)).toBe('Unknown');
  });
  it('names chains and data categories, and passes an unfamiliar one through', () => {
    expect(chainLabel('bnb')).toBe('BNB Chain');
    expect(chainLabel('solana')).toBe('Solana');
    expect(chainLabel('newchain')).toBe('newchain');
    expect(categoryLabel('smartWallet')).toBe('smart-wallet activity');
    expect(categoryLabel('other')).toBe('other');
  });
  it('says how old the data is, and admits when it does not know', () => {
    expect(ageText(20)).toBe('just now');
    expect(ageText(600)).toBe('10 min ago');
    expect(ageText(7200)).toBe('2 h ago');
    expect(ageText(400_000)).toBe('5 days ago');
    expect(ageText(null)).toBe('unknown age');
    expect(ageText(-2)).toBe('just now'); // clock skew of a moment
    expect(ageText(-500)).toBe('unknown age');
  });
  it('turns an error code into a plain sentence, and never shows an unknown code', () => {
    expect(radarErrorText('radar-not-configured')).toMatch(/not switched on/);
    expect(radarErrorText('not-analyzed')).toMatch(/not analyzed/);
    expect(radarErrorText('db password leaked')).toBe('Radar could not answer. Try again shortly.');
    expect(radarErrorText(undefined)).toBe('Radar could not answer. Try again shortly.');
  });
  it('never uses promise language', () => {
    const all = [...['radar-not-configured', 'radar-unreachable', 'radar-error', 'radar-bad-answer', 'radar-busy', 'rate-limit', 'not-analyzed', 'bad-asset', 'origin'].map(radarErrorText), ...['EARLY', 'EMERGING', 'MOMENTUM', 'MATURE', 'OVEREXTENDED', 'DECLINING', 'AVOID', 'INSUFFICIENT_EVIDENCE'].map(classificationLabel)].join(' ');
    expect(all).not.toMatch(/guarantee|risk-free|will pump|sure winner|\bsafe\b|10x/i);
  });
});
