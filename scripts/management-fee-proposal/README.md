# Management Fee Harvest — Proposal Script

Drafts a Squads proposal that harvests withheld ACT transfer fees and sends the 0.1% management-fee share to the [dedicated management-fee wallet](../../MANAGEMENT_FEE.md). It never moves funds on its own — it only prepares a proposal that a real signer still has to open in Squads and approve (2 of 3), exactly like any other treasury transaction. See `propose-harvest.mjs`'s header comment for the full mechanism.

**This was written from verified on-chain data and verified SDK source, but could not be run end-to-end in the environment it was written in (no outbound network access there). Treat the first several runs as a code review, not a trusted tool — dry-run repeatedly, read the output carefully, and check the proposal's actual instructions in the Squads UI before approving, the same as you would for a proposal from anyone else.**

## Setup

```bash
cd aretia-climate-coin/scripts/management-fee-proposal
npm install
```

## Running

**Dry run (default, safe, sends nothing):**

```bash
node propose-harvest.mjs
```

Prints what it found — total withheld fees, the computed management-fee share, which accounts it would harvest from — and stops. Run this on its own, repeatedly, until the numbers look right. If there's nothing withheld yet (no trading has happened), it says so and exits — this is the expected state until liquidity is seeded.

**Actually submit the proposal:**

```bash
PROPOSER_KEYPAIR_PATH=/path/to/your/keypair.json node propose-harvest.mjs --execute
```

`PROPOSER_KEYPAIR_PATH` must point to a Solana CLI-style JSON keypair file for a wallet that's already a member of the Aretia Treasury multisig (e.g. the founder's, `4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG`). That key only ever signs the "here's a proposal" transaction — it cannot move treasury or management-fee funds by itself, with or without this script. After it runs, go approve (or reject) the proposal in the Squads app, same as any other transaction.

## Scheduling it (optional)

This is meant to be run on a schedule so nobody has to remember to do the math by hand — but scheduling only automates the *proposal*, not the approval. Two co-signers still need to review and execute it in Squads every time.

**Windows Task Scheduler**, running weekly:

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "propose-harvest.mjs --execute" -WorkingDirectory "C:\path\to\aretia-climate-coin\scripts\management-fee-proposal"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
Register-ScheduledTask -TaskName "Aretia Management Fee Proposal" -Action $action -Trigger $trigger
```

Set `PROPOSER_KEYPAIR_PATH` as a system/user environment variable first, since the scheduled task won't inherit an ad-hoc shell variable. Keep that keypair file secured like any other wallet key — while it can't move fee funds, it's still your identity as a multisig member, and losing control of it could let someone submit misleading proposals in your name (which your co-signers would still have to approve, but don't make their job harder than it needs to be).

## What it does NOT do

- It does not change any authority on the ACT mint. Withdraw-withheld authority stays on the treasury multisig throughout.
- It does not execute the harvest or the transfer. Only a 2-of-3 Squads approval does that.
- It does not run itself the first time you set it up — you choose when to schedule it, if at all.
