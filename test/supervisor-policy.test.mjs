import { describe, expect, it } from "vitest";
import {
  AUTONOMY_READY_LABEL,
  REASONS,
  RETRY_INTERVAL_MS,
  computeIssueStateFingerprint,
  evaluateIssueAction,
  evaluatePullRequestAction,
  findActiveHoldLabel,
  isIndependentReviewerLogin,
  isRetryDue,
  selectQueuedTasks,
} from "../scripts/lib/supervisor-policy.mjs";
import { buildIdempotencyKey } from "../scripts/lib/supervisor-idempotency.mjs";

const NOW = new Date("2026-09-02T12:00:00Z");
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function pr(overrides = {}) {
  return {
    number: 26,
    headSha: HEAD_A,
    isDraft: false,
    labels: [],
    checks: null,
    review: null,
    ...overrides,
  };
}

describe("isIndependentReviewerLogin", () => {
  it("accepts a non-Claude reviewer login", () => {
    expect(isIndependentReviewerLogin("codex-reviewer-bot")).toBe(true);
  });

  it("rejects any login associated with the Claude implementer identity", () => {
    expect(isIndependentReviewerLogin("claude")).toBe(false);
    expect(isIndependentReviewerLogin("claude[bot]")).toBe(false);
    expect(isIndependentReviewerLogin("Claude-Code")).toBe(false);
  });

  it("rejects a missing login", () => {
    expect(isIndependentReviewerLogin(undefined)).toBe(false);
    expect(isIndependentReviewerLogin("")).toBe(false);
  });
});

describe("findActiveHoldLabel", () => {
  it("returns null when no hold label is present", () => {
    expect(findActiveHoldLabel(["autonomy-ready", "accepted"])).toBeNull();
  });

  it("returns the matching hold label", () => {
    expect(findActiveHoldLabel(["security-hold"])).toBe("security-hold");
    expect(findActiveHoldLabel(["major-decision-required"])).toBe("major-decision-required");
  });
});

describe("evaluatePullRequestAction: draft handling", () => {
  it("never dispatches for a draft pull request, even with failing checks", () => {
    const decision = evaluatePullRequestAction(
      pr({ isDraft: true, checks: { headSha: HEAD_A, conclusion: "failure" } }),
      NOW,
    );
    expect(decision).toEqual({ action: "skip", reason: "draft" });
  });
});

describe("evaluatePullRequestAction: security/major-decision holds", () => {
  it("holds instead of dispatching when a hold label is present, even with failing checks", () => {
    const decision = evaluatePullRequestAction(
      pr({ labels: ["security-hold"], checks: { headSha: HEAD_A, conclusion: "failure" } }),
      NOW,
    );
    expect(decision).toEqual({ action: "hold", reason: "security-hold" });
  });
});

describe("evaluatePullRequestAction: exact-head CI state", () => {
  it("dispatches ci_failed when checks fail at the exact current head", () => {
    const decision = evaluatePullRequestAction(pr({ checks: { headSha: HEAD_A, conclusion: "failure" } }), NOW);
    expect(decision.action).toBe("dispatch");
    expect(decision.reason).toBe(REASONS.CI_FAILED);
  });

  it("treats checks recorded against a stale head as absent (stale-evidence invalidation)", () => {
    const decision = evaluatePullRequestAction(
      pr({ headSha: HEAD_B, checks: { headSha: HEAD_A, conclusion: "failure" } }),
      NOW,
    );
    expect(decision).toEqual({ action: "skip", reason: "awaiting_ci" });
  });

  it("skips when there is no check evidence at all", () => {
    expect(evaluatePullRequestAction(pr(), NOW)).toEqual({ action: "skip", reason: "awaiting_ci" });
  });
});

describe("evaluatePullRequestAction: exact-head review state", () => {
  const passingChecks = { headSha: HEAD_A, conclusion: "success" };

  it("dispatches review_missing when checks pass but no independent review exists at head", () => {
    const decision = evaluatePullRequestAction(pr({ checks: passingChecks, review: null }), NOW);
    expect(decision.action).toBe("dispatch");
    expect(decision.reason).toBe(REASONS.REVIEW_MISSING);
  });

  it("treats a review recorded against a stale head as missing", () => {
    const decision = evaluatePullRequestAction(
      pr({ checks: passingChecks, review: { headSha: HEAD_B, state: "approved" } }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_MISSING);
  });

  it("dispatches review_rejected on an exact-head changes_requested review", () => {
    const decision = evaluatePullRequestAction(
      pr({ checks: passingChecks, review: { headSha: HEAD_A, state: "changes_requested" } }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_REJECTED);
  });

  it("dispatches merge_ready on an exact-head approved review", () => {
    const decision = evaluatePullRequestAction(
      pr({ checks: passingChecks, review: { headSha: HEAD_A, state: "approved" } }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.MERGE_READY);
  });

  it("skips while an exact-head review is still pending", () => {
    const decision = evaluatePullRequestAction(
      pr({ checks: passingChecks, review: { headSha: HEAD_A, state: "pending" } }),
      NOW,
    );
    expect(decision).toEqual({ action: "skip", reason: "awaiting_review" });
  });
});

describe("evaluatePullRequestAction: idempotency and retry timing", () => {
  const failingChecks = { headSha: HEAD_A, conclusion: "failure" };

  it("suppresses a duplicate dispatch for the same exact-head reason immediately after dispatching", () => {
    const idempotencyKey = buildIdempotencyKey({
      subjectType: "pull_request",
      subjectNumber: 26,
      stateId: HEAD_A,
      reason: REASONS.CI_FAILED,
    });
    const dispatches = [{ key: idempotencyKey, dispatchedAt: NOW.toISOString() }];
    const decision = evaluatePullRequestAction(pr({ checks: failingChecks }), NOW, dispatches);
    expect(decision).toEqual({ action: "skip", reason: "retry_not_due", idempotencyKey });
  });

  it("allows a redispatch once the retry interval has elapsed and the condition still holds", () => {
    const idempotencyKey = buildIdempotencyKey({
      subjectType: "pull_request",
      subjectNumber: 26,
      stateId: HEAD_A,
      reason: REASONS.CI_FAILED,
    });
    const dispatchedAt = new Date(NOW.getTime() - RETRY_INTERVAL_MS - 1);
    const dispatches = [{ key: idempotencyKey, dispatchedAt: dispatchedAt.toISOString() }];
    const decision = evaluatePullRequestAction(pr({ checks: failingChecks }), NOW, dispatches);
    expect(decision).toEqual({ action: "dispatch", reason: REASONS.CI_FAILED, idempotencyKey });
  });

  it("does not let a prior dispatch at an old head block a fresh dispatch at a new head", () => {
    const oldKey = buildIdempotencyKey({
      subjectType: "pull_request",
      subjectNumber: 26,
      stateId: HEAD_A,
      reason: REASONS.CI_FAILED,
    });
    const dispatches = [{ key: oldKey, dispatchedAt: NOW.toISOString() }];
    const decision = evaluatePullRequestAction(
      pr({ headSha: HEAD_B, checks: { headSha: HEAD_B, conclusion: "failure" } }),
      NOW,
      dispatches,
    );
    expect(decision.action).toBe("dispatch");
    expect(decision.idempotencyKey).not.toBe(oldKey);
  });
});

describe("isRetryDue", () => {
  it("is due when there is no prior dispatch", () => {
    expect(isRetryDue(NOW, null)).toBe(true);
  });

  it("is not due within the retry interval", () => {
    expect(isRetryDue(NOW, NOW.getTime() - 1000)).toBe(false);
  });

  it("is due once the retry interval has fully elapsed", () => {
    expect(isRetryDue(NOW, NOW.getTime() - RETRY_INTERVAL_MS)).toBe(true);
  });
});

describe("computeIssueStateFingerprint", () => {
  it("is stable for the same content regardless of label order", () => {
    const a = computeIssueStateFingerprint({ number: 1, labels: ["a", "b"], title: "t", body: "b" });
    const b = computeIssueStateFingerprint({ number: 1, labels: ["b", "a"], title: "t", body: "b" });
    expect(a).toBe(b);
  });

  it("changes when the body changes (stale-evidence invalidation for issues)", () => {
    const a = computeIssueStateFingerprint({ number: 1, labels: [], title: "t", body: "one" });
    const b = computeIssueStateFingerprint({ number: 1, labels: [], title: "t", body: "two" });
    expect(a).not.toBe(b);
  });
});

describe("evaluateIssueAction: queued-task eligibility", () => {
  it("skips an issue without the autonomy-ready label", () => {
    expect(evaluateIssueAction({ number: 25, labels: [] }, NOW)).toEqual({
      action: "skip",
      reason: "not_autonomy_ready",
    });
  });

  it("dispatches an eligible autonomy-ready issue with no prior dispatch", () => {
    const decision = evaluateIssueAction({ number: 25, labels: [AUTONOMY_READY_LABEL] }, NOW);
    expect(decision.action).toBe("dispatch");
    expect(decision.reason).toBe(REASONS.QUEUED_TASK_START);
  });

  it("holds instead of dispatching when a hold label is also present", () => {
    const decision = evaluateIssueAction(
      { number: 25, labels: [AUTONOMY_READY_LABEL, "major-decision-required"] },
      NOW,
    );
    expect(decision).toEqual({ action: "hold", reason: "major-decision-required" });
  });

  it("suppresses a duplicate dispatch for unchanged issue content", () => {
    const issue = { number: 25, labels: [AUTONOMY_READY_LABEL], title: "t", body: "b" };
    const key = buildIdempotencyKey({
      subjectType: "issue",
      subjectNumber: 25,
      stateId: computeIssueStateFingerprint(issue),
      reason: REASONS.QUEUED_TASK_START,
    });
    const decision = evaluateIssueAction(issue, NOW, [{ key, dispatchedAt: NOW.toISOString() }]);
    expect(decision).toEqual({ action: "skip", reason: "retry_not_due", idempotencyKey: key });
  });
});

describe("selectQueuedTasks: deterministic ordering and bounded selection", () => {
  it("selects only eligible issues in ascending issue-number order, bounded by limit", () => {
    const items = [
      { issue: { number: 30, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
      { issue: { number: 10, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
      { issue: { number: 20, labels: [] }, dispatches: [] },
    ];
    const selected = selectQueuedTasks(items, NOW, { limit: 5 });
    expect(selected.map((entry) => entry.issue.number)).toEqual([10, 30]);
  });

  it("respects the limit", () => {
    const items = [
      { issue: { number: 1, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
      { issue: { number: 2, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
    ];
    expect(selectQueuedTasks(items, NOW, { limit: 1 }).map((entry) => entry.issue.number)).toEqual([1]);
  });
});
