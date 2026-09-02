import { describe, expect, it } from "vitest";
import { GOVERNANCE_CHECK_NAME, isGovernanceCheckRun, summarizeGovernanceCheckRuns } from "../scripts/lib/supervisor-ci.mjs";

const HEAD_A = "a".repeat(40);

describe("isGovernanceCheckRun", () => {
  it("matches only the exact named governance check", () => {
    expect(isGovernanceCheckRun({ name: GOVERNANCE_CHECK_NAME })).toBe(true);
    expect(isGovernanceCheckRun({ name: "Some Other Check" })).toBe(false);
    expect(isGovernanceCheckRun({ name: "Autonomous supervisor" })).toBe(false);
    expect(isGovernanceCheckRun({})).toBe(false);
  });
});

describe("summarizeGovernanceCheckRuns", () => {
  it("returns null when no named governance run exists yet at this head", () => {
    expect(summarizeGovernanceCheckRuns([{ name: "Some Other Check", status: "completed", conclusion: "success" }], HEAD_A)).toBeNull();
    expect(summarizeGovernanceCheckRuns([], HEAD_A)).toBeNull();
  });

  it("reports pending while the named governance run is still in progress", () => {
    const result = summarizeGovernanceCheckRuns(
      [{ name: GOVERNANCE_CHECK_NAME, status: "in_progress", conclusion: null, startedAt: "2026-09-02T09:00:00Z" }],
      HEAD_A,
    );
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "pending" });
  });

  it("reports success for a completed, successful named governance run", () => {
    const result = summarizeGovernanceCheckRuns(
      [{ name: GOVERNANCE_CHECK_NAME, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:00:00Z" }],
      HEAD_A,
    );
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });

  it.each(["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped"])(
    "reports failure for a completed named governance run with conclusion %s (only exact success counts)",
    (conclusion) => {
      const result = summarizeGovernanceCheckRuns(
        [{ name: GOVERNANCE_CHECK_NAME, status: "completed", conclusion, startedAt: "2026-09-02T09:00:00Z" }],
        HEAD_A,
      );
      expect(result).toEqual({ headSha: HEAD_A, conclusion: "failure" });
    },
  );

  it("bootstrap: a failed Autonomous supervisor run at the same head never counts as governance evidence", () => {
    const result = summarizeGovernanceCheckRuns(
      [
        { name: "Autonomous supervisor", status: "completed", conclusion: "failure", startedAt: "2026-09-02T09:00:00Z" },
        { name: GOVERNANCE_CHECK_NAME, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:05:00Z" },
      ],
      HEAD_A,
    );
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });

  it("bootstrap: an unrelated green check never satisfies governance CI evidence on its own", () => {
    const result = summarizeGovernanceCheckRuns(
      [{ name: "Some Unrelated Check", status: "completed", conclusion: "success", startedAt: "2026-09-02T09:00:00Z" }],
      HEAD_A,
    );
    expect(result).toBeNull();
  });

  it("uses the most recently started governance run when more than one exists at the same head (a rerun)", () => {
    const result = summarizeGovernanceCheckRuns(
      [
        { name: GOVERNANCE_CHECK_NAME, status: "completed", conclusion: "failure", startedAt: "2026-09-02T09:00:00Z" },
        { name: GOVERNANCE_CHECK_NAME, status: "completed", conclusion: "success", startedAt: "2026-09-02T10:00:00Z" },
      ],
      HEAD_A,
    );
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });
});
