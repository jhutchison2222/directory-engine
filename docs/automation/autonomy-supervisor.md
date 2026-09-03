# DE-0010: repository-native autonomy supervisor

This document describes the bounded, code-only autonomy supervisor authorized
by DE-0010. It supplements, and does not weaken,
[`collaboration-policy.md`](collaboration-policy.md).

## Purpose

The supervisor watches supervised pull requests and queued issues, and wakes
the dedicated ChatGPT Workspace Agent when there is exact-head evidence that
it should act. It never merges, deploys, or mutates repository content
itself. It runs as **two separate GitHub Actions workflows** (see
"Architecture: the workflow split" below) rather than one, for a security
reason specific to how GitHub Actions loads workflow *definitions*.

## Architecture: the workflow split

An earlier single-workflow design triggered directly on `pull_request`,
`pull_request_review`, `issue_comment`, `schedule`, `workflow_dispatch`, and
`workflow_run`, and held `secrets.CHATGPT_WORKSPACE_AGENT_TOKEN` throughout.
An exact-head security review rejected that design: GitHub Actions loads a
workflow's own **YAML definition** from the git ref associated with the
triggering event. For `pull_request` and `pull_request_review`, that ref is
the pull request's own head - so a same-repository pull request could, in
principle, rewrite the secret-bearing workflow's own steps (for example,
inserting a step that echoes an environment variable) *before* its
trusted-checkout step ever ran, regardless of what that checkout step itself
pinned to. Pinning `actions/checkout`'s `ref:` to the default branch protects
what code the job *executes*, but not what the job's *own YAML* says to do in
the first place - that is a strictly earlier point in the execution model
that a `ref:` override cannot reach back and fix.

`schedule`, `workflow_dispatch`, and `workflow_run`, by contrast, are not
associated with a pull request ref at all (or, per GitHub's documented
behavior, `workflow_run`-triggered workflows are only ever loaded from the
repository's default branch) - so a workflow triggered *only* by these three
event types has a definition that is always the reviewed, merged version.

The supervisor is therefore split into two workflows:

- **`.github/workflows/autonomy-wake.yml`** ("Autonomy wake") - unprivileged.
  Triggered directly by `pull_request`, `pull_request_review`, and
  `issue_comment`. Holds `permissions: contents: read` only, no
  `CHATGPT_WORKSPACE_AGENT_ID`/`CHATGPT_WORKSPACE_AGENT_TOKEN`, and no other
  secret. It checks out the repository's **default branch** (never the PR
  head or merge ref, regardless of what triggered it) and runs exactly one
  script, `scripts/run-autonomy-wake.mjs`, which makes no GitHub API calls,
  treats the event payload purely as parsed JSON data (never executed,
  sourced, or interpolated into a shell command), and exits `0` (success) or
  `1` (irrelevant/self/bot-generated/out-of-repository event) via the same
  tested `shouldHandleEvent` gate the supervisor itself uses. Even though a
  malicious PR could rewrite *this* workflow's own definition too (it is
  triggered by `pull_request`/`pull_request_review`), doing so gains an
  attacker nothing: there is no credential to steal, and its only observable
  effect either way is whether it exits 0 or 1.
- **`.github/workflows/autonomy-supervisor.yml`** ("Autonomous supervisor") -
  secret-bearing. Triggered only by `schedule` (the five-minute recovery
  backstop), `workflow_dispatch` (manual), and `workflow_run: workflows:
  ["Autonomy wake"], types: [completed]` (the immediate-wake fast path,
  additionally required to have `conclusion: success` - see
  `supervisor-event-guard.mjs`). Its own definition is therefore always
  loaded from the default branch, and it holds the Workspace Agent
  credential.

Both workflows check out the repository's default branch with
`persist-credentials: false` and never reference
`github.event.pull_request.head.sha`, a `refs/pull/...` ref, or
`github.event.pull_request.merge_commit_sha`; neither uses
`pull_request_target`. `test/autonomy-wake-workflow.test.mjs` and
`test/autonomy-supervisor-workflow.test.mjs` inspect the committed workflow
file text directly to prove both of these properties, plus that no secret
reference of any kind appears in the wake workflow.

## Scope

- Supervises every open, non-draft pull request in this repository.
- Supervises only open issues explicitly labeled `autonomy-ready`; every
  other issue is left untouched regardless of any other state.
- Never acts on a subject labeled `security-review` or `major-decision` -
  it reports the hold and stops, requiring a human decision.
- Never acts on a subject the supervisor itself has already labeled
  `autonomy-blocked` after exhausting a retry/remediation budget (see
  "Bounded retries and the remediation-cycle attempt cap" below) - a new
  head (or new content) is required before it will try again, unless the
  packet-wide remediation-cycle ceiling has also been reached (see below),
  in which case a human decision is required regardless of head.
- Never merges directly. Only the Workspace Agent, re-reading fresh evidence
  under the owner's standing code-only authorization, may merge - with
  expected-head protection and a merge commit.

## Entry paths

- **Scheduled recovery backstop** - every five minutes (`*/5 * * * *`) on the
  secret-bearing supervisor workflow, unconditionally.
- **Manual dispatch** - `workflow_dispatch` on the secret-bearing supervisor
  workflow, unconditionally.
- **Event-driven fast path** - the unprivileged wake workflow reacts directly
  to:
  - `pull_request`: `opened`, `reopened`, `synchronize`, `ready_for_review`,
    `converted_to_draft`, `closed`
  - `pull_request_review`: `submitted`, `edited`, `dismissed`
  - `issue_comment`: `created`, `edited`, limited to comments on pull
    requests or on `autonomy-ready`-labeled issues

  and, if `shouldHandleEvent` (in `scripts/lib/supervisor-event-guard.mjs`,
  shared by both workflows' scripts) decides the event is relevant, exits
  successfully - which wakes the secret-bearing supervisor via its
  `workflow_run` trigger. A missing or unreadable event payload fails closed
  immediately (only the schedule/manual paths may proceed without one), then
  repository match, actor (never a Claude-associated actor, and never a
  generic bot actor - preventing recursion against the supervisor's own
  comments/labels - unless the sender is on the fixed, reviewed
  `TRUSTED_BOT_LOGINS` code constant in `supervisor-event-guard.mjs`
  (currently empty; see "Open items" below), never a repository variable or
  issue/PR content; `github-actions[bot]` can never be on that allowlist
  regardless of configuration), and the event's own action/comment-scope
  filter. The secret-bearing supervisor's own
  `workflow_run` handling separately requires the completing run to match
  the wake workflow's fixed name *and* path (`WAKE_WORKFLOW_NAME`/
  `WAKE_WORKFLOW_PATH` in `supervisor-event-guard.mjs`) and have
  `conclusion: success` - a same-named forged workflow elsewhere in
  `.github/workflows/`, or a wake run that itself decided to skip, can never
  wake the supervisor.

  All triggers - schedule, manual, and event-driven - share one
  non-overlapping concurrency group on the supervisor workflow and compute
  the identical deterministic idempotency key for identical state, so no
  combination of them can duplicate a dispatch.

  This is an additive fast path only; the five-minute schedule remains the
  recovery backstop regardless of webhook delivery or the wake workflow's
  own availability.

  No public webhook receiver, external relay, Cloudflare Worker, or new
  credential is introduced. Every trigger is a native GitHub Actions webhook
  event on this repository.

## Workflow permissions

`.github/workflows/autonomy-wake.yml` requests exactly:

- `contents: read` - to check out the repository (the default branch only;
  no write path, no other permission of any kind).

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

Neither workflow requests `contents: write`, any deployment, environment,
packages, administration, or security-events permission, and neither ever
uses one it was not granted.

## Decision model

All decision logic lives in pure, dependency-injected, fully-tested modules
under `scripts/lib/`:

- `supervisor-policy.mjs` - exact-head/exact-state evaluation for pull
  requests and issues, hold labels, the bounded per-head retry-attempt cap
  and the separate packet-wide remediation-cycle ceiling, retry timing, and
  queued-task selection (`selectQueuedTasks` surfaces the front-of-queue
  issue's decision even when it is `hold`, `blocked`, or a bare
  `retry_not_due` skip, not only `dispatch` - a later-numbered issue is never
  selected instead, so overlapping work packets cannot start while the front
  of the queue is mid-cycle).
- `supervisor-verdicts.mjs` - owner-only exact-head acceptance chronology:
  classifying owner-authored comments/reviews into ACCEPTED / REJECTED /
  SUPERSEDED / REMEDIATION_REQUESTED verdicts and resolving the
  chronologically latest one at an exact head (the PR #24 stale-verdict race
  guard). Verdict markers are structurally anchored (`NOT ACCEPTED` and
  `UNACCEPTED` never classify as ACCEPTED; incidental remediation-flavored
  prose ahead of a real `ACCEPTED` clause can never steal that clause's head
  reference), `DISMISSED`/`PENDING` reviews are excluded before their body is
  even inspected for a marker, and a comment or review is only ever trusted
  when its creation/update provenance is valid and unedited (see
  `supervisor-provenance.mjs`).
- `supervisor-ci.mjs` - governance CI evidence: requires a completed,
  successful GitHub Actions **workflow run** matching both the fixed name
  (`Project governance`) and the fixed, reviewed file path
  (`.github/workflows/project-governance.yml`) at the exact head; nothing
  else (an unrelated green check, a job-level check-run name such as this
  repository's own governance job `verify`, a same-named workflow run at a
  *different* path, this repository's own pre-merge-inoperable
  `Autonomous supervisor`/`Autonomy wake` jobs, or a stale-head run) ever
  counts. Matching by path in addition to name is what stops a
  same-repository pull request from forging acceptance by adding a second
  workflow file elsewhere in `.github/workflows/` with an identical
  human-readable `name:`.
- `supervisor-provenance.mjs` - the single fail-closed
  `isUneditedProvenance` check used everywhere a **comment** body is trusted
  as evidence (owner-verdict conversation comments, dispatch markers): both
  `createdAt`/`updatedAt` must be present, parseable, and exactly equal, or
  the body is not trusted - a missing timestamp is never treated as "safe by
  default". This check is not used for formal PR review bodies (see "Owner-only
  exact-head acceptance chronology" below) because GitHub's list-reviews API
  exposes no genuine independent edit timestamp to check.
- `supervisor-idempotency.mjs` - deterministic idempotency keys, the hidden
  HTML-comment dispatch marker used as the duplicate-suppression ledger (the
  workflow has no `contents: write`, so it cannot persist a ledger file; it
  reads its own prior marker comments instead), trusted-marker-author
  filtering, and the same edited-comment provenance check as owner-verdict
  comments.
- `supervisor-event-guard.mjs` - the pure gate, shared by both workflows'
  entry scripts, deciding whether one event-driven invocation should proceed,
  including the missing/unreadable-payload fail-closed check and (for the
  supervisor's own `workflow_run` case) the wake workflow's fixed
  name/path/conclusion checks.
- `supervisor-dispatch.mjs` - the fixed Workspace Agent trigger request
  against the official API contract, agent-id validation, the bounded
  non-secret dispatch instruction, and fail-closed credential handling.
- `supervisor-run.mjs` - the orchestrator tying the above together with
  per-item failure isolation, active-pull-request precedence, and retried
  dispatch-marker posting (see "Bounded retries" below).

`scripts/run-autonomy-supervisor.mjs` and `scripts/run-autonomy-wake.mjs` are
the thin, intentionally simple wiring each workflow invokes; neither contains
decision logic and neither is itself unit tested, only their pure
dependencies are. `scripts/lib/read-github-event.mjs` is the shared,
untested-by-design helper both use to read and parse the local event payload
file.

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

The only trusted acceptance identity is the **repository owner login**,
supplied by the wiring layer from repository metadata (the `owner` segment
of the `GITHUB_REPOSITORY` environment variable GitHub Actions always sets) -
never guessed, hardcoded, or read from issue/PR content.

`supervisor-verdicts.mjs` merges owner-authored pull-request conversation
comments with owner-authored formal PR reviews into a single chronological
verdict timeline (`buildOwnerVerdictEvents`), but trusts the two kinds of
evidence differently:

- A **conversation comment** only counts when it carries an explicit marker:
  `ACCEPTED — exact head <sha>`, `REJECTED — exact head <sha>`,
  `SUPERSEDED ... exact head <sha>`, or a remediation request tied to an
  exact head (recognizing the owner's own real-world phrasing, e.g.
  "Remediate DE-0010 at exact head `<sha>`") - `NOT ACCEPTED`/`UNACCEPTED`
  phrasing never matches the ACCEPTED marker, and a remediation-flavored word
  appearing ahead of a real `ACCEPTED` clause can never consume that clause's
  own head reference (the marker's bounded lookahead cannot cross another
  marker keyword). It must also pass `isUneditedProvenance` - an edited
  comment (GitHub preserves the original author on an edit, so author
  identity alone is not proof the body is still what the owner wrote) is
  never trusted, regardless of the identity that appears to have authored it.
- A **formal PR review** is first excluded entirely if its native state is
  `DISMISSED` or `PENDING`, and otherwise counts *only* via its own
  immutable native GitHub verdict (`APPROVED` -> accepted,
  `CHANGES_REQUESTED` -> rejected); `COMMENTED` is not evidence. An explicit
  marker in a review's *body* is never honored, even for an otherwise
  actionable state - GitHub's list-reviews API exposes no genuine,
  independent edit timestamp the way its comments API does, so there is no
  way to verify a review body has not been rewritten after submission. An
  earlier version manufactured `updatedAt = submittedAt` for reviews to run
  the same provenance check comments use, which made the check pass
  unconditionally rather than verify anything; rather than manufacture or
  skip that check, review bodies are simply never trusted as verdict
  evidence at all.

`selectLatestOwnerVerdict` picks the chronologically latest event (by
timestamp) among those recorded at the pull request's exact current head.
This means an earlier acceptance can never be treated as authoritative once
a later rejection, supersession, or remediation request exists at that same
exact head - exactly the race that occurred on PR #24, where an earlier
accepted verdict and a later rejection both existed for the same head. The
later evidence always wins and blocks `merge_ready` dispatch until a new
accepted head is produced.

### Bounded retries, the remediation-cycle attempt cap, and the packet-wide ceiling

Each dispatch reason is keyed by `subjectType:subjectNumber:stateId:reason`.
The supervisor never dispatches the same key twice within the retry interval
(30 minutes), and a change in `stateId` (new head SHA, or new issue content)
always produces a new key regardless of any prior dispatch history at the old
state.

Two independent budgets bound remediation (`ci_failed`, `review_missing`,
`review_rejected`) dispatches for a pull request:

- **Per-head attempt cap** (`MAX_DISPATCH_ATTEMPTS_PER_KEY`, 3) - counted
  across every equivalent remediation reason combined for the *same exact
  head*, not separately per reason wording. A subject that bounces between a
  failing check and a rejected review at the same head still exhausts this
  budget after three dispatches total at that head.
- **Packet-wide remediation-cycle ceiling**
  (`MAX_REMEDIATION_CYCLES_PER_SUBJECT`, 3) - counted across *distinct heads*
  that have each had at least one remediation dispatch, for the whole life
  of the pull request. Once three distinct heads have each gone through
  remediation, a brand-new fourth head is held for the owner immediately -
  with zero attempts spent at that new head - rather than being granted a
  fresh per-head budget. This is issue #25's "stop after three unsuccessful
  remediation cycles and escalate the blocker" made packet-wide: pushing a
  new commit no longer resets the clock. A head that is already among the
  counted heads (i.e. remediation already started at that exact head) is
  still governed by the ordinary per-head cap above, so retries already
  under way at the current head are not abruptly cut off mid-cycle.

These two budgets are deliberately separate constants (even though both
currently equal 3) so retry-attempt accounting and remediation-cycle
accounting can be changed independently without silently affecting each
other. Once either is exhausted, the next evaluation blocks instead of
retrying again and applies the supervisor-owned `autonomy-blocked` label;
from the next cycle onward that label is itself treated as a hold, so the
subject is reported and skipped until a human clears it. `merge_ready`
dispatch is deliberately excluded from both budgets: it is governed
independently by its own idempotency key and the same 30-minute retry
interval only, so a merge-ready subject - including one reached at a brand
new head after the packet-wide ceiling was hit - is never blocked by
remediation-cycle exhaustion.

A dispatch marker is posted for **every** attempted dispatch, not only a
successful one: a non-`202` response or a thrown error (e.g. the dispatch
endpoint refusing a redirect, or a network failure) is recorded with outcome
`failed` (see `DISPATCH_OUTCOMES` in `supervisor-idempotency.mjs`) and counts
toward both the 30-minute retry interval and the remediation attempt budgets
exactly like a successful dispatch.

**Marker-post retries.** Posting the dispatch marker after a dispatch attempt
is itself retried up to three times (`supervisor-run.mjs`) before giving up,
because a successful dispatch (a real side effect already sent to the
Workspace Agent) followed by a marker-post failure would otherwise leave no
local evidence of that dispatch at all - the next cycle would see an empty
history for that key and could retry immediately, before `RETRY_INTERVAL_MS`
has elapsed. If every retry still fails, the cycle reports the distinct
terminal status `dispatch_marker_failed` (treated as an error by the wiring
layer, surfacing as a failed Actions run rather than a silent success) so an
operator is alerted, instead of the ambiguous `dispatched`. This reduces, but
does not by itself eliminate, the residual risk in the all-retries-failed
case; the deterministic `Idempotency-Key` sent on every dispatch attempt
(unchanged for a given exact state) is the authoritative last-line defense
the official Workspace Agent API itself provides against a genuine duplicate
side effect even when this local marker cannot be recorded at all.

For queued issues, `selectQueuedTasks` always surfaces the front of the
queue - the lowest-numbered issue that carries the `autonomy-ready` label at
all - whatever its decision is (`dispatch`, `hold`, `blocked`, or a bare
`retry_not_due` skip). A later-numbered, otherwise-dispatchable issue is
never selected instead: only once the front issue's own decision is
`dispatch` (and it eventually produces an active pull request, which itself
takes precedence over the queue) does any new work actually start. This is
what prevents two queued packets from overlapping - a prior version passed
over a front issue that was merely in its retry cooldown to consider the
next-lowest-numbered issue, letting a second packet start before the first
had finished.

### Trusted dispatch-marker authorship

`filterTrustedDispatchMarkers` in `supervisor-idempotency.mjs` counts a
marker only when the comment is authored by the exact trusted identity
(`github-actions[bot]`, type `Bot`) the supervisor itself posts as, **and**
passes the same `isUneditedProvenance` check used for owner verdicts - an
identical, well-formed marker forged by any other author, or a
trusted-author marker edited after posting, is discarded. A marker is posted
for every attempted dispatch (see "Bounded retries" above), tagged with an
`outcome` of `dispatched` or `failed`; `outcome` is optional on parse so a
marker posted before this field existed still round-trips.

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

- The supervisor workflow reads only `vars.CHATGPT_WORKSPACE_AGENT_ID` and
  `secrets.CHATGPT_WORKSPACE_AGENT_TOKEN`, by name, and fails closed
  (`requireEnv`) if either is missing or empty. The wake workflow never
  references either, or any other secret.
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

## Pre-merge vs. post-merge acceptance evidence, and rollback

The `workflow_run` chain that wakes the secret-bearing supervisor cannot
become active until `autonomy-wake.yml` and `autonomy-supervisor.yml` are
both present on the repository's default branch - GitHub only recognizes a
`workflow_run` relationship between workflows that already exist there.
**Pre-merge acceptance can therefore only ever cover**: exact-head Project
governance (install/typecheck/test/governance-validator), the structural and
security-boundary tests described throughout this document, the harmless
in-memory fixture proof (below), and Codex/owner exact-head review of the
code, tests, and workflow file text. It cannot cover a real `202 Accepted`
Workspace Agent response, a real `workflow_run` hand-off between the two
live workflows, or any other post-merge-only behavior - claiming otherwise
before merge would misrepresent what was actually verified.

**The one live harmless dispatch proof happens immediately after a guarded
merge**, once both workflows are live on the default branch, and must itself
fail closed without exposing any credential value: if the Workspace Agent
repository variable/secret are not both configured, `requireEnv` throws
before any network call, and the run fails visibly (not silently) with no
credential ever printed, logged, or persisted. If that post-merge proof
fails for any other reason (e.g. the Workspace Agent endpoint rejects the
request, or the `workflow_run` hand-off does not fire as expected),
**rollback/disable is a revert of the two workflow files** (not a code
revert) - since neither workflow performs any repository mutation beyond
posting bookkeeping comments/labels via `issues: write`/`pull-requests:
write`, disabling them by reverting the workflow files (or, for an
immediate stop without a revert, disabling the workflows from the repository
Actions settings) fully and immediately stops all supervision with no
partial or inconsistent state left behind.

## Open items

- **Live prerequisites remain unverified.** The dedicated Workspace Agent's
  repository variable (`CHATGPT_WORKSPACE_AGENT_ID`) and encrypted secret
  (`CHATGPT_WORKSPACE_AGENT_TOKEN`) are authorized but their actual
  configuration in this repository has not been independently verified by
  this work packet, and no live dispatch has been attempted. Do not treat
  the harmless in-memory proof below as evidence of a real `202 Accepted`
  response or of fresh live-agent behavior; that requires the separate,
  explicitly authorized post-merge live verification step described above.
- **The trusted-bot-login allowlist is a fixed, empty code constant.**
  `TRUSTED_BOT_LOGINS` in `supervisor-event-guard.mjs` is a literal, frozen
  module constant - not a repository variable or any other mutable setting -
  because the owner requires this trust boundary to be changeable only
  through code review. It is empty because no non-owner bot identity (e.g.
  the ChatGPT Workspace Agent's literal GitHub login, which would post as
  sender type `Bot`) has yet been independently confirmed by repository
  evidence. Until a confirmed literal login is added here through its own
  separately reviewed change, every bot-type sender - including a
  legitimate trusted reviewer/agent - is rejected by the event-driven fast
  path, and that evidence is instead picked up by the five-minute schedule,
  exactly as it was before the fast path existed.
- **Bootstrap:** neither workflow can successfully invoke its script against
  `main` until this pull request merges (neither script, nor
  `autonomy-wake.yml` itself, exists on `main` yet). A pre-merge failure of
  either workflow's own job is therefore expected and is never Project
  governance evidence - `supervisor-ci.mjs` only ever considers runs
  matching both the fixed name *and* path of `project-governance.yml`, so
  this cannot affect the acceptance calculation either way.

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
`test/autonomy-wake-workflow.test.mjs` and
`test/autonomy-supervisor-workflow.test.mjs` separately prove the two
workflow files' own trigger/permission/checkout/credential-isolation
properties by inspecting their committed text. None of this touches a live
system, calls the real GitHub API, performs a real `workflow_run` hand-off
between the two live workflows, or is a substitute for the post-merge live
verification called out above.
