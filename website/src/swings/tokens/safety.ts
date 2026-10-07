/**
 * Turns a token's risk assessment into the plain statements the swap screen shows before anyone signs:
 * what was found, what was fine, and what could not be checked. It adds no judgement of its own: every line is a
 * signal the risk engine already produced, in the engine's own words, and an unchecked signal is said to be
 * unchecked rather than counted as safe.
 */
import type { RiskStatus, TokenRisk } from '../core/types.js';

export type SafetyTone = 'ok' | 'info' | 'warn' | 'bad';

export interface SafetyView {
  tone: SafetyTone;
  headline: string;
  /** Things found that a buyer should know, worst first, each in plain words. */
  concerns: { text: string; severe: boolean }[];
  /** How many checks passed. */
  passed: number;
  /** Checks that could not be run, named. Never counted as passed. */
  unchecked: string[];
  /** True when the swap screen should ask for an explicit extra confirmation. */
  needsAcknowledgement: boolean;
}

const HEADLINE: Readonly<Record<RiskStatus, { text: string; tone: SafetyTone }>> = {
  established: { text: 'Established token: widely held and long-lived, no major concerns found.', tone: 'ok' },
  verified: { text: 'Verified by Aretia, no major concerns found.', tone: 'ok' },
  new: { text: 'New token: very little history. New tokens are where most scams are.', tone: 'warn' },
  unverified: { text: 'Unverified token: Aretia has not vouched for it.', tone: 'info' },
  elevated: { text: 'Elevated risk: concerns were found. Read them before you buy.', tone: 'warn' },
  high: { text: 'High risk: serious concerns were found. You may not be able to sell this token.', tone: 'bad' },
  restricted: { text: 'Restricted: this token has controls that can stop or tax your trades.', tone: 'bad' },
  unknown: { text: 'Not enough data to assess this token. That is not a good sign or a bad one.', tone: 'info' },
};

/** Builds the view. A null assessment means none was available, and says so. */
export function describeSafety(risk: TokenRisk | null): SafetyView {
  if (!risk) {
    return { tone: 'info', headline: 'No safety assessment could be made for this token. Check it yourself before buying.', concerns: [], passed: 0, unchecked: [], needsAcknowledgement: false };
  }
  const h = HEADLINE[risk.status];
  const bad = risk.signals.filter((s) => s.state === 'bad');
  const warn = risk.signals.filter((s) => s.state === 'warn');
  const concerns = [...bad.map((s) => ({ text: `${s.label}: ${s.detail}`, severe: true })), ...warn.map((s) => ({ text: `${s.label}: ${s.detail}`, severe: false }))];
  const passed = risk.signals.filter((s) => s.state === 'ok').length;
  const unchecked = [...risk.signals.filter((s) => s.state === 'unavailable').map((s) => s.label), ...risk.unavailable];
  const tone: SafetyTone = bad.length > 0 && h.tone !== 'bad' ? 'bad' : h.tone;
  return { tone, headline: h.text, concerns, passed, unchecked: [...new Set(unchecked)], needsAcknowledgement: tone === 'bad' || risk.status === 'high' || risk.status === 'restricted' };
}
