/**
 * Governance CI evidence: the supervisor must require a completed,
 * successful GitHub Actions **workflow run** literally named `Project
 * governance` at the pull request's exact current head SHA. Any other
 * evidence - including an unrelated green check, this repository's own
 * `Autonomous supervisor` job (which cannot even succeed against a
 * pre-merge branch, since `main` has no supervisor script to invoke until
 * DE-0010 merges - see the bootstrap note below), or a stale-head run -
 * must never satisfy or block acceptance.
 *
 * DE-0010 cycle 3/3: a prior version queried GitHub's check-runs API
 * (`/commits/{sha}/check-runs`) and matched on `run.name`. A GitHub
 * check-run's `name` is the **job** name, not the workflow name - this
 * repository's governance workflow is named "Project governance" but its
 * job is named "verify" - so the production wiring never found a match and
 * governance evidence was permanently absent. The wiring now queries the
 * Actions **workflow-runs** API (`/actions/runs?head_sha=...`), whose
 * `name` field is the workflow's own top-level `name:`, which does match.
 */
export const GOVERNANCE_WORKFLOW_NAME = "Project governance";

export function isGovernanceWorkflowRun(run) {
  return typeof run?.name === "string" && run.name.trim() === GOVERNANCE_WORKFLOW_NAME;
}

/**
 * Summarizes governance CI evidence for one exact head SHA from a raw list
 * of workflow runs (already normalized to `{ name, status, conclusion,
 * startedAt }`, where `name` is the workflow's name - never a job or
 * check-run name). Returns `null` when no named governance run exists yet at
 * this head (treated as "awaiting_ci", not failure). When more than one
 * governance run exists at the same head (e.g. a rerun), the most recently
 * started run is authoritative - the same chronological-latest-wins
 * principle used for owner verdicts, so an earlier stale run can never
 * shadow a fresh rerun.
 *
 * Bootstrap note (DE-0010 item 10): because this function only ever
 * considers runs literally named "Project governance", an unrelated
 * pre-merge failure of the `Autonomous supervisor` job itself - which
 * cannot succeed against `main` until this pull request merges - can never
 * appear here and therefore can never affect this calculation.
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
