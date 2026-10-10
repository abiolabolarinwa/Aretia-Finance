import { describe, expect, it } from 'vitest';
import { LINK_ICONS, linkKind } from './walletLinkIcons';

describe('which icon a project link gets', () => {
  it('reads Twitter and X links as the X mark, from the host', () => {
    expect(linkKind('https://twitter.com/aretia', 'Twitter')).toBe('x');
    expect(linkKind('https://x.com/aretia', 'Twitter')).toBe('x');
    expect(linkKind('https://mobile.twitter.com/aretia', 'Twitter')).toBe('x');
  });

  it('knows Telegram, Discord and GitHub by host', () => {
    expect(linkKind('https://t.me/aretia', 'Telegram')).toBe('telegram');
    expect(linkKind('https://discord.gg/abc', 'Discord')).toBe('discord');
    expect(linkKind('https://github.com/aretia', 'GitHub')).toBe('github');
  });

  it('gives a plain website a globe, and anything else a chain link', () => {
    expect(linkKind('https://aretiafinance.org', 'Website')).toBe('website');
    expect(linkKind('https://docs.example.org', 'Docs')).toBe('link');
  });

  it('is not fooled by wording or by a look-alike host', () => {
    expect(linkKind('https://evil.example/x.com', 'Twitter')).toBe('link');
    expect(linkKind('https://notx.com/aretia', 'Twitter')).toBe('link');
    expect(linkKind('https://x.com.evil.example', 'X')).toBe('link');
  });

  it('copes with a link that is not a URL', () => {
    expect(linkKind('not a url', 'Website')).toBe('link');
  });

  it('has an icon for every kind', () => {
    for (const k of ['x', 'telegram', 'discord', 'github', 'website', 'link'] as const) expect(LINK_ICONS[k]).toContain('<svg');
  });
});
