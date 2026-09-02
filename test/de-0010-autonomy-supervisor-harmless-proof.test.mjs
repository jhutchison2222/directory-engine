import { describe, expect, it } from "vitest";
import { runAutonomySupervisor } from "../scripts/lib/supervisor-run.mjs";
import { parseDispatchMarker } from "../scripts/lib/supervisor-idempotency.mjs";
import { AUTONOMY_BLOCKED_LABEL, MAX_DISPATCH_ATTEMPTS_PER_KEY, RETRY_INTERVAL_MS } from "../scripts/lib/supervisor-policy.mjs";

/**
 * Harmless, fully in-memory, deterministic end-to-end proof of DE-0010's
 * evaluation loop. Nothing here touches a live system, a real GitHub API, or
 * the real Workspace Agent endpoint: "GitHub" is a plain in-memory store and
 * "the Workspace Agent" is a call counter. This exercises the full
 * scheduled/manual/event-driven evaluation -> dispatch -> marker -> re-read
 * cycle end to end, including duplicate suppression, fresh exact-head
 * re-read, the retry-attempt cap, and the AUTONOMY_BLOCKED_LABEL hold, all
 * without any network access or credential material.
 */
function createFakeGitHub() {
  const pullRequests = new Map();
  const issues = new Map();
  const comments = new Map(); // subjectNumber -> [{ body }]
  const labels = new Map(); // subjectNumber -> Set<string>
  const dispatchCalls = [];

  function commentsFor(number) {
    if (!comments.has(number)) comments.set(number, []);
    return comments.get(number);
  }

  function labelsFor(number) {
    if (!labels.has(number)) labels.set(number, new Set());
    return labels.get(number);
  }

  function makeDeps(now) {
    return {
      now,
      async listPullRequests() {
        return [...pullRequests.values()].map((snapshot) => ({
          ...snapshot,
          labels: [...(snapshot.labels ?? []), ...labelsFor(snapshot.number)],
        }));
      },
      async listIssues() {
        return [...issues.values()].map((snapshot) => ({
          ...snapshot,
          labels: [...(snapshot.labels ?? []), ...labelsFor(snapshot.number)],
        }));
      },
      async listDispatchMarkers(_subjectType, number) {
        if (number === "throw") throw new Error("simulated transient GitHub API failure");
        return commentsFor(number)
          .map((comment) => parseDispatchMarker(comment.body))
          .filter((marker) => marker !== null);
      },
      async postDispatchMarker(_subjectType, number, markerBody) {
        commentsFor(number).push({ body: markerBody });
      },
      async addLabel(_subjectType, number, label) {
        labelsFor(number).add(label);
      },
      async dispatchToWorkspaceAgent({ idempotencyKey, reason, subject }) {
        dispatchCalls.push({ idempotencyKey, reason, subject });
        return { ok: true, status: 202 };
      },
    };
  }

  return { pullRequests, issues, dispatchCalls, labelsFor, makeDeps };
}

describe("DE-0010 harmless end-to-end proof", () => {
  it("dispatches once, suppresses duplicates, re-reads fresh state on a new head, and enforces active-PR precedence", async () => {
    const github = createFakeGitHub();
    const t0 = new Date("2026-09-02T12:00:00Z");
    const HEAD_A = "a".repeat(40);
    const HEAD_B = "b".repeat(40);

    github.pullRequests.set(100, {
      number: 100,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "success" },
      reviewEvents: [], // missing exact-head review
    });

    // Cycle 1 (scheduled tick): checks pass, review missing -> one wake-up.
    let results = await runAutonomySupervisor(github.makeDeps(t0));
    expect(github.dispatchCalls).toHaveLength(1);
    expect(github.dispatchCalls[0].reason).toBe("review_missing");
    expect(results).toEqual([
      {
        subjectType: "pull_request",
        number: 100,
        status: "dispatched",
        reason: "review_missing",
        idempotencyKey: github.dispatchCalls[0].idempotencyKey,
      },
    ]);

    // Cycle 2 (manual workflow_dispatch moments later, same exact-head state):
    // duplicate suppression - no second wake-up.
    const t1 = new Date(t0.getTime() + 60_000);
    results = await runAutonomySupervisor(github.makeDeps(t1));
    expect(github.dispatchCalls).toHaveLength(1);
    expect(results[0].status).toBe("skip");
    expect(results[0].reason).toBe("retry_not_due");

    // Cycle 3, after the retry interval elapses with the condition unchanged:
    // a bounded retry is allowed (retry timing), still the same reason/head.
    const t2 = new Date(t0.getTime() + RETRY_INTERVAL_MS + 1);
    results = await runAutonomySupervisor(github.makeDeps(t2));
    expect(github.dispatchCalls).toHaveLength(2);
    expect(github.dispatchCalls[1].reason).toBe("review_missing");

    // A queued autonomy-ready issue exists, but the pull request still needs
    // attention this cycle -> active-PR precedence means it is not touched.
    github.issues.set(200, { number: 200, labels: ["autonomy-ready"], title: "queued task", body: "do work" });
    const t3 = new Date(t2.getTime() + 1000);
    results = await runAutonomySupervisor(github.makeDeps(t3));
    expect(results.some((r) => r.subjectType === "issue")).toBe(false);
    expect(github.dispatchCalls).toHaveLength(2); // immediate re-run, still suppressed

    // Fresh exact-head re-read: a new commit lands (head B), with checks
    // passing and still no review at the new head. The stale head-A dispatch
    // history must not block a fresh dispatch at the new head, and it
    // happens immediately even though the retry window has not elapsed.
    github.pullRequests.set(100, {
      number: 100,
      headSha: HEAD_B,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_B, conclusion: "success" },
      reviewEvents: [],
    });
    const t4 = new Date(t3.getTime() + 1000);
    results = await runAutonomySupervisor(github.makeDeps(t4));
    expect(github.dispatchCalls).toHaveLength(3);
    expect(github.dispatchCalls[2].idempotencyKey).not.toBe(github.dispatchCalls[1].idempotencyKey);
    expect(results.some((r) => r.subjectType === "issue")).toBe(false); // PR still active this cycle

    // The pull request is now approved at the exact new head (merge-ready) -
    // one more wake-up, then the exact-head state goes quiet.
    github.pullRequests.set(100, {
      number: 100,
      headSha: HEAD_B,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_B, conclusion: "success" },
      reviewEvents: [{ headSha: HEAD_B, state: "approved", submittedAt: t4.toISOString() }],
    });
    const t5 = new Date(t4.getTime() + 1000);
    results = await runAutonomySupervisor(github.makeDeps(t5));
    expect(github.dispatchCalls).toHaveLength(4);
    expect(github.dispatchCalls[3].reason).toBe("merge_ready");

    // Only once the pull request actually leaves the open, non-draft
    // pipeline (the Workspace Agent merged it under its own standing
    // authorization - simulated here by it no longer being open) does the
    // queued autonomy-ready issue get picked up (queued-task selection,
    // unblocked once active-PR precedence clears).
    github.pullRequests.delete(100);
    const t6 = new Date(t5.getTime() + 1000);
    results = await runAutonomySupervisor(github.makeDeps(t6));
    expect(github.dispatchCalls).toHaveLength(5);
    expect(github.dispatchCalls[4].subject).toEqual({ type: "issue", number: 200 });
    expect(github.dispatchCalls[4].reason).toBe("queued_task_start");
  });

  it("PR #24 stale-verdict race: a later rejection at the same exact head blocks merge-ready dispatch after an earlier acceptance", async () => {
    const github = createFakeGitHub();
    const t0 = new Date("2026-09-02T12:00:00Z");
    const HEAD_A = "a".repeat(40);

    github.pullRequests.set(24, {
      number: 24,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "success" },
      reviewEvents: [
        { headSha: HEAD_A, state: "approved", submittedAt: "2026-09-02T09:00:00Z" },
        { headSha: HEAD_A, state: "changes_requested", submittedAt: "2026-09-02T11:00:00Z" },
      ],
    });

    const results = await runAutonomySupervisor(github.makeDeps(t0));

    expect(github.dispatchCalls).toHaveLength(1);
    expect(github.dispatchCalls[0].reason).toBe("review_rejected");
    expect(results[0].status).toBe("dispatched");
    expect(results[0].reason).toBe("review_rejected");
  });

  it("blocks and applies AUTONOMY_BLOCKED_LABEL once the retry-attempt cap is reached for one exact-head reason", async () => {
    const github = createFakeGitHub();
    const HEAD_A = "a".repeat(40);
    const t0 = new Date("2026-09-02T12:00:00Z");

    github.pullRequests.set(300, {
      number: 300,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      reviewEvents: [],
    });

    // Exhaust the attempt budget, one retry-interval apart.
    let now = t0;
    for (let attempt = 0; attempt < MAX_DISPATCH_ATTEMPTS_PER_KEY; attempt += 1) {
      const results = await runAutonomySupervisor(github.makeDeps(now));
      expect(results[0].status).toBe("dispatched");
      now = new Date(now.getTime() + RETRY_INTERVAL_MS + 1);
    }
    expect(github.dispatchCalls).toHaveLength(MAX_DISPATCH_ATTEMPTS_PER_KEY);

    // The next evaluation at the same exact head blocks instead of
    // dispatching a fourth time, and applies AUTONOMY_BLOCKED_LABEL.
    const blockedResults = await runAutonomySupervisor(github.makeDeps(now));
    expect(github.dispatchCalls).toHaveLength(MAX_DISPATCH_ATTEMPTS_PER_KEY);
    expect(blockedResults[0].status).toBe("blocked");
    expect(github.labelsFor(300).has(AUTONOMY_BLOCKED_LABEL)).toBe(true);

    // Once labeled, every subsequent cycle holds instead of re-evaluating,
    // even long after the retry interval would otherwise have elapsed.
    const afterLabelNow = new Date(now.getTime() + RETRY_INTERVAL_MS * 10);
    const heldResults = await runAutonomySupervisor(github.makeDeps(afterLabelNow));
    expect(github.dispatchCalls).toHaveLength(MAX_DISPATCH_ATTEMPTS_PER_KEY);
    expect(heldResults[0]).toEqual({
      subjectType: "pull_request",
      number: 300,
      status: "hold",
      reason: AUTONOMY_BLOCKED_LABEL,
      idempotencyKey: null,
    });
  });

  it("simultaneous schedule and event-driven evaluation of identical unchanged state produce only one dispatch", async () => {
    const github = createFakeGitHub();
    const HEAD_A = "a".repeat(40);
    const t0 = new Date("2026-09-02T12:00:00Z");

    github.pullRequests.set(400, {
      number: 400,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      reviewEvents: [],
    });

    // Two triggers (a scheduled tick and, say, a workflow_run completion
    // event) fire back to back for the exact same unchanged state. The
    // workflow's single non-overlapping concurrency group means these are
    // processed one after another rather than truly in parallel; this
    // proves the second one is a no-op regardless of which trigger caused
    // it, since both compute the identical idempotency key.
    const scheduledResults = await runAutonomySupervisor(github.makeDeps(t0));
    const eventDrivenResults = await runAutonomySupervisor(github.makeDeps(new Date(t0.getTime() + 1)));

    expect(github.dispatchCalls).toHaveLength(1);
    expect(scheduledResults[0].status).toBe("dispatched");
    expect(eventDrivenResults[0].status).toBe("skip");
    expect(eventDrivenResults[0].reason).toBe("retry_not_due");
    expect(eventDrivenResults[0].idempotencyKey).toBe(scheduledResults[0].idempotencyKey);
  });

  it("isolates a per-item failure so one subject's error never stops evaluation of the rest", async () => {
    const github = createFakeGitHub();
    const t0 = new Date("2026-09-02T12:00:00Z");
    const HEAD_A = "a".repeat(40);

    // This subject's dispatch-marker lookup throws.
    github.pullRequests.set("throw", {
      number: "throw",
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      reviewEvents: [],
    });
    github.pullRequests.set(101, {
      number: 101,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      reviewEvents: [],
    });

    const results = await runAutonomySupervisor(github.makeDeps(t0));

    const failed = results.find((r) => r.number === "throw");
    const succeeded = results.find((r) => r.number === 101);
    expect(failed.status).toBe("error");
    expect(failed.message).toMatch(/simulated transient GitHub API failure/);
    expect(succeeded.status).toBe("dispatched");
    expect(succeeded.reason).toBe("ci_failed");
  });

  it("never dispatches a draft pull request or a subject on a security/major-decision hold", async () => {
    const github = createFakeGitHub();
    const t0 = new Date("2026-09-02T12:00:00Z");
    const HEAD_A = "a".repeat(40);

    github.pullRequests.set(102, {
      number: 102,
      headSha: HEAD_A,
      isDraft: true,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      reviewEvents: [],
    });
    github.pullRequests.set(103, {
      number: 103,
      headSha: HEAD_A,
      isDraft: false,
      labels: ["security-review"],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      reviewEvents: [],
    });

    const results = await runAutonomySupervisor(github.makeDeps(t0));

    expect(github.dispatchCalls).toHaveLength(0);
    expect(results).toEqual(
      expect.arrayContaining([
        { subjectType: "pull_request", number: 102, status: "skip", reason: "draft", idempotencyKey: null },
        { subjectType: "pull_request", number: 103, status: "hold", reason: "security-review", idempotencyKey: null },
      ]),
    );
  });

  it("never dispatches to a queued issue lacking the explicit autonomy-ready opt-in label", async () => {
    const github = createFakeGitHub();
    const t0 = new Date("2026-09-02T12:00:00Z");
    github.issues.set(201, { number: 201, labels: [], title: "not opted in", body: "" });

    const results = await runAutonomySupervisor(github.makeDeps(t0));

    expect(github.dispatchCalls).toHaveLength(0);
    expect(results).toEqual([]);
  });
});
