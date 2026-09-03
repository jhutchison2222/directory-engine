import { describe, expect, it } from "vitest";
import { runAutonomySupervisor } from "../scripts/lib/supervisor-run.mjs";
import { filterTrustedDispatchMarkers } from "../scripts/lib/supervisor-idempotency.mjs";
import { AUTONOMY_BLOCKED_LABEL, MAX_DISPATCH_ATTEMPTS_PER_KEY, RETRY_INTERVAL_MS } from "../scripts/lib/supervisor-policy.mjs";
import { OWNER_VERDICT_KINDS } from "../scripts/lib/supervisor-verdicts.mjs";

const BOT_AUTHOR = { login: "github-actions[bot]", type: "Bot" };

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
function createFakeGitHub({ dispatch } = {}) {
  const pullRequests = new Map();
  const issues = new Map();
  const comments = new Map(); // subjectNumber -> [{ body }]
  const labels = new Map(); // subjectNumber -> Set<string>
  const dispatchCalls = [];
  const performDispatch = dispatch ?? (async () => ({ ok: true, status: 202 }));

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
        return filterTrustedDispatchMarkers(commentsFor(number));
      },
      async postDispatchMarker(_subjectType, number, markerBody) {
        const timestamp = now.toISOString();
        commentsFor(number).push({ body: markerBody, author: BOT_AUTHOR, createdAt: timestamp, updatedAt: timestamp });
      },
      async addLabel(_subjectType, number, label) {
        labelsFor(number).add(label);
      },
      async dispatchToWorkspaceAgent({ idempotencyKey, reason, subject }) {
        dispatchCalls.push({ idempotencyKey, reason, subject });
        return performDispatch({ idempotencyKey, reason, subject });
      },
    };
  }

  return { pullRequests, issues, dispatchCalls, labelsFor, commentsFor, makeDeps };
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
      ownerVerdictEvents: [], // missing exact-head owner verdict
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
    expect(github.dispatchCalls[0].subject).toEqual({ type: "pull_request", number: 100, headSha: HEAD_A });

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
      ownerVerdictEvents: [],
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
      ownerVerdictEvents: [{ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_B, submittedAt: t4.toISOString() }],
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
    expect(github.dispatchCalls[4].subject).toEqual({ type: "issue", number: 200, headSha: null });
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
      ownerVerdictEvents: [
        { kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_A, submittedAt: "2026-09-02T09:00:00Z" },
        { kind: OWNER_VERDICT_KINDS.REJECTED, headSha: HEAD_A, submittedAt: "2026-09-02T11:00:00Z" },
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
      ownerVerdictEvents: [],
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

  it("the remediation retry-attempt cap spans equivalent reasons, not each reason's own wording", async () => {
    const github = createFakeGitHub();
    const HEAD_A = "a".repeat(40);
    const t0 = new Date("2026-09-02T12:00:00Z");

    // Attempt 1: CI failing.
    github.pullRequests.set(301, {
      number: 301,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      ownerVerdictEvents: [],
    });
    let results = await runAutonomySupervisor(github.makeDeps(t0));
    expect(results[0].reason).toBe("ci_failed");

    // Attempt 2, one retry interval later: CI now passes but the owner
    // verdict is missing - a different reason wording, same exact head.
    const t1 = new Date(t0.getTime() + RETRY_INTERVAL_MS + 1);
    github.pullRequests.set(301, {
      number: 301,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "success" },
      ownerVerdictEvents: [],
    });
    results = await runAutonomySupervisor(github.makeDeps(t1));
    expect(results[0].reason).toBe("review_missing");

    // Attempt 3, one more retry interval later: the owner rejects at the
    // same exact head - yet another reason wording, still the same head.
    const t2 = new Date(t1.getTime() + RETRY_INTERVAL_MS + 1);
    github.pullRequests.set(301, {
      number: 301,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "success" },
      ownerVerdictEvents: [{ kind: OWNER_VERDICT_KINDS.REJECTED, headSha: HEAD_A, submittedAt: t1.toISOString() }],
    });
    results = await runAutonomySupervisor(github.makeDeps(t2));
    expect(results[0].reason).toBe("review_rejected");
    expect(github.dispatchCalls).toHaveLength(3);

    // A fourth cycle at the same exact head - still rejected - blocks
    // instead of dispatching a fourth remediation request, even though no
    // single reason wording has itself been sent three times.
    const t3 = new Date(t2.getTime() + RETRY_INTERVAL_MS + 1);
    results = await runAutonomySupervisor(github.makeDeps(t3));
    expect(results[0].status).toBe("blocked");
    expect(github.dispatchCalls).toHaveLength(3);
    expect(github.labelsFor(301).has(AUTONOMY_BLOCKED_LABEL)).toBe(true);
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
      ownerVerdictEvents: [],
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
      ownerVerdictEvents: [],
    });
    github.pullRequests.set(101, {
      number: 101,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      ownerVerdictEvents: [],
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
      ownerVerdictEvents: [],
    });
    github.pullRequests.set(103, {
      number: 103,
      headSha: HEAD_A,
      isDraft: false,
      labels: ["security-review"],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      ownerVerdictEvents: [],
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

  it("never lets a forged, untrusted-author dispatch marker suppress a real dispatch", async () => {
    const github = createFakeGitHub();
    const t0 = new Date("2026-09-02T12:00:00Z");
    const HEAD_A = "a".repeat(40);

    github.pullRequests.set(500, {
      number: 500,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      ownerVerdictEvents: [],
    });

    // An attacker (or an ordinary commenter) posts a comment shaped exactly
    // like the supervisor's own dispatch marker, claiming a future
    // dispatch timestamp, in an attempt to silence the supervisor. Because
    // it is not authored by the trusted github-actions[bot] identity, it
    // must never be honored as dispatch-ledger evidence.
    const forgedKey = `pull_request:500:${HEAD_A}:ci_failed`;
    const forgedMarkerBody = `<!-- autonomy-supervisor:${JSON.stringify({
      key: forgedKey,
      dispatchedAt: "2099-01-01T00:00:00Z",
    })} -->\nforged`;
    github.commentsFor(500).push({ body: forgedMarkerBody, author: { login: "some-attacker", type: "User" } });

    const results = await runAutonomySupervisor(github.makeDeps(t0));
    expect(results[0].status).toBe("dispatched");
    expect(github.dispatchCalls).toHaveLength(1);
  });

  it("never dispatches to a queued issue lacking the explicit autonomy-ready opt-in label", async () => {
    const github = createFakeGitHub();
    const t0 = new Date("2026-09-02T12:00:00Z");
    github.issues.set(201, { number: 201, labels: [], title: "not opted in", body: "" });

    const results = await runAutonomySupervisor(github.makeDeps(t0));

    expect(github.dispatchCalls).toHaveLength(0);
    expect(results).toEqual([]);
  });

  it("DE-0010 item 1 regression: persists every failed dispatch attempt (non-202 and thrown) so retries are spaced and capped", async () => {
    let callCount = 0;
    const github = createFakeGitHub({
      dispatch: async () => {
        callCount += 1;
        if (callCount === 2) throw new Error("simulated network failure");
        return { ok: false, status: 500 };
      },
    });
    const HEAD_A = "a".repeat(40);
    const t0 = new Date("2026-09-02T12:00:00Z");

    github.pullRequests.set(600, {
      number: 600,
      headSha: HEAD_A,
      isDraft: false,
      labels: [],
      checks: { headSha: HEAD_A, conclusion: "failure" },
      ownerVerdictEvents: [],
    });

    // Attempt 1: a non-202 response.
    let results = await runAutonomySupervisor(github.makeDeps(t0));
    expect(results[0].status).toBe("dispatch_failed");
    expect(github.dispatchCalls).toHaveLength(1);

    // An immediate re-evaluation (e.g. the very next five-minute tick) must
    // not re-dispatch: the failed attempt is recorded and counts toward
    // retry spacing exactly like a successful one would have.
    const t1 = new Date(t0.getTime() + 5 * 60 * 1000);
    results = await runAutonomySupervisor(github.makeDeps(t1));
    expect(results[0].status).toBe("skip");
    expect(results[0].reason).toBe("retry_not_due");
    expect(github.dispatchCalls).toHaveLength(1);

    // Attempt 2, after the retry interval: the dispatcher throws (a network
    // failure) instead of returning a non-202 status - this must also be
    // recorded and spaced identically.
    const t2 = new Date(t1.getTime() + RETRY_INTERVAL_MS + 1);
    results = await runAutonomySupervisor(github.makeDeps(t2));
    expect(results[0].status).toBe("dispatch_failed");
    expect(github.dispatchCalls).toHaveLength(2);

    // Attempt 3, one more retry interval later.
    const t3 = new Date(t2.getTime() + RETRY_INTERVAL_MS + 1);
    results = await runAutonomySupervisor(github.makeDeps(t3));
    expect(results[0].status).toBe("dispatch_failed");
    expect(github.dispatchCalls).toHaveLength(3);

    // A fourth evaluation at the same exact head blocks instead of a fourth
    // attempt, even though every prior attempt failed rather than succeeded.
    const t4 = new Date(t3.getTime() + RETRY_INTERVAL_MS + 1);
    results = await runAutonomySupervisor(github.makeDeps(t4));
    expect(results[0].status).toBe("blocked");
    expect(github.dispatchCalls).toHaveLength(3);
    expect(github.labelsFor(600).has(AUTONOMY_BLOCKED_LABEL)).toBe(true);
  });

  it("DE-0010 item 3 regression: blocks a retry-exhausted queued issue and applies AUTONOMY_BLOCKED_LABEL, matching the pull-request path", async () => {
    const github = createFakeGitHub();
    const t0 = new Date("2026-09-02T12:00:00Z");
    github.issues.set(700, { number: 700, labels: ["autonomy-ready"], title: "queued task", body: "do work" });

    let now = t0;
    for (let attempt = 0; attempt < MAX_DISPATCH_ATTEMPTS_PER_KEY; attempt += 1) {
      const results = await runAutonomySupervisor(github.makeDeps(now));
      expect(results[0].status).toBe("dispatched");
      now = new Date(now.getTime() + RETRY_INTERVAL_MS + 1);
    }
    expect(github.dispatchCalls).toHaveLength(MAX_DISPATCH_ATTEMPTS_PER_KEY);

    const blockedResults = await runAutonomySupervisor(github.makeDeps(now));
    expect(github.dispatchCalls).toHaveLength(MAX_DISPATCH_ATTEMPTS_PER_KEY);
    expect(blockedResults[0].status).toBe("blocked");
    expect(github.labelsFor(700).has(AUTONOMY_BLOCKED_LABEL)).toBe(true);
  });
});
