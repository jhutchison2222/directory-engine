import { describe, expect, it } from "vitest";
import {
  AUTONOMY_BLOCKED_LABEL,
  AUTONOMY_BLOCKED_REASON,
  AUTONOMY_READY_LABEL,
  MAX_DISPATCH_ATTEMPTS_PER_KEY,
  MAX_REMEDIATION_CYCLES_PER_SUBJECT,
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

describe("evaluatePullRequestAction: security redesign item 8 - packet-wide remediation-cycle ceiling", () => {
  const HEAD_C = "c".repeat(40);
  const HEAD_D = "d".repeat(40);
  const failingChecksAt = (headSha) => ({ headSha, conclusion: "failure" });

  function remediationDispatchAt(headSha, reason, secondsAgo) {
    return {
      key: buildIdempotencyKey({ subjectType: "pull_request", subjectNumber: 26, stateId: headSha, reason }),
      dispatchedAt: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
    };
  }

  it("holds a brand-new fourth head immediately once three distinct heads have already gone through remediation, even with zero attempts at the new head", () => {
    const dispatches = [
      remediationDispatchAt(HEAD_A, REASONS.CI_FAILED, 14400),
      remediationDispatchAt(HEAD_B, REASONS.REVIEW_MISSING, 10800),
      remediationDispatchAt(HEAD_C, REASONS.REVIEW_REJECTED, 7200),
    ];
    const decision = evaluatePullRequestAction(pr({ headSha: HEAD_D, checks: failingChecksAt(HEAD_D) }), NOW, dispatches);
    expect(decision.action).toBe("blocked");
    expect(decision.reason).toBe(AUTONOMY_BLOCKED_REASON);
  });

  it("does not hold a new head when fewer than three distinct heads have gone through remediation", () => {
    const dispatches = [
      remediationDispatchAt(HEAD_A, REASONS.CI_FAILED, 14400),
      remediationDispatchAt(HEAD_B, REASONS.REVIEW_MISSING, 10800),
    ];
    const decision = evaluatePullRequestAction(pr({ headSha: HEAD_C, checks: failingChecksAt(HEAD_C) }), NOW, dispatches);
    expect(decision.action).toBe("dispatch");
  });

  it("keeps retrying under the ordinary per-head cap at a head that is already one of the three spent remediation heads, instead of blocking it immediately", () => {
    const dispatches = [
      remediationDispatchAt(HEAD_A, REASONS.CI_FAILED, 14400),
      remediationDispatchAt(HEAD_B, REASONS.REVIEW_MISSING, 10800),
      remediationDispatchAt(HEAD_C, REASONS.REVIEW_REJECTED, 7200),
    ];
    // HEAD_C already has exactly one remediation dispatch recorded (below
    // MAX_DISPATCH_ATTEMPTS_PER_KEY), and is already counted among the three
    // spent heads - a fresh evaluation at HEAD_C itself must still be
    // allowed to retry under its own per-head budget, not be treated as a
    // "new" fourth head.
    const decision = evaluatePullRequestAction(pr({ headSha: HEAD_C, checks: failingChecksAt(HEAD_C) }), NOW, dispatches);
    expect(decision.action).toBe("dispatch");
  });

  it("retry-attempt accounting (MAX_DISPATCH_ATTEMPTS_PER_KEY) and remediation-cycle accounting (MAX_REMEDIATION_CYCLES_PER_SUBJECT) are independent knobs", () => {
    expect(MAX_REMEDIATION_CYCLES_PER_SUBJECT).toBe(3);
    expect(MAX_DISPATCH_ATTEMPTS_PER_KEY).toBe(3);
  });

  it("merge_ready dispatch at a brand-new head is never blocked by the packet-wide remediation ceiling", () => {
    const dispatches = [
      remediationDispatchAt(HEAD_A, REASONS.CI_FAILED, 14400),
      remediationDispatchAt(HEAD_B, REASONS.REVIEW_MISSING, 10800),
      remediationDispatchAt(HEAD_C, REASONS.REVIEW_REJECTED, 7200),
    ];
    const decision = evaluatePullRequestAction(
      pr({
        headSha: HEAD_D,
        checks: { headSha: HEAD_D, conclusion: "success" },
        ownerVerdictEvents: [verdict(OWNER_VERDICT_KINDS.ACCEPTED, HEAD_D, "2026-09-02T08:00:00Z")],
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
  it("selects only the lowest-numbered eligible issue, even when limit would allow more and a later issue is also eligible", () => {
    // Security redesign item 7: even with a generous limit, a second
    // eligible, later-numbered issue (30) must never be selected alongside
    // the front of the queue (10) - only one queued packet may be started
    // per cycle, in ascending order, so work never overlaps.
    const items = [
      { issue: { number: 30, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
      { issue: { number: 10, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
      { issue: { number: 20, labels: [] }, dispatches: [] },
    ];
    const selected = selectQueuedTasks(items, NOW, { limit: 5 });
    expect(selected.map((entry) => entry.issue.number)).toEqual([10]);
  });

  it("respects the limit", () => {
    const items = [
      { issue: { number: 1, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
      { issue: { number: 2, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
    ];
    expect(selectQueuedTasks(items, NOW, { limit: 1 }).map((entry) => entry.issue.number)).toEqual([1]);
  });

  it("DE-0010 item 3 regression: surfaces a held queued issue's decision instead of silently discarding it, without starting the next issue this cycle", () => {
    // The default limit (1, as supervisor-run.mjs always calls this with) is
    // what actually matters here: production never asks for more than one
    // queued item per cycle, so the held issue at the front of the queue
    // must occupy that single slot rather than being skipped past.
    const items = [
      { issue: { number: 5, labels: [AUTONOMY_READY_LABEL, "major-decision"] }, dispatches: [] },
      { issue: { number: 10, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
    ];
    const selected = selectQueuedTasks(items, NOW);
    expect(selected).toHaveLength(1);
    expect(selected[0].issue.number).toBe(5);
    expect(selected[0].decision).toEqual({ action: "hold", reason: "major-decision" });
  });

  it("DE-0010 item 3 regression: surfaces a retry-exhausted queued issue as blocked, without starting a new task underneath it", () => {
    const issue = { number: 6, labels: [AUTONOMY_READY_LABEL], title: "t", body: "b" };
    const key = buildIdempotencyKey({
      subjectType: "issue",
      subjectNumber: 6,
      stateId: computeIssueStateFingerprint(issue),
      reason: REASONS.QUEUED_TASK_START,
    });
    const dispatches = Array.from({ length: MAX_DISPATCH_ATTEMPTS_PER_KEY }, (_, i) => ({
      key,
      dispatchedAt: new Date(NOW.getTime() - RETRY_INTERVAL_MS * (MAX_DISPATCH_ATTEMPTS_PER_KEY - i)).toISOString(),
    }));
    const items = [
      { issue, dispatches },
      { issue: { number: 7, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
    ];
    const selected = selectQueuedTasks(items, NOW, { limit: 1 });
    expect(selected).toHaveLength(1);
    expect(selected[0].issue.number).toBe(6);
    expect(selected[0].decision).toEqual({ action: "blocked", reason: AUTONOMY_BLOCKED_REASON, idempotencyKey: key });
  });

  it("still skips past an issue that is not autonomy-ready (not part of the queue at all) to find the queue's front", () => {
    const items = [
      { issue: { number: 1, labels: [] }, dispatches: [] }, // not_autonomy_ready
      { issue: { number: 2, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] }, // dispatch
    ];
    const selected = selectQueuedTasks(items, NOW, { limit: 5 });
    expect(selected.map((entry) => entry.issue.number)).toEqual([2]);
  });

  it("security redesign item 7: a front-of-queue issue in its retry cooldown blocks a later, otherwise-dispatchable issue from starting this cycle", () => {
    const frontIssue = { number: 10, labels: [AUTONOMY_READY_LABEL], title: "t", body: "b" };
    const key = buildIdempotencyKey({
      subjectType: "issue",
      subjectNumber: 10,
      stateId: computeIssueStateFingerprint(frontIssue),
      reason: REASONS.QUEUED_TASK_START,
    });
    const items = [
      // The front issue (10) was just dispatched a moment ago and is well
      // within RETRY_INTERVAL_MS, so its own decision is a "retry_not_due"
      // skip - but it must still occupy this cycle's one selection slot.
      { issue: frontIssue, dispatches: [{ key, dispatchedAt: NOW.toISOString() }] },
      { issue: { number: 30, labels: [AUTONOMY_READY_LABEL], title: "t2", body: "b2" }, dispatches: [] },
    ];
    const selected = selectQueuedTasks(items, NOW, { limit: 5 });
    expect(selected).toHaveLength(1);
    expect(selected[0].issue.number).toBe(10);
    expect(selected[0].decision.action).toBe("skip");
    expect(selected[0].decision.reason).toBe("retry_not_due");
  });

  it("security redesign item 7: a front-of-queue issue that is held blocks a later, otherwise-dispatchable issue from starting this cycle", () => {
    const items = [
      { issue: { number: 10, labels: [AUTONOMY_READY_LABEL, "security-review"] }, dispatches: [] },
      { issue: { number: 30, labels: [AUTONOMY_READY_LABEL] }, dispatches: [] },
    ];
    const selected = selectQueuedTasks(items, NOW, { limit: 5 });
    expect(selected.map((entry) => entry.issue.number)).toEqual([10]);
    expect(selected[0].decision.action).toBe("hold");
  });
});
