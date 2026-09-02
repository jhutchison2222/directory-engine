# DE-0010: repository-native autonomy supervisor

This document describes the bounded, code-only autonomy supervisor authorized
by DE-0010. It supplements, and does not weaken,
[`collaboration-policy.md`](collaboration-policy.md).

## Purpose

The supervisor is a scheduled and manually-dispatchable GitHub Actions
workflow that watches supervised pull requests and queued issues, and wakes
the dedicated ChatGPT Workspace Agent when there is exact-head evidence that
it should act. It never merges, deploys, or mutates repository content
itself.

## Scope

- Supervises every open, non-draft pull request in this repository.
- Supervises only open issues explicitly labeled `autonomy-ready`; every
  other issue is left untouched regardless of any other state.
- Never acts on a subject labeled `security-hold` or `major-decision-required`
  - it reports the hold and stops, requiring a human decision.
- Never merges directly. Only the Workspace Agent, re-reading fresh evidence
  under the owner's standing code-only authorization, may merge - with
  expected-head protection and a merge commit.

## Workflow permissions

`.github/workflows/autonomy-supervisor.yml` requests exactly:

- `actions: read` - to observe CI state.
- `checks: read` - to read exact-head check-run conclusions.
- `contents: read` - to check out the repository (no write path).
- `issues: write` - to post dispatch-bookkeeping comments on issues.
- `pull-requests: write` - to post dispatch-bookkeeping comments on pull
  requests.

It does not request `contents: write`, any deployment, environment, packages,
administration, or security-events permission, and it never uses one it was
not granted.

## Decision model

All decision logic lives in pure, dependency-injected, fully-tested modules
under `scripts/lib/`:

- `supervisor-policy.mjs` - exact-head/exact-state evaluation for pull
  requests and issues, hold labels, retry timing, and queued-task selection.
- `supervisor-idempotency.mjs` - deterministic idempotency keys and the
  hidden HTML-comment dispatch marker used as the duplicate-suppression
  ledger (the workflow has no `contents: write`, so it cannot persist a
  ledger file; it reads its own prior marker comments instead).
- `supervisor-dispatch.mjs` - the fixed Workspace Agent trigger request,
  agent-id validation, and fail-closed credential handling.
- `supervisor-run.mjs` - the orchestrator tying the above together with
  per-item failure isolation and active-pull-request precedence.

`scripts/run-autonomy-supervisor.mjs` is the thin, intentionally simple
GitHub REST wiring the workflow invokes; it contains no decision logic and is
not itself unit tested, only its pure dependencies are.

### Exact-head/exact-state evidence only

A pull request's checks and review are only trusted when they are recorded
against its **current** head SHA. Evidence recorded against an older head is
treated as absent, which is what forces a fresh evaluation after every new
commit (stale-evidence invalidation). Queued issues have no git head, so an
equivalent content fingerprint (labels, title, body) plays the same role.

### Independent review only

Any reviewer login matching `claude` (case-insensitively) is excluded before
a review is ever considered as evidence. Claude's own review of its own
implementation can never satisfy independent exact-head acceptance.

### Idempotency and retry timing

Each dispatch reason is keyed by `subjectType:subjectNumber:stateId:reason`.
The supervisor never dispatches the same key twice within the retry interval
(30 minutes), and a change in `stateId` (new head SHA, or new issue content)
always produces a new key regardless of any prior dispatch history at the old
state.

### Active-pull-request precedence

As long as any non-draft pull request is open, queued `autonomy-ready` issues
are left untouched for that cycle, even if that pull request needs no
dispatch on this specific tick. Queued work only starts once the non-draft
pull-request pipeline is completely empty, keeping autonomous attention
bounded and sequential.

### Per-item failure isolation

Every subject is evaluated inside its own try/catch. One subject's API or
dispatch failure is recorded and reported; it never prevents evaluation of
the remaining subjects in the same cycle.

## Credential handling

- The workflow reads only `vars.CHATGPT_WORKSPACE_AGENT_ID` and
  `secrets.CHATGPT_WORKSPACE_AGENT_TOKEN`, by name, and fails closed
  (`requireEnv`) if either is missing or empty.
- `validateAgentId` rejects a malformed agent id before any network call.
- The token is used only to build the `Authorization` header of the fixed
  trigger request. It is never included in a dispatch marker, a log line, a
  thrown error message, or any other evidence artifact.
- The trigger endpoint is a hardcoded module constant in
  `supervisor-dispatch.mjs`, never read from a repository variable, secret,
  issue/PR body, label, or any other repository content, so it cannot be
  redirected or derived from untrusted repository content. Redirect
  responses (3xx) from that endpoint are never followed; they fail closed.

### Open item: the trigger endpoint value

`WORKSPACE_AGENT_TRIGGER_ENDPOINT` in `scripts/lib/supervisor-dispatch.mjs`
is currently an RFC 2606 `.invalid` placeholder. This work packet's available
tool access could not independently confirm the literal fixed endpoint
issue #25 authorizes, and this repository's policy is to never assert or
guess a live external system fact. The placeholder cannot resolve, so a
misconfigured deployment fails closed rather than calling an unverified host.
Codex/owner review must confirm and, if needed, replace this constant with
the verified literal endpoint before any live dispatch is authorized.

## Harmless proof

`test/de-0010-autonomy-supervisor-harmless-proof.test.mjs` exercises the full
cycle - scheduled and manual evaluation, one Workspace Agent wake-up, fresh
exact-head re-read after a new commit, active-pull-request precedence over a
queued task, per-item failure isolation, and duplicate suppression - entirely
in memory, with a fake GitHub store and a call-counting fake Workspace Agent
dispatcher. It performs no network access and touches no live system or
credential.
