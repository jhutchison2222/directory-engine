import { describe, expect, it } from "vitest";
import {
  AUTONOMY_BLOCKED_LABEL,
  AUTONOMY_BLOCKED_REASON,
  AUTONOMY_READY_LABEL,
  MAX_DISPATCH_ATTEMPTS_PER_KEY,
  REASONS,
  RETRY_INTERVAL_MS,
  computeIssueStateFingerprint,
  evaluateIssueAction,
  evaluatePullRequestAction,
  findActiveHoldLabel,
  isRetryDue,
  selectQueuedTasks,
} from "../scripts/lib/supervisor-policy.mjs";
import { buildIdempotencyKey } from "../scripts/lib/supervisor-idempotency.mjs";
import { OWNER_VERDICT_KINDS } from "../scripts/lib/supervisor-verdicts.mjs";

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
    ownerVerdictEvents: [],
    ...overrides,
  };
}

function verdict(kind, headSha, submittedAt) {
  return { kind, headSha, submittedAt };
}

describe("findActiveHoldLabel", () => {
  it("returns null when no hold label is present", () => {
    expect(findActiveHoldLabel(["autonomy-ready", "accepted"])).toBeNull();
  });

  it("returns the matching hold label using the exact authorized names", () => {
    expect(findActiveHoldLabel(["security-review"])).toBe("security-review");
    expect(findActiveHoldLabel(["major-decision"])).toBe("major-decision");
  });

  it("treats the supervisor-applied AUTONOMY_BLOCKED_LABEL as a hold label", () => {
    expect(findActiveHoldLabel([AUTONOMY_BLOCKED_LABEL])).toBe(AUTONOMY_BLOCKED_LABEL);
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
      pr({ labels: ["security-review"], checks: { headSha: HEAD_A, conclusion: "failure" } }),
      NOW,
    );
    expect(decision).toEqual({ action: "hold", reason: "security-review" });
  });

  it("holds on major-decision", () => {
    const decision = evaluatePullRequestAction(
      pr({ labels: ["major-decision"], checks: { headSha: HEAD_A, conclusion: "failure" } }),
      NOW,
    );
    expect(decision).toEqual({ action: "hold", reason: "major-decision" });
  });

  it("holds once the supervisor has already applied AUTONOMY_BLOCKED_LABEL", () => {
    const decision = evaluatePullRequestAction(
      pr({ labels: [AUTONOMY_BLOCKED_LABEL], checks: { headSha: HEAD_A, conclusion: "failure" } }),
      NOW,
    );
    expect(decision).toEqual({ action: "hold", reason: AUTONOMY_BLOCKED_LABEL });
  });
});

describe("evaluatePullRequestAction: exact-head governance CI state", () => {
  it("dispatches ci_failed when governance checks fail at the exact current head", () => {
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

  it("reports a pending exact-head governance run as awaiting_ci, not awaiting_review", () => {
    const decision = evaluatePullRequestAction(
      pr({ checks: { headSha: HEAD_A, conclusion: "pending" } }),
      NOW,
    );
    expect(decision).toEqual({ action: "skip", reason: "awaiting_ci" });
  });
});

describe("evaluatePullRequestAction: exact-head owner verdict chronology", () => {
  const passingChecks = { headSha: HEAD_A, conclusion: "success" };

  it("dispatches review_missing when checks pass but no owner verdict exists at head", () => {
    const decision = evaluatePullRequestAction(pr({ checks: passingChecks, ownerVerdictEvents: [] }), NOW);
    expect(decision.action).toBe("dispatch");
    expect(decision.reason).toBe(REASONS.REVIEW_MISSING);
  });

  it("treats an owner verdict recorded against a stale head as missing", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [verdict(OWNER_VERDICT_KINDS.ACCEPTED, HEAD_B, "2026-09-02T10:00:00Z")],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_MISSING);
  });

  it("dispatches review_rejected on an exact-head REJECTED owner verdict", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [verdict(OWNER_VERDICT_KINDS.REJECTED, HEAD_A, "2026-09-02T10:00:00Z")],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_REJECTED);
  });

  it("dispatches review_rejected on an exact-head SUPERSEDED owner verdict", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [verdict(OWNER_VERDICT_KINDS.SUPERSEDED, HEAD_A, "2026-09-02T10:00:00Z")],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_REJECTED);
  });

  it("dispatches review_rejected on an exact-head REMEDIATION_REQUESTED owner verdict", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [verdict(OWNER_VERDICT_KINDS.REMEDIATION_REQUESTED, HEAD_A, "2026-09-02T10:00:00Z")],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_REJECTED);
  });

  it("dispatches merge_ready on an exact-head ACCEPTED owner verdict", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [verdict(OWNER_VERDICT_KINDS.ACCEPTED, HEAD_A, "2026-09-02T10:00:00Z")],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.MERGE_READY);
  });

  it("PR #24 stale-verdict race: a later rejection at the same exact head overrides an earlier acceptance", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [
          verdict(OWNER_VERDICT_KINDS.ACCEPTED, HEAD_A, "2026-09-02T09:00:00Z"),
          verdict(OWNER_VERDICT_KINDS.REJECTED, HEAD_A, "2026-09-02T11:00:00Z"),
        ],
      }),
      NOW,
    );
    expect(decision.action).toBe("dispatch");
    expect(decision.reason).toBe(REASONS.REVIEW_REJECTED);
  });

  it("PR #24 stale-verdict race: array order does not matter, only chronology (submittedAt) does", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [
          verdict(OWNER_VERDICT_KINDS.REJECTED, HEAD_A, "2026-09-02T09:00:00Z"),
          verdict(OWNER_VERDICT_KINDS.ACCEPTED, HEAD_A, "2026-09-02T11:00:00Z"),
        ],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.MERGE_READY);
  });

  it("a later owner REMEDIATION_REQUESTED supersedes an earlier ACCEPTED at the same exact head", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [
          verdict(OWNER_VERDICT_KINDS.ACCEPTED, HEAD_A, "2026-09-02T09:00:00Z"),
          verdict(OWNER_VERDICT_KINDS.REMEDIATION_REQUESTED, HEAD_A, "2026-09-02T11:00:00Z"),
        ],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_REJECTED);
  });

  it("a non-actionable follow-up (no classified verdict) never overwrites an earlier real acceptance", () => {
    // Regression: a prior design collapsed every review event (including
    // GitHub's non-actionable COMMENTED state) into "the latest at head",
    // so a comment-only follow-up review after a real approval silently
    // stalled merge-ready dispatch. Because unclassifiable events are never
    // added to ownerVerdictEvents at all (see buildOwnerVerdictEvents), the
    // earlier ACCEPTED remains the only, and therefore latest, event.
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [verdict(OWNER_VERDICT_KINDS.ACCEPTED, HEAD_A, "2026-09-02T09:00:00Z")],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.MERGE_READY);
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

  it("two concurrent evaluations of identical, unchanged state compute the identical idempotency key (simultaneous schedule/event dedupe)", () => {
    const scheduledDecision = evaluatePullRequestAction(pr({ checks: failingChecks }), NOW, []);
    const eventDrivenDecision = evaluatePullRequestAction(pr({ checks: failingChecks }), NOW, []);
    expect(scheduledDecision).toEqual(eventDrivenDecision);
    expect(scheduledDecision.action).toBe("dispatch");
  });
});

describe("evaluatePullRequestAction: bounded retries span equivalent remediation reasons", () => {
  const failingChecks = { headSha: HEAD_A, conclusion: "failure" };
  const passingChecks = { headSha: HEAD_A, conclusion: "success" };

  function dispatchAt(reason, secondsAgo) {
    return {
      key: buildIdempotencyKey({ subjectType: "pull_request", subjectNumber: 26, stateId: HEAD_A, reason }),
      dispatchedAt: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
    };
  }

  it(`still allows a dispatch at ${MAX_DISPATCH_ATTEMPTS_PER_KEY - 1} prior attempts of the same reason`, () => {
    const dispatches = [dispatchAt(REASONS.CI_FAILED, 7200), dispatchAt(REASONS.CI_FAILED, 3600)];
    const decision = evaluatePullRequestAction(pr({ checks: failingChecks }), NOW, dispatches);
    expect(decision.action).toBe("dispatch");
  });

  it(`blocks once ${MAX_DISPATCH_ATTEMPTS_PER_KEY} attempts have already been made for the same exact head, even across different equivalent reasons`, () => {
    const dispatches = [
      dispatchAt(REASONS.CI_FAILED, 10800),
      dispatchAt(REASONS.REVIEW_MISSING, 7200),
      dispatchAt(REASONS.REVIEW_REJECTED, 3600),
    ];
    const decision = evaluatePullRequestAction(pr({ checks: failingChecks }), NOW, dispatches);
    expect(decision.action).toBe("blocked");
    expect(decision.reason).toBe(AUTONOMY_BLOCKED_REASON);
  });

  it("a new head resets the attempt budget even if the old head was fully exhausted across mixed reasons", () => {
    const dispatches = [
      dispatchAt(REASONS.CI_FAILED, 10800),
      dispatchAt(REASONS.REVIEW_MISSING, 7200),
      dispatchAt(REASONS.REVIEW_REJECTED, 3600),
    ];
    const decision = evaluatePullRequestAction(
      pr({ headSha: HEAD_B, checks: { headSha: HEAD_B, conclusion: "failure" } }),
      NOW,
      dispatches,
    );
    expect(decision.action).toBe("dispatch");
  });

  it("merge_ready dispatch is independently idempotent and is never blocked by the remediation attempt cap", () => {
    const dispatches = [
      dispatchAt(REASONS.CI_FAILED, 14400),
      dispatchAt(REASONS.REVIEW_MISSING, 10800),
      dispatchAt(REASONS.REVIEW_REJECTED, 7200),
      dispatchAt(REASONS.MERGE_READY, 3600),
    ];
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        ownerVerdictEvents: [verdict(OWNER_VERDICT_KINDS.ACCEPTED, HEAD_A, "2026-09-02T08:00:00Z")],
      }),
      NOW,
      dispatches,
    );
    expect(decision.action).toBe("dispatch");
    expect(decision.reason).toBe(REASONS.MERGE_READY);
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
      { number: 25, labels: [AUTONOMY_READY_LABEL, "major-decision"] },
      NOW,
    );
    expect(decision).toEqual({ action: "hold", reason: "major-decision" });
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

  it(`blocks once ${MAX_DISPATCH_ATTEMPTS_PER_KEY} attempts have already been made for the same issue content`, () => {
    const issue = { number: 25, labels: [AUTONOMY_READY_LABEL], title: "t", body: "b" };
    const key = buildIdempotencyKey({
      subjectType: "issue",
      subjectNumber: 25,
      stateId: computeIssueStateFingerprint(issue),
      reason: REASONS.QUEUED_TASK_START,
    });
    const dispatches = Array.from({ length: MAX_DISPATCH_ATTEMPTS_PER_KEY }, (_, i) => ({
      key,
      dispatchedAt: new Date(NOW.getTime() - RETRY_INTERVAL_MS * (MAX_DISPATCH_ATTEMPTS_PER_KEY - i)).toISOString(),
    }));
    const decision = evaluateIssueAction(issue, NOW, dispatches);
    expect(decision).toEqual({ action: "blocked", reason: AUTONOMY_BLOCKED_REASON, idempotencyKey: key });
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
