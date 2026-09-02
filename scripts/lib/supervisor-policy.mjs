import { createHash } from "node:crypto";
import { buildIdempotencyKey } from "./supervisor-idempotency.mjs";

/** Issue label that opts a queued task into autonomous supervision. Pull
 * requests are supervised whenever they are non-draft; issues additionally
 * require this explicit opt-in label before the supervisor will ever start
 * work on them. */
export const AUTONOMY_READY_LABEL = "autonomy-ready";

/** Labels that place a subject on hold: the supervisor evaluates but never
 * dispatches while one of these is present, and always reports the hold
 * instead so a human decision is visibly required. */
export const HOLD_LABELS = new Set(["security-hold", "major-decision-required"]);

/** Minimum time between repeat dispatches for the same exact-state/reason
 * idempotency key. This bounds retries to something a five-minute schedule
 * will not spam, while still allowing a bounded nudge if the Workspace Agent
 * has not resolved a persistent condition. */
export const RETRY_INTERVAL_MS = 30 * 60 * 1000;

export const REASONS = Object.freeze({
  CI_FAILED: "ci_failed",
  REVIEW_MISSING: "review_missing",
  REVIEW_REJECTED: "review_rejected",
  MERGE_READY: "merge_ready",
  QUEUED_TASK_START: "queued_task_start",
});

/** Claude must never satisfy independent exact-head review: any reviewer
 * login associated with the Claude implementer identity is excluded before a
 * review is ever considered as evidence. */
export function isIndependentReviewerLogin(login) {
  return typeof login === "string" && login.length > 0 && !/claude/i.test(login);
}

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
 * Only checks and reviews recorded against the pull request's exact current
 * head SHA are trusted as evidence; anything recorded against an older head
 * is stale and is treated as absent, forcing a fresh evaluation.
 *
 * `pr.checks` is `{ headSha, conclusion: "success" | "failure" | "pending" }
 *   | null`. `pr.review` is `{ headSha, state: "approved" | "changes_requested"
 *   | "pending" } | null` and must already have non-independent (Claude)
 * reviews filtered out by the caller.
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
  const reviewAtHead = pr.review && pr.review.headSha === pr.headSha ? pr.review : null;

  let reason = null;
  if (checksAtHead?.conclusion === "failure") {
    reason = REASONS.CI_FAILED;
  } else if (checksAtHead?.conclusion === "success") {
    if (!reviewAtHead) {
      reason = REASONS.REVIEW_MISSING;
    } else if (reviewAtHead.state === "changes_requested") {
      reason = REASONS.REVIEW_REJECTED;
    } else if (reviewAtHead.state === "approved") {
      reason = REASONS.MERGE_READY;
    } else {
      return { action: "skip", reason: "awaiting_review" };
    }
  }

  if (!reason) {
    return { action: "skip", reason: checksAtHead ? "awaiting_review" : "awaiting_ci" };
  }

  const idempotencyKey = buildIdempotencyKey({
    subjectType: "pull_request",
    subjectNumber: pr.number,
    stateId: pr.headSha,
    reason,
  });

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
