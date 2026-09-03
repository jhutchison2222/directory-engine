import { describe, expect, it } from "vitest";
import {
  CHANGED_FILE_EVIDENCE_COMPLETENESS_CAP,
  GOVERNANCE_WORKFLOW_NAME,
  GOVERNANCE_WORKFLOW_PATH,
  evaluateGovernanceEvidence,
  isGovernanceDecisionPathFile,
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

describe("isGovernanceDecisionPathFile", () => {
  it("DE-0010-R1 cycle 2: matches the fixed decision-path files exactly", () => {
    expect(isGovernanceDecisionPathFile(GOVERNANCE_WORKFLOW_PATH)).toBe(true);
    expect(isGovernanceDecisionPathFile("package.json")).toBe(true);
    expect(isGovernanceDecisionPathFile("tsconfig.json")).toBe(true);
    expect(isGovernanceDecisionPathFile("vitest.config.ts")).toBe(true);
  });

  it("DE-0010-R1 cycle 2: matches every file under scripts/ or test/, including files added by the pull request itself", () => {
    expect(isGovernanceDecisionPathFile("scripts/validate-project-governance.mjs")).toBe(true);
    expect(isGovernanceDecisionPathFile("scripts/lib/supervisor-ci.mjs")).toBe(true);
    expect(isGovernanceDecisionPathFile("scripts/lib/brand-new-helper-not-yet-invented.mjs")).toBe(true);
    expect(isGovernanceDecisionPathFile("test/supervisor-ci.test.mjs")).toBe(true);
    expect(isGovernanceDecisionPathFile("test/brand-new-test-file.test.mjs")).toBe(true);
  });

  it("DE-0010-R1 cycle 2: never matches ordinary application code, docs, or project state", () => {
    expect(isGovernanceDecisionPathFile("src/index.ts")).toBe(false);
    expect(isGovernanceDecisionPathFile("README.md")).toBe(false);
    expect(isGovernanceDecisionPathFile("project/current-state.json")).toBe(false);
    expect(isGovernanceDecisionPathFile("docs/automation/autonomy-supervisor.md")).toBe(false);
    // A path that merely starts with the same characters as a decision-path
    // directory, but is not actually inside it, must never match.
    expect(isGovernanceDecisionPathFile("scripts-unrelated/evil.mjs")).toBe(false);
  });

  it("fails closed on non-string/empty input rather than throwing", () => {
    expect(isGovernanceDecisionPathFile(null)).toBe(false);
    expect(isGovernanceDecisionPathFile(undefined)).toBe(false);
    expect(isGovernanceDecisionPathFile("")).toBe(false);
  });

  it("DE-0010-R1 cycle 3: matches every package-manager dependency-resolution input npm install can honor", () => {
    expect(isGovernanceDecisionPathFile("package-lock.json")).toBe(true);
    expect(isGovernanceDecisionPathFile("npm-shrinkwrap.json")).toBe(true);
    expect(isGovernanceDecisionPathFile("yarn.lock")).toBe(true);
  });

  it("DE-0010-R1 cycle 3: matches every supported Vitest/Vite config and workspace filename variant, not only the one currently in use", () => {
    // vitest.config.ts is already covered by the fixed-file list above; the
    // point of this regression is the *other* recognized variants, which a
    // pull request could add without ever touching vitest.config.ts itself.
    expect(isGovernanceDecisionPathFile("vitest.config.mts")).toBe(true);
    expect(isGovernanceDecisionPathFile("vitest.config.js")).toBe(true);
    expect(isGovernanceDecisionPathFile("vitest.workspace.ts")).toBe(true);
    expect(isGovernanceDecisionPathFile("vitest.projects.ts")).toBe(true);
    expect(isGovernanceDecisionPathFile("vite.config.ts")).toBe(true);
    expect(isGovernanceDecisionPathFile("vite.config.mjs")).toBe(true);
  });

  it("DE-0010-R1 cycle 3: the config-variant pattern never matches an unrelated path that merely contains the same words", () => {
    expect(isGovernanceDecisionPathFile("src/vitest.config.ts.md")).toBe(false);
    expect(isGovernanceDecisionPathFile("docs/vite.config.ts.example")).toBe(false);
    expect(isGovernanceDecisionPathFile("src/notvitest.config.ts")).toBe(false);
  });
});

describe("evaluateGovernanceEvidence", () => {
  const SUCCESSFUL_RUN = [{ ...GOVERNANCE_RUN, status: "completed", conclusion: "success", startedAt: "2026-09-02T09:00:00Z" }];
  const TRUSTED_WORKFLOW_FILE = {
    headContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
    defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
  };

  it("clean exact-head governance: a successful run with a trusted workflow file and only ordinary code changes reports success", () => {
    const result = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: ["src/index.ts", "docs/automation/autonomy-supervisor.md", "project/current-state.json"],
    });
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });

  it("DE-0010-R1 cycle 1 regression: a pull request that tampers with its own governance workflow while producing a same-name/path success run is never trusted", () => {
    const tamperedWorkflowContent = "name: Project governance\non:\n  pull_request:\njobs:\n  verify:\n    run: exit 0\n";
    const result = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: {
        headContent: tamperedWorkflowContent,
        defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT,
      },
      changedFilePaths: [GOVERNANCE_WORKFLOW_PATH],
    });
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });
  });

  it("DE-0010-R1 cycle 1 regression: a stale or unreadable default-branch copy never lets a mismatched head pass as trusted", () => {
    // The default-branch fetch failed (e.g. transient error, or this
    // pull request predates the governance workflow file's existence) - the
    // absence of a comparison target must never be treated as "nothing to
    // compare against, so trust it".
    const result = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: { headContent: DEFAULT_BRANCH_WORKFLOW_CONTENT, defaultBranchContent: null },
      changedFilePaths: [],
    });
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });
  });

  it("DE-0010-R1 cycle 2 regression: a same-repository pull request that keeps the governance workflow byte-identical but tampers with package.json is never trusted", () => {
    // The exact attack Codex's exact-head review identified: the trusted,
    // byte-identical workflow file still checks out and runs whatever
    // `npm run test`/`typecheck`/`check:governance` resolve to via
    // package.json's own scripts - a same-repository pull request could
    // replace those with no-ops and still land a clean, name+path-matching,
    // byte-trusted "success" run.
    const result = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: ["package.json"],
    });
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });
  });

  it("DE-0010-R1 cycle 2 regression: a same-repository pull request that keeps the governance workflow byte-identical but tampers with the governance validator or its transitive helpers is never trusted", () => {
    const validatorTampered = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: ["scripts/validate-project-governance.mjs"],
    });
    expect(validatorTampered).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });

    const transitiveHelperTampered = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: ["scripts/lib/schema-fail-closed.mjs"],
    });
    expect(transitiveHelperTampered).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });
  });

  it("DE-0010-R1 cycle 2 regression: tampering with the TypeScript or vitest test configuration is never trusted, even with an unrelated other file also changed", () => {
    const tsconfigTampered = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: ["src/index.ts", "tsconfig.json"],
    });
    expect(tsconfigTampered).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });

    const vitestConfigTampered = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: ["vitest.config.ts"],
    });
    expect(vitestConfigTampered).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });
  });

  it("DE-0010-R1 cycle 2 regression: a missing or unreadable changed-file diff fails closed rather than defaulting to trusted", () => {
    const missing = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: null,
    });
    expect(missing).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });

    const undefinedPaths = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
    });
    expect(undefinedPaths).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });
  });

  it("never downgrades a pending or failing run: neither trust check has anything to add for those two conclusions", () => {
    const pending = evaluateGovernanceEvidence({
      workflowRuns: [{ ...GOVERNANCE_RUN, status: "in_progress", conclusion: null, startedAt: "2026-09-02T09:00:00Z" }],
      headSha: HEAD_A,
      workflowFileTrust: { headContent: "tampered", defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT },
      changedFilePaths: ["package.json"],
    });
    expect(pending).toEqual({ headSha: HEAD_A, conclusion: "pending" });

    const failing = evaluateGovernanceEvidence({
      workflowRuns: [{ ...GOVERNANCE_RUN, status: "completed", conclusion: "failure", startedAt: "2026-09-02T09:00:00Z" }],
      headSha: HEAD_A,
      workflowFileTrust: { headContent: "tampered", defaultBranchContent: DEFAULT_BRANCH_WORKFLOW_CONTENT },
      changedFilePaths: ["package.json"],
    });
    expect(failing).toEqual({ headSha: HEAD_A, conclusion: "failure" });
  });

  it("returns null (awaiting_ci) when no governance run exists yet at this head, regardless of either trust check", () => {
    const result = evaluateGovernanceEvidence({
      workflowRuns: [],
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: ["package.json"],
    });
    expect(result).toBeNull();
  });

  it("DE-0010-R1 cycle 3 regression: a changed-file list at or above GitHub's compare-API completeness cap is never trusted, even with no visible decision-path file", () => {
    // The exact bypass exact-head review identified: a pull request touching
    // more than 300 files could place a decision-path edit past the compare
    // API's 300-file cap, where it would never appear in this list at all.
    const atCap = Array.from({ length: CHANGED_FILE_EVIDENCE_COMPLETENESS_CAP }, (_, index) => `src/file-${index}.ts`);
    const result = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: atCap,
    });
    expect(result).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });

    const belowCap = Array.from(
      { length: CHANGED_FILE_EVIDENCE_COMPLETENESS_CAP - 1 },
      (_, index) => `src/file-${index}.ts`,
    );
    const trusted = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: belowCap,
    });
    expect(trusted).toEqual({ headSha: HEAD_A, conclusion: "success" });
  });

  it("DE-0010-R1 cycle 3 regression: a same-repository pull request that keeps the governance workflow byte-identical but adds a lockfile or an unlisted Vitest/Vite config variant is never trusted", () => {
    const lockfileAdded = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: ["package-lock.json"],
    });
    expect(lockfileAdded).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });

    const workspaceConfigAdded = evaluateGovernanceEvidence({
      workflowRuns: SUCCESSFUL_RUN,
      headSha: HEAD_A,
      workflowFileTrust: TRUSTED_WORKFLOW_FILE,
      changedFilePaths: ["vitest.workspace.ts"],
    });
    expect(workspaceConfigAdded).toEqual({ headSha: HEAD_A, conclusion: "untrusted" });
  });
});
