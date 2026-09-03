import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_WORKFLOW_NAME,
  GOVERNANCE_WORKFLOW_PATH,
  evaluateGovernanceEvidence,
  isGovernanceWorkflowFileTrusted,
  isGovernanceWorkflowRun,
  summarizeGovernanceWorkflowRuns,
} from "../scripts/lib/supervisor-ci.mjs";

const HEAD_A = "a".repeat(40);
const GOVERNANCE_RUN = { name: GOVERNANCE_WORKFLOW_NAME, path: GOVERNANCE_WORKFLOW_PATH };

describe("isGovernanceWorkflowRun", () => {
  it("matches only the exact named governance workflow run at its exact reviewed path", () => {
    expect(isGovernanceWorkflowRun(GOVERNANCE_RUN)).toBe(true);
    expect(isGovernanceWorkflowRun({ name: "Some Other Check", path: GOVERNANCE_WORKFLOW_PATH })).toBe(false);
    expect(isGovernanceWorkflowRun({ name: "Autonomous supervisor", path: ".github/workflows/autonomy-supervisor.yml" })).toBe(
      false,
    );
    expect(isGovernanceWorkflowRun({})).toBe(false);
  });

  it("DE-0010 item 4 regression: a job/check-run name ('verify') is not a workflow name and never matches", () => {
    // This repository's actual governance workflow is named "Project
    // governance" (matches GOVERNANCE_WORKFLOW_NAME) but its job is named
    // "verify" - a prior version fed job/check-run names (which GitHub's
    // check-runs API reports as "verify") into this comparison, so
    // production code never found a match. "verify" must never satisfy this
    // check on its own.
    expect(isGovernanceWorkflowRun({ name: "verify", path: GOVERNANCE_WORKFLOW_PATH })).toBe(false);
  });

  it("security redesign item 9 regression: a same-name workflow run at a forged path never counts as governance evidence", () => {
    // Name alone is attacker-choosable: any same-repository pull request can
    // add a second workflow file anywhere under .github/workflows/ with
    // `name: "Project governance"` and a trivially-succeeding job. GitHub
    // reports that run with the identical human-readable name, but its
    // `path` reveals it is not the fixed, reviewed governance workflow file.
    expect(isGovernanceWorkflowRun({ name: GOVERNANCE_WORKFLOW_NAME, path: ".github/workflows/forged.yml" })).toBe(
      false,
    );
    expect(isGovernanceWorkflowRun({ name: GOVERNANCE_WORKFLOW_NAME })).toBe(false);
  });
});

describe("summarizeGovernanceWorkflowRuns", () => {
  it("returns null when no named governance run exists yet at this head", () => {
    expect(
      summarizeGovernanceWorkflowRuns(
        [{ name: "Some Other Check", path: GOVERNANCE_WORKFLOW_PATH, status: "completed", conclusion: "success" }],
        HEAD_A,
      ),
    ).toBeNull();
    expect(summarizeGovernanceWorkflowRuns([], HEAD_A)).toBeNull();
  });

  it("reports pending while the named governance run is still in progress", () => {
    const result = summarizeGovernanceWorkflowRuns(
      [{ ...GOVERNANCE_RUN, status: "in_progress", conclusion: null, startedAt: "2026-09-02T09:00:00Z" }],
      HEAD_A,
    );
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "pending" });
  });

  it("reports success for a completed, successful named governance run", () => {
    const result = summarizeGovernanceWorkflowRuns(
      [{ ...GOVERNANCE_RUN, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:00:00Z" }],
      HEAD_A,
    );
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });

  it.each(["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped"])(
    "reports failure for a completed named governance run with conclusion %s (only exact success counts)",
    (conclusion) => {
      const result = summarizeGovernanceWorkflowRuns(
        [{ ...GOVERNANCE_RUN, status: "completed", conclusion, startedAt: "2026-09-02T09:00:00Z" }],
        HEAD_A,
      );
      expect(result).toEqual({ headSha: HEAD_A, conclusion: "failure" });
    },
  );

  it("bootstrap: a failed Autonomous supervisor run at the same head never counts as governance evidence", () => {
    const result = summarizeGovernanceWorkflowRuns(
      [
        {
          name: "Autonomous supervisor",
          path: ".github/workflows/autonomy-supervisor.yml",
          status: "completed",
          conclusion: "failure",
          startedAt: "2026-09-02T09:00:00Z",
        },
        { ...GOVERNANCE_RUN, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:05:00Z" },
      ],
      HEAD_A,
    );
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });

  it("bootstrap: an unrelated green check never satisfies governance CI evidence on its own", () => {
    const result = summarizeGovernanceWorkflowRuns(
      [
        {
          name: "Some Unrelated Check",
          path: ".github/workflows/unrelated.yml",
          status: "completed",
          conclusion: "success",
          startedAt: "2026-09-02T09:00:00Z",
        },
      ],
      HEAD_A,
    );
    expect(result).toBeNull();
  });

  it("uses the most recently started governance run when more than one exists at the same head (a rerun)", () => {
    const result = summarizeGovernanceWorkflowRuns(
      [
        { ...GOVERNANCE_RUN, status: "completed", conclusion: "failure", startedAt: "2026-09-02T09:00:00Z" },
        { ...GOVERNANCE_RUN, status: "completed", conclusion: "success", startedAt: "2026-09-02T10:00:00Z" },
      ],
      HEAD_A,
    );
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });

  it("DE-0010 item 4 regression: a green 'verify' job/check-run name alone can never satisfy governance evidence - only the exact workflow name does", () => {
    const withOnlyTheJobName = summarizeGovernanceWorkflowRuns(
      [{ name: "verify", path: GOVERNANCE_WORKFLOW_PATH, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:00:00Z" }],
      HEAD_A,
    );
    expect(withOnlyTheJobName).toBeNull();

    const withTheActualWorkflowRun = summarizeGovernanceWorkflowRuns(
      [
        { name: "verify", path: GOVERNANCE_WORKFLOW_PATH, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:00:00Z" },
        { ...GOVERNANCE_RUN, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:05:00Z" },
      ],
      HEAD_A,
    );
    expect(withTheActualWorkflowRun).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });

  it("security redesign item 9 regression: a forged same-name workflow run at a different path never satisfies governance evidence, even alone", () => {
    const forgedOnly = summarizeGovernanceWorkflowRuns(
      [
        {
          name: GOVERNANCE_WORKFLOW_NAME,
          path: ".github/workflows/forged.yml",
          status: "completed",
          conclusion: "success",
          startedAt: "2026-09-02T09:00:00Z",
        },
      ],
      HEAD_A,
    );
    expect(forgedOnly).toBeNull();

    // Even when the forged run's conclusion is success and started later than
    // the real governance run, the real run at the fixed path must still be
    // the one and only source of evidence - the forged run is filtered out
    // entirely rather than competing on recency.
    const forgedAlongsideReal = summarizeGovernanceWorkflowRuns(
      [
        { ...GOVERNANCE_RUN, status: "completed", conclusion: "failure", startedAt: "2026-09-02T09:00:00Z" },
        {
          name: GOVERNANCE_WORKFLOW_NAME,
          path: ".github/workflows/forged.yml",
          status: "completed",
          conclusion: "success",
          startedAt: "2026-09-02T09:10:00Z",
        },
      ],
      HEAD_A,
    );
    expect(forgedAlongsideReal).toEqual({ headSha: HEAD_A, conclusion: "failure" });
  });
});

const DEFAULT_BRANCH_WORKFLOW_CONTENT = "name: Project governance\non:\n  pull_request:\n";

describe("isGovernanceWorkflowFileTrusted", () => {
  it("trusts only byte-identical content on both sides", () => {
    expect(
      isGovernanceWorkflowFileTrusted({
        headContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
        defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
      }),
    ).toBe(true);
  });

  it("DE-0010-R1 regression: never trusts a tampered governance workflow file, even by one character", () => {
    const tampered = `${DEFAULT_BRANCH_WORKFLOW_CONTENT}  push:\n`;
    expect(
      isGovernanceWorkflowFileTrusted({ headContent: tampered, defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT }),
    ).toBe(false);
  });

  it("fails closed when either side is missing, unreadable, or empty", () => {
    expect(isGovernanceWorkflowFileTrusted({ headContent: null, defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT })).toBe(
      false,
    );
    expect(isGovernanceWorkflowFileTrusted({ headContent: DEFAULT_BRANCH_WORKFLOW_CONTENT, defaultBranchContent: null })).toBe(
      false,
    );
    expect(isGovernanceWorkflowFileTrusted({ headContent: "", defaultBranchContent: "" })).toBe(false);
    expect(isGovernanceWorkflowFileTrusted({})).toBe(false);
  });
});

describe("evaluateGovernanceEvidence", () => {
  it("clean exact-head governance: a successful run with a trusted, matching workflow file reports success", () => {
    const result = evaluateGovernanceEvidence({
      workflowRuns: [{ ...GOVERNANCE_RUN, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:00:00Z" }],
      headSha: HEAD_A,
      workflowFileTrust: {
        headContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
        defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
      },
    });
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });

  it("DE-0010-R1 regression: a pull request that tampers with its own governance workflow while producing a same-name/path success run is never trusted", () => {
    const tamperedWorkflowContent = "name: Project governance\non:\n  pull_request:\njobs:\n  verify:\n    run: exit 0\n";
    const result = evaluateGovernanceEvidence({
      workflowRuns: [{ ...GOVERNANCE_RUN, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:00:00Z" }],
      headSha: HEAD_A,
      workflowFileTrust: {
        headContent: tamperedWorkflowContent,
        defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
      },
    });
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });
  });

  it("DE-0010-R1 regression: a stale or unreadable default-branch copy never lets a mismatched head pass as trusted", () => {
    // The default-branch fetch failed (e.g. transient error, or this
    // pull request predates the governance workflow file's existence) - the
    // absence of a comparison target must never be treated as "nothing to
    // compare against, so trust it".
    const result = evaluateGovernanceEvidence({
      workflowRuns: [{ ...GOVERNANCE_RUN, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:00:00Z" }],
      headSha: HEAD_A,
      workflowFileTrust: { headContent: DEFAULT_BRANCH_WORKFLOW_CONTENT, defaultBranchContent: null },
    });
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });
  });

  it("never downgrades a pending or failing run: file-trust evidence only matters for an otherwise-successful run", () => {
    const pending = evaluateGovernanceEvidence({
      workflowRuns: [{ ...GOVERNANCE_RUN, status: "in_progress", conclusion: null, startedAt: "2026-09-02T09:00:00Z" }],
      headSha: HEAD_A,
      workflowFileTrust: { headContent: "tampered", defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT },
    });
    expect(pending).toEqual({ headSha: HEAD_A, conclusion: "pending" });

    const failing = evaluateGovernanceEvidence({
      workflowRuns: [{ ...GOVERNANCE_RUN, status: "completed", conclusion: "failure", startedAt: "2026-09-02T09:00:00Z" }],
      headSha: HEAD_A,
      workflowFileTrust: { headContent: "tampered", defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT },
    });
    expect(failing).toEqual({ headSha: HEAD_A, conclusion: "failure" });
  });

  it("returns null (awaiting_ci) when no governance run exists yet at this head, regardless of file-trust evidence", () => {
    const result = evaluateGovernanceEvidence({
      workflowRuns: [],
      headSha: HEAD_A,
      workflowFileTrust: {
        headContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
        defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
      },
    });
    expect(result).toBeNull();
  });
});
