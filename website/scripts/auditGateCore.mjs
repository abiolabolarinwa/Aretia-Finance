/**
 * The dependency-advisory gate (audit ARETIA-SEC-008). Reads the JSON that `npm audit --omit=dev --json` prints and says which
 * high or critical advisories are not on the accepted list. An accepted advisory is named by its GHSA id with the reason in
 * `audit-allowlist.json`; anything new, or anything whose entry has no reason, fails the build.
 */

const BAD = new Set(['high', 'critical']);

/** The GHSA ids of every high or critical advisory in an npm audit report, with the package it was found on. */
export function highAdvisories(report) {
  const out = [];
  for (const [pkg, v] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || via === null || !BAD.has(via.severity)) continue;
      const id = String(via.url ?? '').split('/').pop() || String(via.source ?? 'unknown');
      out.push({ id, severity: via.severity, pkg, title: String(via.title ?? '') });
    }
  }
  return out;
}

/** Advisories that are not accepted, and accepted entries that lack a reason. `allow` is the parsed audit-allowlist.json. */
export function gateProblems(report, allow) {
  const accepted = new Map((allow?.accepted ?? []).map((a) => [a.id, a]));
  const problems = [];
  for (const a of highAdvisories(report)) {
    const entry = accepted.get(a.id);
    if (!entry) problems.push(`${a.id} (${a.severity}, ${a.pkg}): ${a.title} is not on the accepted list`);
    else if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) problems.push(`${a.id}: the accepted entry needs a reason of at least a sentence`);
  }
  return problems;
}
