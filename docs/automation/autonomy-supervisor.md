# DE-0010: repository-native autonomy supervisor

This document describes the bounded, code-only autonomy supervisor authorized
by DE-0010. It supplements, and does not weaken,
[`collaboration-policy.md`](collaboration-policy.md).

## Purpose

The supervisor is a scheduled, manually-dispatchable, and event-driven GitHub
Actions workflow that watches supervised pull requests and queued issues, and
wakes the dedicated ChatGPT Workspace Agent when there is exact-head evidence
that it should act. It never merges, deploys, or mutates repository content
itself.

## Scope

- Supervises every open, non-draft pull request in this repository.
- Supervises only open issues explicitly labeled `autonomy-ready`; every
  other issue is left untouched regardless of any other state.
- Never acts on a subject labeled `security-review` or `major-decision` -
  it reports the hold and stops, requiring a human decision.
- Never acts on a subject the supervisor itself has already labeled
  `autonomy-blocked` after exhausting the remediation-cycle attempt budget
  (`MAX_DISPATCH_ATTEMPTS_PER_KEY`, 3) for the same exact head (or, for
  issues, exact content) - a new head (or new content) is required before it
  will try again.
- Never merges directly. Only the Workspace Agent, re-reading fresh evidence
  under the owner's standing code-only authorization, may merge - with
  expected-head protection and a merge commit.

## Entry paths

- **Scheduled recovery backstop** - every five minutes (`*/5 * * * *`),
  unconditionally.
- **Manual dispatch** - `workflow_dispatch`, unconditionally.
- **Event-driven fast path** - native GitHub Actions webhook triggers for:
  - `pull_request`: `opened`, `reopened`, `synchronize`, `ready_for_review`,
    `converted_to_draft`, `closed`
  - `pull_request_review`: `submitted`, `edited`, `dismissed`
  - `issue_comment`: `created`, `edited`, limited to comments on pull
    requests or on `autonomy-ready`-labeled issues
  - `workflow_run`: `completed`, limited to the named governance/Claude
    workflows this supervisor actually depends on for evidence

  Every guarded event is checked by the pure `shouldHandleEvent` gate in
  `scripts/lib/supervisor-event-guard.mjs` before any credential is read or
  any dispatch is attempted: a missing or unreadable event payload fails
  closed immediately (only the schedule/manual paths may proceed without
  one), then repository match, actor (never a Claude-associated actor, and
  never a generic bot actor - preventing recursion against the supervisor's
  own comments/labels - unless the sender is on an explicit, injectable
  trusted-bot-login allowlist supplied from a fixed reviewed configuration
  or verified environment, never issue/PR content; `github-actions[bot]` can
  never be on that allowlist regardless of configuration), the event's own
  action filter, the comment-scope filter, and the workflow-name filter. All
  triggers - schedule, manual, and event-driven - share one non-overlapping
  concurrency group and compute the identical deterministic idempotency key
  for identical state, so no combination of them can duplicate a dispatch.

  This is an additive fast path only; the five-minute schedule remains the
  recovery backstop regardless of webhook delivery.

  No public webhook receiver, external relay, Cloudflare Worker, or new
  credential is introduced. Every trigger is a native GitHub Actions webhook
  event on this repository.

## Workflow permissions

`.github/workflows/autonomy-supervisor.yml` requests exactly:

- `actions: read` - to read exact-head governance evidence from the Actions
  workflow-runs API (`/actions/runs?head_sha=...`).
- `checks: read` - part of the already-reviewed least-privilege permission
  set; not currently used by the script (see the workflow-run vs. check-run
  note below), and retained rather than removed here since editing the
  workflow file's permissions is out of scope for a code/tests/docs-only
  remediation cycle.
- `contents: read` - to check out the repository (no write path).
- `issues: write` - to post dispatch-bookkeeping comments and apply
  `autonomy-blocked` on issues and pull requests (both are the Issues API).
- `pull-requests: write` - to post dispatch-bookkeeping comments on pull
  requests.

It does not request `contents: write`, any deployment, environment, packages,
administration, or security-events permission, and it never uses one it was
not granted. Because the job holds `secrets.CHATGPT_WORKSPACE_AGENT_TOKEN`,
every trigger - including event-driven ones carrying an untrusted pull
request's metadata - checks out only the repository's trusted default branch
(`ref: ${{ github.event.repository.default_branch }}`, with
`persist-credentials: false`), never a pull request head SHA or merge ref;
`test/autonomy-supervisor-workflow.test.mjs` inspects the committed workflow
file text directly to prove this.

## Decision model

All decision logic lives in pure, dependency-injected, fully-tested modules
under `scripts/lib/`:

- `supervisor-policy.mjs` - exact-head/exact-state evaluation for pull
  requests and issues, hold labels, the bounded remediation-cycle retry-
  attempt cap, retry timing, and queued-task selection (`selectQueuedTasks`
  surfaces the first eligible queued issue's decision - including `hold` and
  `blocked`, not only `dispatch` - so a held or retry-exhausted issue is
  visible and, once blocked, actually receives `autonomy-blocked` instead of
  being silently passed over).
- `supervisor-verdicts.mjs` - owner-only exact-head acceptance chronology:
  classifying owner-authored comments/reviews into ACCEPTED / REJECTED /
  SUPERSEDED / REMEDIATION_REQUESTED verdicts and resolving the
  chronologically latest one at an exact head (the PR #24 stale-verdict race
  guard).
- `supervisor-ci.mjs` - governance CI evidence: requires a completed,
  successful GitHub Actions **workflow run** literally named `Project
  governance` at the exact head; nothing else (an unrelated green check, a
  job-level check-run name such as this repository's own governance job
  `verify`, this repository's own pre-merge-inoperable `Autonomous
  supervisor` job, or a stale-head run) ever counts.
- `supervisor-idempotency.mjs` - deterministic idempotency keys, the hidden
  HTML-comment dispatch marker used as the duplicate-suppression ledger (the
  workflow has no `contents: write`, so it cannot persist a ledger file; it
  reads its own prior marker comments instead), and trusted-marker-author
  filtering.
- `supervisor-event-guard.mjs` - the pure gate deciding whether one
  event-driven webhook invocation should proceed to a full evaluation cycle,
  including the missing/unreadable-payload fail-closed check.
- `supervisor-dispatch.mjs` - the fixed Workspace Agent trigger request
  against the official API contract, agent-id validation, the bounded
  non-secret dispatch instruction, and fail-closed credential handling.
- `supervisor-run.mjs` - the orchestrator tying the above together with
  per-item failure isolation and active-pull-request precedence.

`scripts/run-autonomy-supervisor.mjs` is the thin, intentionally simple
GitHub REST wiring the workflow invokes; it contains no decision logic and is
not itself unit tested, only its pure dependencies are.

### Exact-head/exact-state evidence only

A pull request's checks and owner verdict are only trusted when they are
recorded against its **current** head SHA. Evidence recorded against an
older head is treated as absent, which is what forces a fresh evaluation
after every new commit (stale-evidence invalidation). Queued issues have no
git head, so an equivalent content fingerprint (labels, title, body) plays
the same role. A pending exact-head governance run - or the complete absence
of one yet - is always reported as `awaiting_ci`, never mistaken for an
"awaiting review" state.

### Owner-only exact-head acceptance chronology (the PR #24 stale-verdict race)

A prior version of this supervisor trusted a hardcoded allowlist of guessed
third-party reviewer logins (a dedicated Codex reviewer, the Workspace
Agent). This work packet's available tool access could never independently
confirm those literal logins, so the allowlist was a standing risk of either
failing closed forever or, if guessed wrong, accepting nobody's review as
authoritative. The only trusted acceptance identity is now the **repository
owner login**, supplied by the wiring layer from repository metadata (the
`owner` segment of the `GITHUB_REPOSITORY` environment variable GitHub
Actions always sets) - never guessed, hardcoded, or read from issue/PR
content.

`supervisor-verdicts.mjs` merges owner-authored pull-request conversation
comments with owner-authored formal PR reviews into a single chronological
verdict timeline (`buildOwnerVerdictEvents`). A conversation comment only
counts when it carries an explicit marker: `ACCEPTED — exact head <sha>`,
`REJECTED — exact head <sha>`, `SUPERSEDED ... exact head <sha>`, or a
remediation request tied to an exact head (recognizing the owner's own
real-world phrasing, e.g. "Remediate DE-0010 at exact head `<sha>`"). A
formal review counts via an explicit marker in its body, or - lacking one -
via its own native GitHub verdict (`APPROVED` -> accepted,
`CHANGES_REQUESTED` -> rejected); any other native review state
(`COMMENTED`, `DISMISSED`, `PENDING`) without an explicit marker is not
evidence and is silently ignored, so a non-actionable follow-up review can
never overwrite an earlier real verdict.

`selectLatestOwnerVerdict` picks the chronologically latest event (by
timestamp) among those recorded at the pull request's exact current head.
This means an earlier acceptance can never be treated as authoritative once
a later rejection, supersession, or remediation request exists at that same
exact head - exactly the race that occurred on PR #24, where an earlier
accepted verdict and a later rejection both existed for the same head. The
later evidence always wins and blocks `merge_ready` dispatch until a new
accepted head is produced.

### Bounded retries and the remediation-cycle attempt cap

Each dispatch reason is keyed by `subjectType:subjectNumber:stateId:reason`.
The supervisor never dispatches the same key twice within the retry interval
(30 minutes), and a change in `stateId` (new head SHA, or new issue content)
always produces a new key regardless of any prior dispatch history at the old
state. The remediation-cycle attempt budget
(`MAX_DISPATCH_ATTEMPTS_PER_KEY`, 3) is counted **across every equivalent
remediation reason** (`ci_failed`, `review_missing`, `review_rejected`)
combined for the same exact head, not separately per reason wording - a
subject that bounces between a failing check and a rejected review at the
same head still exhausts the budget after three dispatches total. Once
exhausted, the next evaluation blocks instead of retrying again and applies
the supervisor-owned `autonomy-blocked` label; from the next cycle onward
that label is itself treated as a hold, so the subject is reported and
skipped until a new exact-state key exists. `merge_ready` dispatch is
deliberately excluded from this shared cap: it is governed independently by
its own idempotency key and the same 30-minute retry interval only, so a
merge-ready subject is never blocked by remediation-cycle exhaustion.

A dispatch marker is posted for **every** attempted dispatch, not only a
successful one: a non-`202` response or a thrown error (e.g. the dispatch
endpoint refusing a redirect, or a network failure) is recorded with outcome
`failed` (see `DISPATCH_OUTCOMES` in `supervisor-idempotency.mjs`) and counts
toward both the 30-minute retry interval and the remediation attempt budget
exactly like a successful dispatch. A prior version only recorded a
successful dispatch, so a persistently failing endpoint was retried on every
five-minute tick forever, with no spacing and no cap.

For queued issues, `selectQueuedTasks` surfaces the first eligible issue's
decision even when it is `hold` or `blocked`, not only `dispatch` - a prior
version filtered to `dispatch` before the caller ever saw the result, so an
issue that had exhausted its attempt budget never reached the code path that
applies `autonomy-blocked`, unlike pull requests (which are always evaluated
and applied). Because at most one queued issue is surfaced per cycle, a
held or blocked issue at the front of the ascending-number queue is reported
instead of silently passed over to start a new task underneath it.

### Trusted dispatch-marker authorship

A prior version parsed a dispatch marker out of *any* issue/PR comment with
no author check. Because the marker format (subject type, number, head SHA,
reason string) is entirely public, any commenter could forge one with a
future `dispatchedAt` and silence the supervisor for that subject
indefinitely. `filterTrustedDispatchMarkers` in `supervisor-idempotency.mjs`
now counts a marker only when the comment is authored by the exact trusted
identity (`github-actions[bot]`, type `Bot`) the supervisor itself posts as;
an identical, well-formed marker forged by any other author is discarded. A
marker is posted for every attempted dispatch (see "Bounded retries" above),
tagged with an `outcome` of `dispatched` or `failed`; `outcome` is optional
on parse so a marker posted before this field existed still round-trips.

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
- `validateAgentId` rejects an agent id that does not match the official
  `agtch_...` channel-id format (bounded `[A-Za-z0-9_-]` suffix, matching the
  official example's use of underscores) before any network call.
- The token is used only to build the `Authorization` header of the fixed
  trigger request. It is never included in a dispatch marker, a log line, a
  thrown error message, or any other evidence artifact. `buildDispatchInstruction`
  - which builds the entire request body sent to the Workspace Agent -
  accepts no credential parameter at all, so it is structurally impossible
  for a secret to end up in the instruction text.
- The trigger URL is built from a hardcoded API base in
  `supervisor-dispatch.mjs` plus the validated agent id only; the base is
  never read from a repository variable, secret, issue/PR body, label, or any
  other repository content, and the agent id is checked against a strict
  pattern before it is interpolated, so the URL cannot be redirected or
  derived from untrusted repository content. Redirect responses (3xx) from
  that endpoint are never followed; they fail closed.
- The deterministic exact-state/reason idempotency key is sent in the
  official `Idempotency-Key` request header (not only recorded in a marker
  after the dispatch completes), so the Workspace Agent API itself can
  deduplicate two requests for the same key even in the case of a true race
  before either dispatch marker is recorded.

## Dispatch instruction content

Every dispatch sends a bounded, human-readable, non-secret instruction as
the Workspace Agent's `input` (see `buildDispatchInstruction` in
`supervisor-dispatch.mjs`): the repository identity, the exact subject (type
and number), the exact head SHA where one applies, the dispatch reason, an
explicit requirement to re-read fresh evidence rather than trust cached
state, the current code-only authorization boundary, and a reason-specific
requested next action. The function accepts no credential parameter, so a
secret can never end up in the instruction text even by mistake.

## Workspace Agent API contract

Per the official Workspace Agents API (confirmed in Codex's exact-head
review of PR #26):

- `POST https://api.chatgpt.com/v1/workspace_agents/{id}/trigger`, where
  `{id}` matches the `agtch_...` channel-id format.
- Body: `{ "conversation_key": "<idempotency key>", "input": "<bounded
  instruction text>" }`.
- Headers: `Authorization: Bearer <token>`, `Idempotency-Key: <idempotency
  key>`, `OpenAI-Beta: workspace_agent_runs=v1`.
- Success is exactly HTTP `202 Accepted`; any other non-redirect status is
  treated as a failed (but not thrown) dispatch.

## Open items

- **Live prerequisites remain unverified.** The dedicated Workspace Agent's
  repository variable (`CHATGPT_WORKSPACE_AGENT_ID`) and encrypted secret
  (`CHATGPT_WORKSPACE_AGENT_TOKEN`) are authorized but their actual
  configuration in this repository has not been independently verified by
  this work packet, and no live dispatch has been attempted. Do not treat
  the harmless in-memory proof below as evidence of a real `202 Accepted`
  response or of fresh live-agent behavior; that requires a separate,
  explicitly authorized live verification step.
- **Supervised `workflow_run` names are provisional.** `SUPERVISED_WORKFLOW_RUN_NAMES`
  in `supervisor-event-guard.mjs` lists `"Project governance"` and
  `"Claude Code"` as placeholders for the governance/Claude workflow names
  this supervisor depends on; confirm these match the actual `name:` fields
  once the workflow is live. (`"Project governance"` is confirmed correct
  against this repository's actual `.github/workflows/project-governance.yml`
  `name:` field; `"Claude Code"` remains unconfirmed.)
- **The trusted-bot-login allowlist is unset by default.** `shouldHandleEvent`
  now accepts an injectable `trustedBotLogins` allowlist so a specifically
  trusted reviewer/agent identity (e.g. a GitHub App-backed Workspace Agent,
  which posts as sender type `Bot`) can trigger the event-driven fast path
  without weakening the generic bot-recursion guard. The wiring reads it from
  the optional, comma-separated `AUTONOMY_TRUSTED_BOT_LOGINS` environment
  variable, which is not yet set anywhere - until the dedicated Workspace Agent's literal GitHub
  login is independently confirmed, no bot identity beyond the hardcoded
  `github-actions[bot]` exclusion is trusted, and the event-driven path falls
  back to the five-minute schedule for that evidence, exactly as before this
  change.
- **Bootstrap:** `.github/workflows/autonomy-supervisor.yml` itself cannot
  successfully invoke `scripts/run-autonomy-supervisor.mjs` against `main`
  until this pull request merges (the script does not exist on `main` yet).
  A pre-merge failure of the workflow's own `Autonomous supervisor` job is
  therefore expected and is never Project governance evidence -
  `supervisor-ci.mjs` only ever considers runs literally named `Project
  governance`, so this cannot affect the acceptance calculation either way.

## Harmless proof

`test/de-0010-autonomy-supervisor-harmless-proof.test.mjs` exercises the full
cycle - scheduled and manual evaluation, one Workspace Agent wake-up, fresh
exact-head re-read after a new commit, active-pull-request precedence over a
queued task, the PR #24 stale-verdict race, the remediation-cycle attempt cap
spanning equivalent reasons and the resulting `autonomy-blocked` hold, a
persistently failing dispatch endpoint (non-`202` and thrown-error attempts)
being spaced and capped exactly like a succeeding one, a retry-exhausted
queued issue receiving `autonomy-blocked` the same way a pull request does,
simultaneous schedule/event-driven dedupe, forged dispatch-marker rejection,
per-item failure isolation, and duplicate suppression - entirely in memory,
with a fake GitHub store and a call-counting fake Workspace Agent dispatcher.
It performs no network access and touches no live system or credential, and
it is not a substitute for the live verification called out above.
