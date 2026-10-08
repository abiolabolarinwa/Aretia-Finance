import { describe, expect, it } from 'vitest';
import { mirroredExecutionStore, RecordMirror, restoreFromCode, secureId } from './remote.js';
import { InMemoryExecutionStore, StorageExecutionStore } from './store.js';
import { CrossChainOrchestrator } from './orchestrator.js';
import { MockSettlementProvider } from '../settlement/testing.js';
import { handleRecords } from '../../../api/_swingsRecords.js';

const NOW = 1_000_000;
const A = '0x' + 'a'.repeat(40);
const intent = { sourceChain: 'ethereum' as const, sourceAsset: { chain: 'ethereum' as const, address: '0x1' }, sourceAmount: 5_000_000n, destinationChain: 'base' as const, destinationAsset: { chain: 'base' as const, address: '0x2' }, sender: A, recipient: A };

/** The real server code behind an in-memory table, so the client and server are tested against each other. */
function server() {
  const rows = new Map<string, { version: number; body: unknown; kind: string }>();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'https://aretiafinance.org');
    const db = (async (dbUrl: string, dbInit?: RequestInit) => {
      const d = new URL(dbUrl);
      const id = d.searchParams.get('id')?.replace('eq.', '');
      const method = dbInit?.method ?? 'GET';
      const body = dbInit?.body ? (JSON.parse(String(dbInit.body)) as Record<string, unknown>) : null;
      if (method === 'GET') return new Response(JSON.stringify(rows.has(id!) ? [{ body: rows.get(id!)!.body }] : []));
      if (method === 'POST') {
        if (rows.has(body!.id as string)) return new Response('{}', { status: 409 });
        rows.set(body!.id as string, { version: body!.version as number, body: body!.body, kind: body!.kind as string });
        return new Response(null, { status: 201 });
      }
      const cur = rows.get(id!);
      const want = Number(d.searchParams.get('version')?.replace('eq.', ''));
      if (!cur || cur.version !== want) return new Response('[]');
      rows.set(id!, { ...cur, version: body!.version as number, body: body!.body });
      return new Response(JSON.stringify([{ id }]));
    }) as unknown as typeof fetch;
    const out = await handleRecords({ method: init?.method ?? 'GET', origin: 'https://aretiafinance.org', ip: `1.1.1.${Math.floor(Math.random() * 250)}`, contentType: 'application/json', query: Object.fromEntries(u.searchParams), body: (init?.body as string) ?? '', env: { SUPABASE_URL: 'https://db.example.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }, fetchImpl: db, now: NOW });
    return new Response(out.body, { status: out.status });
  }) as unknown as typeof fetch;
  return { rows, fetchImpl };
}

describe('secureId', () => {
  it('is long, unguessable-looking, unique, and fits what the server accepts', () => {
    const ids = new Set(Array.from({ length: 200 }, () => secureId('x')));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^x_[0-9a-f]{32}$/);
  });
});

describe('recovery copies', () => {
  const setup = (enabled = true) => {
    const s = server();
    const mirror = new RecordMirror(s.fetchImpl);
    const results: string[] = [];
    const store = mirroredExecutionStore(new InMemoryExecutionStore(), mirror, () => enabled, (r) => results.push(r));
    const provider = new MockSettlementProvider({ now: () => NOW });
    const orch = new CrossChainOrchestrator({ store, providers: [provider], gateway: { send: async () => '0x' + '1'.repeat(64), confirmation: async () => 'confirmed' }, now: () => NOW, sleep: async () => undefined, confirmTimeoutMs: 0 });
    return { s, mirror, results, store, orch, provider };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('sends every version to the server when switched on, with the real server code accepting each one in order', async () => {
    const { s, orch, provider, results } = setup();
    const rec = await orch.create(await provider.getQuote(intent));
    await orch.start(rec.id);
    await settle();
    expect(rec.id).toMatch(/^x_[0-9a-f]{32}$/);
    expect(results.every((r) => r === 'saved')).toBe(true);
    expect(s.rows.get(rec.id)!.version).toBeGreaterThan(3);
  });

  it('sends nothing when switched off', async () => {
    const { s, orch, provider } = setup(false);
    await orch.create(await provider.getQuote(intent));
    await settle();
    expect(s.rows.size).toBe(0);
  });

  it('never stops an execution when the server is down, and says the copy is behind', async () => {
    const results: string[] = [];
    const mirror = new RecordMirror((async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    const store = mirroredExecutionStore(new InMemoryExecutionStore(), mirror, () => true, (r) => results.push(r));
    const provider = new MockSettlementProvider({ now: () => NOW });
    const orch = new CrossChainOrchestrator({ store, providers: [provider], gateway: { send: async () => '0x' + '1'.repeat(64), confirmation: async () => 'confirmed' }, now: () => NOW, sleep: async () => undefined, confirmTimeoutMs: 0 });
    const rec = await orch.create(await provider.getQuote(intent));
    expect((await orch.start(rec.id)).state).toBe('SETTLEMENT_PENDING');
    await settle();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r === 'unavailable')).toBe(true);
  });

  it('restores a record from its code into a fresh browser, with its version, and the move can carry on from there', async () => {
    const { s, orch, provider } = setup();
    const rec = await orch.create(await provider.getQuote(intent));
    const done = await orch.start(rec.id);
    await settle();
    const fresh = new InMemoryExecutionStore();
    const back = await restoreFromCode(rec.id, new RecordMirror(s.fetchImpl), fresh);
    expect(back.state).toBe(done.state);
    expect(back.version).toBe(done.version);
    expect(back.quote.sourceAmount).toBe(5_000_000n); // bigints survive the trip
    const orch2 = new CrossChainOrchestrator({ store: fresh, providers: [provider], gateway: { send: async () => '0x', confirmation: async () => 'confirmed' }, now: () => NOW });
    expect((await orch2.advance(rec.id)).record.id).toBe(rec.id);
  });

  it('does not overwrite a newer local copy, and refuses a bad code or an unknown one', async () => {
    const { s, orch, provider, store } = setup();
    const rec = await orch.create(await provider.getQuote(intent));
    await orch.start(rec.id);
    await settle();
    const local = await store.get(rec.id);
    expect(await restoreFromCode(rec.id, new RecordMirror(s.fetchImpl), store)).toMatchObject({ version: local!.version });
    await expect(restoreFromCode('nope', new RecordMirror(s.fetchImpl), store)).rejects.toThrow(/not a recovery code/);
    await expect(restoreFromCode('x_' + 'f'.repeat(32), new RecordMirror(s.fetchImpl), store)).rejects.toThrow(/No recovery copy/);
  });

  it('a stale upload from a second browser is reported as a conflict, not applied', async () => {
    const { s, orch, provider } = setup();
    const rec = await orch.create(await provider.getQuote(intent));
    await settle();
    const mirror = new RecordMirror(s.fetchImpl);
    expect(await mirror.push('settlement', { ...rec, version: 7, state: 'QUOTED' } as never, 6)).toBe('conflict');
  });

  it('works with the browser-storage store too', async () => {
    const mem = new Map<string, string>();
    const store = new StorageExecutionStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) });
    const provider = new MockSettlementProvider({ now: () => NOW });
    const orch = new CrossChainOrchestrator({ store, providers: [provider], gateway: { send: async () => '0x', confirmation: async () => 'confirmed' }, now: () => NOW });
    const rec = await orch.create(await provider.getQuote(intent));
    const copy = { ...rec, version: rec.version + 4 };
    expect((await store.restore!(copy)).version).toBe(rec.version + 4);
    await expect(store.restore!(rec)).rejects.toThrow(/newer copy/);
  });
});
