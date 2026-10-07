/**
 * POST /api/swings-submit: forwards a user-SIGNED Solana swap to Jito for protected (private) sending.
 *
 * It holds no key and cannot change the transaction: any change would break the user's signature. Before it
 * forwards anything it checks that the transaction is signed, small enough, and carries a tip to one of Jito's own
 * tip accounts paid by the signer and within the cap, so it cannot be used as a free relay or to move other funds.
 * Off unless SWINGS_PROTECTED_SUBMIT is "on". The transaction is never stored or logged.
 */
import { isOriginAllowed, overLimit, type ProxyEnv } from './_rpcProxy.js';
import { findTip, JITO_SEND_URL, MAX_TIP_LAMPORTS, MIN_TIP_LAMPORTS } from '../src/swings/solana/jito.js';

export interface SubmitEnv extends ProxyEnv {
  SWINGS_PROTECTED_SUBMIT?: string;
}

export interface SubmitInput {
  method: string;
  origin: string | null;
  ip: string;
  contentType: string | null;
  body: string;
  env: SubmitEnv;
  fetchImpl: typeof fetch;
  now: number;
}

const MAX_BODY = 4 * 1024;
const MAX_TX_BYTES = 1232;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export async function handleSubmit(input: SubmitInput): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = { vary: 'origin', 'cache-control': 'no-store', 'content-type': 'application/json' };
  const allowed = isOriginAllowed(input.origin, input.env);
  if (allowed) {
    headers['access-control-allow-origin'] = input.origin!;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'content-type';
  }
  const reply = (status: number, error?: string, extra: Record<string, unknown> = {}) => ({ status, body: JSON.stringify(error ? { error } : extra), headers });
  if (input.method === 'OPTIONS') return { status: allowed ? 204 : 403, body: '', headers };
  if (input.method !== 'POST') return reply(405, 'method');
  if (!allowed) return reply(403, 'origin');
  if (input.env.SWINGS_PROTECTED_SUBMIT !== 'on') return reply(503, 'not-enabled');
  if (!(input.contentType ?? '').toLowerCase().includes('json')) return reply(415, 'content-type');
  if (new TextEncoder().encode(input.body).length > MAX_BODY) return reply(413, 'too-large');
  if (overLimit(`submit:${input.ip}`, input.now)) return reply(429, 'rate-limit');

  let b64: string;
  try {
    const parsed = JSON.parse(input.body) as { transaction?: unknown };
    if (typeof parsed.transaction !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.transaction)) return reply(400, 'shape');
    b64 = parsed.transaction;
  } catch {
    return reply(400, 'json');
  }
  const raw = Buffer.from(b64, 'base64');
  if (raw.length === 0 || raw.length > MAX_TX_BYTES) return reply(400, 'size');

  try {
    const web3 = await import('@solana/web3.js');
    const tx = web3.VersionedTransaction.deserialize(raw);
    // Signed by the fee payer.
    if (!tx.signatures[0] || tx.signatures[0].every((b) => b === 0)) return reply(400, 'unsigned');
    const tip = findTip(tx);
    if (!tip) return reply(400, 'no-tip');
    if (tip.from !== tx.message.staticAccountKeys[0]!.toBase58()) return reply(400, 'tip-payer');
    if (tip.lamports < BigInt(MIN_TIP_LAMPORTS) || tip.lamports > BigInt(MAX_TIP_LAMPORTS)) return reply(400, 'tip-range');
  } catch {
    return reply(400, 'transaction');
  }

  try {
    const res = await input.fetchImpl(JITO_SEND_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64' }] }) });
    if (!res.ok) return reply(502, 'relay');
    const out = (await res.json()) as { result?: unknown; error?: unknown };
    if (typeof out.result !== 'string' || !SIGNATURE.test(out.result)) return reply(502, 'relay');
    return reply(200, undefined, { signature: out.result });
  } catch {
    return reply(502, 'relay');
  }
}
