# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private reporting: the repository's **Security → Report a vulnerability** tab.

> OWNER ACTION REQUIRED: confirm private vulnerability reporting is enabled in the repository settings and, if you want an email channel, add a monitored security address here. This file deliberately does not invent a contact.

Please include: affected component and commit, reproduction steps or proof of concept, impact, and any suggested fix. Do not include real private keys, seed phrases or secrets in a report.

## Scope

In scope: `program/` (Anchor programs), `sdk/`, `website/api/`, `website/src/swings/`, `website/supabase/`, operator tooling in `mainnet/`, `devnet/`, `scripts/`, and CI workflows.
Out of scope: third-party contracts/services (Jupiter, 0x, DEX programs, Squads, Supabase, Vercel, RPC providers), social engineering, volumetric DoS.

## Status of assurance (read before relying on this code)

No external security audit of the on-chain programs is referenced in this repository. `docs/audit/` records internal engineering review only and states per item whether evidence exists. Passing CI is not an audit.

## If a secret may have leaked

Treat it as compromised: revoke and rotate first (see `docs/security/OPERATOR_RUNBOOK.md`), then clean up. Deleting the file or rewriting history does not un-leak a secret.
