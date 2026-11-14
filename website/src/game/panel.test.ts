// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CITIES } from './cities.js';

// The map, 3D and the other views are not what is tested here, only the three stages and the wallet step.
let roamDestroyed = 0;
vi.mock('./world/roam.js', () => ({ mountRoam: async (host: HTMLElement) => { host.textContent = 'ROAM'; return { destroy() { roamDestroyed++; host.replaceChildren(); } }; } }));
vi.mock('./explore.js', () => ({ mountExplore: async (host: HTMLElement) => { host.textContent = 'MAP'; return { destroy() {} }; } }));
vi.mock('./missions.js', () => ({ mountMissions: (host: HTMLElement) => { host.textContent = 'MISSIONS'; return { refresh() {} }; } }));
vi.mock('./progress.js', () => ({ mountProgress: (host: HTMLElement) => { host.textContent = 'PROGRESS'; return { refresh() {} }; } }));
vi.mock('./boards.js', () => ({ mountBoards: (host: HTMLElement) => { host.textContent = 'BOARDS'; return { refresh() {}, stop() {} }; } }));
vi.mock('./admin.js', () => ({ mountAdmin: (host: HTMLElement) => { host.textContent = 'ADMIN'; return { destroy() {} }; } }));

let admin = false;
let hasPhantom = true;
let hasMetaMask = true;
let waiting: ((v: never) => void) | null = null;
let rejectWith: string | null = null;
let showUri = 'wc:test-uri@2?relay-protocol=irn';
const signer = (address: string) => ({ family: 'evm', address, sign: async () => '0xsig' });
vi.mock('./signers.js', () => ({
  pageSignerEnv: async () => ({}),
  signerOptions: async () => [
    ...(hasPhantom ? [{ id: 'solana:injected', label: 'Phantom', family: 'solana', kind: 'phantom', icon: null, make: async () => signer('4DoV') }] : []),
    ...(hasMetaMask ? [{ id: 'evm:meta', label: 'MetaMask', family: 'evm', kind: 'metamask', icon: 'data:image/svg+xml;base64,PHN2Zy8+', make: async () => { if (rejectWith) throw new Error(rejectWith); return signer('0xabc0000000000000000000000000000000000001'); } }] : []),
    { id: 'evm:rabby', label: 'Rabby Wallet', family: 'evm', kind: 'other', icon: null, make: () => new Promise((resolve) => { waiting = resolve as never; }) },
    { id: 'evm:walletconnect', label: 'WalletConnect (scan with a phone or hardware wallet)', family: 'evm', kind: 'other', icon: null, make: (ctx?: { onUri?: (u: string) => void }) => new Promise((resolve) => { ctx?.onUri?.(showUri); waiting = resolve as never; }) },
  ],
}));

const cityJson = (c: (typeof CITIES)[number]) => ({ id: c.id, name: c.name, country: c.country, center: c.center, bounds: c.bounds, blurb: c.blurb, transport: c.transport, tint: c.tint, status: 'active', imageUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/x/xx/' + c.id + '.jpg/960px-' + c.id + '.jpg', imageCredit: 'Photo: Someone, CC BY-SA 4.0, via Wikimedia Commons', landmarks: c.landmarks, scene: c.scene });
const profile = (selectedCity: string | null) => ({ playerId: 'p1', displayName: '', avatar: null, explorerLevel: 3, totalXp: 240, totalDiscoveries: 0, missionsCompleted: 0, selectedCity });
let selected: string | null = null;

function stubFetch(): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string; city?: string };
    const out = (data: unknown): Response => new Response(JSON.stringify(data), { status: 200 });
    switch (body.op) {
      case 'catalogue': return out({ cities: CITIES.map(cityJson) });
      case 'nonce': return out({ nonce: 'ab'.repeat(16) });
      case 'login': return out({ token: 'g1.x.y', expiresAt: Date.now() + 1e9, network: 'evm', address: '0xabc0000000000000000000000000000000000001', profile: profile(selected) });
      case 'cities': return out({ selected, cities: CITIES.map((c) => ({ ...cityJson(c), progress: null })) });
      case 'select-city': selected = body.city ?? null; return out({ selected, cities: CITIES.map((c) => ({ ...cityJson(c), progress: null })), first: true, changed: false });
      case 'me': return out({ profile: profile(selected), admin });
      default: return out({ announcements: [], missions: [], treasures: [] });
    }
  }) as typeof fetch;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const click = async (el: Element | null | undefined): Promise<void> => {
  (el as HTMLElement).click();
  await settle();
};
const all = (root: HTMLElement, sel: string): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>(sel)];
const wallet = (root: HTMLElement, name: string): HTMLButtonElement | undefined => all(root, '.ucs-wallet').find((b) => b.textContent?.startsWith(name));
const names = (root: HTMLElement): string[] => all(root, '.ucs-wallet').map((b) => b.querySelector('span')?.firstChild?.textContent ?? '');

async function open(): Promise<{ root: HTMLElement }> {
  const { initGame } = await import('./panel.js');
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const game = initGame(root);
  game.onShow();
  await settle();
  return { root };
}

async function signedInAtCities(): Promise<HTMLElement> {
  const { root } = await open();
  await click(root.querySelector('.ucs-play'));
  await click(wallet(root, 'MetaMask'));
  return root;
}

describe('the welcome screen and the wallet step', () => {
  beforeEach(() => {
    roamDestroyed = 0;
    localStorage.clear();
    document.getElementById('ucs-theme')?.remove();
    selected = null;
    admin = false;
    hasPhantom = true;
    hasMetaMask = true;
    waiting = null;
    rejectWith = null;
    showUri = 'wc:test-uri@2?relay-protocol=irn';
    stubFetch();
    vi.resetModules();
  });

  it('opens on a welcome screen with a Play button and a strip of the nine cities, and no wallet buttons yet', async () => {
    const { root } = await open();
    expect(root.querySelector('h1')?.textContent).toBe('Welcome to Ultimate City Search');
    expect(root.textContent).toContain('Choose your city where you want to find your treasure');
    expect(all(root, '.ucs-play').map((b) => b.textContent)).toEqual(['Play']);
    expect(root.querySelectorAll('.ucs-thumb')).toHaveLength(9);
    expect(root.textContent).not.toContain('Signing in is a free message');
    expect(root.textContent).not.toContain('does not use ACT');
    expect(root.querySelector('.ucs-wallet')).toBeNull();
  });

  it('is black and white: no gold and no indigo anywhere in its styles, and the headline is white on black', async () => {
    await open();
    const css = document.getElementById('ucs-theme')?.textContent ?? '';
    expect(css.length).toBeGreaterThan(500);
    for (const colour of ['c9a227', 'd9b53a', 'e4c24a', 'b8901c', 'f0d672', '4338ca', '14123a', '4a47c4', '3a38a0', '2b2a72', '8b85ff']) expect(css.toLowerCase(), colour).not.toContain(colour);
    expect(css).toMatch(/\.ucs-dark \.ucs-title \{[^}]*color: #fff/);
    expect(css).toMatch(/\.ucs-dark h1, \.ucs-dark h2, \.ucs-dark h3 \{ color: #fff; \}/);
    expect(css).toMatch(/linear-gradient\(170deg, #000/);
  });

  it('offers exactly three choices after Play: Phantom, MetaMask and Connect others, each with a logo', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    expect(names(root)).toEqual(['Phantom', 'MetaMask', 'Connect others']);
    for (const b of all(root, '.ucs-wallet')) expect(b.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(wallet(root, 'MetaMask')?.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zy8+'); // the wallet's own logo
    expect(root.querySelector('h3')?.textContent).toBe('Connect a wallet to play');
  });

  it('signs in with MetaMask and goes to the cities', async () => {
    const root = await signedInAtCities();
    expect(root.querySelector('.ucs-row.five')).not.toBeNull();
    expect(root.textContent).toContain('Lv 3 · 240 XP');
  });

  it('signs in with Phantom the same way', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    await click(wallet(root, 'Phantom'));
    expect(root.querySelector('.ucs-row.five')).not.toBeNull();
  });

  it('says plainly when Phantom or MetaMask is not installed, and offers the others instead', async () => {
    hasPhantom = false;
    hasMetaMask = false;
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    expect(wallet(root, 'Phantom')?.textContent).toContain('Not found in this browser');
    await click(wallet(root, 'Phantom'));
    expect(root.querySelector('.ucs-msg')?.textContent).toMatch(/Phantom was not found in this browser\. Install it from phantom\.app/);
    await click(wallet(root, 'MetaMask'));
    expect(root.querySelector('.ucs-msg')?.textContent).toMatch(/MetaMask was not found in this browser\. Install it from metamask\.io/);
    await click(wallet(root, 'Connect others'));
    expect(names(root)).toEqual(['Rabby Wallet', 'WalletConnect (scan with a phone or hardware wallet)']);
  });

  it('lists the other wallets under Connect others, with a way back', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    await click(wallet(root, 'Connect others'));
    expect(root.querySelector('h3')?.textContent).toBe('Connect another wallet');
    expect(names(root)).toEqual(['Rabby Wallet', 'WalletConnect (scan with a phone or hardware wallet)']);
    await click(all(root, '.ucs-btn').find((b) => b.textContent === 'Back'));
    expect(names(root)).toEqual(['Phantom', 'MetaMask', 'Connect others']);
  });

  it('keeps every wallet name while one request waits, marks only the chosen one, and lets the player cancel', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    await click(wallet(root, 'Connect others'));
    await click(wallet(root, 'Rabby Wallet'));
    expect(names(root)).toEqual(['Rabby Wallet', 'WalletConnect (scan with a phone or hardware wallet)']);
    expect(wallet(root, 'Rabby Wallet')?.textContent).toContain('Waiting for your wallet…');
    expect(wallet(root, 'WalletConnect')?.textContent).not.toContain('Waiting');
    expect(all(root, '.ucs-wallet').every((b) => b.disabled)).toBe(true);
    expect(root.textContent).toContain('Look for a request from your wallet');
    await click(all(root, '.ucs-btn').find((b) => b.textContent === 'Cancel'));
    expect(all(root, '.ucs-wallet').every((b) => !b.disabled)).toBe(true);
    expect(root.querySelector('.ucs-msg')?.textContent).toMatch(/Cancelled/);
    // The wallet that was abandoned answering late changes nothing.
    waiting?.(signer('0xlate') as never);
    await settle();
    expect(root.querySelector('.ucs-row')).toBeNull();
  });

  it('shows the WalletConnect code on the page itself, with copy, open and cancel, and signs in once it is approved', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    await click(wallet(root, 'Connect others'));
    await click(wallet(root, 'WalletConnect'));
    expect(root.querySelector('.ucs-qr h3')?.textContent).toBe('Scan with your wallet app');
    expect(all(root, '.ucs-qr .ucs-btn').map((b) => b.textContent)).toEqual(['Copy link', 'Open in wallet app', 'Cancel']);
    expect(root.querySelector('.ucs-qr a')?.getAttribute('href')).toBe('wc:test-uri@2?relay-protocol=irn');
    expect(root.querySelector('.ucs-wallet')).toBeNull(); // the code replaces the list
    waiting?.(signer('0xwc') as never); // the wallet approves
    await settle();
    expect(root.querySelector('.ucs-qr')).toBeNull();
    expect(root.querySelector('.ucs-row.five')).not.toBeNull();
  });

  it('lets a player cancel from the WalletConnect code and choose again', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    await click(wallet(root, 'Connect others'));
    await click(wallet(root, 'WalletConnect'));
    await click(all(root, '.ucs-qr .ucs-btn').find((b) => b.textContent === 'Cancel'));
    expect(root.querySelector('.ucs-qr')).toBeNull();
    expect(root.querySelector('.ucs-msg')?.textContent).toMatch(/Cancelled/);
    expect(all(root, '.ucs-wallet').every((b) => !b.disabled)).toBe(true);
  });

  it('explains a declined request in plain words and lets the player try again', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    rejectWith = 'User rejected the request.';
    await click(wallet(root, 'MetaMask'));
    expect(root.querySelector('.ucs-msg')?.textContent).toMatch(/You declined the request in your wallet/);
    expect(all(root, '.ucs-wallet').every((b) => !b.disabled)).toBe(true);
    rejectWith = null;
    await click(wallet(root, 'MetaMask'));
    expect(root.querySelector('.ucs-row.five')).not.toBeNull();
  });
});

describe('the city choice and the game', () => {
  beforeEach(() => {
    roamDestroyed = 0;
    localStorage.clear();
    document.getElementById('ucs-theme')?.remove();
    selected = null;
    admin = false;
    hasPhantom = true;
    hasMetaMask = true;
    waiting = null;
    rejectWith = null;
    stubFetch();
    vi.resetModules();
  });

  it('shows the cities on two rows: five on the first, four on the next', async () => {
    const root = await signedInAtCities();
    expect(root.querySelector('.ucs-cities-head h2')?.textContent).toBe('Choose your city');
    expect(root.textContent).toContain('Where do you want to find your treasure?');
    const first = root.querySelector('.ucs-row.five')!;
    const second = root.querySelector('.ucs-row.four')!;
    expect([...first.querySelectorAll('.ucs-city-name')].map((n) => n.textContent)).toEqual(['Lagos', 'New York', 'Nairobi', 'Hong Kong', 'London']);
    expect([...second.querySelectorAll('.ucs-city-name')].map((n) => n.textContent)).toEqual(['Dubai', 'Paris', 'Miami', 'Nicosia']);
    for (const card of root.querySelectorAll('.ucs-city')) {
      expect(card.querySelector('img')?.getAttribute('src')).toMatch(/^https:\/\/thumb\.wikimedia\.org/);
      expect(card.querySelector('.ucs-credit')?.textContent).toMatch(/via Wikimedia Commons/);
      expect(card.querySelector('.ucs-city-go')?.textContent).toBe('Enter');
    }
  });

  it('opens the game on the chosen city, with a tab for each part, and Change city goes back to the choice', async () => {
    const root = await signedInAtCities();
    const paris = all(root, '.ucs-city').find((c) => c.querySelector('.ucs-city-name')?.textContent === 'Paris');
    await click(paris);
    expect(root.querySelector('.ucs-bar h2')?.textContent).toBe('Paris');
    expect(root.textContent).toContain('France');
    const tabs = all(root, '.ucs-tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Walk & drive', 'Map', 'Missions', 'My progress', 'Leaderboard & team']);
    // The game opens in the walk-and-drive view, which only runs while its tab is open.
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(root.textContent).toContain('ROAM');
    expect(roamDestroyed).toBe(0);
    await click(tabs[1]);
    expect(roamDestroyed).toBe(1);
    expect(root.textContent).toContain('MAP');
    await click(all(root, '.ucs-tab')[2]);
    expect(root.textContent).toContain('MISSIONS');
    expect(root.textContent).not.toContain('MAP');
    await click(all(root, '.ucs-tab')[3]);
    expect(root.textContent).toContain('PROGRESS');
    await click(all(root, '.ucs-tab')[4]);
    expect(root.textContent).toContain('BOARDS');
    await click(all(root, '.ucs-btn').find((b) => b.textContent === 'Change city'));
    expect(root.querySelector('.ucs-row.five')).not.toBeNull();
    const here = all(root, '.ucs-city').find((c) => c.getAttribute('aria-current') === 'true');
    expect(here?.querySelector('.ucs-city-name')?.textContent).toBe('Paris');
    expect(here?.querySelector('.ucs-city-go')?.textContent).toBe('You are here');
    await click(here);
    expect(root.querySelector('.ucs-bar h2')?.textContent).toBe('Paris');
  });

  it('puts a returning player straight into their city, and shows the Admin tab only to an administrator', async () => {
    selected = 'london';
    admin = true;
    localStorage.setItem('aretia-game-session-v1', JSON.stringify({ token: 'g1.x.y', expiresAt: Date.now() + 1e9, network: 'evm', address: '0xabc0000000000000000000000000000000000001', profile: profile('london') }));
    const { root } = await open();
    expect(root.querySelector('.ucs-bar h2')?.textContent).toBe('London');
    expect(all(root, '.ucs-tab').map((t) => t.textContent)).toContain('Admin');
    await click(all(root, '.ucs-tab').find((t) => t.textContent === 'Admin'));
    expect(root.textContent).toContain('ADMIN');
  });

  it('hides the Admin tab from everyone else, and signing out returns to the welcome screen', async () => {
    selected = 'london';
    localStorage.setItem('aretia-game-session-v1', JSON.stringify({ token: 'g1.x.y', expiresAt: Date.now() + 1e9, network: 'evm', address: '0xabc0000000000000000000000000000000000001', profile: profile('london') }));
    const { root } = await open();
    expect(all(root, '.ucs-tab').map((t) => t.textContent)).not.toContain('Admin');
    await click(all(root, '.ucs-btn').find((b) => b.textContent === 'Sign out'));
    expect(root.querySelector('h1')?.textContent).toBe('Welcome to Ultimate City Search');
    expect(root.querySelector('.ucs-play')).not.toBeNull();
  });
});
