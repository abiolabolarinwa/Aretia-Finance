// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CITIES } from './cities.js';

// The map, 3D and the other views are not what is tested here, only the three stages and the wallet step.
vi.mock('./explore.js', () => ({ mountExplore: async (host: HTMLElement) => { host.textContent = 'MAP'; return { destroy() {} }; } }));
vi.mock('./missions.js', () => ({ mountMissions: (host: HTMLElement) => { host.textContent = 'MISSIONS'; return { refresh() {} }; } }));
vi.mock('./progress.js', () => ({ mountProgress: (host: HTMLElement) => { host.textContent = 'PROGRESS'; return { refresh() {} }; } }));
vi.mock('./boards.js', () => ({ mountBoards: (host: HTMLElement) => { host.textContent = 'BOARDS'; return { refresh() {}, stop() {} }; } }));
vi.mock('./admin.js', () => ({ mountAdmin: (host: HTMLElement) => { host.textContent = 'ADMIN'; return { destroy() {} }; } }));

let admin = false;
let waiting: ((v: never) => void) | null = null;
let rejectWith: string | null = null;
vi.mock('./signers.js', () => ({
  pageSignerEnv: async () => ({}),
  signerOptions: async () => [
    { id: 'evm:a', label: 'MetaMask (Ethereum-style)', family: 'evm', make: async () => { if (rejectWith) throw new Error(rejectWith); return { family: 'evm', address: '0xabc0000000000000000000000000000000000001', sign: async () => '0xsig' }; } },
    { id: 'evm:b', label: 'Rabby (Ethereum-style)', family: 'evm', make: () => new Promise((resolve) => { waiting = resolve as never; }) },
    { id: 'evm:walletconnect', label: 'WalletConnect (phone, hardware or any wallet app)', family: 'evm', make: async () => ({ family: 'evm', address: '0xwc', sign: async () => '0xsig' }) },
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
const buttons = (root: HTMLElement, cls: string): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>(cls)];

async function open(): Promise<{ root: HTMLElement }> {
  const { initGame } = await import('./panel.js');
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const game = initGame(root);
  game.onShow();
  await settle();
  return { root };
}

describe('the game screens', () => {
  beforeEach(() => {
    localStorage.clear();
    document.getElementById('ucs-theme')?.remove();
    selected = null;
    admin = false;
    waiting = null;
    rejectWith = null;
    stubFetch();
    vi.resetModules();
  });

  it('opens on a welcome screen with a Play button and a strip of the nine cities, and no sign-in buttons yet', async () => {
    const { root } = await open();
    expect(root.querySelector('h1')?.textContent).toBe('Welcome to Ultimate City Search');
    expect(root.textContent).toContain('Choose your city where you want to find your treasure');
    expect(buttons(root, '.ucs-play').map((b) => b.textContent)).toEqual(['Play']);
    expect(root.querySelectorAll('.ucs-thumb')).toHaveLength(9);
    expect(root.querySelector('.ucs-wallet')).toBeNull();
    expect(root.querySelector('.ucs-row')).toBeNull();
    expect(document.getElementById('ucs-theme')).not.toBeNull();
  });

  it('lists each wallet by name when Play is pressed, and shows Waiting only on the one that was chosen', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    expect(buttons(root, '.ucs-wallet').map((b) => b.textContent)).toEqual(['MetaMask (Ethereum-style)', 'Rabby (Ethereum-style)', 'WalletConnect (phone, hardware or any wallet app)']);
    await click(buttons(root, '.ucs-wallet')[1]);
    const labels = buttons(root, '.ucs-wallet').map((b) => b.textContent);
    expect(labels).toEqual(['MetaMask (Ethereum-style)', 'Waiting for your wallet…', 'WalletConnect (phone, hardware or any wallet app)']);
    expect(buttons(root, '.ucs-wallet').every((b) => b.disabled)).toBe(true);
    expect(root.textContent).toContain('Look for a request from your wallet');
  });

  it('lets a player cancel a wallet that is not answering, and choose another', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    await click(buttons(root, '.ucs-wallet')[1]);
    const cancel = buttons(root, '.ucs-btn').find((b) => b.textContent === 'Cancel');
    expect(cancel).toBeTruthy();
    await click(cancel);
    expect(buttons(root, '.ucs-wallet').every((b) => !b.disabled)).toBe(true);
    expect(buttons(root, '.ucs-wallet').map((b) => b.textContent).join('|')).not.toContain('Waiting');
    expect(root.querySelector('.ucs-msg')?.textContent).toMatch(/Cancelled/);
    // The wallet that was abandoned answering late changes nothing.
    waiting?.({ family: 'evm', address: '0xlate', sign: async () => 's' } as never);
    await settle();
    expect(root.querySelector('.ucs-row')).toBeNull();
    await click(buttons(root, '.ucs-wallet')[0]);
    expect(root.querySelector('.ucs-row.five')).not.toBeNull();
  });

  it('explains a declined request in plain words and lets the player try again', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    rejectWith = 'User rejected the request.';
    await click(buttons(root, '.ucs-wallet')[0]);
    expect(root.querySelector('.ucs-msg')?.textContent).toMatch(/You declined the request in your wallet/);
    expect(buttons(root, '.ucs-wallet').every((b) => !b.disabled)).toBe(true);
    rejectWith = null;
    await click(buttons(root, '.ucs-wallet')[0]);
    expect(root.querySelector('.ucs-row.five')).not.toBeNull();
  });

  it('shows the cities on two rows after sign-in: five on the first, four on the next', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    await click(buttons(root, '.ucs-wallet')[0]);
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
    expect(root.textContent).toContain('Lv 3 · 240 XP');
  });

  it('opens the game on the chosen city, with a tab for each part, and Change city goes back to the choice', async () => {
    const { root } = await open();
    await click(root.querySelector('.ucs-play'));
    await click(buttons(root, '.ucs-wallet')[0]);
    const paris = buttons(root, '.ucs-city').find((c) => c.querySelector('.ucs-city-name')?.textContent === 'Paris');
    await click(paris);
    expect(root.querySelector('.ucs-bar h2')?.textContent).toBe('Paris');
    expect(root.textContent).toContain('France');
    const tabs = buttons(root, '.ucs-tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Explore', 'Missions', 'My progress', 'Leaderboard & team']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(root.textContent).toContain('MAP');
    await click(tabs[1]);
    expect(root.textContent).toContain('MISSIONS');
    expect(root.textContent).not.toContain('MAP');
    await click(buttons(root, '.ucs-tab')[2]);
    expect(root.textContent).toContain('PROGRESS');
    await click(buttons(root, '.ucs-tab')[3]);
    expect(root.textContent).toContain('BOARDS');
    await click(buttons(root, '.ucs-btn').find((b) => b.textContent === 'Change city'));
    expect(root.querySelector('.ucs-row.five')).not.toBeNull();
    const here = buttons(root, '.ucs-city').find((c) => c.getAttribute('aria-current') === 'true');
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
    expect(buttons(root, '.ucs-tab').map((t) => t.textContent)).toContain('Admin');
    await click(buttons(root, '.ucs-tab').find((t) => t.textContent === 'Admin'));
    expect(root.textContent).toContain('ADMIN');
  });

  it('hides the Admin tab from everyone else, and signing out returns to the welcome screen', async () => {
    selected = 'london';
    localStorage.setItem('aretia-game-session-v1', JSON.stringify({ token: 'g1.x.y', expiresAt: Date.now() + 1e9, network: 'evm', address: '0xabc0000000000000000000000000000000000001', profile: profile('london') }));
    const { root } = await open();
    expect(buttons(root, '.ucs-tab').map((t) => t.textContent)).not.toContain('Admin');
    await click(buttons(root, '.ucs-btn').find((b) => b.textContent === 'Sign out'));
    expect(root.querySelector('h1')?.textContent).toBe('Welcome to Ultimate City Search');
    expect(root.querySelector('.ucs-play')).not.toBeNull();
  });
});
