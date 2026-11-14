/**
 * One whole game, played through the real request handler on a real SQLite database (the dialect Cloudflare D1 runs) with the game's
 * actual schema: an administrator builds a mission and hides a coin, a player signs in, solves the trail, travels there and collects
 * it, the find is verified, claimed, approved and paid, and the boards, achievements and history show it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from '../src/swings/core/keccak.js';
import { loginMessage } from '../src/swings/account/loginMessage.js';
import { resetRateLimit } from './_rpcProxy.js';
import { handleGame, type GameInput } from './_game.js';
import { sqliteRest } from './_gameSqlite.js';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const NOW = 1_800_000_000_000;
const DOMAIN = 'aretiafinance.org';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const toBase58 = (bytes: Uint8Array): string => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

function world() {
  const { rest, raw } = sqliteRest(() => clock);
  let clock = NOW;
  const admin = (() => {
    const priv = secp256k1.utils.randomPrivateKey();
    const address = '0x' + hex(keccak256(secp256k1.getPublicKey(priv, false).slice(1)).slice(12));
    return { priv, address };
  })();
  const env = { SWINGS_SESSION_SECRET: 'flow-secret', GAME_ANSWER_SECRET: 'flow-answer-secret', ADMIN_WALLETS: admin.address, GAME_PRIZES_ENABLED: '1' } as GameInput['env'];
  const ip = (() => { let n = 0; return () => `10.0.${Math.floor(n / 250)}.${(n++ % 250) + 1}`; })();
  const call = async (token: string | null, body: J): Promise<{ status: number; data: J }> => {
    const out = await handleGame({ method: 'POST', origin: `https://${DOMAIN}`, authorization: token ? `Bearer ${token}` : null, ip: ip(), body, db: rest, env, now: clock });
    return { status: out.status, data: out.body ? (JSON.parse(out.body) as J) : {} };
  };
  const nonce = async (): Promise<string> => (await call(null, { op: 'nonce' })).data.nonce as string;
  const signInSolana = async (): Promise<string> => {
    const priv = ed25519.utils.randomPrivateKey();
    const address = toBase58(ed25519.getPublicKey(priv));
    const message = loginMessage({ purpose: 'game', family: 'solana', address, domain: DOMAIN, issuedAt: clock, nonce: await nonce() });
    const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), priv)).toString('base64');
    return (await call(null, { op: 'login', message, signature })).data.token as string;
  };
  const signInAdmin = async (): Promise<string> => {
    const message = loginMessage({ purpose: 'game', family: 'evm', address: admin.address, domain: DOMAIN, issuedAt: clock, nonce: await nonce() });
    const body = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
    const joined = new Uint8Array(prefix.length + body.length);
    joined.set(prefix);
    joined.set(body, prefix.length);
    const sig = secp256k1.sign(keccak256(joined), admin.priv);
    const signature = '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
    return (await call(null, { op: 'login', message, signature })).data.token as string;
  };
  return { call, raw, signInSolana, signInAdmin, wait: (ms: number) => void (clock += ms), now: () => clock };
}

describe('a whole game on SQLite', () => {
  beforeEach(() => resetRateLimit());

  it('runs from an administrator hiding a coin to the winner being paid', async () => {
    const w = world();
    const boss = await w.signInAdmin();
    const alice = await w.signInSolana();
    const bob = await w.signInSolana();

    // The administrator sees the console; a player does not.
    expect((await w.call(boss, { op: 'me' })).data.admin).toBe(true);
    expect((await w.call(alice, { op: 'me' })).data.admin).toBe(false);
    expect((await w.call(alice, { op: 'admin-overview' })).status).toBe(404);

    // Hide a Samarium Coin 1 km east of the centre of Paris. A spot near the Heathrow runway is refused.
    const spot = { city: 'paris', class: 'samarium', lng: 2.3672, lat: 48.8566, radiusM: 60, confirmSafe: true };
    expect((await w.call(boss, { op: 'admin-treasure-place', ...spot, confirmSafe: false })).status).toBe(400);
    expect((await w.call(boss, { op: 'admin-treasure-place', ...spot, lng: 2.3652, lat: 48.7262 })).status).toBe(400); // Orly
    const placed = await w.call(boss, { op: 'admin-treasure-place', ...spot });
    expect(placed.status).toBe(200);
    const treasure = placed.data.id as string;

    // A two-step mission that leads to it.
    expect((await w.call(boss, { op: 'admin-mission-save', id: 'paris-hunt', city: 'paris', title: 'The hunt', difficulty: 'advanced', status: 'active', treasureId: treasure, xpReward: 200 })).status).toBe(409); // no clues yet
    await w.call(boss, { op: 'admin-mission-save', id: 'paris-hunt', city: 'paris', title: 'The hunt', difficulty: 'advanced', status: 'draft', treasureId: treasure, xpReward: 200 });
    expect((await w.call(boss, { op: 'admin-clue-save', mission: 'paris-hunt', seq: 1, type: 'numerical', content: 'How many arrondissements?', answer: '20', hints: ['A spiral.', 'More than 15.'] })).status).toBe(200);
    expect((await w.call(boss, { op: 'admin-clue-save', mission: 'paris-hunt', seq: 2, type: 'geographical', content: 'Which river?', answer: 'Seine' })).status).toBe(200);
    expect((await w.call(boss, { op: 'admin-mission-save', id: 'paris-hunt', city: 'paris', title: 'The hunt', difficulty: 'advanced', status: 'active', treasureId: treasure, xpReward: 200 })).status).toBe(200);

    // Alice enters Paris and sees the mission, with the prize on offer but not where it is.
    expect((await w.call(alice, { op: 'select-city', city: 'paris' })).data).toMatchObject({ selected: 'paris', first: true, achievements: [{ id: 'first-steps' }] });
    const list = await w.call(alice, { op: 'missions', city: 'paris' });
    expect(list.data.missions[0]).toMatchObject({ id: 'paris-hunt', totalStages: 2, treasure: { coin: 'Samarium Coin', usd: 1 } });
    expect(JSON.stringify(list.data)).not.toMatch(/2\.3672|lng|answer|hash/);

    // She cannot just collect it, even knowing its id.
    expect((await w.call(alice, { op: 'collect', treasure })).status).toBe(404);

    // She solves the trail: one hint, one wrong answer, then the right ones.
    expect((await w.call(alice, { op: 'mission-start', mission: 'paris-hunt' })).data).toMatchObject({ stage: 1, totalStages: 2 });
    expect((await w.call(alice, { op: 'hint', mission: 'paris-hunt' })).data.hints).toEqual(['A spiral.']);
    expect((await w.call(alice, { op: 'answer', mission: 'paris-hunt', answer: '19' })).data).toMatchObject({ correct: false, attemptsLeft: 4 });
    expect((await w.call(alice, { op: 'answer', mission: 'paris-hunt', answer: ' 20 ' })).data).toMatchObject({ correct: true, completed: false });
    const done = await w.call(alice, { op: 'answer', mission: 'paris-hunt', answer: 'the seine'.replace('the ', '') });
    expect(done.data).toMatchObject({ correct: true, completed: true, xp: 180, treasure: { coin: 'Samarium Coin', zone: { lng: 2.3672, lat: 48.8566, radiusM: 60 } } });
    expect(done.data.achievements.map((a: J) => a.id)).toEqual(['first-mission']); // first-steps came when she entered Paris

    // Bob never solved it, so he cannot see it or take it.
    expect((await w.call(bob, { op: 'treasures' })).data.treasures).toEqual([]);

    // She is still at the centre of Paris, about 370 metres away: not close enough.
    expect((await w.call(alice, { op: 'collect', treasure })).data.message).toMatch(/not close enough/);
    const go = await w.call(alice, { op: 'travel', city: 'paris', mode: 'walk', to: [2.3672, 48.8566] });
    expect(go.status).toBe(200);
    expect((await w.call(alice, { op: 'collect', treasure })).data.message).toMatch(/journey/);
    w.wait(go.data.travel.arrivesAt - w.now() + 1);

    // The first to arrive takes it; she is the First Finder, and the coin waits for verification.
    const got = await w.call(alice, { op: 'collect', treasure });
    expect(got.data).toMatchObject({ discovered: true, firstFinder: true, treasure: { coin: 'Samarium Coin', verification: 'pending' } });
    expect((await w.call(alice, { op: 'collect', treasure })).status).toBe(409);

    // Verification, claim, decision and payment.
    expect((await w.call(alice, { op: 'claim-prize', treasure })).data.message).toMatch(/not been verified/);
    const queue = await w.call(boss, { op: 'admin-verify-queue' });
    expect(queue.data.queue).toHaveLength(1);
    const aliceId = queue.data.queue[0].playerId as string;
    expect((await w.call(boss, { op: 'admin-verify', playerId: aliceId, treasureId: treasure, decision: 'verified', notes: 'Checked the log' })).status).toBe(200);
    expect((await w.call(alice, { op: 'claim-prize', treasure })).data).toMatchObject({ claim: 'pending' });
    expect((await w.call(alice, { op: 'claim-prize', treasure })).status).toBe(409);
    const claim = (await w.call(boss, { op: 'admin-claims', status: 'pending' })).data.claims[0] as J;
    expect(claim).toMatchObject({ amount_usd: 1, claim_status: 'pending' });
    await w.call(boss, { op: 'admin-claim-decide', id: claim.id, decision: 'approved', notes: 'Eligible' });
    await w.call(boss, { op: 'admin-reserve', amountUsd: 5, note: 'Funding' });
    expect((await w.call(boss, { op: 'admin-claim-paid', id: claim.id, paymentReference: 'PAY-1' })).status).toBe(200);
    const overview = (await w.call(boss, { op: 'admin-overview' })).data;
    expect(overview.prizes).toMatchObject({ paidUsd: 1, reserveUsd: 5, claimsPendingUsd: 0, claimsApprovedUnpaidUsd: 0 });
    expect(overview).toMatchObject({ players: 3, prizesEnabled: true });

    // Progress, boards and history show it all.
    const progress = (await w.call(alice, { op: 'progress' })).data;
    expect(progress.totals).toMatchObject({ missionsCompleted: 1, discoveries: 1, citiesVisited: 1 });
    expect(progress.achievements.filter((a: J) => a.unlockedAt).map((a: J) => a.id).sort()).toEqual(['first-find', 'first-mission', 'first-steps']);
    expect(progress.firstFinds).toEqual([{ cityId: 'paris', class: 'samarium', unlockedAt: w.now() }]);
    const board = (await w.call(alice, { op: 'leaderboard', period: 'all' })).data;
    expect(board.entries[0]).toMatchObject({ rank: 1, you: true });
    expect(board.entries[0].xp).toBeGreaterThan(180);
    expect(JSON.stringify(board)).not.toMatch(/solana|0x|addr/);
    expect((await w.call(bob, { op: 'leaderboard', period: 'all' })).data.yourRank).toBeNull();
    const history = (await w.call(alice, { op: 'history' })).data;
    const kinds = history.items.map((i: J) => i.type);
    expect(kinds).toEqual(expect.arrayContaining(['city_selected', 'mission_started', 'hint_requested', 'answer_incorrect', 'answer_correct', 'mission_completed', 'treasure_unlocked', 'journey_started', 'treasure_discovered', 'first_finder', 'prize_claimed', 'achievement_unlocked']));

    // Every administrator change is in the audit log, and the answer is nowhere in the database in the clear.
    const audit = (await w.call(boss, { op: 'admin-audit' })).data.entries.map((e: J) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['treasure_place', 'mission_save', 'clue_save', 'verify', 'claim_decide', 'claim_paid', 'reserve_entry']));
    const dump = JSON.stringify(w.raw.prepare('select * from game_clues').all());
    expect(dump).not.toMatch(/seine/i);
  });

  it('lets two players race for one coin and gives it to exactly one', async () => {
    const w = world();
    const boss = await w.signInAdmin();
    const [a, b] = [await w.signInSolana(), await w.signInSolana()];
    const placed = await w.call(boss, { op: 'admin-treasure-place', city: 'london', class: 'lutetium', lng: -0.1276, lat: 51.5072, radiusM: 60, confirmSafe: true }); // at the starting point
    const treasure = placed.data.id as string;
    await w.call(boss, { op: 'admin-mission-save', id: 'london-race', city: 'london', title: 'Race', difficulty: 'beginner', status: 'draft', treasureId: treasure });
    await w.call(boss, { op: 'admin-clue-save', mission: 'london-race', seq: 1, type: 'riddle', content: 'x?', answer: 'x' });
    await w.call(boss, { op: 'admin-mission-save', id: 'london-race', city: 'london', title: 'Race', difficulty: 'beginner', status: 'active', treasureId: treasure });
    for (const t of [a, b]) {
      await w.call(t, { op: 'select-city', city: 'london' });
      await w.call(t, { op: 'mission-start', mission: 'london-race' });
      expect((await w.call(t, { op: 'answer', mission: 'london-race', answer: 'x' })).data.treasure.zone).toBeTruthy();
    }
    const results = await Promise.all([w.call(a, { op: 'collect', treasure }), w.call(b, { op: 'collect', treasure })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(w.raw.prepare("select count(*) as n from game_treasures where status = 'found'").get()).toEqual({ n: 1 });
    expect(w.raw.prepare("select count(*) as n from game_player_treasures where discovery_status = 'discovered'").get()).toEqual({ n: 1 });
  });

  it('flies a player to another city on the server clock', async () => {
    const w = world();
    const t = await w.signInSolana();
    await w.call(t, { op: 'select-city', city: 'lagos' });
    const up = await w.call(t, { op: 'fly', to: 'london' });
    expect(up.data.flight.to).toBe('london');
    expect((await w.call(t, { op: 'select-city', city: 'paris' })).status).toBe(409);
    w.wait(up.data.flight.arrivesAt - w.now() + 1);
    const landed = await w.call(t, { op: 'state' });
    expect(landed.data).toMatchObject({ selected: 'london', flight: null });
    expect((await w.call(t, { op: 'progress' })).data.achievements.filter((a: J) => a.unlockedAt).map((a: J) => a.id)).toEqual(expect.arrayContaining(['first-steps', 'frequent-flyer']));
  });

  it('runs a team and its boards', async () => {
    const w = world();
    const [a, b] = [await w.signInSolana(), await w.signInSolana()];
    await w.call(a, { op: 'select-city', city: 'paris' });
    const made = await w.call(a, { op: 'team-create', name: 'Night Owls' });
    expect(made.status).toBe(200);
    const code = made.data.team.joinCode as string;
    expect((await w.call(b, { op: 'team-join', code })).data.team.members).toHaveLength(2);
    expect((await w.call(b, { op: 'team-create', name: 'Other' })).status).toBe(409);
    const standings = (await w.call(a, { op: 'team-board', period: 'all' })).data;
    expect(standings.entries[0]).toMatchObject({ name: 'Night Owls', members: 2 });
    expect((await w.call(a, { op: 'team-leave' })).data.team).toBeNull();
    expect((await w.call(b, { op: 'team' })).data.team.owner).toBe(true); // ownership passed on
  });
});

describe('cities in the database', () => {
  beforeEach(() => resetRateLimit());
  const accra = { id: 'accra', name: 'Accra', country: 'Ghana', bounds: [-0.4, 5.45, 0.1, 5.75], center: [-0.187, 5.603], blurb: 'A coastal capital.', transport: ['walk', 'run', 'taxi', 'car', 'bus', 'flight'], tint: ['#112233', '#ccaa22'], landmarks: [{ name: 'Independence Arch', lng: -0.1969, lat: 5.5486 }], scene: 'beach-bay' };

  it('shows the nine to a visitor with no sign-in, without anything about treasures', async () => {
    const w = world();
    const r = await w.call(null, { op: 'catalogue' });
    expect(r.status).toBe(200);
    expect(r.data.cities).toHaveLength(9);
    expect(r.data.cities[0]).toMatchObject({ id: 'lagos', name: 'Lagos', status: 'active', scene: 'lagoon' });
    expect(r.data.cities[0].landmarks.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.data)).not.toMatch(/treasure|answer|hash/i);
  });

  it('lets an administrator add a city that then works like the others: opening it, flying to it, a mission and a coin in it', async () => {
    const w = world();
    const boss = await w.signInAdmin();
    const player = await w.signInSolana();
    expect((await w.call(player, { op: 'admin-city-save', ...accra })).status).toBe(404); // players cannot
    for (const bad of [{ id: 'Bad Id' }, { bounds: [0, 0, 9, 9] }, { center: [9, 9] }, { transport: ['walk'] }, { landmarks: [{ name: 'Far', lng: 40, lat: 40 }] }, { imageUrl: 'https://x.example/a.jpg' }]) {
      expect((await w.call(boss, { op: 'admin-city-save', ...accra, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await w.call(boss, { op: 'admin-city-save', ...accra })).status).toBe(200);

    // It starts hidden from players ("coming soon") and cannot be entered.
    const seen = (await w.call(player, { op: 'catalogue' })).data.cities.find((c: J) => c.id === 'accra');
    expect(seen).toMatchObject({ status: 'coming_soon', name: 'Accra' });
    expect((await w.call(player, { op: 'select-city', city: 'accra' })).status).toBe(409);

    // Opening it makes it playable at once.
    expect((await w.call(boss, { op: 'admin-city-save', ...accra, status: 'active', imageUrl: 'https://upload.wikimedia.org/a.jpg', imageCredit: 'J. Doe, CC BY-SA 4.0' })).status).toBe(200);
    const open = (await w.call(player, { op: 'catalogue' })).data.cities.find((c: J) => c.id === 'accra');
    expect(open).toMatchObject({ status: 'active', imageUrl: 'https://upload.wikimedia.org/a.jpg', imageCredit: 'J. Doe, CC BY-SA 4.0' });
    expect((await w.call(player, { op: 'select-city', city: 'accra' })).data).toMatchObject({ selected: 'accra', first: true });
    const walk = await w.call(player, { op: 'travel', city: 'accra', mode: 'walk', to: [-0.19, 5.6] });
    expect(walk.status).toBe(200);
    expect((await w.call(player, { op: 'travel', city: 'accra', mode: 'taxi', to: [-0.2, 5.6] })).status).toBe(409); // already walking
    w.wait(60_000);
    expect((await w.call(player, { op: 'travel', city: 'accra', mode: 'metro', to: [-0.2, 5.6] })).status).toBe(400); // no metro there
    expect((await w.call(player, { op: 'travel', city: 'accra', mode: 'walk', to: [3, 6] })).status).toBe(400); // outside Accra

    // It can be flown to from the others, and holds missions and treasures like any city.
    const out = await w.call(player, { op: 'fly', to: 'lagos' });
    expect(out.status).toBe(200);
    w.wait(120_000);
    expect((await w.call(player, { op: 'state' })).data.selected).toBe('lagos');
    expect((await w.call(player, { op: 'fly', to: 'accra' })).status).toBe(200);
    expect((await w.call(boss, { op: 'admin-treasure-place', city: 'accra', class: 'lutetium', lng: -0.187, lat: 5.603, radiusM: 60, confirmSafe: true })).status).toBe(200);
    expect((await w.call(boss, { op: 'admin-treasure-place', city: 'accra', class: 'lutetium', lng: 9, lat: 9, radiusM: 60, confirmSafe: true })).status).toBe(400); // outside Accra
    expect((await w.call(boss, { op: 'admin-mission-save', id: 'accra-first', city: 'accra', title: 'First', difficulty: 'beginner' })).status).toBe(200);
    expect((await w.call(player, { op: 'progress' })).data.cities.map((c: J) => c.id)).toContain('accra');

    // Hiding it removes it from visitors but not from the console, and the audit log shows who did what.
    expect((await w.call(boss, { op: 'admin-city-set', id: 'accra', status: 'inactive' })).status).toBe(200);
    expect((await w.call(player, { op: 'catalogue' })).data.cities.map((c: J) => c.id)).not.toContain('accra');
    expect((await w.call(boss, { op: 'admin-city-list' })).data.cities.map((c: J) => c.id)).toContain('accra');
    const audit = (await w.call(boss, { op: 'admin-audit' })).data.entries.map((e: J) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['city_create', 'city_save', 'city_set']));
  });

  it('keeps an existing city open when its description is edited without a status', async () => {
    const w = world();
    const boss = await w.signInAdmin();
    expect((await w.call(boss, { op: 'admin-city-save', id: 'paris', name: 'Paris', country: 'France', bounds: [2.22, 48.8, 2.47, 48.92], center: [2.3522, 48.8566], blurb: 'New text', transport: ['walk', 'metro', 'flight'], tint: ['#232a52', '#d6c58a'], landmarks: [], scene: 'boulevards' })).status).toBe(200);
    const paris = (await w.call(boss, { op: 'catalogue' })).data.cities.find((c: J) => c.id === 'paris');
    expect(paris).toMatchObject({ status: 'active', blurb: 'New text', transport: ['walk', 'metro', 'flight'] });
  });
});
