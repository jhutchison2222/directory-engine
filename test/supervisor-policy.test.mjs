import { describe, expect, it } from "vitest";
import {
  AUTONOMY_BLOCKED_LABEL,
  AUTONOMY_BLOCKED_REASON,
  AUTONOMY_READY_LABEL,
  MAX_DISPATCH_ATTEMPTS_PER_KEY,
  REASONS,
  RETRY_INTERVAL_MS,
  TRUSTED_INDEPENDENT_REVIEWER_LOGINS,
  computeIssueStateFingerprint,
  evaluateIssueAction,
  evaluatePullRequestAction,
  findActiveHoldLabel,
  isCiRelevantCheckName,
  isIndependentReviewerLogin,
  isRetryDue,
  selectLatestReviewEvent,
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
    reviewEvents: [],
    ...overrides,
  };
}

describe("isIndependentReviewerLogin", () => {
  it("accepts every trusted allowlisted login", () => {
    for (const login of TRUSTED_INDEPENDENT_REVIEWER_LOGINS) {
      expect(isIndependentReviewerLogin(login)).toBe(true);
    }
  });

  it("rejects any login associated with the Claude implementer identity, even if allowlisted-looking", () => {
    expect(isIndependentReviewerLogin("claude")).toBe(false);
    expect(isIndependentReviewerLogin("claude[bot]")).toBe(false);
    expect(isIndependentReviewerLogin("Claude-Code")).toBe(false);
  });

  it("rejects a generic third-party reviewer login not on the trusted allowlist", () => {
    expect(isIndependentReviewerLogin("codex-reviewer-bot")).toBe(false);
    expect(isIndependentReviewerLogin("some-random-approver")).toBe(false);
  });

  it("rejects github-actions[bot] and other generic bot logins", () => {
    expect(isIndependentReviewerLogin("github-actions[bot]")).toBe(false);
    expect(isIndependentReviewerLogin("dependabot[bot]")).toBe(false);
  });

  it("rejects a missing login", () => {
    expect(isIndependentReviewerLogin(undefined)).toBe(false);
    expect(isIndependentReviewerLogin("")).toBe(false);
  });
});

describe("isCiRelevantCheckName", () => {
  it("accepts an ordinary CI check name", () => {
    expect(isCiRelevantCheckName("Project governance")).toBe(true);
    expect(isCiRelevantCheckName("test")).toBe(true);
  });

  it("excludes Claude's own review check to avoid a circular/non-CI signal", () => {
    expect(isCiRelevantCheckName("Claude")).toBe(false);
    expect(isCiRelevantCheckName("Claude Code Review")).toBe(false);
  });

  it("excludes the supervisor's own check to avoid a self-referential CI signal", () => {
    expect(isCiRelevantCheckName("Autonomy supervisor")).toBe(false);
    expect(isCiRelevantCheckName("Autonomy Supervisor / supervise")).toBe(false);
  });

  it("rejects a missing or empty name", () => {
    expect(isCiRelevantCheckName(undefined)).toBe(false);
    expect(isCiRelevantCheckName("")).toBe(false);
    expect(isCiRelevantCheckName("   ")).toBe(false);
  });
});

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
    const decision = evaluatePullRequestAction(pr({ checks: passingChecks, reviewEvents: [] }), NOW);
    expect(decision.action).toBe("dispatch");
    expect(decision.reason).toBe(REASONS.REVIEW_MISSING);
  });

  it("treats a review recorded against a stale head as missing", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        reviewEvents: [{ headSha: HEAD_B, state: "approved", submittedAt: "2026-09-02T10:00:00Z" }],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_MISSING);
  });

  it("dispatches review_rejected on an exact-head changes_requested review", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        reviewEvents: [{ headSha: HEAD_A, state: "changes_requested", submittedAt: "2026-09-02T10:00:00Z" }],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_REJECTED);
  });

  it("dispatches review_rejected on an exact-head dismissed review (supersession)", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        reviewEvents: [{ headSha: HEAD_A, state: "dismissed", submittedAt: "2026-09-02T10:00:00Z" }],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.REVIEW_REJECTED);
  });

  it("dispatches merge_ready on an exact-head approved review", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        reviewEvents: [{ headSha: HEAD_A, state: "approved", submittedAt: "2026-09-02T10:00:00Z" }],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.MERGE_READY);
  });

  it("skips while an exact-head review is still pending", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        reviewEvents: [{ headSha: HEAD_A, state: "pending", submittedAt: "2026-09-02T10:00:00Z" }],
      }),
      NOW,
    );
    expect(decision).toEqual({ action: "skip", reason: "awaiting_review" });
  });

  it("PR #24 stale-verdict race: a later rejection at the same exact head overrides an earlier acceptance", () => {
    const decision = evaluatePullRequestAction(
      pr({
        checks: passingChecks,
        reviewEvents: [
          { headSha: HEAD_A, state: "approved", submittedAt: "2026-09-02T09:00:00Z" },
          { headSha: HEAD_A, state: "changes_requested", submittedAt: "2026-09-02T11:00:00Z" },
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
        reviewEvents: [
          { headSha: HEAD_A, state: "changes_requested", submittedAt: "2026-09-02T09:00:00Z" },
          { headSha: HEAD_A, state: "approved", submittedAt: "2026-09-02T11:00:00Z" },
        ],
      }),
      NOW,
    );
    expect(decision.reason).toBe(REASONS.MERGE_READY);
  });
});

describe("selectLatestReviewEvent", () => {
  it("returns null when no event matches the exact head", () => {
    expect(
      selectLatestReviewEvent([{ headSha: HEAD_B, state: "approved", submittedAt: "2026-09-02T09:00:00Z" }], HEAD_A),
    ).toBeNull();
  });

  it("returns the chronologically latest event at the exact head", () => {
    const latest = selectLatestReviewEvent(
      [
        { headSha: HEAD_A, state: "approved", submittedAt: "2026-09-02T09:00:00Z" },
        { headSha: HEAD_A, state: "dismissed", submittedAt: "2026-09-02T10:00:00Z" },
        { headSha: HEAD_B, state: "approved", submittedAt: "2026-09-02T12:00:00Z" },
      ],
      HEAD_A,
    );
    expect(latest).toEqual({ headSha: HEAD_A, state: "dismissed", submittedAt: "2026-09-02T10:00:00Z" });
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

describe("evaluatePullRequestAction: bounded retries and autonomy-blocked", () => {
  const failingChecks = { headSha: HEAD_A, conclusion: "failure" };

  function dispatchesAtCount(count) {
    const idempotencyKey = buildIdempotencyKey({
      subjectType: "pull_request",
      subjectNumber: 26,
      stateId: HEAD_A,
      reason: REASONS.CI_FAILED,
    });
    const dispatches = [];
    for (let i = 0; i < count; i += 1) {
      dispatches.push({
        key: idempotencyKey,
        dispatchedAt: new Date(NOW.getTime() - RETRY_INTERVAL_MS * (count - i)).toISOString(),
      });
    }
    return { idempotencyKey, dispatches };
  }

  it(`still allows a dispatch at ${MAX_DISPATCH_ATTEMPTS_PER_KEY - 1} prior attempts`, () => {
    const { dispatches } = dispatchesAtCount(MAX_DISPATCH_ATTEMPTS_PER_KEY - 1);
    const decision = evaluatePullRequestAction(pr({ checks: failingChecks }), NOW, dispatches);
    expect(decision.action).toBe("dispatch");
  });

  it(`blocks instead of dispatching once ${MAX_DISPATCH_ATTEMPTS_PER_KEY} attempts have already been made for the same exact-head key`, () => {
    const { dispatches, idempotencyKey } = dispatchesAtCount(MAX_DISPATCH_ATTEMPTS_PER_KEY);
    const decision = evaluatePullRequestAction(pr({ checks: failingChecks }), NOW, dispatches);
    expect(decision).toEqual({ action: "blocked", reason: AUTONOMY_BLOCKED_REASON, idempotencyKey });
  });

  it("a new head resets the attempt budget even if the old head was fully exhausted", () => {
    const { dispatches } = dispatchesAtCount(MAX_DISPATCH_ATTEMPTS_PER_KEY);
    const decision = evaluatePullRequestAction(
      pr({ headSha: HEAD_B, checks: { headSha: HEAD_B, conclusion: "failure" } }),
      NOW,
      dispatches,
    );
    expect(decision.action).toBe("dispatch");
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
