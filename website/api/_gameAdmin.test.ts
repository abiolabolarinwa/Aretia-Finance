import { describe, expect, it } from 'vitest';
import { adminOp, playerAdminOp, CASH_ELIGIBLE_USD, type AdminCtx } from './_gameAdmin.js';
import { answerHash } from './_gameMissions.js';
import { fakeDb, type Row } from './_gameTestDb.js';
import { placementProblem } from '../src/game/exclusions.js';

const NOW = 1_800_000_000_000;
const SECRET = 'admin-test-secret';
const ADMIN = 'evm:0xadmin';
const P1 = '00000000-0000-4000-8000-0000000000a1';

function setup(prizesEnabled = false) {
  const f = fakeDb({ game_missions: ['id'], game_prize_claims: ['treasure_id'], game_treasure_locations: ['treasure_id'] }, { game_treasures: { status: 'hidden' }, game_prize_claims: { claim_status: 'pending' }, game_announcements: { active: true }, game_abuse_reports: { status: 'open' } });
  // A city has one live Diamond: the real database enforces it with a unique index; the stand-in does the same here.
  const realCall = f.db.call.bind(f.db);
  f.db.call = async (path, init = {}) => {
    if (path.startsWith('game_treasures') && (init.method ?? 'GET') === 'POST') {
      const b = JSON.parse(String(init.body)) as Row;
      if (b.class_id === 'diamond' && (f.t.game_treasures ?? []).some((r) => r.city_id === b.city_id && r.class_id === 'diamond' && r.status !== 'withdrawn')) throw new Error('answered 409');
    }
    return realCall(path, init);
  };
  const ctx = (body: Row, over: Partial<AdminCtx> = {}): AdminCtx => ({ db: f.db, admin: ADMIN, playerId: P1, network: 'evm', addressNorm: '0xplayer', body, now: NOW, secret: SECRET, prizesEnabled, ...over });
  const audited = (): string[] => (f.t.game_admin_audit ?? []).map((r) => String(r.action));
  return { ...f, ctx, audited };
}

describe('placement rules', () => {
  it('keep zones inside their city, away from airports and the buffer zone, and a sensible size', () => {
    expect(placementProblem({ city: 'paris', lng: 2.3522, lat: 48.8566, radiusM: 60 })).toBeNull();
    expect(placementProblem({ city: 'paris', lng: 10, lat: 10, radiusM: 60 })).toMatch(/outside Paris/);
    expect(placementProblem({ city: 'london', lng: -0.4543, lat: 51.47, radiusM: 60 })).toMatch(/Heathrow/);
    expect(placementProblem({ city: 'london', lng: -0.4543 + 0.04, lat: 51.47, radiusM: 60 })).toMatch(/Heathrow/); // 2.8 km away is still inside the margin
    expect(placementProblem({ city: 'nicosia', lng: 33.3647, lat: 35.1733, radiusM: 60 })).toMatch(/buffer zone/);
    expect(placementProblem({ city: 'paris', lng: 2.3522, lat: 48.8566, radiusM: 5 })).toMatch(/10 to 500/);
    expect(placementProblem({ city: 'paris', lng: 2.3522, lat: 48.8566, radiusM: 60.5 })).toMatch(/10 to 500/);
    expect(placementProblem({ city: 'atlantis', lng: 0, lat: 0, radiusM: 60 })).toMatch(/Unknown/);
  });
});

describe('missions and clues', () => {
  const mission = { id: 'paris-tour', city: 'paris', title: 'A tour', difficulty: 'beginner' };

  it('saves a mission, refuses bad input, and will not go live without a clue', async () => {
    const w = setup();
    expect((await adminOp('admin-mission-save', w.ctx({ ...mission, status: 'draft' })))!.status).toBe(200);
    expect(w.t.game_missions![0]).toMatchObject({ id: 'paris-tour', city_id: 'paris', status: 'draft', xp_reward: 100 });
    for (const bad of [{ id: 'X' }, { city: 'atlantis' }, { title: '' }, { difficulty: 'easy' }, { kind: 'forever' }, { status: 'live' }, { xpReward: -1 }, { opensAt: 10, closesAt: 5 }, { treasureId: 'nope' }]) {
      expect((await adminOp('admin-mission-save', w.ctx({ ...mission, ...bad })))!.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await adminOp('admin-mission-save', w.ctx({ ...mission, status: 'active' })))!.status).toBe(409);
    expect(w.audited()).toEqual(['mission_save']);
  });

  it('adds clues in order, hashes the answer with the clue id, keeps the id on edit, and never returns an answer', async () => {
    const w = setup();
    await adminOp('admin-mission-save', w.ctx({ ...mission, status: 'draft' }));
    const base = { mission: 'paris-tour', type: 'riddle', content: 'What am I?', hints: ['a', 'b'] };
    expect((await adminOp('admin-clue-save', w.ctx({ ...base, seq: 2, answer: 'x' })))!.status).toBe(400); // cannot skip step 1
    expect((await adminOp('admin-clue-save', w.ctx({ ...base, seq: 1 })))!.status).toBe(400); // a new clue needs an answer
    expect((await adminOp('admin-clue-save', w.ctx({ ...base, seq: 1, type: 'poem', answer: 'x' })))!.status).toBe(400);
    expect((await adminOp('admin-clue-save', w.ctx({ ...base, mission: 'nope-nope', seq: 1, answer: 'x' })))!.status).toBe(404);
    expect((await adminOp('admin-clue-save', w.ctx({ ...base, seq: 1, answer: 'The Louvre' })))!.status).toBe(200);
    const clue = w.t.game_clues![0]!;
    expect(clue.answer_hash).toBe(answerHash(SECRET, String(clue.id), 'the louvre'));
    const id = clue.id;
    await adminOp('admin-clue-save', w.ctx({ ...base, seq: 1, content: 'Changed text' }));
    expect(w.t.game_clues![0]).toMatchObject({ id, content: 'Changed text', answer_hash: clue.answer_hash });
    await adminOp('admin-clue-save', w.ctx({ ...base, seq: 1, answer: 'Orsay' }));
    expect(w.t.game_clues![0]!.answer_hash).toBe(answerHash(SECRET, String(id), 'orsay'));
    expect(w.t.game_clues).toHaveLength(1);
    const list = await adminOp('admin-clue-list', w.ctx({ mission: 'paris-tour' }));
    expect(JSON.stringify(list!.data)).not.toMatch(/answer_hash|orsay|louvre/i);
    expect((list!.data.clues as Row[])[0]).toMatchObject({ seq: 1, hasAnswer: true, content: 'What am I?' });
    expect((await adminOp('admin-mission-save', w.ctx({ ...mission, status: 'active' })))!.status).toBe(200);
    expect((await adminOp('admin-clue-delete', w.ctx({ mission: 'paris-tour' })))!.status).toBe(409); // its only clue while live
    expect(w.audited()).toEqual(expect.arrayContaining(['mission_save', 'clue_save']));
  });
});

describe('treasure placement', () => {
  const spot = { city: 'paris', class: 'lutetium', lng: 2.3522, lat: 48.8566, radiusM: 60, confirmSafe: true };

  it('needs the safety confirmation and a clean position, then stores the treasure and its zone', async () => {
    const w = setup();
    expect((await adminOp('admin-treasure-place', w.ctx({ ...spot, confirmSafe: false })))!.status).toBe(400);
    expect((await adminOp('admin-treasure-place', w.ctx({ ...spot, lng: 55, lat: 25 })))!.status).toBe(400);
    expect((await adminOp('admin-treasure-place', w.ctx({ ...spot, class: 'ruby' })))!.status).toBe(400);
    expect(w.t.game_treasures ?? []).toHaveLength(0);
    const r = await adminOp('admin-treasure-place', w.ctx(spot));
    expect(r!.status).toBe(200);
    expect(w.t.game_treasures![0]).toMatchObject({ city_id: 'paris', class_id: 'lutetium', status: 'hidden' });
    expect(w.t.game_treasure_locations![0]).toMatchObject({ lng: 2.3522, lat: 48.8566, radius_m: 60 });
    expect(w.t.game_admin_audit![0]).toMatchObject({ action: 'treasure_place', admin: ADMIN });
    expect(JSON.stringify(w.t.game_admin_audit![0]!.details)).toContain('confirmedSafe');
  });

  it('allows one Diamond per city, honours a supply cap, and withdraws only a hidden treasure', async () => {
    const w = setup();
    const diamond = { ...spot, class: 'diamond' };
    const first = await adminOp('admin-treasure-place', w.ctx(diamond));
    expect(first!.status).toBe(200);
    expect((await adminOp('admin-treasure-place', w.ctx(diamond)))!.status).toBe(409);
    expect((await adminOp('admin-treasure-place', w.ctx({ ...diamond, city: 'london', lng: -0.1276, lat: 51.5072 })))!.status).toBe(200);
    expect((await adminOp('admin-treasure-place', w.ctx({ ...spot, class: 'golden', supplyCap: 1 })))!.status).toBe(200);
    expect((await adminOp('admin-treasure-place', w.ctx({ ...spot, class: 'golden', supplyCap: 1 })))!.status).toBe(409);
    const id = String(first!.data.id);
    expect((await adminOp('admin-treasure-withdraw', w.ctx({ id })))!.status).toBe(200);
    expect((await adminOp('admin-treasure-withdraw', w.ctx({ id })))!.status).toBe(409);
    expect((await adminOp('admin-treasure-place', w.ctx(diamond)))!.status).toBe(200); // the slot is free again
    const list = await adminOp('admin-treasure-list', w.ctx({ city: 'paris' }));
    expect((list!.data.treasures as Row[]).every((x) => x.zone !== undefined)).toBe(true);
  });

  it('rolls the treasure back if its location cannot be saved', async () => {
    const w = setup();
    w.failOn.add('POST game_treasure_locations');
    expect((await adminOp('admin-treasure-place', w.ctx(spot)))!.status).toBe(500);
    expect(w.t.game_treasures).toHaveLength(0);
  });
});

describe('verification and claims', () => {
  const T = '00000000-0000-4000-8000-0000000000c1';
  function found(w: ReturnType<typeof setup>, cls: string, verification = 'verified'): void {
    w.t.game_treasures = [{ id: T, city_id: 'paris', class_id: cls, status: 'found', found_by: P1 }];
    w.t.game_player_treasures = [{ player_id: P1, treasure_id: T, discovery_status: 'discovered', verification_status: verification, claim_status: 'none' }];
  }

  it('verifies or rejects a pending find, and can put a rejected treasure back in play', async () => {
    const w = setup();
    found(w, 'diamond', 'pending');
    const q = await adminOp('admin-verify-queue', w.ctx({}));
    expect(q!.data.queue).toEqual([expect.objectContaining({ playerId: P1, treasureId: T, class: 'diamond' })]);
    expect((await adminOp('admin-verify', w.ctx({ playerId: P1, treasureId: T, decision: 'maybe' })))!.status).toBe(400);
    expect((await adminOp('admin-verify', w.ctx({ playerId: P1, treasureId: T, decision: 'rejected', reopen: true })))!.status).toBe(200);
    expect(w.t.game_player_treasures![0]!.verification_status).toBe('rejected');
    expect(w.t.game_treasures![0]).toMatchObject({ status: 'hidden', found_by: null });
    expect((await adminOp('admin-verify', w.ctx({ playerId: P1, treasureId: T, decision: 'verified' })))!.status).toBe(409); // no longer pending
  });

  it('keeps cash closed until prizes are switched on, and never claims a collectible', async () => {
    const off = setup(false);
    found(off, 'diamond');
    expect((await playerAdminOp('claim-prize', off.ctx({ treasure: T })))!.status).toBe(409);
    expect(off.t.game_prize_claims ?? []).toHaveLength(0);
    const on = setup(true);
    found(on, 'lutetium');
    const r = await playerAdminOp('claim-prize', on.ctx({ treasure: T }));
    expect(r!.status).toBe(409);
    expect(r!.data.message).toMatch(/collectible/);
    expect(CASH_ELIGIBLE_USD).toBe(1);
  });

  it('records one claim per treasure, only for a verified find, then decisions and the payment reference', async () => {
    const w = setup(true);
    found(w, 'diamond', 'pending');
    expect((await playerAdminOp('claim-prize', w.ctx({ treasure: T })))!.status).toBe(409); // not verified yet
    found(w, 'diamond');
    expect((await playerAdminOp('claim-prize', w.ctx({ treasure: 'x' })))!.status).toBe(400);
    expect((await playerAdminOp('claim-prize', w.ctx({ treasure: T }, { playerId: '00000000-0000-4000-8000-0000000000a2' })))!.status).toBe(404); // someone else's find
    expect((await playerAdminOp('claim-prize', w.ctx({ treasure: T })))!.status).toBe(200);
    expect((await playerAdminOp('claim-prize', w.ctx({ treasure: T })))!.status).toBe(409); // duplicate
    expect(w.t.game_prize_claims![0]).toMatchObject({ amount_usd: 1000, claim_status: 'pending', player_id: P1 });
    const id = String(w.t.game_prize_claims![0]!.id);
    expect((await adminOp('admin-claim-paid', w.ctx({ id, paymentReference: 'REF-1' })))!.status).toBe(409); // not approved yet
    expect((await adminOp('admin-claim-decide', w.ctx({ id, decision: 'approved', notes: 'ID and eligibility checked' })))!.status).toBe(200);
    expect((await adminOp('admin-claim-decide', w.ctx({ id, decision: 'rejected' })))!.status).toBe(409); // decided already
    expect((await adminOp('admin-claim-paid', w.ctx({ id, paymentReference: '' })))!.status).toBe(400);
    expect((await adminOp('admin-claim-paid', w.ctx({ id, paymentReference: 'REF-1' })))!.status).toBe(200);
    expect(w.t.game_prize_claims![0]).toMatchObject({ claim_status: 'paid', payment_reference: 'REF-1', paid_at: NOW });
    expect(w.audited()).toEqual(['claim_decide', 'claim_paid']);
    const listed = await adminOp('admin-claims', w.ctx({ status: 'paid' }));
    expect((listed!.data.claims as Row[]).length).toBe(1);
  });
});

describe('reserve, overview and the rest', () => {
  it('works out what is owed against the funded reserve', async () => {
    const w = setup();
    w.rpc.game_admin_overview = () => ({ players: 10, hiddenValueUsd: 9000, pendingVerificationUsd: 587, reserveUsd: 5000, claims: { pending: { n: 1, usd: 65 }, approved: { n: 1, usd: 212 }, paid: { n: 2, usd: 100 } } });
    const r = await adminOp('admin-overview', w.ctx({}));
    expect(r!.data.prizes).toEqual({ committedHiddenUsd: 9000, pendingVerificationUsd: 587, claimsPendingUsd: 65, claimsApprovedUnpaidUsd: 212, paidUsd: 100, remainingObligationsUsd: 9864, reserveUsd: 5000, shortfallUsd: 4864 });
    expect(r!.data.prizesEnabled).toBe(false);
  });

  it('records reserve entries with the administrator and audits them', async () => {
    const w = setup();
    expect((await adminOp('admin-reserve', w.ctx({ amountUsd: 0 })))!.status).toBe(400);
    expect((await adminOp('admin-reserve', w.ctx({ amountUsd: 'a lot' })))!.status).toBe(400);
    expect((await adminOp('admin-reserve', w.ctx({ amountUsd: 9000, note: 'Initial funding' })))!.status).toBe(200);
    expect(w.t.game_reserve_entries![0]).toMatchObject({ amount_usd: 9000, admin: ADMIN });
    expect(w.audited()).toEqual(['reserve_entry']);
  });

  it('edits only catalogue cities, with valid statuses, and audits it', async () => {
    const w = setup();
    w.t.game_cities = [{ id: 'paris', status: 'active' }];
    expect((await adminOp('admin-city-set', w.ctx({ id: 'atlantis', status: 'active' })))!.status).toBe(400);
    expect((await adminOp('admin-city-set', w.ctx({ id: 'paris', status: 'gone' })))!.status).toBe(400);
    expect((await adminOp('admin-city-set', w.ctx({ id: 'paris' })))!.status).toBe(400);
    expect((await adminOp('admin-city-set', w.ctx({ id: 'paris', status: 'inactive' })))!.status).toBe(200);
    expect(w.t.game_cities![0]!.status).toBe('inactive');
    expect(w.audited()).toEqual(['city_set']);
  });

  it('shows announcements until they end or expire, and limits abuse reports', async () => {
    const w = setup();
    expect((await adminOp('admin-announce', w.ctx({ title: '' })))!.status).toBe(400);
    expect((await adminOp('admin-announce', w.ctx({ title: 'Paris is open', body: 'Go', expiresAt: NOW - 1 })))!.status).toBe(400);
    const a = await adminOp('admin-announce', w.ctx({ title: 'Paris is open', body: 'Go', expiresAt: NOW + 1000 }));
    await adminOp('admin-announce', w.ctx({ title: 'Always on' }));
    expect(((await playerAdminOp('announcements', w.ctx({})))!.data.announcements as Row[]).map((x) => x.title).sort()).toEqual(['Always on', 'Paris is open']);
    expect(((await playerAdminOp('announcements', w.ctx({}, { now: NOW + 2000 })))!.data.announcements as Row[]).map((x) => x.title)).toEqual(['Always on']);
    await adminOp('admin-announcement-end', w.ctx({ id: String(a!.data.id) }));
    expect(((await playerAdminOp('announcements', w.ctx({})))!.data.announcements as Row[]).map((x) => x.title)).toEqual(['Always on']);

    expect((await playerAdminOp('report-abuse', w.ctx({ kind: 'bribery' })))!.status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await playerAdminOp('report-abuse', w.ctx({ kind: 'cheating', details: 'x' })))!.status).toBe(200);
    expect((await playerAdminOp('report-abuse', w.ctx({ kind: 'cheating' })))!.status).toBe(429);
    const open = await adminOp('admin-reports', w.ctx({}));
    expect((open!.data.reports as Row[]).length).toBe(5);
    const rid = String((open!.data.reports as Row[])[0]!.id);
    expect((await adminOp('admin-report-resolve', w.ctx({ id: rid, status: 'resolved' })))!.status).toBe(200);
    expect((await adminOp('admin-report-resolve', w.ctx({ id: rid, status: 'resolved' })))!.status).toBe(409);
  });

  it('flags guessing and hint spam, and lists the audit log newest first', async () => {
    const w = setup();
    w.t.game_attempts = Array.from({ length: 25 }, () => ({ player_id: 'p-guesser', correct: false, at: NOW - 1000 }));
    w.t.game_attempts.push({ player_id: 'p-fine', correct: false, at: NOW - 1000 });
    w.t.game_player_activities = Array.from({ length: 61 }, () => ({ player_id: 'p-hinter', activity_type: 'hint_requested', created_at: NOW - 1000 }));
    const s = await adminOp('admin-suspicious', w.ctx({}));
    expect((s!.data.flagged as Row[]).map((f) => f.player).sort()).toEqual(['p-guesser', 'p-hinter']);
    await adminOp('admin-reserve', w.ctx({ amountUsd: 1 }));
    await adminOp('admin-reserve', w.ctx({ amountUsd: 2 }, { now: NOW + 5 }));
    const log = await adminOp('admin-audit', w.ctx({}));
    expect((log!.data.entries as Row[]).map((e) => e.at)).toEqual([NOW + 5, NOW]);
  });

  it('does not own ops that are not admin ops', async () => {
    expect(await adminOp('missions', setup().ctx({}))).toBeNull();
    expect(await playerAdminOp('admin-audit', setup().ctx({}))).toBeNull();
  });
});
