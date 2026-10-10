/**
 * Icons for a token project's own links (the "Links from the project" row of the Markets panel). The kind is read from
 * the link's host, never from a piece of its text, so a link cannot pass for another site by how it is worded.
 */
export type LinkKind = 'x' | 'telegram' | 'discord' | 'github' | 'website' | 'link';

const HOSTS: readonly (readonly [LinkKind, readonly string[]])[] = [
  ['x', ['x.com', 'twitter.com']],
  ['telegram', ['t.me', 'telegram.me', 'telegram.org']],
  ['discord', ['discord.gg', 'discord.com', 'discordapp.com']],
  ['github', ['github.com']],
];

const onHost = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Which icon a link gets: its network by host, a globe for a plain website, a chain link for anything else. */
export function linkKind(url: string, label: string): LinkKind {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'link';
  }
  for (const [kind, domains] of HOSTS) if (domains.some((d) => onHost(host, d))) return kind;
  return /^(website|site|web|homepage)$/i.test(label.trim()) ? 'website' : 'link';
}

const stroke = (d: string): string => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

export const LINK_ICONS: Record<LinkKind, string> = {
  // The X mark (a filled shape).
  x: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  telegram: stroke('M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z'),
  discord: stroke('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM9 10h.01M15 10h.01'),
  github: stroke('M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22'),
  website: stroke('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'),
  link: stroke('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),
};
