/**
 * From findings to a verdict: the colour, the one-line answer, and the plain-text version people paste into a chat.
 */
import { checkHash } from './classify.js';
import type { Band, Fact, Finding, Severity, Subject, Verdict } from './types.js';
import { worseBand } from './types.js';

/** The colour the findings add up to. Any problem is red; a strong caution orange; a thing worth knowing yellow; passes alone green; nothing known grey. */
export function bandFromFindings(findings: readonly Finding[]): Band {
  if (findings.some((f) => f.severity === 'bad')) return 'red';
  if (findings.some((f) => f.severity === 'warn')) return 'orange';
  if (findings.some((f) => f.severity === 'note')) return 'yellow';
  if (findings.some((f) => f.severity === 'ok')) return 'green';
  return 'grey';
}

const RANK: Record<Severity, number> = { bad: 0, warn: 1, note: 2, info: 3, ok: 4 };

/** Worst first, so the list reads from what matters most. */
export const sortFindings = (findings: readonly Finding[]): Finding[] => [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);

const LEAD: Record<Band, string> = {
  red: 'Do not send or sign.',
  orange: 'Be careful.',
  yellow: 'Worth a second look.',
  green: 'No problems found in what Shield could check.',
  grey: 'Shield could not tell.',
};

/** The sentence at the top of a result: what to do, then the worst thing found. */
export function headlineFor(band: Band, findings: readonly Finding[]): string {
  const worst = sortFindings(findings).find((f) => f.severity === 'bad' || f.severity === 'warn' || f.severity === 'note');
  if ((band === 'red' || band === 'orange' || band === 'yellow') && worst) return `${LEAD[band]} ${worst.title}`;
  if (band === 'green') return `${LEAD.green} That is not a promise of safety: see what it could not check.`;
  return LEAD[band];
}

export interface VerdictInput {
  subject: Subject;
  findings: Finding[];
  couldNot: string[];
  facts?: Fact[];
  links?: { label: string; url: string }[];
  now: number;
  /** A colour already decided elsewhere (a token's rating): the verdict is never better than this, nor than the findings. */
  floor?: Band;
  ratingLabel?: string;
}

export function buildVerdict(i: VerdictInput): Verdict {
  const findings = sortFindings(i.findings);
  const band = i.floor ? worseBand(bandFromFindings(findings), i.floor) : bandFromFindings(findings);
  return {
    subject: i.subject,
    band,
    headline: headlineFor(band, findings),
    findings,
    couldNot: i.couldNot,
    facts: i.facts ?? [],
    links: i.links ?? [],
    checkedAt: i.now,
    ...(i.ratingLabel ? { ratingLabel: i.ratingLabel } : {}),
  };
}

/** A check that could not be made at all: grey, and honest about it. */
export function failedVerdict(subject: Subject, why: string, now: number): Verdict {
  return buildVerdict({ subject, findings: [{ id: 'unreachable', severity: 'info', title: 'Shield could not read this just now.', detail: why }], couldNot: ['Everything: the check did not complete. Try again in a moment.'], now });
}

const COLOUR_WORD: Record<Band, string> = { green: 'Green', yellow: 'Yellow', orange: 'Orange', red: 'Red', grey: 'Grey' };
export const bandWord = (b: Band): string => COLOUR_WORD[b];

const short = (v: string): string => (v.length > 16 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);

/** What someone pastes into a chat: the colour, the answer, the top findings, and a link that re-runs the check live. */
export function shareText(v: Verdict, origin: string): string {
  const name = v.subject.label ? `${v.subject.label} (${short(v.subject.value)})` : short(v.subject.value);
  const top = v.findings.filter((f) => f.severity !== 'ok' && f.severity !== 'info').slice(0, 3);
  const lines = [`Aretia Shield: ${COLOUR_WORD[v.band]} for ${name}`, v.headline, ...top.map((f) => `• ${f.title}`), `Check it yourself: ${origin}/wallet${checkHash(v.subject.value)}`, 'Shield reads public data. It is not advice and never says something is safe.'];
  return lines.join('\n');
}

/** The address of a shareable result. It carries only what was checked: no result, no wallet, nothing private. */
export const shareLink = (origin: string, value: string): string => `${origin}/wallet${checkHash(value)}`;
