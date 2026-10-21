/**
 * POST /api/swings-referrals: the referral system for swap fees (docs/referrals.md). Both operations need the session a person gets by
 * signing a plain message with their wallet (the same sign-in as /api/swings-account); no password, no key.
 *
 *   { op: 'capture', ref }                           (no sign-in) a visitor arrived through a referral link: answers a signed token
 *                                                    saying when the server first saw that visit. A referral binds only from it.
 *   { op: 'record', capture?, chain, txs: [hash...] }  a trader reports the transaction(s) that paid the Aretia fee. The server reads
 *                                                    each one back from the chain and credits the referrer for what Aretia really received.
 *   { op: 'mine' }                                   a referrer's own numbers: traders, volume, and what is owed, per chain and coin.
 *
 * What keeps it honest:
 *  - nothing a browser says is believed: the fee amount, the payer and the time come from the chain, and a payment is credited once
 *    ((chain, tx, asset) is unique in the database, and an EVM hash is stored only in lower case, so a re-spelled hash is the same row);
 *  - only final transactions count (`finalized` on Solana, a per-chain confirmation depth on EVM chains);
 *  - a trader is bound to the first referrer only, for the window, and never to themselves or to someone they brought. A binding is
 *    made only from a server-signed capture of the link visit, starts at that visit, and no transaction made before it is credited;
 *  - the daily caps are read with ordered, filtered queries, rows stop being stored past a per-trader daily limit, and reports are
 *    rate-limited per signed-in owner and per IP;
 *  - the referrer's share comes out of the fee the trader paid, so inventing volume costs more than it returns;
 *  - 'mine' reads only the rows of the address the session was issued for.
 * No payout is made here or anywhere in the app: the owner pays by hand from a local export (scripts/referral-export.mjs).
 */
import { supabaseBase } from '../src/swings/tokens/supabaseAuth.js';
import { isOriginAllowed, overLimit } from './_rpcProxy.js';
import { openToken, sessionOwner, sessionSecret, signToken } from './_swingsAuth.js';
import { rest } from './_swingsAccount.js';
import { overBudget } from './_limits.js';
import { isChainId, CHAINS, type ChainId } from '../src/swings/core/types.js';
import { REFERRAL_CONFIG, decideCredit, inWindow, isMutual, isSelf, parseReferrer, totalsByChainAsset, windowMs, type CreditRow, type CreditStatus, type Family, type PriorCredit } from '../src/swings/referrals/core.js';
import { canonicalTx, verifyFee, type VerifyEnv } from './_referralVerify.js';
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
const DAY_MS = 86_400_000;
/** `record` calls allowed per signed-in owner, and per IP, per minute; `capture` calls per IP per minute. */
export const RECORD_LIMITS = { perOwner: 6, perIp: 20, capturePerIp: 10 } as const;
const CAPTURE_KIND = 'rc1';
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const json = (status: number, data: unknown, headers: Record<string, string>): ReferralsOutput => ({ status, body: JSON.stringify(data), headers: { ...headers, 'content-type': 'application/json' } });
const enc = encodeURIComponent;
const familyOf = (chain: ChainId): Family => (CHAINS[chain].kind === 'solana' ? 'solana' : 'evm');

interface BindingRow { trader: string; referrer: string; bound_at: number; expires_at: number }
interface CreditDb { chain: string; tx: string; asset: string; trader: string; referrer: string; fee_raw: string; share_raw: string; status: CreditStatus; tx_at: number; created_at: number }

const toPrior = (r: CreditDb): PriorCredit => ({ referrer: r.referrer, trader: r.trader, asset: r.asset, feeRaw: BigInt(r.fee_raw), at: Number(r.tx_at), status: r.status });

/** A signed record of a referral-link visit: who the link names and when the server first saw it. */
export function issueCapture(secret: string, referrerOwner: string, now: number): string {
  return signToken(secret, CAPTURE_KIND, { r: referrerOwner, t: now });
}

/** The referrer and visit time of a capture token, or null when it is forged, from the future, or older than the referral window. */
export function readCapture(secret: string, token: unknown, now: number): { referrer: string; at: number } | null {
  const p = openToken(secret, CAPTURE_KIND, token);
  if (!p || typeof p.r !== 'string' || typeof p.t !== 'number' || !Number.isFinite(p.t)) return null;
  const ref = parseReferrer(p.r.slice(p.r.indexOf(':') + 1));
  if (!ref || ref.owner !== p.r || p.t > now || now - p.t >= windowMs()) return null;
  return { referrer: p.r, at: p.t };
}

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
  const secret = sessionSecret(input.env) ?? key;
  const body = obj(input.body);
  const db = rest(url, key, input.fetchImpl);

  // A link visit, recorded before any swap and before any sign-in: the signed time is when a binding may start.
  if (body.op === 'capture') {
    if (overBudget(`ref-capture:${input.ip}`, input.now, RECORD_LIMITS.capturePerIp)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
    const ref = parseReferrer(body.ref);
    if (!ref) return json(400, { error: 'bad-request' }, headers);
    return json(200, { capture: issueCapture(secret, ref.owner, input.now), at: input.now }, headers);
  }

  let owner: string | null;
  try {
    owner = await sessionOwner(secret, input.authorization, input.now, db);
  } catch {
    return json(502, { error: 'database', message: 'Referrals could not be reached.' }, headers);
  }
  if (!owner) return json(401, { error: 'session', message: 'Sign in again to continue.' }, headers);
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
    if (overBudget(`ref-record:${owner}`, input.now, RECORD_LIMITS.perOwner) || overBudget(`ref-record-ip:${input.ip}`, input.now, RECORD_LIMITS.perIp)) return json(429, { error: 'rate-limit' }, { ...headers, 'retry-after': '60' });
    const chain = typeof body.chain === 'string' && isChainId(body.chain) ? body.chain : null;
    // One spelling per transaction (EVM hashes lower-cased) before anything is compared, removed as a duplicate, stored or read.
    const txs = chain && Array.isArray(body.txs) ? [...new Set(body.txs.map((t) => canonicalTx(chain, t)).filter((t): t is string => t !== null))].slice(0, MAX_TXS) : [];
    if (!chain || txs.length === 0) return json(400, { error: 'bad-request' }, headers);
    const traderFamily = owner.startsWith('solana:') ? 'solana' : 'evm';
    if (familyOf(chain) !== traderFamily) return json(400, { error: 'bad-request', message: 'That network does not match the signed-in wallet.' }, headers);
    const trader = owner.slice(owner.indexOf(':') + 1);

    // The first referrer wins. An existing binding is used as it is; a new one is made only from a server-signed capture of the
    // link visit, never for oneself, never for a revoked referrer and never between two people who named each other. It starts at
    // the visit, so nothing traded before the person arrived through the link is ever credited.
    let binding = ((await db.call(`referral_bindings?trader=eq.${q}&select=trader,referrer,bound_at,expires_at`)) as BindingRow[])[0] ?? null;
    if (!binding) {
      const capture = readCapture(secret, body.capture, input.now);
      // A token that was sent but does not verify (signed with an earlier secret, or damaged) is 'bad-capture', so the browser drops it
      // and asks for a new one instead of resending it for ever.
      if (!capture) return json(200, { credited: 0, reason: typeof body.capture === 'string' && body.capture ? 'bad-capture' : parseReferrer(body.ref) ? 'no-capture' : 'no-referrer' }, headers);
      if (isSelf(owner, capture.referrer)) return json(200, { credited: 0, reason: 'self' }, headers);
      const [revoked, back] = (await Promise.all([db.call(`referral_revocations?referrer=eq.${enc(capture.referrer)}&select=referrer`), db.call(`referral_bindings?trader=eq.${enc(capture.referrer)}&select=trader,referrer`)])) as [unknown[], { trader: string; referrer: string }[]];
      if (revoked.length > 0) return json(200, { credited: 0, reason: 'revoked' }, headers);
      if (isMutual(owner, capture.referrer, back)) return json(200, { credited: 0, reason: 'mutual' }, headers);
      const row = { trader: owner, referrer: capture.referrer, bound_at: capture.at, expires_at: capture.at + windowMs() };
      // Two tabs can race here; the table's primary key keeps the first and the loser reads it back.
      await db.call('referral_bindings?on_conflict=trader', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) });
      binding = ((await db.call(`referral_bindings?trader=eq.${q}&select=trader,referrer,bound_at,expires_at`)) as BindingRow[])[0] ?? null;
      if (!binding) return json(502, { error: 'database' }, headers);
    }
    const bound = Number(binding.bound_at);
    if (input.now >= Number(binding.expires_at)) return json(200, { credited: 0, reason: 'window-ended' }, headers);
    if (isSelf(owner, binding.referrer)) return json(200, { credited: 0, reason: 'self' }, headers);
    const revokedNow = (await db.call(`referral_revocations?referrer=eq.${enc(binding.referrer)}&select=referrer`)) as unknown[];
    if (revokedNow.length > 0) return json(200, { credited: 0, reason: 'revoked' }, headers);
    const referrerFamily: Family = binding.referrer.startsWith('solana:') ? 'solana' : 'evm';

    // Past the daily row limit nothing more is stored for this trader, credited or not.
    let stored = ((await db.call(`referral_credits?trader=eq.${q}&created_at=gte.${input.now - DAY_MS}&select=tx&order=created_at.desc&limit=${REFERRAL_CONFIG.dailyRowsPerTrader}`)) as unknown[]).length;

    const results: { tx: string; result: string }[] = [];
    let credited = 0;
    const cols = 'select=chain,tx,asset,trader,referrer,fee_raw,share_raw,status,tx_at,created_at';
    for (const tx of txs) {
      if (stored >= REFERRAL_CONFIG.dailyRowsPerTrader) {
        results.push({ tx, result: 'daily-limit' });
        continue;
      }
      const verified = await verifyFee({ chain, tx, trader, env: input.env, fetchImpl: input.fetchImpl });
      if (!verified.ok) {
        results.push({ tx, result: verified.reason });
        continue;
      }
      const maxAge = REFERRAL_CONFIG.maxTxAgeHours * 3_600_000;
      if (input.now - verified.at > maxAge || verified.at > input.now + 5 * 60_000) {
        results.push({ tx, result: 'out-of-time' });
        continue;
      }
      // Block times are whole seconds; a swap in the same second as the visit still counts.
      if (verified.at < Math.floor(bound / 1000) * 1000) {
        results.push({ tx, result: 'before-binding' });
        continue;
      }
      const swapTx = canonicalTx(chain, body.swapTx);
      for (const p of verified.payments) {
        if (stored >= REFERRAL_CONFIG.dailyRowsPerTrader) {
          results.push({ tx, result: 'daily-limit' });
          break;
        }
        // The caps and the burst rule read exactly the rows they count, newest first and no more than they need, so a full page of
        // unrelated rows can never hide an earlier credit.
        const day = `tx_at=gte.${verified.at - DAY_MS + 1}&tx_at=lte.${verified.at + 60_000}`;
        const wash = `tx_at=gte.${verified.at - REFERRAL_CONFIG.washWindowMinutes * 60_000 + 1}&tx_at=lte.${verified.at + 60_000}`;
        const [byReferrer, byTrader, burst] = (await Promise.all([
          db.call(`referral_credits?referrer=eq.${enc(binding.referrer)}&status=eq.credited&${day}&${cols}&order=tx_at.desc&limit=${REFERRAL_CONFIG.dailyCapPerReferrer}`),
          db.call(`referral_credits?trader=eq.${q}&status=eq.credited&${day}&${cols}&order=tx_at.desc&limit=${REFERRAL_CONFIG.dailyCapPerTrader}`),
          db.call(`referral_credits?trader=eq.${q}&asset=eq.${enc(p.asset)}&fee_raw=eq.${p.amount.toString()}&${wash}&${cols}&order=tx_at.desc&limit=${REFERRAL_CONFIG.washRepeat}`),
        ])) as [CreditDb[], CreditDb[], CreditDb[]];
        const seen = new Map<string, CreditDb>();
        for (const r of [...byReferrer, ...byTrader, ...burst]) seen.set(`${r.chain}|${r.tx}|${r.asset}`, r);
        const decision = decideCredit({ referrer: binding.referrer, trader: owner, asset: p.asset, feeRaw: p.amount, at: verified.at, chainFamily: familyOf(chain), referrerFamily }, [...seen.values()].map(toPrior));
        const row = { chain, tx, asset: p.asset, trader: owner, referrer: binding.referrer, swap_tx: swapTx, fee_raw: p.amount.toString(), share_raw: decision.shareRaw.toString(), status: decision.status, tx_at: verified.at, created_at: input.now };
        const inserted = (await db.call('referral_credits?on_conflict=chain,tx,asset', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(row) })) as unknown[] | null;
        const isNew = Array.isArray(inserted) && inserted.length > 0;
        if (isNew) stored += 1;
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
