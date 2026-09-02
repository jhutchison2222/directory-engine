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
  `autonomy-blocked` after exhausting `MAX_DISPATCH_ATTEMPTS_PER_KEY`
  (3) dispatch attempts for the same exact-state/reason key - a new head (or,
  for issues, new content) is required before it will try again.
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
  any dispatch is attempted: repository match, actor (never a Claude-
  associated or generic bot actor, preventing recursion against the
  supervisor's own comments/labels), the event's own action filter, the
  comment-scope filter, and the workflow-name filter. All triggers - schedule,
  manual, and event-driven - share one non-overlapping concurrency group and
  compute the identical deterministic idempotency key for identical state, so
  no combination of them can duplicate a dispatch.

  This is an additive fast path only; the five-minute schedule remains the
  recovery backstop regardless of webhook delivery.

  No public webhook receiver, external relay, Cloudflare Worker, or new
  credential is introduced. Every trigger is a native GitHub Actions webhook
  event on this repository.

## Workflow permissions

`.github/workflows/autonomy-supervisor.yml` requests exactly:

- `actions: read` - to observe CI state.
- `checks: read` - to read exact-head check-run conclusions.
- `contents: read` - to check out the repository (no write path).
- `issues: write` - to post dispatch-bookkeeping comments and apply
  `autonomy-blocked` on issues and pull requests (both are the Issues API).
- `pull-requests: write` - to post dispatch-bookkeeping comments on pull
  requests.

It does not request `contents: write`, any deployment, environment, packages,
administration, or security-events permission, and it never uses one it was
not granted.

## Decision model

All decision logic lives in pure, dependency-injected, fully-tested modules
under `scripts/lib/`:

- `supervisor-policy.mjs` - exact-head/exact-state evaluation for pull
  requests and issues, hold labels, the bounded retry-attempt cap, retry
  timing, chronological same-head verdict resolution, CI-check relevance
  filtering, and queued-task selection.
- `supervisor-idempotency.mjs` - deterministic idempotency keys and the
  hidden HTML-comment dispatch marker used as the duplicate-suppression
  ledger (the workflow has no `contents: write`, so it cannot persist a
  ledger file; it reads its own prior marker comments instead).
- `supervisor-event-guard.mjs` - the pure gate deciding whether one
  event-driven webhook invocation should proceed to a full evaluation cycle.
- `supervisor-dispatch.mjs` - the fixed Workspace Agent trigger request
  against the official API contract, agent-id validation, and fail-closed
  credential handling.
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

Check-run aggregation excludes non-CI-relevant check names (`isCiRelevantCheckName`)
- specifically Claude's own review check and the supervisor's own check - so
neither creates a circular or self-referential CI signal.

### Chronological same-head verdict resolution (the PR #24 stale-verdict race)

A pull request's review evidence is a list of independent-reviewer events at
various heads and times, not a single "current" verdict. `selectLatestReviewEvent`
picks the chronologically latest event (by `submittedAt`) among those
recorded at the pull request's exact current head. This means an earlier
acceptance can never be treated as authoritative once a later rejection,
dismissal, or re-review exists at that same exact head - exactly the race
that occurred on PR #24, where an earlier accepted verdict and a later
rejection both existed for the same head. The later evidence always wins and
blocks `merge_ready` dispatch until a new accepted head is produced.

Only reviews from a login on the explicit `TRUSTED_INDEPENDENT_REVIEWER_LOGINS`
allowlist are ever considered (see "Independent review only" below); a
structured, comment-based remediation-request marker convention (as opposed
to a formal PR review submission or dismissal) is an open item - see
"Open items" below.

### Independent review only

A review only counts as independent-acceptance evidence when its login is on
the explicit `TRUSTED_INDEPENDENT_REVIEWER_LOGINS` allowlist in
`supervisor-policy.mjs`, and any login containing `claude` is rejected even if
it were mistakenly added there. This is an allowlist, not merely a
"not-Claude" blocklist: a generic third-party approval or
`github-actions[bot]` review can never satisfy independent acceptance just by
not being Claude.

### Bounded retries and the retry-attempt cap

Each dispatch reason is keyed by `subjectType:subjectNumber:stateId:reason`.
The supervisor never dispatches the same key twice within the retry interval
(30 minutes), and a change in `stateId` (new head SHA, or new issue content)
always produces a new key regardless of any prior dispatch history at the old
state. Once `MAX_DISPATCH_ATTEMPTS_PER_KEY` (3) dispatches have already been
sent for the same key, the next evaluation blocks instead of retrying again
and applies the supervisor-owned `autonomy-blocked` label; from the next
cycle onward that label is itself treated as a hold, so the subject is
reported and skipped until a new exact-state key exists.

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
  `agtch_...` channel-id format before any network call.
- The token is used only to build the `Authorization` header of the fixed
  trigger request. It is never included in a dispatch marker, a log line, a
  thrown error message, or any other evidence artifact.
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

## Workspace Agent API contract

Per the official Workspace Agents API (confirmed in Codex's exact-head
review of PR #26):

- `POST https://api.chatgpt.com/v1/workspace_agents/{id}/trigger`, where
  `{id}` matches the `agtch_...` channel-id format.
- Body: `{ "conversation_key": "<idempotency key>", "input": "<JSON-encoded
  reason/subject>" }`.
- Headers: `Authorization: Bearer <token>`, `Idempotency-Key: <idempotency
  key>`, `OpenAI-Beta: workspace_agent_runs=v1`.
- Success is exactly HTTP `202 Accepted`; any other non-redirect status is
  treated as a failed (but not thrown) dispatch.

## Open items

- **Trusted reviewer logins are provisional.** This work packet's available
  tool access could not independently confirm the literal GitHub login(s)
  the dedicated Codex reviewer and Workspace Agent use on this repository.
  `TRUSTED_INDEPENDENT_REVIEWER_LOGINS` in `supervisor-policy.mjs` currently
  lists plausible placeholders (`codex`, `chatgpt-codex-connector`,
  `directory-engine-workspace-agent`); Codex/owner review must confirm and,
  if needed, correct these literal values before any live dispatch decision
  relies on independent-review acceptance. Until confirmed, any login not on
  this list simply never satisfies acceptance (fails closed).
- **Comment-based remediation requests are not yet a recognized verdict
  source.** Only formal PR review submissions and dismissals feed
  `selectLatestReviewEvent`. A free-form rejection comment (such as the one
  that triggered this remediation cycle) is not automatically parsed into a
  same-head verdict; a future structured Codex-verdict marker convention
  (analogous to the dispatch marker) would be needed to make that
  automatic, and is out of this bounded packet's scope.
- **Live prerequisites remain unverified.** The dedicated Workspace Agent's
  repository variable (`CHATGPT_WORKSPACE_AGENT_ID`) and encrypted secret
  (`CHATGPT_WORKSPACE_AGENT_TOKEN`) are authorized but their actual
  configuration in this repository has not been independently verified by
  this work packet, and no live dispatch has been attempted. Do not treat
  the harmless in-memory proof below as evidence of a real `202 Accepted`
  response or of fresh live-agent behavior; that requires a separate,
  explicitly authorized live verification step.
- **The workflow file itself could not be pushed.** The GitHub App token
  used for these commits lacks the `workflows` permission required to
  create or update `.github/workflows/autonomy-supervisor.yml`. The complete
  proposed workflow content is provided in this pull request's evidence
  comment for maintainer-authorized insertion.
- **Supervised `workflow_run` names are provisional.** `SUPERVISED_WORKFLOW_RUN_NAMES`
  in `supervisor-event-guard.mjs` lists `"Project governance"` and
  `"Claude Code"` as placeholders for the governance/Claude workflow names
  this supervisor depends on; confirm these match the actual `name:` fields
  once the workflow is live.

## Harmless proof

`test/de-0010-autonomy-supervisor-harmless-proof.test.mjs` exercises the full
cycle - scheduled and manual evaluation, one Workspace Agent wake-up, fresh
exact-head re-read after a new commit, active-pull-request precedence over a
queued task, the PR #24 stale-verdict race, the retry-attempt cap and
`autonomy-blocked` hold, simultaneous schedule/event-driven dedupe, per-item
failure isolation, and duplicate suppression - entirely in memory, with a
fake GitHub store and a call-counting fake Workspace Agent dispatcher. It
performs no network access and touches no live system or credential, and it
is not a substitute for the live verification called out above.
