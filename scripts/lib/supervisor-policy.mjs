import { createHash } from "node:crypto";
import { buildIdempotencyKey } from "./supervisor-idempotency.mjs";

/** Issue label that opts a queued task into autonomous supervision. Pull
 * requests are supervised whenever they are non-draft; issues additionally
 * require this explicit opt-in label before the supervisor will ever start
 * work on them. */
export const AUTONOMY_READY_LABEL = "autonomy-ready";

/** Label the supervisor applies itself (never a human) once a subject has
 * exhausted MAX_DISPATCH_ATTEMPTS_PER_KEY for its current exact-state/reason
 * key. It is included in HOLD_LABELS so that, from the next cycle onward, the
 * blocked subject is held exactly like a human-applied hold - no special
 * casing is needed once the label is visible on the subject. */
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

/** Maximum number of dispatch requests the supervisor will ever send for one
 * exact-state/reason idempotency key. Once this many dispatches have already
 * gone out for the same key, the next evaluation blocks instead of retrying
 * again, applying AUTONOMY_BLOCKED_LABEL so a human decision is required to
 * move the subject forward. A new head SHA (or, for issues, new content)
 * produces a new key and a fresh attempt budget. */
export const MAX_DISPATCH_ATTEMPTS_PER_KEY = 3;

export const AUTONOMY_BLOCKED_REASON = "autonomy_blocked";

export const REASONS = Object.freeze({
  CI_FAILED: "ci_failed",
  REVIEW_MISSING: "review_missing",
  REVIEW_REJECTED: "review_rejected",
  MERGE_READY: "merge_ready",
  QUEUED_TASK_START: "queued_task_start",
});

/** Explicit allowlist of trusted independent-reviewer GitHub logins whose
 * verdict can satisfy exact-head acceptance: the dedicated Codex reviewer and
 * the dedicated ChatGPT Workspace Agent. Generic third-party approvals and
 * `github-actions[bot]` never count merely for lacking "claude" in the login;
 * they must also be one of these two named, owner-authorized identities.
 *
 * Open item: this work packet's available tool access could not
 * independently confirm the literal GitHub login(s) issue #25's Codex and
 * Workspace Agent reviewer identities use. Until Codex/owner review confirms
 * and, if needed, corrects these literal values, this allowlist fails closed
 * (nothing outside it satisfies acceptance) rather than guessing a broader
 * set. See docs/automation/autonomy-supervisor.md.
 */
export const TRUSTED_INDEPENDENT_REVIEWER_LOGINS = Object.freeze([
  "codex",
  "chatgpt-codex-connector",
  "directory-engine-workspace-agent",
]);

/** Claude must never satisfy independent exact-head review, and neither may
 * any other generic reviewer: only a login on the explicit trusted allowlist
 * above counts as independent-acceptance evidence. */
export function isIndependentReviewerLogin(login) {
  if (typeof login !== "string" || login.length === 0) return false;
  const normalized = login.toLowerCase();
  if (normalized.includes("claude")) return false;
  return TRUSTED_INDEPENDENT_REVIEWER_LOGINS.includes(normalized);
}

/** Check-run names that are never treated as CI evidence: the supervisor's
 * own check and Claude's review check would otherwise create a circular or
 * non-CI signal (e.g. the supervisor waiting on a check that can never
 * complete while it is itself running, or treating an implementer's own
 * review check as an independent CI gate). */
const NON_CI_CHECK_NAME_PATTERN = /^(claude|autonomy supervisor)\b/i;

export function isCiRelevantCheckName(name) {
  return typeof name === "string" && name.trim().length > 0 && !NON_CI_CHECK_NAME_PATTERN.test(name.trim());
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
 * Selects the chronologically latest independent review verdict recorded
 * against one exact head SHA. This is what prevents the PR #24 stale-verdict
 * race: if an earlier acceptance and a later rejection/dismissal both exist
 * for the same exact head, the later one is authoritative and is the only one
 * returned - an earlier "approved" event at that head is never reachable once
 * a later event at the same head exists. Events are supplied unsorted;
 * `submittedAt` is parsed to establish chronology.
 */
export function selectLatestReviewEvent(reviewEvents, headSha) {
  const atHead = (reviewEvents ?? []).filter((event) => event.headSha === headSha);
  if (atHead.length === 0) return null;
  const sorted = [...atHead].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  return sorted[sorted.length - 1];
}

/**
 * Decides the supervisor's action for one non-draft-or-draft pull request.
 * Only checks and reviews recorded against the pull request's exact current
 * head SHA are trusted as evidence; anything recorded against an older head
 * is stale and is treated as absent, forcing a fresh evaluation.
 *
 * `pr.checks` is `{ headSha, conclusion: "success" | "failure" | "pending" }
 *   | null` and must already have non-CI-relevant check names filtered out by
 * the caller (see isCiRelevantCheckName). `pr.reviewEvents` is an array of
 * `{ headSha, state: "approved" | "changes_requested" | "dismissed" |
 * "pending", submittedAt }` and must already have non-independent (Claude, or
 * any login outside TRUSTED_INDEPENDENT_REVIEWER_LOGINS) reviews filtered out
 * by the caller; the chronologically latest event at the exact current head
 * is authoritative (see selectLatestReviewEvent).
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
  const reviewAtHead = selectLatestReviewEvent(pr.reviewEvents, pr.headSha);

  let reason = null;
  if (checksAtHead?.conclusion === "failure") {
    reason = REASONS.CI_FAILED;
  } else if (checksAtHead?.conclusion === "success") {
    if (!reviewAtHead) {
      reason = REASONS.REVIEW_MISSING;
    } else if (reviewAtHead.state === "changes_requested" || reviewAtHead.state === "dismissed") {
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

  if (countDispatchesForKey(dispatches, idempotencyKey) >= MAX_DISPATCH_ATTEMPTS_PER_KEY) {
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
