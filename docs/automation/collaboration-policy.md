# Claude and Codex collaboration policy

This document is the canonical maker/reviewer policy for Directory Engine.
Surface-specific files such as `AGENTS.md` and `CLAUDE.md` may add role guidance
but must not weaken this policy.

## Source of truth

GitHub is the shared task queue, project memory, implementation record, review
surface, and evidence ledger. Chat transcripts are context, not durable project
state or execution authority.

Every material task requires one GitHub work packet. The issue body must identify
the objective, accepted baseline, allowed changes, prohibited changes, required
checks, required evidence, authorization class, and acceptance criteria.

## Roles

- **Owner:** makes business decisions and approves operations outside standing
  authority.
- **Codex:** architecture custodian and independent reviewer.
- **Claude:** primary implementer for approved work packets.
- **CI:** deterministic verifier and scope gate.

The implementer must not be the final reviewer of its own material change.

## Change lanes

1. `code_only`: documentation, schemas, tests, Worker code, theme/plugin source,
   and validators. No live mutation.
2. `staging`: reversible changes to an explicitly identified staging site with
   before-and-after evidence.
3. `production_reversible`: narrow, pre-approved production changes with backup,
   preflight, receipts, and read-back verification.
4. `high_risk`: DNS, secrets, D1 migrations, production deployment with new write
   capability, destructive operations, payment/claim authority, or mass
   indexation. Explicit owner approval is required.

Authorization for one lane does not imply authorization for another.

## State machine

```text
draft -> ready_for_implementation -> implementing -> ready_for_review
      -> changes_requested -> implementing
      -> accepted -> merge_ready -> completed
```

`blocked` may be entered from any active state. A blocked packet records the
specific missing decision, permission, identity, evidence, or dependency.

## Branch and pull-request rules

- One active implementer owns a work-packet branch.
- Branches use `<agent>/<packet-id>-<short-description>`.
- A pull request identifies the work-packet issue and exact accepted baseline.
- Unrelated cleanup is prohibited.
- Reviews apply to an exact commit SHA.
- New commits invalidate prior acceptance until delta review completes.
- Deployments must use the exact reviewed commit or a separately verified
  descendant containing no unreviewed material changes.

## Automated handoff

The intended automated sequence is:

1. A `ready-for-claude` work packet triggers Claude implementation.
2. Claude opens or updates a pull request and supplies evidence.
3. CI completes deterministic checks.
4. A `ready-for-codex-review` pull request triggers Codex review.
5. Findings add `claude-remediation-required` and return to the same branch.
6. Claude remediation triggers CI and Codex delta review.
7. A clean result adds `accepted` and advances only within the packet's
   authorization class.

Automation must use concurrency locks, exact labels, explicit bot allowlists,
workflow timeouts, bounded turns, and a maximum of three remediation cycles.
Generic bot comments must not trigger another agent.

## Merge policy

Auto-merge is disabled during the foundation phase. It may be enabled by a later
reviewed work packet only after a harmless end-to-end fixture proves dispatch,
implementation, CI, review, remediation, delta review, and exact-head acceptance.

Even after that proof, only explicitly authorized `code_only` packets may
auto-merge. Staging, production, deployment, database, DNS, secret, destructive,
payment, claim-authority, and mass-indexation operations retain their specified
approval gates.

## Evidence

Evidence must be reproducible and must not contain secrets. A material change
records, as applicable:

- exact baseline and head SHAs;
- changed-file list;
- commands and results;
- expected and actual behavior;
- before-and-after snapshots;
- target site or resource identity;
- deployment identity and receipt;
- rollback or stopped-partial status.

Claims such as "deployed", "live", "unchanged", or "all tests pass" require
corresponding evidence.

## Escalation

Escalate to the owner only for a missing business decision, unavailable required
permission or credential, security/privacy issue, destructive or high-risk
operation, material agent disagreement, repeated remediation failure, or a
production gate outside standing authority.
