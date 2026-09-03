/**
 * Governance CI evidence: the supervisor must require a completed,
 * successful GitHub Actions **workflow run** at the pull request's exact
 * current head SHA, produced by the fixed, reviewed governance workflow
 * file - not merely a run whose human-readable `name:` happens to match.
 * Any other evidence - including an unrelated green check, this
 * repository's own `Autonomous supervisor`/`Autonomy wake` jobs (which
 * cannot even succeed against a pre-merge branch, since `main` has no
 * supervisor script to invoke until DE-0010 merges - see the bootstrap note
 * below), or a stale-head run - must never satisfy or block acceptance.
 *
 * DE-0010 cycle 3/3: a prior version queried GitHub's check-runs API
 * (`/commits/{sha}/check-runs`) and matched on `run.name`. A GitHub
 * check-run's `name` is the **job** name, not the workflow name - this
 * repository's governance workflow is named "Project governance" but its
 * job is named "verify" - so the production wiring never found a match and
 * governance evidence was permanently absent. The wiring now queries the
 * Actions **workflow-runs** API (`/actions/runs?head_sha=...`), whose
 * `name` field is the workflow's own top-level `name:`, which does match.
 *
 * DE-0010 security redesign (owner-authorized): matching by `name` alone is
 * forgeable - any pull request can add a second workflow file, anywhere in
 * `.github/workflows/`, with `name: "Project governance"` and a trivial
 * always-succeeding job, and GitHub will report that run with the identical
 * `name`. A workflow run's `path` field (e.g.
 * ".github/workflows/project-governance.yml") identifies the exact reviewed
 * workflow *file* the run came from, and is not attacker-choosable the way
 * `name:` is - the path is what GitHub actually executed. Governance
 * evidence now requires the fixed, reviewed path in addition to the
 * human-readable name (kept for logging/readability), so a forged
 * same-name workflow at a different path can never satisfy acceptance.
 *
 * DE-0010-R1 cycle 1 (governance trust rooting): matching name *and* path
 * still only proves which workflow *file path* produced the run - not which
 * *content* GitHub loaded from that path when it ran. GitHub loads a
 * `pull_request`-triggered workflow's own YAML definition from the pull
 * request's own ref (the same control-plane-loading behavior that forced
 * the wake/supervisor split described in docs/automation/autonomy-supervisor.md).
 * A same-repository pull request can therefore edit
 * `.github/workflows/project-governance.yml` itself - for example,
 * replacing the real install/typecheck/test/governance-validator steps with
 * a trivial `exit 0` - and still produce a completed, successful run with
 * the identical fixed `name` and `path`, at that PR's own exact head. Name
 * and path alone can never distinguish that tampered-but-passing run from a
 * genuine one. `isGovernanceWorkflowFileTrusted` closes this specific gap by
 * requiring the exact bytes of the governance workflow file at the pull
 * request's head to match the repository's default-branch copy before a
 * "success" conclusion is ever reported as trustworthy - see its own
 * docstring below.
 *
 * DE-0010-R1 cycle 2 (decision-path rooting): byte-identity of the workflow
 * *file* alone is still insufficient. That trusted, unmodified YAML checks
 * out and executes the pull request's own head - including its own
 * `package.json` scripts, its own `tsconfig.json`/`vitest.config.ts` test
 * configuration, `scripts/validate-project-governance.mjs` and every
 * transitive helper under `scripts/`, and every file under `test/`. A
 * same-repository pull request can leave the governance workflow file
 * byte-identical to `main` and still weaken or neuter any of those, then
 * land a genuinely successful, name+path-matching, byte-trusted run at its
 * own exact head. `isGovernanceDecisionPathFile` and the
 * `changedFilePaths` check in `evaluateGovernanceEvidence` close this
 * broader gap deterministically: rather than attempt to judge whether a
 * change to one of these files is malicious (undecidable in general), a
 * pull request that touches *any* file capable of weakening what
 * `npm run check:governance`/`typecheck`/`test` can catch is unconditionally
 * ineligible for a trusted `"success"` conclusion, regardless of the
 * governance workflow file's own byte-identity or the run's own conclusion.
 * This is the deliberately conservative, deterministic reading of issue
 * #29's minimum bar ("any PR modifying ... the trusted governance decision
 * path must be ineligible for merge-ready dispatch") over attempting a more
 * permissive but judgment-based classification.
 *
 * DE-0010-R1 cycle 3 (evidence-completeness and toolchain-input coverage):
 * two further deterministic bypasses of cycle 2's decision-path check
 * remained, both flagged by exact-head review.
 *
 * First, `changedFilePaths` was trusted as complete evidence even though its
 * source - GitHub's `compare` API - documents a hard cap of 300 changed
 * files per comparison
 * (https://docs.github.com/en/rest/commits/commits#compare-two-commits). A
 * pull request touching more than 300 files could place a decision-path
 * edit past that cap, where it would never appear in the returned list, and
 * still be reported `"success"`. `changedFilePaths` reaching or exceeding
 * `CHANGED_FILE_EVIDENCE_COMPLETENESS_CAP` is now treated exactly like a
 * missing/unreadable diff: fail-closed `"untrusted"`, because completeness
 * can no longer be proven at that size. This repository's pull requests
 * have never approached that size, so no legitimate change is expected to
 * be affected; a pull request that legitimately needs to touch that many
 * files falls back to requiring a human owner's exact-head review, the same
 * posture already used for any other decision-path change.
 *
 * Second, the fixed file set only protected the exact filenames
 * `package.json`/`tsconfig.json`/`vitest.config.ts`, but `npm install`
 * resolves dependencies through `package-lock.json`, `npm-shrinkwrap.json`,
 * or `yarn.lock` when present
 * (https://docs.npmjs.com/cli/v11/commands/npm-install/), and Vitest/Vite
 * both support several recognized config/workspace filename variants and
 * extensions capable of changing which tests run or how
 * (https://v2.vitest.dev/guide/workspace.html) - none of which the fixed
 * list matched. `GOVERNANCE_DECISION_PATH_FILES` now also lists the
 * lock/shrinkwrap inputs, and `GOVERNANCE_DECISION_PATH_CONFIG_PATTERN`
 * matches every supported extension of `vitest.config`, `vitest.workspace`,
 * `vitest.projects`, and `vite.config` at the repository root (Vitest falls
 * back to a discovered Vite config when it has none of its own), so adding
 * a previously-unlisted variant can no longer evade the decision-path
 * check.
 *
 * Trust boundary (documented, not solved by this check): `changedFilePaths`
 * is sourced from GitHub's own compare API (`base...head`), anchored to the
 * pull request's recorded base branch and its exact current head SHA - never
 * from PR-supplied content - so the list itself cannot be spoofed by the
 * pull request, though it is only trusted below its documented completeness
 * cap (see above). Ordinary application code under `src/`, documentation,
 * and project state/fixtures are deliberately *not* part of the decision
 * path, so an ordinary code change unrelated to governance/typecheck/test
 * enforcement still reaches a trusted `"success"` conclusion when the
 * workflow file is untouched and the run is genuinely green.
 */
export const GOVERNANCE_WORKFLOW_NAME = "Project governance";
export const GOVERNANCE_WORKFLOW_PATH = ".github/workflows/project-governance.yml";

export function isGovernanceWorkflowRun(run) {
  return (
    typeof run?.name === "string" &&
    run.name.trim() === GOVERNANCE_WORKFLOW_NAME &&
    typeof run?.path === "string" &&
    run.path.trim() === GOVERNANCE_WORKFLOW_PATH
  );
}

/**
 * Summarizes governance CI evidence for one exact head SHA from a raw list
 * of workflow runs (already normalized to `{ name, path, status, conclusion,
 * startedAt }`, where `name`/`path` identify the workflow itself - never a
 * job or check-run name). Returns `null` when no matching governance run
 * exists yet at this head (treated as "awaiting_ci", not failure). When more
 * than one governance run exists at the same head (e.g. a rerun), the most
 * recently started run is authoritative - the same chronological-latest-wins
 * principle used for owner verdicts, so an earlier stale run can never
 * shadow a fresh rerun.
 *
 * Bootstrap note (DE-0010 item 10): because this function only ever
 * considers runs matching both the fixed name and path, an unrelated
 * pre-merge failure of the `Autonomous supervisor`/`Autonomy wake` jobs
 * themselves - which cannot succeed against `main` until this pull request
 * merges - can never appear here and therefore can never affect this
 * calculation.
 */
export function summarizeGovernanceWorkflowRuns(workflowRuns, headSha) {
  const governanceRuns = (workflowRuns ?? []).filter(isGovernanceWorkflowRun);
  if (governanceRuns.length === 0) return null;
  const sorted = [...governanceRuns].sort((a, b) => Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0));
  const latest = sorted[sorted.length - 1];
  if (latest.status !== "completed") {
    return { headSha, conclusion: "pending" };
  }
  return { headSha, conclusion: latest.conclusion === "success" ? "success" : "failure" };
}

/**
 * DE-0010-R1: proves the governance workflow file GitHub actually loaded to
 * produce a run at the pull request's exact head is the same reviewed
 * content the repository's default branch carries - not merely a run at
 * the same fixed name and path (see the module docstring above for why name
 * and path alone are insufficient). Deterministic byte-for-byte comparison,
 * fail-closed on either side: a missing, unreadable, or empty value on
 * either side (a 404 fetching the pull request's copy, a local read
 * failure for the default-branch copy) can never be treated as "trusted by
 * default" - it can only ever compare as untrusted, the same posture this
 * codebase uses everywhere else evidence provenance is uncertain (compare
 * `isUneditedProvenance` in supervisor-provenance.mjs).
 */
export function isGovernanceWorkflowFileTrusted({ headContent, defaultBranchContent }) {
  return (
    typeof headContent === "string" &&
    headContent.length > 0 &&
    typeof defaultBranchContent === "string" &&
    defaultBranchContent.length > 0 &&
    headContent === defaultBranchContent
  );
}

/**
 * The fixed, reviewed set of individual file paths capable of weakening
 * what `npm run check:governance`/`typecheck`/`test` can catch: the
 * governance workflow file itself (also covered by
 * `isGovernanceWorkflowFileTrusted`'s byte comparison; listed here too for
 * defense in depth), the `npm` script definitions, the TypeScript
 * configuration, and every package-manager dependency-resolution input the
 * workflow's `npm install` step can honor when present -
 * `package-lock.json`/`npm-shrinkwrap.json` (npm itself) and `yarn.lock`
 * (listed for the same reason `yarn.lock` support is documented on the
 * install command generally: a future change to the install step must not
 * silently reopen this gap). A literal, frozen code constant - never read
 * from PR content - exactly like `GOVERNANCE_WORKFLOW_PATH` above. Vitest/Vite
 * config and workspace filename variants are matched separately by
 * `GOVERNANCE_DECISION_PATH_CONFIG_PATTERN` below, since they exist in
 * several recognized extensions rather than one fixed name.
 */
export const GOVERNANCE_DECISION_PATH_FILES = Object.freeze([
  GOVERNANCE_WORKFLOW_PATH,
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "tsconfig.json",
]);

/**
 * Matches every supported extension of the Vitest/Vite config and workspace
 * filenames capable of changing which tests `npm test` runs or how:
 * `vitest.config` and `vite.config` (Vitest falls back to a discovered Vite
 * config when it has none of its own) in every recognized script extension,
 * and `vitest.workspace`/`vitest.projects` in every recognized script
 * extension *plus* `.json` - Vitest's own workspace/projects documentation
 * (https://v2.vitest.dev/guide/workspace.html) lists `.json` as a supported
 * extension for those two filenames specifically, unlike `vitest.config`/
 * `vite.config`, which do not support a JSON config file. Anchored so it
 * only ever matches the exact root-level filename (optionally nested one
 * directory deep, matching how these tools also discover a config file
 * placed in a subdirectory) - never merely a path that happens to contain
 * one of these words elsewhere.
 */
export const GOVERNANCE_DECISION_PATH_CONFIG_PATTERN = new RegExp(
  "(?:^|/)(?:vitest\\.config|vite\\.config)\\.(?:ts|mts|cts|js|mjs|cjs)$" +
    "|(?:^|/)(?:vitest\\.workspace|vitest\\.projects)\\.(?:ts|mts|cts|js|mjs|cjs|json)$",
);

/** GitHub's compare API caps a single comparison at 300 changed files; see
 * the module docstring's cycle 3 note above.
 */
export const CHANGED_FILE_EVIDENCE_COMPLETENESS_CAP = 300;

/**
 * The fixed, reviewed set of directory roots whose entire contents are the
 * governance/typecheck/test decision path: `scripts/` (the governance
 * validator and every transitive helper it imports, plus the supervisor's
 * own decision-logic modules) and `test/` (everything `npm test` runs).
 * Expressed as directory roots rather than an enumerated file list so a
 * pull request cannot evade this check merely by adding a *new* file under
 * either directory - the enumerated-list alternative the reviewer
 * explicitly warned against.
 */
export const GOVERNANCE_DECISION_PATH_DIRECTORIES = Object.freeze(["scripts/", "test/"]);

/**
 * True when `path` falls within the governance decision path: an exact
 * match against `GOVERNANCE_DECISION_PATH_FILES`, or a prefix match against
 * `GOVERNANCE_DECISION_PATH_DIRECTORIES`. Ordinary application code
 * (`src/`), documentation, and project state/fixtures are deliberately
 * excluded - see the module docstring's "Trust boundary" note above.
 */
export function isGovernanceDecisionPathFile(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  if (GOVERNANCE_DECISION_PATH_FILES.includes(path)) return true;
  if (GOVERNANCE_DECISION_PATH_DIRECTORIES.some((directory) => path.startsWith(directory))) return true;
  return GOVERNANCE_DECISION_PATH_CONFIG_PATTERN.test(path);
}

/**
 * Evaluates the workflow-file byte-identity check in isolation, returning
 * `"untrusted"` (a genuine mismatch, or an unreadable/missing side that is
 * not a transient availability failure), `"unavailable"` (the caller
 * marked this evidence as unreadable due to a transient/network/rate-limit/
 * 5xx failure, not a genuine missing-or-mismatched file), or `"trusted"`.
 */
function evaluateWorkflowFileCheck(workflowFileTrust, workflowFileUnavailable) {
  if (workflowFileUnavailable) return "unavailable";
  return isGovernanceWorkflowFileTrusted(workflowFileTrust ?? {}) ? "trusted" : "untrusted";
}

/**
 * Evaluates the changed-file decision-path check in isolation, with the
 * same three-way result as evaluateWorkflowFileCheck above.
 */
function evaluateChangedFilesCheck(changedFilePaths, changedFilePathsUnavailable) {
  if (changedFilePathsUnavailable) return "unavailable";
  if (
    !Array.isArray(changedFilePaths) ||
    changedFilePaths.length >= CHANGED_FILE_EVIDENCE_COMPLETENESS_CAP ||
    changedFilePaths.some(isGovernanceDecisionPathFile)
  ) {
    return "untrusted";
  }
  return "trusted";
}

/**
 * Composes run evidence (summarizeGovernanceWorkflowRuns) with two
 * independent trust checks into the single evidence object
 * supervisor-policy.mjs consumes as `pr.checks`. A run is only ever reported
 * as `"success"` when all three hold: the fixed name+path match, the exact
 * workflow-file content is trusted (isGovernanceWorkflowFileTrusted), and
 * `changedFilePaths` - every file path GitHub's compare API reports as
 * different between the pull request's base branch and its exact head -
 * contains no governance decision-path file (isGovernanceDecisionPathFile),
 * *and* is short enough to be trustworthy as complete evidence at all. A
 * `changedFilePaths` array is required (an unreadable/missing diff can never
 * be treated as "nothing changed, so trust it"), and reaching or exceeding
 * `CHANGED_FILE_EVIDENCE_COMPLETENESS_CAP` is treated identically: GitHub's
 * compare API caps a single comparison at that many files, so a list at or
 * above the cap can never be trusted to be the *complete* list - a
 * decision-path edit could be sitting just past the cap, silently excluded.
 * A completed, green-conclusion run that fails either trust check - a
 * tampered governance workflow file, an untouched workflow file alongside a
 * tampered decision-path file, or unprovably-complete changed-file evidence
 * - is reported as `"untrusted"` instead of `"success"`, regardless of the
 * run's own conclusion. `"pending"` and `"failure"` pass through unchanged:
 * they already cannot unlock merge-ready dispatch on their own, so neither
 * trust check has anything to add for those two conclusions.
 *
 * DE-0010-R1 cycle 3 (final): `workflowFileUnavailable` and
 * `changedFilePathsUnavailable` let the caller (scripts/run-autonomy-
 * supervisor.mjs) distinguish a genuine content mismatch or a genuinely
 * missing/absent file (still folded into `"untrusted"` above - these are
 * real, actionable fail-closed evidence) from a transient read failure that
 * proves nothing either way - a network error, GitHub secondary rate
 * limiting, or a 5xx response fetching the pull request's copy of the
 * workflow file or its compare diff. Before this cycle, both wiring
 * functions (`fetchFileContentAtRef`, `fetchChangedFilePaths`) collapsed
 * every error into the same `null`/missing-array shape this function
 * already treats as tamper evidence, so a transient blip reported a real
 * PR's governance evidence as `"untrusted"` -> `ci_failed` in
 * supervisor-policy.mjs, consuming one of that PR's finite remediation-cycle
 * attempts and triggering an unwarranted Workspace Agent dispatch for
 * nothing the PR actually did. When either flag is set (and neither trust
 * check independently proves an actual mismatch/decision-path edit, which
 * always takes priority as definitive evidence), this function instead
 * reports `"unavailable"`, which supervisor-policy.mjs treats exactly like
 * `"pending"`: skip this cycle, dispatch nothing, spend no budget.
 */
export function evaluateGovernanceEvidence({
  workflowRuns,
  headSha,
  workflowFileTrust,
  workflowFileUnavailable = false,
  changedFilePaths,
  changedFilePathsUnavailable = false,
}) {
  const summary = summarizeGovernanceWorkflowRuns(workflowRuns, headSha);
  if (summary === null || summary.conclusion !== "success") return summary;

  const fileCheck = evaluateWorkflowFileCheck(workflowFileTrust, workflowFileUnavailable);
  const changedFilesCheck = evaluateChangedFilesCheck(changedFilePaths, changedFilePathsUnavailable);

  if (fileCheck === "untrusted" || changedFilesCheck === "untrusted") {
    return { headSha, conclusion: "untrusted" };
  }
  if (fileCheck === "unavailable" || changedFilesCheck === "unavailable") {
    return { headSha, conclusion: "unavailable" };
  }
  return summary;
}
