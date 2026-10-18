/**
 * POST /api/swings-referrals: the referral system for swap fees (docs/referrals.md). Both operations need the session a person gets by
 * signing a plain message with their wallet (the same sign-in as /api/swings-account); no password, no key.
 *
 *   { op: 'record', ref?, chain, txs: [hash...] }   a trader reports the transaction(s) that paid the Aretia fee. The server reads each
 *                                                    one back from the chain and credits the referrer for what Aretia really received.
 *   { op: 'mine' }                                   a referrer's own numbers: traders, volume, and what is owed, per chain and coin.
 *
 * What keeps it honest:
 *  - nothing a browser says is believed: the fee amount, the payer and the time come from the chain, and a payment is credited once
 *    ((chain, tx, asset) is unique in the database);
 *  - a trader is bound to the first referrer only, for the window, and never to themselves or to someone they brought;
 *  - the referrer's share comes out of the fee the trader paid, so inventing volume costs more than it returns;
 *  - 'mine' reads only the rows of the address the session was issued for.
 * No payout is made here or anywhere in the app: the owner pays by hand from a local export (scripts/referral-export.mjs).
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { readSession } from './_swingsAuth.js';
import { rest } from './_swingsAccount.js';
import { isChainId, CHAINS, type ChainId } from '../src/swings/core/types.js';
import { REFERRAL_CONFIG, decideCredit, inWindow, isMutual, isSelf, parseReferrer, totalsByChainAsset, windowMs, type CreditRow, type CreditStatus, type Family, type PriorCredit } from '../src/swings/referrals/core.js';
import { verifyFee, type VerifyEnv } from './_referralVerify.js';
import type { TokensEnv } from './_swingsTokens.js';

export interface ReferralsInput {
  method: string;
  origin: string | null;
  authorization: string | null;
  ip: string;
  body: unknown;
  env: TokensEnv & VerifyEnv & { SWINGS_SESSION_SECRET?: string };
  fetchImpl: typeof fetch;
  now: number;
}
export interface ReferralsOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const MAX_TXS = 3;
const MAX_ROWS = 5000;
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const json = (status: number, data: unknown, headers: Record<string, string>): ReferralsOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });
const enc = encodeURIComponent;
const familyOf = (chain: ChainId): Family => (CHAINS[chain].kind === 'solana' ? 'solana' : 'evm');

interface BindingRow { trader: string; referrer: string; bound_at: number; expires_at: number }
interface CreditDb { chain: string; tx: string; asset: string; trader: string; referrer: string; fee_raw: string; share_raw: string; status: CreditStatus; tx_at: number; created_at: number }

const toPrior = (r: CreditDb): PriorCredit => ({ referrer: r.referrer, trader: r.trader, asset: r.asset, feeRaw: BigInt(r.fee_raw), at: Number(r.tx_at), status: r.status });

export async function handleReferrals(input: ReferralsInput): Promise<ReferralsOutput> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type, authorization';
  }
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'POST') return json(405, { error: 'method' }, { ...headers, allow: 'POST, OPTIONS' });
  if (!allowed) return json(403, { error: 'origin' }, headers);
  const url = supabaseBase(input.env.SUPABASE_URL);
  const key = input.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return json(503, { error: 'not-configured', message: 'Referrals are not set up on this server yet.' }, headers);
  if (overLimit(`referrals:${input.ip}`, input.now)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
  const secret = input.env.SWINGS_SESSION_SECRET?.trim() || key;
  const bearer = input.authorization?.startsWith('Bearer ') ? input.authorization.slice(7).trim() : null;
  const owner = readSession(secret, bearer, input.now);
  if (!owner) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
  const body = obj(input.body);
  const db = rest(url, key, input.fetchImpl);
  const q = enc(owner);

  try {
    if (body.op === 'mine') {
      const [credits, bindings, revoked] = (await Promise.all([
        db.call(`referral_credits?referrer=eq.${q}&select=chain,asset,trader,fee_raw,share_raw,status,created_at&order=created_at.desc&limit=${MAX_ROWS}`),
        db.call(`referral_bindings?referrer=eq.${q}&select=trader,bound_at,expires_at&limit=${MAX_ROWS}`),
        db.call(`referral_revocations?referrer=eq.${q}&select=referrer`),
      ])) as [CreditDb[], BindingRow[], unknown[]];
      const rows: CreditRow[] = credits.map((c) => ({ chain: c.chain, asset: c.asset, status: c.status, feeRaw: BigInt(c.fee_raw), shareRaw: BigInt(c.share_raw), trader: c.trader }));
      const revokedNow = revoked.length > 0;
      const totals = revokedNow ? [] : totalsByChainAsset(rows);
      const traders = new Set(rows.filter((r) => r.status === 'credited').map((r) => r.trader));
      return json(
        200,
        {
          revoked: revokedNow,
          traders: bindings.length,
          activeTraders: bindings.filter((b) => inWindow(Number(b.bound_at), input.now)).length,
          tradersWithSwaps: traders.size,
          notCounted: { capped: rows.filter((r) => r.status === 'capped').length, flagged: rows.filter((r) => r.status === 'flagged').length, otherFamily: rows.filter((r) => r.status === 'family').length },
          totals: totals.map((t) => ({ chain: t.chain, asset: t.asset, swaps: t.swaps, fee: t.feeRaw.toString(), volume: t.volumeRaw.toString(), owed: t.owedRaw.toString() })),
        },
        headers,
      );
    }

    if (body.op !== 'record') return json(400, { error: 'bad-request' }, headers);
    const chain = typeof body.chain === 'string' && isChainId(body.chain) ? body.chain : null;
    const txs = Array.isArray(body.txs) ? [...new Set(body.txs.filter((t): t is string => typeof t === 'string' && t.length >= 20 && t.length <= 130))].slice(0, MAX_TXS) : [];
    if (!chain || txs.length === 0) return json(400, { error: 'bad-request' }, headers);
    const traderFamily = owner.startsWith('solana:') ? 'solana' : 'evm';
    if (familyOf(chain) !== traderFamily) return json(400, { error: 'bad-request', message: 'That network does not match the signed-in wallet.' }, headers);
    const trader = owner.slice(owner.indexOf(':') + 1);

    // The first referrer wins. An existing binding is used as it is; a new one is made only from a valid link, never for oneself,
    // never for a revoked referrer and never between two people who named each other.
    let binding = ((await db.call(`referral_bindings?trader=eq.${q}&select=trader,referrer,bound_at,expires_at`)) as BindingRow[])[0] ?? null;
    if (!binding) {
      const ref = parseReferrer(body.ref);
      if (!ref) return json(200, { credited: 0, reason: 'no-referrer' }, headers);
      if (isSelf(owner, ref.owner)) return json(200, { credited: 0, reason: 'self' }, headers);
      const [revoked, back] = (await Promise.all([db.call(`referral_revocations?referrer=eq.${enc(ref.owner)}&select=referrer`), db.call(`referral_bindings?trader=eq.${enc(ref.owner)}&select=trader,referrer`)])) as [unknown[], { trader: string; referrer: string }[]];
      if (revoked.length > 0) return json(200, { credited: 0, reason: 'revoked' }, headers);
      if (isMutual(owner, ref.owner, back)) return json(200, { credited: 0, reason: 'mutual' }, headers);
      const row = { trader: owner, referrer: ref.owner, bound_at: input.now, expires_at: input.now + windowMs() };
      // Two tabs can race here; the table's primary key keeps the first and the loser reads it back.
      await db.call('referral_bindings?on_conflict=trader', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) });
      binding = ((await db.call(`referral_bindings?trader=eq.${q}&select=trader,referrer,bound_at,expires_at`)) as BindingRow[])[0] ?? null;
      if (!binding) return json(502, { error: 'database' }, headers);
    }
    const bound = Number(binding.bound_at);
    if (input.now >= Number(binding.expires_at)) return json(200, { credited: 0, reason: 'window-ended' }, headers);
    const revokedNow = (await db.call(`referral_revocations?referrer=eq.${enc(binding.referrer)}&select=referrer`)) as unknown[];
    if (revokedNow.length > 0) return json(200, { credited: 0, reason: 'revoked' }, headers);
    const referrerFamily: Family = binding.referrer.startsWith('solana:') ? 'solana' : 'evm';

    const results: { tx: string; result: string }[] = [];
    let credited = 0;
    for (const tx of txs) {
      const verified = await verifyFee({ chain, tx, trader, env: input.env, fetchImpl: input.fetchImpl });
      if (!verified.ok) {
        results.push({ tx, result: verified.reason });
        continue;
      }
      const maxAge = REFERRAL_CONFIG.maxTxAgeHours * 3_600_000;
      if (input.now - verified.at > maxAge || verified.at < bound - maxAge || verified.at > input.now + 5 * 60_000) {
        results.push({ tx, result: 'out-of-time' });
        continue;
      }
      for (const p of verified.payments) {
        const since = input.now - 86_400_000;
        const recent = ((await db.call(`referral_credits?created_at=gte.${since}&or=(referrer.eq.${enc(binding.referrer)},trader.eq.${q})&select=chain,tx,asset,trader,referrer,fee_raw,share_raw,status,tx_at,created_at&limit=2000`)) as CreditDb[]).map(toPrior);
        const decision = decideCredit({ referrer: binding.referrer, trader: owner, asset: p.asset, feeRaw: p.amount, at: verified.at, chainFamily: familyOf(chain), referrerFamily }, recent);
        const swapTx = typeof body.swapTx === 'string' && body.swapTx.length <= 130 ? body.swapTx : null;
        const row = { chain, tx, asset: p.asset, trader: owner, referrer: binding.referrer, swap_tx: swapTx, fee_raw: p.amount.toString(), share_raw: decision.shareRaw.toString(), status: decision.status, tx_at: verified.at, created_at: input.now };
        const inserted = (await db.call('referral_credits?on_conflict=chain,tx,asset', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(row) })) as unknown[] | null;
        const isNew = Array.isArray(inserted) && inserted.length > 0;
        if (isNew && decision.status === 'credited') credited += 1;
        results.push({ tx, result: isNew ? decision.status : 'already-recorded' });
      }
    }
    return json(200, { credited, results }, headers);
  } catch (e) {
    const detail = e instanceof Error ? /answered (\d{3})/.exec(e.message)?.[1] ?? null : null;
    return json(502, { error: 'database', message: 'Referrals could not be reached.', ...(detail ? { status: Number(detail) } : {}) }, headers);
  }
}
