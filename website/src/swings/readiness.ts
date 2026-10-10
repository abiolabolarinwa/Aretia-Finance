/**
 * Production readiness, as a checklist that can be run. Each gate is either something the code can verify (read from
 * the live status endpoint) or something only a person can attest to (a real-money test, an audit). A manual gate is
 * "not done" unless the attestation file says otherwise with a date, so nothing is ever ready by default.
 *
 * Two levels:
 *  - `canary`: safe to let a named first group use it with small amounts;
 *  - `public`: safe to open to everyone. It needs everything `canary` needs, plus the evidence that only real use and
 *    review can give.
 */
export interface StatusFacts {
  evmChains: string[];
  canaryActive: boolean;
  aggregatorsOn: boolean;
  protectedSubmit: boolean;
  reachable: boolean;
}

export interface Attestation {
  done: boolean;
  /** ISO date the thing was done. Required when `done`. */
  date?: string;
  note?: string;
}

export type Attestations = Record<string, Attestation | undefined>;

export type GateState = 'pass' | 'fail' | 'unknown';
export interface Gate {
  id: string;
  area: string;
  level: 'canary' | 'public';
  title: string;
  state: GateState;
  evidence: string;
}

export interface Readiness {
  gates: Gate[];
  canary: { ready: boolean; blockers: Gate[] };
  public: { ready: boolean; blockers: Gate[] };
}

const MANUAL: { id: string; area: string; level: 'canary' | 'public'; title: string }[] = [
  { id: 'real-swap-solana', area: 'Swaps', level: 'canary', title: 'A real swap on Solana, signed and confirmed with a small amount' },
  { id: 'real-swap-evm', area: 'Swaps', level: 'canary', title: 'A real swap on one EVM network, signed and confirmed with a small amount' },
  { id: 'real-cctp-move', area: 'Settlement', level: 'canary', title: 'A real USDC move between two EVM networks through CCTP, burn to claim, with a small amount' },
  { id: 'real-cctp-solana', area: 'Settlement', level: 'canary', title: 'A real USDC move from Solana to an EVM network and back through CCTP, with a small amount' },
  { id: 'moonpay-sandbox-buy', area: 'Ramps', level: 'canary', title: 'A MoonPay sandbox purchase delivered to a test wallet' },
  { id: 'aretia-fee-evm', area: 'Fees', level: 'canary', title: 'The EVM fee address is set (PUBLIC_ARETIA_EVM_FEE_ADDRESS) and a small EVM swap showed the 0.29% fee arriving there' },
  { id: 'aretia-fee-solana', area: 'Fees', level: 'canary', title: 'A small Solana swap showed the 0.29% fee arriving at the fee wallet (in SOL, and in USDC when selling USDC)' },
  { id: 'db-migrations', area: 'Data', level: 'canary', title: 'Database migrations applied to the production database' },
  { id: 'moonpay-sandbox-sell', area: 'Ramps', level: 'public', title: 'MoonPay sell checked in the sandbox before selling is switched on' },
  { id: 'real-cctp-fast', area: 'Settlement', level: 'public', title: 'A real fast-transfer CCTP move' },
  { id: 'external-audit', area: 'Security', level: 'public', title: 'An independent review of the wallet, settlement, orchestrator and ramp code' },
  { id: 'csp', area: 'Security', level: 'public', title: 'A content security policy and subresource integrity on the wallet page' },
  { id: 'incident-plan', area: 'Operations', level: 'public', title: 'A named person and a written plan for an incident, including how to switch everything off' },
];

export function evaluate(status: StatusFacts, attestations: Attestations): Readiness {
  const gates: Gate[] = [];
  const auto = (id: string, area: string, level: 'canary' | 'public', title: string, ok: boolean | null, evidence: string): void => {
    gates.push({ id, area, level, title, state: ok === null ? 'unknown' : ok ? 'pass' : 'fail', evidence });
  };
  const reach = status.reachable ? true : null;
  auto('status-reachable', 'Operations', 'canary', 'The live status endpoint answers', status.reachable, status.reachable ? 'Answered.' : 'It could not be reached, so nothing below can be confirmed.');
  auto('canary-list', 'Rollout', 'canary', 'Only a named first group can sign (staged rollout list is set)', reach === null ? null : status.canaryActive, status.canaryActive ? 'A staged-rollout list is active.' : 'No staged-rollout list: everyone could sign.');
  auto('evm-narrowed', 'Rollout', 'canary', 'EVM networks are narrowed to the ones that have been proven', reach === null ? null : status.evmChains.length <= 2, `Enabled: ${status.evmChains.join(', ') || 'none'}.`);
  for (const m of MANUAL) {
    const a = attestations[m.id];
    const ok = a?.done === true && typeof a.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date);
    gates.push({ id: m.id, area: m.area, level: m.level, title: m.title, state: ok ? 'pass' : a?.done ? 'unknown' : 'fail', evidence: ok ? `Done ${a!.date}${a!.note ? ': ' + a!.note : ''}.` : a?.done ? 'Marked done but with no valid date, so not accepted.' : 'Not done.' });
  }
  const blockers = (lvls: ('canary' | 'public')[]): Gate[] => gates.filter((g) => lvls.includes(g.level) && g.state !== 'pass');
  const canary = blockers(['canary']);
  const pub = blockers(['canary', 'public']);
  return { gates, canary: { ready: canary.length === 0, blockers: canary }, public: { ready: pub.length === 0, blockers: pub } };
}

export function render(r: Readiness): string {
  const mark: Record<GateState, string> = { pass: 'PASS   ', fail: 'FAIL   ', unknown: 'UNKNOWN' };
  const lines = r.gates.map((g) => `${mark[g.state]} [${g.level}] ${g.area}: ${g.title}\n        ${g.evidence}`);
  return [`${lines.join('\n')}`, '', `Ready for a named first group: ${r.canary.ready ? 'YES' : `NO (${r.canary.blockers.length} gate${r.canary.blockers.length === 1 ? '' : 's'} open)`}`, `Ready for the public:        ${r.public.ready ? 'YES' : `NO (${r.public.blockers.length} gate${r.public.blockers.length === 1 ? '' : 's'} open)`}`].join('\n');
}
