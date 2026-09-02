import { createHash } from "node:crypto";
import { buildIdempotencyKey, parseIdempotencyKey } from "./supervisor-idempotency.mjs";
import { OWNER_VERDICT_KINDS, selectLatestOwnerVerdict } from "./supervisor-verdicts.mjs";

/** Issue label that opts a queued task into autonomous supervision. Pull
 * requests are supervised whenever they are non-draft; issues additionally
 * require this explicit opt-in label before the supervisor will ever start
 * work on them. */
export const AUTONOMY_READY_LABEL = "autonomy-ready";

/** Label the supervisor applies itself (never a human) once a subject has
 * exhausted its remediation-cycle attempt budget at its current exact head
 * (or, for issues, exact content). It is included in HOLD_LABELS so that,
 * from the next cycle onward, the blocked subject is held exactly like a
 * human-applied hold - no special casing is needed once the label is
 * visible on the subject. */
export const AUTONOMY_BLOCKED_LABEL = "autonomy-blocked";

/** Labels that place a subject on hold: the supervisor evaluates but never
 * dispatches while one of these is present, and always reports the hold
 * instead so a human decision is visibly required. `security-review` and
 * `major-decision` are the exact labels authorized by issue #25; the
 * supervisor-applied AUTONOMY_BLOCKED_LABEL is included for the same
 * skip-and-report treatment once the retry cap is hit. */
export const HOLD_LABELS = new Set(["security-review", "major-decision", AUTONOMY_BLOCKED_LABEL]);

/** Minimum time between repeat dispatches for the same exact-state/reason
 * idempotency key. This bounds retries to something a five-minute schedule
 * will not spam, while still allowing a bounded nudge if the Workspace Agent
 * has not resolved a persistent condition. */
export const RETRY_INTERVAL_MS = 30 * 60 * 1000;

/** Maximum number of remediation/re-review dispatch cycles the supervisor
 * will ever send for one exact head (or, for issues, exact content) across
 * every equivalent failure reason combined - not three separately per
 * reason wording. A subject that bounces between, say, ci_failed and
 * review_rejected at the same head still exhausts this budget after three
 * dispatches total. A new head SHA (or, for issues, new content) produces a
 * new state and a fresh attempt budget. `merge_ready` dispatch is
 * intentionally excluded from this cap: it is governed independently by its
 * own idempotency key and RETRY_INTERVAL_MS only (see REMEDIATION_REASONS).
 */
export const MAX_DISPATCH_ATTEMPTS_PER_KEY = 3;

export const AUTONOMY_BLOCKED_REASON = "autonomy_blocked";

export const REASONS = Object.freeze({
  CI_FAILED: "ci_failed",
  REVIEW_MISSING: "review_missing",
  REVIEW_REJECTED: "review_rejected",
  MERGE_READY: "merge_ready",
  QUEUED_TASK_START: "queued_task_start",
});

/** Reasons that count against the shared remediation-cycle attempt budget
 * (MAX_DISPATCH_ATTEMPTS_PER_KEY), regardless of which of these specific
 * reasons produced each dispatch. `merge_ready` is deliberately not a
 * member: a merge-ready subject is governed by its own idempotency key and
 * retry interval only, never blocked by this cap. */
const REMEDIATION_REASONS = new Set([REASONS.CI_FAILED, REASONS.REVIEW_MISSING, REASONS.REVIEW_REJECTED]);

export function findActiveHoldLabel(labels) {
  for (const label of labels ?? []) {
    if (HOLD_LABELS.has(label)) return label;
  }
  return null;
}

function mostRecentDispatchAt(dispatches, key) {
  let latest = null;
  for (const dispatch of dispatches ?? []) {
    if (dispatch.key !== key) continue;
    const at = Date.parse(dispatch.dispatchedAt);
    if (Number.isNaN(at)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/**
 * Counts prior dispatches for the same exact subject/state whose reason is
 * one of REMEDIATION_REASONS, regardless of which specific reason each one
 * carried. This is what makes the retry-attempt cap span "equivalent
 * failure reasons" instead of resetting every time the reason wording
 * changes between cycles.
 */
function countRemediationDispatchesAtState(dispatches, subjectType, subjectNumber, stateId) {
  let count = 0;
  for (const dispatch of dispatches ?? []) {
    const parsed = parseIdempotencyKey(dispatch.key);
    if (!parsed) continue;
    if (parsed.subjectType !== subjectType) continue;
    if (parsed.subjectNumber !== subjectNumber) continue;
    if (parsed.stateId !== stateId) continue;
    if (!REMEDIATION_REASONS.has(parsed.reason)) continue;
    count += 1;
  }
  return count;
}

function countDispatchesForKey(dispatches, key) {
  return (dispatches ?? []).filter((dispatch) => dispatch.key === key).length;
}

export function isRetryDue(now, lastDispatchedAtMs) {
  if (lastDispatchedAtMs === null || lastDispatchedAtMs === undefined) return true;
  return now.getTime() - lastDispatchedAtMs >= RETRY_INTERVAL_MS;
}

/**
 * Computes a stable content fingerprint for a queued issue so that any change
 * to its labels, title, or body invalidates prior dispatch evidence, the same
 * way a new head SHA invalidates prior PR evidence. Issues have no git head,
 * so this fingerprint stands in for "exact state".
 */
export function computeIssueStateFingerprint(issue) {
  const canonical = JSON.stringify({
    labels: [...(issue.labels ?? [])].sort(),
    title: issue.title ?? "",
    body: issue.body ?? "",
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Decides the supervisor's action for one non-draft-or-draft pull request.
 * Only checks and owner verdicts recorded against the pull request's exact
 * current head SHA are trusted as evidence; anything recorded against an
 * older head is stale and is treated as absent, forcing a fresh evaluation.
 *
 * `pr.checks` is `{ headSha, conclusion: "success" | "failure" | "pending" }
 *   | null` and must already be scoped to the named governance CI check by
 * the caller (see summarizeGovernanceCheckRuns in supervisor-ci.mjs).
 * `pr.ownerVerdictEvents` is an array of owner-authored verdict events (see
 * buildOwnerVerdictEvents in supervisor-verdicts.mjs) and must already have
 * every non-owner-authored comment/review filtered out by the caller; the
 * chronologically latest event at the exact current head is authoritative
 * (see selectLatestOwnerVerdict - this is what prevents the PR #24
 * stale-verdict race).
 */
export function evaluatePullRequestAction(pr, now, dispatches = []) {
  if (pr.isDraft) {
    return { action: "skip", reason: "draft" };
  }

  const hold = findActiveHoldLabel(pr.labels);
  if (hold) {
    return { action: "hold", reason: hold };
  }

  const checksAtHead = pr.checks && pr.checks.headSha === pr.headSha ? pr.checks : null;

  if (!checksAtHead || checksAtHead.conclusion === "pending") {
    return { action: "skip", reason: "awaiting_ci" };
  }

  let reason;
  if (checksAtHead.conclusion === "failure") {
    reason = REASONS.CI_FAILED;
  } else {
    const ownerVerdict = selectLatestOwnerVerdict(pr.ownerVerdictEvents, pr.headSha);
    if (!ownerVerdict) {
      reason = REASONS.REVIEW_MISSING;
    } else if (ownerVerdict.kind === OWNER_VERDICT_KINDS.ACCEPTED) {
      reason = REASONS.MERGE_READY;
    } else {
      // REJECTED, SUPERSEDED, or REMEDIATION_REQUESTED all block merge-ready
      // dispatch and instead ask for remediation/re-review.
      reason = REASONS.REVIEW_REJECTED;
    }
  }

  const idempotencyKey = buildIdempotencyKey({
    subjectType: "pull_request",
    subjectNumber: pr.number,
    stateId: pr.headSha,
    reason,
  });

  if (
    REMEDIATION_REASONS.has(reason) &&
    countRemediationDispatchesAtState(dispatches, "pull_request", pr.number, pr.headSha) >=
      MAX_DISPATCH_ATTEMPTS_PER_KEY
  ) {
    return { action: "blocked", reason: AUTONOMY_BLOCKED_REASON, idempotencyKey };
  }

  if (!isRetryDue(now, mostRecentDispatchAt(dispatches, idempotencyKey))) {
    return { action: "skip", reason: "retry_not_due", idempotencyKey };
  }

  return { action: "dispatch", reason, idempotencyKey };
}

/**
 * Decides the supervisor's action for one queued issue. Only issues carrying
 * the explicit `autonomy-ready` opt-in label are ever eligible; every other
 * issue is skipped regardless of any other state.
 */
export function evaluateIssueAction(issue, now, dispatches = []) {
  const labels = issue.labels ?? [];
  if (!labels.includes(AUTONOMY_READY_LABEL)) {
    return { action: "skip", reason: "not_autonomy_ready" };
  }

  const hold = findActiveHoldLabel(labels);
  if (hold) {
    return { action: "hold", reason: hold };
  }

  const stateId = computeIssueStateFingerprint(issue);
  const idempotencyKey = buildIdempotencyKey({
    subjectType: "issue",
    subjectNumber: issue.number,
    stateId,
    reason: REASONS.QUEUED_TASK_START,
  });

  if (countDispatchesForKey(dispatches, idempotencyKey) >= MAX_DISPATCH_ATTEMPTS_PER_KEY) {
    return { action: "blocked", reason: AUTONOMY_BLOCKED_REASON, idempotencyKey };
  }

  if (!isRetryDue(now, mostRecentDispatchAt(dispatches, idempotencyKey))) {
    return { action: "skip", reason: "retry_not_due", idempotencyKey };
  }

  return { action: "dispatch", reason: REASONS.QUEUED_TASK_START, idempotencyKey };
}

/**
 * Selects at most `limit` queued issues to dispatch this cycle, in
 * deterministic ascending-issue-number order. Callers are expected to only
 * invoke this when no active pull request needs dispatch this cycle (active
 * pull requests take precedence over starting new queued work).
 */
export function selectQueuedTasks(itemsWithDispatches, now, { limit = 1 } = {}) {
  return itemsWithDispatches
    .map(({ issue, dispatches }) => ({ issue, decision: evaluateIssueAction(issue, now, dispatches) }))
    .filter(({ decision }) => decision.action === "dispatch")
    .sort((a, b) => a.issue.number - b.issue.number)
    .slice(0, limit);
}
