import { describe, expect, it } from "vitest";
import { runAutonomySupervisor } from "../scripts/lib/supervisor-run.mjs";

const HEAD_A = "a".repeat(40);

function basePr(overrides = {}) {
  return {
    number: 26,
    headSha: HEAD_A,
    isDraft: false,
    labels: [],
    checks: { headSha: HEAD_A, conclusion: "failure" },
    ownerVerdictEvents: [],
    ...overrides,
  };
}

function makeDeps({ pr, dispatchResult, postDispatchMarker, dispatches = [] }) {
  return {
    now: new Date("2026-09-03T12:00:00Z"),
    async listPullRequests() {
      return [pr];
    },
    async listIssues() {
      return [];
    },
    async listDispatchMarkers() {
      return dispatches;
    },
    async postDispatchMarker(subjectType, number, markerBody) {
      return postDispatchMarker(subjectType, number, markerBody);
    },
    async addLabel() {},
    async dispatchToWorkspaceAgent() {
      return dispatchResult();
    },
  };
}

describe("security redesign item 13: post-dispatch-marker failure gap", () => {
  it("retries a transient marker-post failure and still records the marker on a later attempt", async () => {
    let postAttempts = 0;
    const postedMarkers = [];
    const deps = makeDeps({
      pr: basePr(),
      dispatchResult: async () => ({ ok: true, status: 202 }),
      postDispatchMarker: async (_subjectType, _number, markerBody) => {
        postAttempts += 1;
        if (postAttempts < 3) throw new Error("simulated transient GitHub API failure");
        postedMarkers.push(markerBody);
      },
    });

    const results = await runAutonomySupervisor(deps);
    expect(postAttempts).toBe(3);
    expect(postedMarkers).toHaveLength(1);
    expect(results).toEqual([
      { subjectType: "pull_request", number: 26, status: "dispatched", reason: "ci_failed", idempotencyKey: expect.any(String) },
    ]);
  });

  it("reports a distinct dispatch_marker_failed status - not a bare 'dispatched' - when a successful dispatch's marker can never be recorded", async () => {
    let postAttempts = 0;
    const deps = makeDeps({
      pr: basePr(),
      dispatchResult: async () => ({ ok: true, status: 202 }),
      postDispatchMarker: async () => {
        postAttempts += 1;
        throw new Error("simulated persistent GitHub API failure");
      },
    });

    const results = await runAutonomySupervisor(deps);
    expect(postAttempts).toBe(3);
    expect(results).toEqual([
      {
        subjectType: "pull_request",
        number: 26,
        status: "dispatch_marker_failed",
        reason: "ci_failed",
        idempotencyKey: expect.any(String),
      },
    ]);
  });

  it("reports dispatch_marker_failed (not dispatch_failed) when both the dispatch and every marker-post attempt fail", async () => {
    const deps = makeDeps({
      pr: basePr(),
      dispatchResult: async () => ({ ok: false, status: 500 }),
      postDispatchMarker: async () => {
        throw new Error("simulated persistent GitHub API failure");
      },
    });

    const results = await runAutonomySupervisor(deps);
    expect(results[0].status).toBe("dispatch_marker_failed");
  });

  it("never sends the Workspace Agent credential or its response body to postDispatchMarker", async () => {
    const seenMarkerBodies = [];
    const deps = makeDeps({
      pr: basePr(),
      dispatchResult: async () => ({ ok: true, status: 202 }),
      postDispatchMarker: async (_subjectType, _number, markerBody) => {
        seenMarkerBodies.push(markerBody);
      },
    });

    await runAutonomySupervisor(deps);
    for (const body of seenMarkerBodies) {
      expect(body).not.toMatch(/Bearer|token|secret/i);
    }
  });
});
