/**
 * Checks for the two request forms ("Request verification" and "Get featured"). Pure: no DOM, no network. The pages call these before
 * anything is sent, and the Formspree form behind them is the only place the answers go. Nothing here takes payment.
 */
import { addressOk, httpsUrl, VERIFY_CHAINS } from './verified';

export type RequestKind = 'verify' | 'featured';

export interface RequestFields {
  token: string;
  chain: string;
  project: string;
  contact: string;
  /** Featured requests only. */
  title?: string;
  blurb?: string;
  from?: string;
  to?: string;
}

export type RequestErrors = Partial<Record<keyof RequestFields, string>>;

export const REQUEST_LIMITS = { title: 60, blurb: 140, contact: 120 } as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A contact is an email address. (A handle alone is not enough for us to reply to.) */
export const contactOk = (v: string): boolean => v.length <= REQUEST_LIMITS.contact && EMAIL.test(v);

/** What is wrong with a request, by field. An empty object means it can be sent. */
export function validateRequest(kind: RequestKind, f: RequestFields): RequestErrors {
  const e: RequestErrors = {};
  const token = f.token.trim();
  const chain = f.chain.trim();
  if (!VERIFY_CHAINS.includes(chain as (typeof VERIFY_CHAINS)[number])) e.chain = 'Choose Solana, BNB Chain, Ethereum or Polygon.';
  if (!token) e.token = 'Paste the token address.';
  else if (!e.chain && !addressOk(chain, token)) e.token = chain === 'solana' ? 'That is not a Solana address (32 to 44 letters and numbers).' : 'That is not an address: it should be 0x followed by 40 letters and numbers.';
  if (!f.project.trim()) e.project = 'Add the project link.';
  else if (!httpsUrl(f.project.trim())) e.project = 'The link must start with https:// and be a real website.';
  if (!f.contact.trim()) e.contact = 'Add an email address we can reply to.';
  else if (!contactOk(f.contact.trim())) e.contact = 'That does not look like an email address.';
  if (kind === 'featured') {
    const title = (f.title ?? '').trim();
    const blurb = (f.blurb ?? '').trim();
    if (!title) e.title = 'Add a title.';
    else if (title.length > REQUEST_LIMITS.title) e.title = `Keep the title to ${REQUEST_LIMITS.title} characters.`;
    if (!blurb) e.blurb = 'Add one line about the token.';
    else if (blurb.length > REQUEST_LIMITS.blurb) e.blurb = `Keep it to ${REQUEST_LIMITS.blurb} characters.`;
    const from = (f.from ?? '').trim();
    const to = (f.to ?? '').trim();
    if (from && !DATE.test(from)) e.from = 'Use a date.';
    if (to && !DATE.test(to)) e.to = 'Use a date.';
    if (!e.from && !e.to && from && to && to < from) e.to = 'The last day cannot be before the first.';
  }
  return e;
}

export const hasErrors = (e: RequestErrors): boolean => Object.keys(e).length > 0;
