import { describe, expect, it } from 'vitest';
import { checkHash, classifyInput, valueFromHash } from './classify.js';
import { findLookalikes, isKnown, sharedEnds } from './lookalike.js';
import { checkSiteLink, editDistance, registrationDate, siteParts, squash } from './domain.js';
import { bandFromFindings, buildVerdict, headlineFor, shareLink, shareText } from './verdict.js';
import { worseBand, type Finding, type KnownAddress, type Subject } from './types.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EVM = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const EVM_CHECKSUMMED = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const f = (severity: Finding['severity'], title = 't'): Finding => ({ id: title + severity, severity, title, detail: 'd' });
const NOW = Date.UTC(2026, 9, 11);

describe('classifyInput', () => {
  it('reads Solana and EVM addresses', () => {
    expect(classifyInput(` ${SOL} `)).toEqual({ kind: 'solana', value: SOL });
    expect(classifyInput(EVM)).toEqual({ kind: 'evm', value: EVM, badChecksum: false });
    expect(classifyInput(EVM_CHECKSUMMED)).toMatchObject({ kind: 'evm', badChecksum: false });
  });
  it('catches an EVM address whose checksum capitals are wrong: it was mistyped or altered', () => {
    const wrong = EVM_CHECKSUMMED.replace('A0b8', 'a0B8');
    expect(classifyInput(wrong)).toMatchObject({ kind: 'evm', badChecksum: true });
  });
  it('reads names, links, bare domains and transactions', () => {
    expect(classifyInput('Bob.sns')).toEqual({ kind: 'name', value: 'bob.sns' });
    expect(classifyInput('https://phantom.app/download')).toMatchObject({ kind: 'site' });
    expect(classifyInput('claim-your-airdrop.xyz/now')).toMatchObject({ kind: 'site' });
    expect(classifyInput('0x' + 'ab'.repeat(32))).toMatchObject({ kind: 'transaction' });
    expect(classifyInput('5'.repeat(88))).toMatchObject({ kind: 'transaction' });
  });
  it('does not guess at anything else', () => {
    for (const t of ['', 'hello there', 'javascript:alert(1)', 'ftp://x.com', '0x123', 'not a link']) expect(classifyInput(t).kind, t).toBe('unknown');
  });
  it('round-trips a shareable link, and refuses a broken one', () => {
    expect(valueFromHash(checkHash(SOL))).toBe(SOL);
    expect(valueFromHash(checkHash('https://a.b/c?d=1'))).toBe('https://a.b/c?d=1');
    expect(valueFromHash('#/shield')).toBeNull();
    expect(valueFromHash('#/shield/%E0%A4%A')).toBeNull();
  });
});

describe('look-alike addresses (address poisoning)', () => {
  const known = (address: string): KnownAddress => ({ address, label: 'Mum', trusted: true, lastUsed: 1 });
  const mine = 'GkXn6PUubyYHHE1h7tVd9bGswwSKoLaGBdBr4eDUdaWa';
  // Same first four and last four characters, different middle: what a poisoner makes.
  const fake = mine.slice(0, 4) + 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' + mine.slice(-4);

  it('finds an address that starts and ends like a known one but is not it', () => {
    const hits = findLookalikes(fake, [known(mine)]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ prefix: 4, suffix: 4 });
    expect(hits[0]!.known.label).toBe('Mum');
  });
  it('does not flag the known address itself, or two unrelated ones', () => {
    expect(findLookalikes(mine, [known(mine)])).toEqual([]);
    expect(findLookalikes(SOL, [known(mine)])).toEqual([]);
  });
  it('compares EVM addresses without the 0x and without letter case', () => {
    const real = '0x1234567890abcdef1234567890abcdef12345678';
    const fakeEvm = '0x1234' + 'F'.repeat(32) + '5678';
    expect(findLookalikes(fakeEvm, [known(real)])).toHaveLength(1);
    expect(findLookalikes(real.toUpperCase().replace('0X', '0x'), [known(real)])).toEqual([]);
    expect(isKnown(real.toUpperCase().replace('0X', '0x'), [known(real)])).not.toBeNull();
  });
  it('never compares a Solana address with an EVM one', () => {
    expect(findLookalikes('0x' + 'a'.repeat(40), [known(mine)])).toEqual([]);
  });
  it('counts the shared ends exactly', () => {
    expect(sharedEnds('abcXYZdef', 'abcQQQdef')).toEqual({ prefix: 3, suffix: 3 });
    expect(sharedEnds('same', 'same').prefix).toBe(4);
  });
});

describe('checking a link', () => {
  const check = (link: string, registeredAt: number | null = null) => checkSiteLink(new URL(link.includes('://') ? link : `https://${link}`), link, { registeredAt }, NOW);
  const ids = (link: string, registeredAt: number | null = null): string[] => check(link, registeredAt).findings.map((x) => x.id);

  it('recognises a brand\'s own address, and still warns that a copy can lead elsewhere', () => {
    const r = check('https://app.phantom.app/swap');
    expect(r.findings[0]).toMatchObject({ id: 'official', severity: 'ok' });
    expect(r.findings[0]!.detail).toMatch(/bookmark/);
    expect(r.brand?.name).toBe('Phantom');
    expect(ids('aretiafinance.org')).toContain('official');
  });
  it('flags look-alike letters, the same name on another ending, and a real name hidden inside a fake one', () => {
    expect(check('phant0m.app').findings.find((x) => x.id === 'lookalike-Phantom')?.severity).toBe('bad');
    expect(check('rnetamask.io').findings.find((x) => x.id === 'lookalike-MetaMask')?.severity).toBe('bad');
    expect(check('phantom.xyz').findings.find((x) => x.id === 'samename-Phantom')?.severity).toBe('bad');
    expect(check('phantom.app.secure-login.com').findings.find((x) => x.id === 'hidden-Phantom')?.severity).toBe('bad');
  });
  it('flags a name one or two letters off, and a brand name inside a longer one, as cautions', () => {
    expect(check('phantomm.app').findings.find((x) => x.id === 'typo-Phantom')?.severity).toBe('warn');
    expect(check('phantom-wallet-support.com').findings.find((x) => x.id === 'contains-Phantom')?.severity).toBe('warn');
  });
  it('treats a short name that is only the same word as a caution, not an accusation', () => {
    expect(check('orca.com').findings.find((x) => x.id === 'samename-Orca')?.severity).toBe('warn');
  });
  it('flags the @ trick, bare numbers, special characters, plain http, shorteners and a file-type ending', () => {
    expect(ids('https://phantom.app@evil.example')).toContain('userinfo');
    expect(ids('http://192.168.4.4/login')).toEqual(expect.arrayContaining(['ip', 'http']));
    expect(ids('https://xn--phantm-9ya.app')).toContain('idn');
    expect(ids('https://bit.ly/3xyz')).toContain('shortener');
    expect(ids('https://free-airdrop.zip')).toContain('file-tld');
  });
  it('flags the words scam pages use, and does not for an official page', () => {
    expect(ids('claim-airdrop-rewards.xyz')).toEqual(expect.arrayContaining(['lure', 'cheap-tld']));
    expect(ids('https://phantom.app/support')).not.toContain('lure');
  });
  it('still flags the scam words and a cheap ending on an imitation, but not on the real thing', () => {
    expect(ids('phantom-app.xyz/claim')).toEqual(expect.arrayContaining(['contains-Phantom', 'lure', 'cheap-tld']));
    expect(ids('phantom.app/claim')).not.toContain('lure');
  });
  it('says nothing alarming about an ordinary site, and does not call it safe either', () => {
    const r = check('https://example.com/docs');
    expect(r.findings).toEqual([]);
    expect(r.brand).toBeNull();
  });
  it('uses the domain\'s age when it is known', () => {
    const day = 86_400_000;
    expect(check('example.com', NOW - 2 * day).findings.find((x) => x.id === 'age')).toMatchObject({ severity: 'warn' });
    expect(check('example.com', NOW - 20 * day).findings.find((x) => x.id === 'age')).toMatchObject({ severity: 'note' });
    expect(check('example.com', NOW - 400 * day).findings.find((x) => x.id === 'age')).toMatchObject({ severity: 'ok' });
    expect(check('example.com', null).findings.find((x) => x.id === 'age')).toBeUndefined();
  });
  it('reads the registration date from a registry record', () => {
    expect(registrationDate({ events: [{ eventAction: 'last changed', eventDate: '2026-01-01T00:00:00Z' }, { eventAction: 'registration', eventDate: '2020-05-06T07:08:09Z' }] })).toBe(Date.parse('2020-05-06T07:08:09Z'));
    expect(registrationDate({ events: [] })).toBeNull();
    expect(registrationDate(null)).toBeNull();
    expect(registrationDate({ events: [{ eventAction: 'registration', eventDate: 'not a date' }] })).toBeNull();
  });
  it('splits a name into its parts, including two-part endings', () => {
    expect(siteParts('app.example.com')).toMatchObject({ registrable: 'example.com', label: 'example', tld: 'com' });
    expect(siteParts('shop.example.co.uk')).toMatchObject({ registrable: 'example.co.uk', label: 'example' });
    expect(siteParts('bank.com.ng')).toMatchObject({ registrable: 'bank.com.ng' });
  });
  it('measures edits and squashes look-alike letters', () => {
    expect(editDistance('phantom', 'phantomm')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(squash('PHANT0M')).toBe('phantom');
    expect(squash('rnetamask')).toBe('metamask');
  });
});

describe('verdicts', () => {
  const subject: Subject = { kind: 'solana-wallet', chain: 'solana', value: USDC, label: null, icon: null };
  it('is red for any problem, orange for a strong caution, yellow for a note, green for passes alone, grey for nothing', () => {
    expect(bandFromFindings([f('ok'), f('bad')])).toBe('red');
    expect(bandFromFindings([f('ok'), f('warn'), f('note')])).toBe('orange');
    expect(bandFromFindings([f('ok'), f('note')])).toBe('yellow');
    expect(bandFromFindings([f('ok')])).toBe('green');
    expect(bandFromFindings([f('info')])).toBe('grey');
    expect(bandFromFindings([])).toBe('grey');
  });
  it('picks the worse of two colours, and treats grey as asserting nothing', () => {
    expect(worseBand('green', 'orange')).toBe('orange');
    expect(worseBand('red', 'yellow')).toBe('red');
    expect(worseBand('grey', 'green')).toBe('green');
    expect(worseBand('yellow', 'grey')).toBe('yellow');
  });
  it('is never better than a rating it was given, nor than its own findings', () => {
    expect(buildVerdict({ subject, findings: [f('ok')], couldNot: [], now: NOW, floor: 'orange' }).band).toBe('orange');
    expect(buildVerdict({ subject, findings: [f('bad')], couldNot: [], now: NOW, floor: 'green' }).band).toBe('red');
  });
  it('says what to do, then the worst thing found, worst first', () => {
    const v = buildVerdict({ subject, findings: [f('ok', 'fine'), f('note', 'minor'), f('bad', 'terrible')], couldNot: ['x'], now: NOW });
    expect(v.findings.map((x) => x.title)).toEqual(['terrible', 'minor', 'fine']);
    expect(v.headline).toBe('Do not send or sign. terrible');
    expect(headlineFor('green', [f('ok')])).toMatch(/not a promise of safety/);
    expect(headlineFor('grey', [])).toBe('Shield could not tell.');
    expect(headlineFor('yellow', [f('ok')], 'Unverified')).toBe('Worth a second look. Aretia rates it "Unverified": read what was checked below.');
  });
  it('writes a share text with the colour, the top findings and a link that re-runs the check, and nothing private', () => {
    const v = buildVerdict({ subject: { ...subject, label: 'Mystery' }, findings: [f('bad', 'It is a trap'), f('ok', 'passed')], couldNot: [], now: NOW });
    const text = shareText(v, 'https://aretiafinance.org');
    expect(text).toContain('Red for Mystery');
    expect(text).toContain('• It is a trap');
    expect(text).not.toContain('passed');
    expect(text).toContain(`https://aretiafinance.org/wallet#/shield/${USDC}`);
    expect(shareLink('https://x.y', 'a b')).toBe('https://x.y/wallet#/shield/a%20b');
  });
});
