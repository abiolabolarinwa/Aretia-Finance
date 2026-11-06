// Calls the site's scheduled endpoints on time. This replaces pg_cron + pg_net (see server/README.md for why).
//   alerts    every minute      GET {SITE_URL}/api/swings-alerts-run   (Bearer CRON_SECRET)
//   launchbox every 5 minutes   GET {SITE_URL}/api/launchbox-run       (Bearer CRON_SECRET)
//   mi        every minute      GET {SITE_URL}/api/mi-run              (Bearer MI_CRON_SECRET, else CRON_SECRET); only until the worker runs
// No dependencies. A failure is logged once per kind per change of state, not every minute. Secrets are never printed.
const SITE = (process.env.SITE_URL || 'https://aretiafinance.org').replace(/\/+$/, '');
const jobs = {
  alerts: { path: '/api/swings-alerts-run', everyMs: 60_000, secret: process.env.CRON_SECRET },
  launchbox: { path: '/api/launchbox-run', everyMs: 300_000, secret: process.env.CRON_SECRET },
  mi: { path: '/api/mi-run', everyMs: 60_000, secret: process.env.MI_CRON_SECRET || process.env.CRON_SECRET },
};
const wanted = (process.env.SCHEDULER_JOBS || 'alerts,launchbox').split(/[\s,;]+/).filter((n) => n in jobs);
const ping = process.env.PING_URL || '';
const state = new Map();
let stopping = false;

async function run(name) {
  const j = jobs[name];
  if (!j.secret) {
    if (state.get(name) !== 'nosecret') console.error(`[scheduler] ${name}: no secret set, skipped`);
    state.set(name, 'nosecret');
    return;
  }
  let status = 'ok';
  try {
    const res = await fetch(SITE + j.path, { headers: { authorization: `Bearer ${j.secret}` }, signal: AbortSignal.timeout(58_000) });
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) status = `http-${res.status}`;
  } catch (e) {
    status = e && e.name === 'TimeoutError' ? 'timeout' : 'network';
  }
  if (state.get(name) !== status) console.log(`[scheduler] ${name}: ${status}`);
  state.set(name, status);
  if (status === 'ok' && name === 'alerts' && ping) fetch(ping, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}

for (const name of wanted) {
  const loop = async () => {
    if (stopping) return;
    const t0 = Date.now();
    await run(name);
    setTimeout(loop, Math.max(1_000, jobs[name].everyMs - (Date.now() - t0))).unref?.();
  };
  // Stagger the first calls so they do not all fire together.
  setTimeout(loop, 2_000 + wanted.indexOf(name) * 7_000);
}
console.log(`[scheduler] started: ${wanted.join(', ') || 'nothing to do'} -> ${SITE}`);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; process.exit(0); });
setInterval(() => undefined, 1 << 30); // keep the process alive between timers
