/**
 * Is this link a fake of a site people trust? Shield does not open the page and has no blocklist, so this is a set of checks
 * that catch the common tricks (look-alike names, a real name hidden inside a fake one, a new domain, a link shortener), said
 * plainly as heuristics. A link that passes is not thereby safe, and the result says so.
 */
import type { Finding } from './types.js';

export interface Brand {
  name: string;
  /** Official registrable domains. */
  domains: readonly string[];
}

/** Sites people are impersonated as. Each domain is the brand's own, as it publishes it. */
export const BRANDS: readonly Brand[] = [
  { name: 'Aretia Finance', domains: ['aretiafinance.org'] },
  { name: 'Phantom', domains: ['phantom.app', 'phantom.com'] },
  { name: 'Solflare', domains: ['solflare.com'] },
  { name: 'Backpack', domains: ['backpack.app', 'backpack.exchange'] },
  { name: 'Jupiter', domains: ['jup.ag'] },
  { name: 'Raydium', domains: ['raydium.io'] },
  { name: 'Orca', domains: ['orca.so'] },
  { name: 'Pump.fun', domains: ['pump.fun'] },
  { name: 'Magic Eden', domains: ['magiceden.io'] },
  { name: 'MetaMask', domains: ['metamask.io'] },
  { name: 'Rabby', domains: ['rabby.io'] },
  { name: 'Trust Wallet', domains: ['trustwallet.com'] },
  { name: 'Ledger', domains: ['ledger.com'] },
  { name: 'Trezor', domains: ['trezor.io'] },
  { name: 'WalletConnect', domains: ['walletconnect.com', 'walletconnect.org'] },
  { name: 'Uniswap', domains: ['uniswap.org'] },
  { name: 'PancakeSwap', domains: ['pancakeswap.finance'] },
  { name: '1inch', domains: ['1inch.io', '1inch.com'] },
  { name: 'Curve', domains: ['curve.fi'] },
  { name: 'Aave', domains: ['aave.com'] },
  { name: 'Lido', domains: ['lido.fi'] },
  { name: 'OpenSea', domains: ['opensea.io'] },
  { name: 'Binance', domains: ['binance.com'] },
  { name: 'Coinbase', domains: ['coinbase.com'] },
  { name: 'Kraken', domains: ['kraken.com'] },
  { name: 'MoonPay', domains: ['moonpay.com'] },
  { name: 'Robinhood', domains: ['robinhood.com'] },
  { name: 'DexScreener', domains: ['dexscreener.com'] },
  { name: 'Solscan', domains: ['solscan.io'] },
  { name: 'Etherscan', domains: ['etherscan.io'] },
  { name: 'BscScan', domains: ['bscscan.com'] },
  { name: 'Solana', domains: ['solana.com'] },
  { name: 'Circle', domains: ['circle.com'] },
  { name: 'Tether', domains: ['tether.to'] },
];

/** Two-part endings, so "example.co.uk" is read as example, not co. */
const TWO_PART = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'co.nz', 'co.jp', 'co.in', 'co.za', 'com.br', 'com.ng', 'org.ng', 'gov.ng', 'com.mx', 'com.tr', 'com.sg', 'com.hk', 'com.cn', 'co.kr', 'co.id', 'com.ar', 'com.co', 'com.pk']);

const SHORTENERS = new Set(['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'is.gd', 'cutt.ly', 'ow.ly', 'rebrand.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in', 'buff.ly', 'bl.ink', 'linktr.ee']);

const CHEAP_TLDS = new Set(['xyz', 'top', 'click', 'icu', 'gq', 'cf', 'tk', 'ml', 'ga', 'buzz', 'rest', 'cyou', 'sbs', 'lol', 'quest', 'monster']);
const FILE_TLDS = new Set(['zip', 'mov']);

const LURE = /(claim|airdrop|giveaway|verify|validate|connect-?wallet|wallet-?connect|unlock|migrate|restore|recover|seed|rewards?|bonus|whitelist|presale|reclaim|revoke|support|helpdesk|resolve)/i;

export interface SiteParts {
  host: string;
  /** "example.com", or "example.co.uk". */
  registrable: string;
  /** The name part: "example". */
  label: string;
  tld: string;
}

export function siteParts(host: string): SiteParts {
  const h = host.toLowerCase().replace(/\.$/, '');
  const labels = h.split('.');
  const two = labels.slice(-2).join('.');
  const take = TWO_PART.has(two) && labels.length >= 3 ? 3 : 2;
  const reg = labels.slice(-take);
  return { host: h, registrable: reg.join('.'), label: reg[0] ?? h, tld: labels[labels.length - 1] ?? '' };
}

/** Letters swapped for look-alikes, then compared: "rnetamask" and "metamask", "phant0m" and "phantom". */
export function squash(label: string): string {
  return label.toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[01!|]/g, (c) => (c === '0' ? 'o' : c === '1' ? 'l' : 'i')).replace(/3/g, 'e').replace(/5/g, 's').replace(/[-_.]/g, '');
}

/** Edits (insert, delete, change) between two short words. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

const brandLabel = (d: string): string => siteParts(d).label;

/** Whether this host IS one of the brand's domains (or a subdomain of one). */
export const isOfficial = (host: string, brand: Brand): boolean => brand.domains.some((d) => host === d || host.endsWith(`.${d}`));

export interface SiteFacts {
  /** When the domain was registered, from its public registration record, or null when that could not be read. */
  registeredAt: number | null;
}

/** The findings for a link. Pure; the domain's age is passed in because reading it needs the network. */
export function checkSiteLink(url: URL, original: string, facts: SiteFacts, now: number): { findings: Finding[]; brand: Brand | null } {
  const findings: Finding[] = [];
  const parts = siteParts(url.hostname);
  const host = parts.host;
  let matched: Brand | null = null;

  // A name hidden before an @: https://phantom.app@evil.com opens evil.com.
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(original)) {
    findings.push({ id: 'userinfo', severity: 'bad', title: 'The address hides its real destination behind an @.', detail: `Everything before the @ is only decoration. This link opens ${host}.` });
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    findings.push({ id: 'ip', severity: 'warn', title: 'It is a bare number address, not a name.', detail: 'Real services use a name you can recognise. A number address is a common sign of a throwaway page.' });
  }
  if (host.split('.').some((l) => l.startsWith('xn--'))) {
    findings.push({ id: 'idn', severity: 'warn', title: 'The name uses special characters that can imitate letters.', detail: 'Some letters from other alphabets look identical to Latin ones. Look at the address in your browser bar closely.' });
  }
  if (url.protocol === 'http:') {
    findings.push({ id: 'http', severity: 'warn', title: 'The connection is not encrypted.', detail: 'The link starts with http, not https. Anything you type, and anything the page shows, can be read or changed on the way.' });
  }

  // Impersonation: is it a brand's own domain, a hidden one, or a close imitation?
  for (const b of BRANDS) {
    if (isOfficial(host, b)) {
      matched = b;
      findings.push({ id: 'official', severity: 'ok', title: `This is ${b.name}'s own address.`, detail: `Aretia knows ${b.domains.join(' and ')} as ${b.name}'s. A copied page, or an ad that looks like a search result, can still send you somewhere else: open it from your own bookmark or type it yourself.` });
      break;
    }
  }
  if (!matched) {
    for (const b of BRANDS) {
      const word = brandLabel(b.domains[0]!).toLowerCase();
      const label = parts.label.toLowerCase();
      const squashed = squash(label);
      const squashedWord = squash(word);
      const hidden = b.domains.some((d) => host.includes(d) && !isOfficial(host, b));
      if (hidden) {
        findings.push({ id: `hidden-${b.name}`, severity: 'bad', title: `${b.name}'s address is hidden inside a different site.`, detail: `The site you would open is ${parts.registrable}. ${b.name}'s own address is ${b.domains.join(' or ')}; this one only contains it.` });
        matched = b;
        break;
      }
      const own = `${b.name}'s own address is ${b.domains.join(' or ')}. This one is ${parts.registrable}`;
      // The same name with look-alike letters swapped in (phant0m, rnetamask): nobody does that by accident.
      if (squashed === squashedWord && label !== word) {
        findings.push({ id: `lookalike-${b.name}`, severity: 'bad', title: `It imitates ${b.name}, with look-alike letters.`, detail: `${own}: a different site dressed up as it.` });
        matched = b;
        break;
      }
      // The same name on a different ending (phantom.xyz). A short name is often just a different company, so it is only a caution.
      if (label === word) {
        findings.push({ id: `samename-${b.name}`, severity: word.length >= 5 ? 'bad' : 'warn', title: word.length >= 5 ? `It copies ${b.name}'s name on a different address.` : `It has the same name as ${b.name}, on a different address.`, detail: `${own}. Different ending, different owner.` });
        matched = b;
        break;
      }
      const distance = editDistance(label, word);
      if (word.length >= 5 && distance >= 1 && distance <= (word.length >= 10 ? 2 : 1)) {
        findings.push({ id: `typo-${b.name}`, severity: 'warn', title: `It is one or two letters away from ${b.name}.`, detail: `${own}. Mistyped and misspelt names are how fake pages catch people out.` });
        matched = b;
        break;
      }
      if (word.length >= 6 && squashed.includes(squashedWord)) {
        findings.push({ id: `contains-${b.name}`, severity: 'warn', title: `It uses ${b.name}'s name inside a longer address.`, detail: `${own}. Names like ${b.name.toLowerCase()}-something are a common way to look official.` });
        matched = b;
        break;
      }
    }
  }

  if (SHORTENERS.has(parts.registrable)) {
    findings.push({ id: 'shortener', severity: 'warn', title: 'It is a shortened link.', detail: 'A short link hides where it leads, and Shield cannot see the destination. Ask for the full address, or open it only if you trust whoever sent it.' });
  }
  // An imitation still gets these: only the brand's own address is spared.
  const official = findings.some((f) => f.id === 'official');
  if (!official && LURE.test(`${host}${url.pathname}`)) {
    findings.push({ id: 'lure', severity: 'warn', title: 'The address uses words scam pages use.', detail: 'Words like claim, airdrop, verify, connect-wallet, recover or support are how fake pages invite you to connect a wallet or type a recovery phrase. No real service will ever ask for your recovery phrase.' });
  }
  if (FILE_TLDS.has(parts.tld)) {
    findings.push({ id: 'file-tld', severity: 'warn', title: `".${parts.tld}" is also a file type.`, detail: 'Scammers use it to make a link look like a harmless file name.' });
  } else if (CHEAP_TLDS.has(parts.tld) && !official) {
    findings.push({ id: 'cheap-tld', severity: 'note', title: `".${parts.tld}" addresses are cheap and common for throwaway sites.`, detail: 'Plenty of honest sites use them too. It is a reason to look closer, not a verdict.' });
  }
  if (parts.host.split('-').length > 3 || parts.host.split('.').length > 4) {
    findings.push({ id: 'long-name', severity: 'note', title: 'The name is unusually long or full of hyphens.', detail: 'Long, hyphen-filled names are a common way to cram a trusted name into a fake address.' });
  }

  if (facts.registeredAt !== null) {
    const days = Math.floor((now - facts.registeredAt) / 86_400_000);
    if (days < 0) findings.push({ id: 'age', severity: 'info', title: 'Its registration date looks odd.', detail: 'The registry reports a date in the future.' });
    else if (days < 7) findings.push({ id: 'age', severity: 'warn', title: `The domain was registered ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}.`, detail: 'Fake sites are usually brand new. A trusted service almost never has a domain this young.' });
    else if (days < 30) findings.push({ id: 'age', severity: 'note', title: `The domain was registered ${days} days ago.`, detail: 'Young domains are more often used for fake pages than old ones.' });
    else if (days >= 365) findings.push({ id: 'age', severity: 'ok', title: `The domain has existed for ${Math.floor(days / 365)} year${days >= 730 ? 's' : ''}.`, detail: 'An old domain is a weak sign in its favour: fake pages are rarely kept for years, but a domain can be sold or taken over.' });
  }
  return { findings, brand: matched };
}

/** The date a domain was registered, from the public registration (RDAP) record, or null if it could not be read. */
export function registrationDate(body: unknown): number | null {
  const events = (body as { events?: { eventAction?: string; eventDate?: string }[] } | null)?.events;
  if (!Array.isArray(events)) return null;
  const reg = events.find((e) => e && e.eventAction === 'registration' && typeof e.eventDate === 'string');
  const t = reg ? Date.parse(reg.eventDate!) : Number.NaN;
  return Number.isFinite(t) ? t : null;
}
