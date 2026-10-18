/* global process */
// The owner's private referral export. READ-ONLY and LOCAL: it reads the referral tables with the database service key, which only the
// owner's machine has, prints what is owed to each referrer by network and coin, and sends nothing anywhere. It pays nobody: the owner
// pays by hand from this list. The key is read from the environment and never printed or written.
//
//   $env:SUPABASE_URL = "https://<project>.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY = "<service key>"
//   node scripts/referral-export.mjs                 the list, as text
//   node scripts/referral-export.mjs --csv           the same as CSV (to a file: redirect with > owed.csv)
//
// After paying a referrer, mark their rows paid in the Supabase SQL editor so they drop off the list (replace the address and the time):
//   update public.referral_credits set paid_at = <ms since 1970> where referrer = 'evm:0x...' and chain = 'ethereum' and paid_at is null and status = 'credited';
// To switch a referrer off after abuse:
//   insert into public.referral_revocations (referrer, reason, revoked_at) values ('evm:0x...', 'why', <ms since 1970>);
import { owedByReferrer, renderCsv, renderExport } from './referralExportCore.mjs';

const base = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base) || !key) {
  console.error('Set SUPABASE_URL (https://<project>.supabase.co) and SUPABASE_SERVICE_ROLE_KEY in this terminal first. Nothing was read.');
  process.exit(2);
}

async function table(path) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${base}/rest/v1/${path}`, { headers: { apikey: key, authorization: `Bearer ${key}`, range: `${from}-${from + 999}`, 'range-unit': 'items' } });
    if (!res.ok) throw new Error(`The database answered ${res.status} for ${path.split('?')[0]}. Has migration 0011 been applied?`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

try {
  const [credits, revoked] = await Promise.all([table('referral_credits?select=chain,asset,referrer,fee_raw,share_raw,status,paid_at&order=created_at.asc'), table('referral_revocations?select=referrer')]);
  const groups = owedByReferrer(credits, revoked.map((r) => r.referrer));
  process.stdout.write(process.argv.includes('--csv') ? renderCsv(groups) : renderExport(groups) + '\n');
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e).split(key).join('[key]'));
  process.exitCode = 1;
}
