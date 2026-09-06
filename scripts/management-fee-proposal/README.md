# Treasury Multisig Proposal Scripts

This folder holds three kinds of scripts against the live ACT mint and its treasury Squads multisig:

- **Read-only checks** (`check-metadata.mjs`, `check-fee-authority.mjs`, `verify-proposal.mjs`) — query mainnet, print findings, never send a transaction.
- **Proposal drafters** (`propose-harvest.mjs`, `propose-fee-change.mjs`) — build a real Squads proposal, but never execute it. Each requires a real signer to open Squads and approve (2 of 3) before anything actually moves or changes, exactly like any other treasury transaction.
- **A local-only key helper** (`convert-phantom-key.mjs`) — converts a Phantom-exported key into the JSON format the proposal scripts need. Never sends anything over the network.

**All of this was written from verified on-chain data and verified SDK source, but treat first runs as a code review, not a trusted tool — dry-run repeatedly, read the output carefully, and check the proposal's actual instructions in the Squads UI before approving, the same as you would for a proposal from anyone else.**

## Setup

```bash
cd aretia-finance/scripts/management-fee-proposal
npm install
```

## `propose-harvest.mjs` — harvest withheld fees, send the management-fee share

Drafts a proposal that harvests withheld ACT transfer fees and sends the management-fee share (0.5% of the total transfer fee, raised from 0.1% on 6 Sept 2026 — see `MANAGEMENT_FEE.md`) to the [dedicated management-fee wallet](../../MANAGEMENT_FEE.md). See its own header comment for the full mechanism.

**Dry run (default, safe, sends nothing):**

```bash
node propose-harvest.mjs
```

Prints total withheld fees, the computed management-fee share, and which accounts it would harvest from, then stops. If there's nothing withheld yet (no trading has happened), it says so and exits — expected until liquidity is seeded.

**Actually submit the proposal:**

```bash
PROPOSER_KEYPAIR_PATH=/path/to/your/keypair.json node propose-harvest.mjs --execute
```

### Scheduling it (optional)

Automates the *proposal* only, never the approval — two co-signers still review and execute in Squads every time.

**Windows Task Scheduler**, running weekly:

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "propose-harvest.mjs --execute" -WorkingDirectory "C:\path\to\aretia-finance\scripts\management-fee-proposal"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
Register-ScheduledTask -TaskName "Aretia Management Fee Proposal" -Action $action -Trigger $trigger
```

Set `PROPOSER_KEYPAIR_PATH` as a system/user environment variable first, since the scheduled task won't inherit an ad-hoc shell variable.

## `propose-fee-change.mjs` — change the mint's transfer-fee rate

Drafts a proposal containing a single `SetTransferFee` instruction, moving the mint's transfer fee from whatever it currently is to the rate hardcoded in the script (`NEW_BPS`, currently 350 = 3.5%, matching `TOKENOMICS.md` §01's 6 Sept 2026 update — burn removed, management raised to 0.5%). See its own header comment for the full mechanism, including what actually happens on-chain (the new rate is scheduled for a future epoch, never applied retroactively).

**Dry run (default, safe, sends nothing):**

```bash
node propose-fee-change.mjs
```

Reads the live rate, compares it to the target, prints the instruction it would build, and stops. Refuses to build anything if the live rate already matches the target, or if `transfer_fee_config_authority` isn't the treasury vault this script expects (a safety check against acting on a stale assumption).

**Actually submit the proposal:**

```bash
PROPOSER_KEYPAIR_PATH=/path/to/your/keypair.json node propose-fee-change.mjs --execute
```

**After submitting, verify what actually got proposed before approving it in Squads:**

```bash
node verify-proposal.mjs <transactionIndex>
```

(The transaction index is printed by `propose-fee-change.mjs --execute` as "Next Squads transaction index".) This fetches the real on-chain vault-transaction account and decodes the instruction inside it directly — program ID, accounts, and the raw `SetTransferFee` bytes — rather than trusting what any proposal script printed about what it submitted. Confirm it shows exactly one instruction, targeting the ACT mint, with the basis-points value you expect.

**After it's approved and executed in Squads**, update `MINT.md`'s "live" row and remove the "not yet executed" framing there and in `TOKENOMICS.md`/`PROTOCOL.md`. `website/verify.html` needs no code change — it already checks live state and will simply stop reporting a mismatch once the new rate takes effect.

## Common to all of these

`PROPOSER_KEYPAIR_PATH` must point to a Solana CLI-style JSON keypair file for a wallet that's already a member of the Aretia Treasury multisig (e.g. the founder's, `4DoV9FEZfTokhhPQvZNCFQCom5KUrrcTbdtX3ctWhjdG`). That key only ever signs the "here's a proposal" transaction — it cannot move funds or change the fee by itself, with or without these scripts. Keep it secured like any other wallet key: while it can't act unilaterally, it's still your identity as a multisig member, and losing control of it could let someone submit misleading proposals in your name (which your co-signers would still have to approve, but don't make their job harder than it needs to be).

## What none of these scripts do

- Change any authority on the ACT mint. Every authority (mint, freeze, transfer-fee-config, withdraw-withheld) stays exactly where it is throughout.
- Execute anything themselves. Only a 2-of-3 Squads approval moves funds or changes the fee.
- Run themselves. You choose when to run them, and whether to schedule `propose-harvest.mjs`.
