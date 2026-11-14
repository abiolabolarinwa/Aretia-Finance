/**
 * A small in-memory stand-in for the game's database, for tests. It understands the PostgREST filters the game code uses
 * (eq, gt, lt, in), order, limit, the "return=representation" and "ignore-duplicates" preferences, unique keys, and stubbed rpc replies.
 */
export type Row = Record<string, unknown>;

export function fakeDb(unique: Record<string, string[]> = {}, defaults: Record<string, Row> = {}) {
  const t: Record<string, Row[]> = {};
  const rpc: Record<string, (body: Row) => unknown> = {};
  const failOn = new Set<string>();
  let seq = 0;
  const match = (row: Row, params: URLSearchParams): boolean => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      const i = v.indexOf('.');
      const op = v.slice(0, i);
      const val = v.slice(i + 1);
      if (op === 'eq' && String(row[k]) !== val) return false;
      if (op === 'gt' && !(Number(row[k]) > Number(val))) return false;
      if (op === 'lt' && !(Number(row[k]) < Number(val))) return false;
      if (op === 'in' && !val.slice(1, -1).split(',').includes(String(row[k]))) return false;
    }
    return true;
  };
  const db = {
    async call(path: string, init: RequestInit = {}): Promise<unknown> {
      const [table, query = ''] = path.split('?');
      const params = new URLSearchParams(query);
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Row) : {};
      const prefer = String((init.headers as Record<string, string> | undefined)?.prefer ?? '');
      if (table!.startsWith('rpc/')) return rpc[table!.slice(4)]?.(body) ?? null;
      if (failOn.has(`${method} ${table}`)) throw new Error('answered 500');
      const rows = (t[table!] ??= []);
      if (method === 'POST') {
        const keys = unique[table!];
        if (keys && rows.some((r) => keys.every((k) => r[k] === body[k]))) {
          if (prefer.includes('ignore-duplicates')) return prefer.includes('representation') ? [] : null;
          if (prefer.includes('merge-duplicates')) {
            Object.assign(rows.find((r) => keys.every((k) => r[k] === body[k]))!, body);
            return null;
          }
          throw new Error('answered 409');
        }
        const row: Row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, ...defaults[table!], ...body };
        rows.push(row);
        return prefer.includes('representation') ? [row] : null;
      }
      const hit = rows.filter((r) => match(r, params));
      if (method === 'DELETE') {
        t[table!] = rows.filter((r) => !hit.includes(r));
        return null;
      }
      if (method === 'PATCH') {
        for (const r of hit) Object.assign(r, body);
        return prefer.includes('representation') ? hit : null;
      }
      const order = params.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        hit.sort((a, b) => (Number(a[col!]) - Number(b[col!]) || String(a[col!]).localeCompare(String(b[col!]))) * (dir === 'desc' ? -1 : 1));
      }
      const limit = Number(params.get('limit') ?? 0);
      return limit > 0 ? hit.slice(0, limit) : hit;
    },
  };
  return { db, t, rpc, failOn };
}
