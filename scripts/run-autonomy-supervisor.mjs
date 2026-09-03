import { readFile } from "node:fs/promises";
import { readGithubEvent } from "./lib/read-github-event.mjs";
import { runAutonomySupervisor } from "./lib/supervisor-run.mjs";
import { GOVERNANCE_WORKFLOW_PATH, evaluateGovernanceEvidence } from "./lib/supervisor-ci.mjs";
import { buildOwnerVerdictEvents } from "./lib/supervisor-verdicts.mjs";
import { filterTrustedDispatchMarkers } from "./lib/supervisor-idempotency.mjs";
import { shouldHandleEvent } from "./lib/supervisor-event-guard.mjs";
import {
  dispatchToWorkspaceAgent,
  validateAgentId,
  requireWorkspaceAgentToken,
} from "./lib/supervisor-dispatch.mjs";

/**
 * Thin, deliberately dumb GitHub REST wiring for the pure orchestrator in
 * lib/supervisor-run.mjs. Nothing here is unit tested (it is a network
 * client, not decision logic); all decision logic lives in the pure,
 * fully-tested lib/ modules. This file only translates GitHub API shapes
 * into the plain snapshots the orchestrator expects, and never logs or
 * returns the Workspace Agent token.
 */

const GITHUB_API = "https://api.github.com";

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is missing or empty; failing closed`);
  }
  return value;
}

async function githubRequest(token, path, init = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed with status ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

function nextPageUrl(response) {
  const link = response.headers.get("link") ?? "";
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * Follows GitHub's `Link: rel="next"` pagination header so no supervised
 * collection (open pull requests, check runs, reviews, issues, comments) is
 * silently truncated at one page.
 */
async function githubPaginated(token, initialUrl, extractItems) {
  const items = [];
  let url = initialUrl;
  while (url) {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API GET ${url} failed with status ${response.status}`);
    }
    const page = await response.json();
    items.push(...extractItems(page));
    url = nextPageUrl(response);
  }
  return items;
}

/**
 * Normalizes one GitHub Actions **workflow run** (from `/actions/runs`, not
 * a check-run) into the plain shape `summarizeGovernanceWorkflowRuns`
 * expects. A workflow run's own `name` is the workflow's top-level `name:`
 * field (e.g. "Project governance") - unlike a check-run's `name`, which is
 * the job name (e.g. "verify") and can never match the governance workflow
 * name.
 */
function normalizeWorkflowRun(run) {
  return {
    name: run.name,
    path: run.path,
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.run_started_at ?? run.created_at,
  };
}

function buildReviewsForVerdicts(reviews) {
  return reviews.map((review) => ({
    authorLogin: review.user?.login,
    state: review.state,
    headSha: review.commit_id,
    submittedAt: review.submitted_at,
    // Deliberately no `body`/`updatedAt` fields: GitHub's "list reviews"
    // response has no field reflecting whether a review's body was edited
    // after submission (unlike comments' `updated_at`), so there is no
    // genuine provenance to check here. buildOwnerVerdictEvents in
    // supervisor-verdicts.mjs no longer reads a review's body as verdict
    // evidence at all - only its immutable native `state` - so no
    // manufactured provenance value is needed or supplied.
  }));
}

function buildCommentsForVerdicts(comments) {
  return comments.map((comment) => ({
    authorLogin: comment.user?.login,
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  }));
}

/**
 * DE-0010-R1: reads the repository's default-branch copy of the governance
 * workflow file directly off the local working tree, rather than making a
 * network call for it. Both autonomy workflows always check out the
 * repository's default branch (never a PR head or merge ref) before
 * invoking this script - see docs/automation/autonomy-supervisor.md - so
 * the local checkout already *is* the trusted default-branch content. A
 * read failure (the file does not exist locally, e.g. before this pull
 * request first merges - see the bootstrap note in
 * docs/automation/autonomy-supervisor.md) fails closed to `null`, which
 * `isGovernanceWorkflowFileTrusted` in supervisor-ci.mjs never treats as
 * trusted.
 */
async function readDefaultBranchGovernanceWorkflowFile() {
  try {
    return await readFile(GOVERNANCE_WORKFLOW_PATH, "utf8");
  } catch {
    return null;
  }
}

/**
 * Fetches the exact byte content of one file at one exact ref via GitHub's
 * Contents API, decoding it from the API's base64 encoding. Fails closed to
 * `null` on any error (missing file, API error, unexpected shape) rather
 * than throwing - a pull request that cannot be read is never trusted by
 * default.
 */
async function fetchFileContentAtRef(token, owner, repo, path, ref) {
  try {
    const data = await githubRequest(token, `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);
    if (typeof data?.content !== "string" || data.encoding !== "base64") return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * DE-0010-R1 cycle 2: lists every file path GitHub's compare API reports as
 * different between the pull request's own recorded base branch (never a
 * hardcoded branch name, and never read from PR title/body/label content -
 * `pull.base.ref` is set by GitHub itself when the pull request is opened)
 * and its exact current head SHA. Fails closed to `null` on any error or
 * unexpected response shape - never an empty array - so
 * `evaluateGovernanceEvidence` in supervisor-ci.mjs can never mistake an
 * unreadable diff for "nothing changed, so trust it". Renamed files
 * contribute both their old and new path, so a decision-path file renamed
 * away (or into) the governance decision path is still caught.
 *
 * Known bound: GitHub's compare API reports at most the first 300 changed
 * files, so a comparison touching more files than that would have any files
 * beyond the cap silently excluded from this list. This function does not
 * itself guard against that - `evaluateGovernanceEvidence` in
 * supervisor-ci.mjs treats any list at or above that same 300-file cap as
 * unprovably incomplete and fails closed to `"untrusted"`, so an oversized
 * comparison can never be mistaken for a complete, trustworthy one.
 */
async function fetchChangedFilePaths(token, owner, repo, base, headSha) {
  try {
    const data = await githubRequest(token, `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${headSha}`);
    if (!Array.isArray(data?.files)) return null;
    const paths = [];
    for (const file of data.files) {
      if (typeof file?.filename === "string") paths.push(file.filename);
      if (typeof file?.previous_filename === "string") paths.push(file.previous_filename);
    }
    return paths;
  } catch {
    return null;
  }
}

function makeDeps({ token, owner, repo, ownerLogin, agentId, agentToken }) {
  const repositoryFullName = `${owner}/${repo}`;

  return {
    now: new Date(),

    async listPullRequests() {
      const [pulls, defaultBranchGovernanceWorkflowContent] = await Promise.all([
        githubPaginated(token, `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=100`, (page) => page),
        readDefaultBranchGovernanceWorkflowFile(),
      ]);
      const snapshots = [];
      for (const pull of pulls) {
        const headSha = pull.head.sha;
        const [workflowRuns, reviews, comments, headGovernanceWorkflowContent, changedFilePaths] = await Promise.all([
          githubPaginated(
            token,
            `${GITHUB_API}/repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&per_page=100`,
            (page) => page.workflow_runs ?? [],
          ),
          githubPaginated(
            token,
            `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pull.number}/reviews?per_page=100`,
            (page) => page,
          ),
          githubPaginated(
            token,
            `${GITHUB_API}/repos/${owner}/${repo}/issues/${pull.number}/comments?per_page=100`,
            (page) => page,
          ),
          fetchFileContentAtRef(token, owner, repo, GOVERNANCE_WORKFLOW_PATH, headSha),
          fetchChangedFilePaths(token, owner, repo, pull.base.ref, headSha),
        ]);
        snapshots.push({
          number: pull.number,
          headSha,
          isDraft: pull.draft === true,
          labels: (pull.labels ?? []).map((label) => label.name),
          checks: evaluateGovernanceEvidence({
            workflowRuns: workflowRuns.map(normalizeWorkflowRun),
            headSha,
            workflowFileTrust: {
              headContent: headGovernanceWorkflowContent,
              defaultBranchContent: defaultBranchGovernanceWorkflowContent,
            },
            changedFilePaths,
          }),
          ownerVerdictEvents: buildOwnerVerdictEvents({
            ownerLogin,
            comments: buildCommentsForVerdicts(comments),
            reviews: buildReviewsForVerdicts(reviews),
          }),
        });
      }
      return snapshots;
    },

    async listIssues() {
      const issues = await githubPaginated(
        token,
        `${GITHUB_API}/repos/${owner}/${repo}/issues?state=open&labels=autonomy-ready&per_page=100`,
        (page) => page,
      );
      return issues
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
          title: issue.title ?? "",
          body: issue.body ?? "",
        }));
    },

    async listDispatchMarkers(_subjectType, number) {
      const comments = await githubPaginated(
        token,
        `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
        (page) => page,
      );
      return filterTrustedDispatchMarkers(
        comments.map((comment) => ({
          body: comment.body,
          author: { login: comment.user?.login, type: comment.user?.type },
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
        })),
      );
    },

    async postDispatchMarker(_subjectType, number, markerBody) {
      await githubRequest(token, `/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: markerBody }),
      });
    },

    async addLabel(_subjectType, number, label) {
      await githubRequest(token, `/repos/${owner}/${repo}/issues/${number}/labels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labels: [label] }),
      });
    },

    async dispatchToWorkspaceAgent({ idempotencyKey, reason, subject }) {
      return dispatchToWorkspaceAgent({
        agentId,
        token: agentToken,
        idempotencyKey,
        reason,
        subject,
        repositoryFullName,
        fetchImpl: fetch,
      });
    },
  };
}

/**
 * Decides, from the raw GitHub Actions event context, whether this
 * invocation should proceed to a full evaluation cycle at all.
 *
 * Security redesign (owner-authorized): this secret-bearing script is now
 * only ever invoked by `schedule`, `workflow_dispatch`, or `workflow_run`
 * (of the unprivileged "Autonomy wake" workflow's completion) - see
 * .github/workflows/autonomy-supervisor.yml. It no longer listens to
 * `pull_request`/`pull_request_review`/`issue_comment` directly (those now
 * belong to the unprivileged wake workflow/script, run-autonomy-wake.mjs),
 * because GitHub loads a workflow's *definition* from the event's own ref
 * for those trigger types - a same-repository pull request could otherwise
 * rewrite this secret-bearing workflow's steps before its trusted-checkout
 * step even ran. `schedule`, `workflow_dispatch`, and `workflow_run` are
 * always loaded from the default branch, so this workflow's own definition
 * can never be PR-controlled. `shouldHandleEvent` still implements the full
 * event-type switch (shared with the wake script) for defense in depth and
 * a single tested implementation, even though production only ever reaches
 * the schedule/workflow_dispatch/workflow_run branches here.
 *
 * `schedule` and `workflow_dispatch` always proceed (the recovery backstop
 * and manual path). `workflow_run` requires a readable, parseable event
 * payload - a missing or unreadable payload fails closed (never proceeds)
 * rather than falling back to an unguarded scan - and is then checked
 * against shouldHandleEvent's actor/repository/workflow-identity/conclusion
 * guards, all before any credential is read.
 */
function decideWhetherToHandleThisEvent() {
  const { eventName, payload, payloadAvailable } = readGithubEvent();
  if (eventName === "schedule" || eventName === "workflow_dispatch") {
    return { handle: true, reason: eventName };
  }

  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repository.split("/");

  return shouldHandleEvent({
    eventName,
    payloadAvailable,
    action: payload?.action,
    repositoryFullName: payload?.repository?.full_name,
    expectedRepositoryFullName: owner && repo ? `${owner}/${repo}` : undefined,
    senderLogin: payload?.sender?.login,
    senderType: payload?.sender?.type,
    workflowName: payload?.workflow_run?.name,
    workflowPath: payload?.workflow_run?.path,
    workflowRunConclusion: payload?.workflow_run?.conclusion,
  });
}

async function main() {
  const guardDecision = decideWhetherToHandleThisEvent();
  if (!guardDecision.handle) {
    console.log(`autonomy supervisor: skipping event (${guardDecision.reason})`);
    return;
  }

  const githubToken = requireEnv("GITHUB_TOKEN");
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/");
  const agentId = validateAgentId(requireEnv("CHATGPT_WORKSPACE_AGENT_ID"));
  const agentToken = requireWorkspaceAgentToken(requireEnv("CHATGPT_WORKSPACE_AGENT_TOKEN"));

  // The only trusted acceptance identity: the repository owner login, taken
  // directly from repository metadata (the owner segment of
  // GITHUB_REPOSITORY, which GitHub Actions always sets to this
  // repository's own "owner/repo" identity) - never guessed, hardcoded, or
  // read from issue/PR content.
  const ownerLogin = owner;

  const results = await runAutonomySupervisor(
    makeDeps({ token: githubToken, owner, repo, ownerLogin, agentId, agentToken }),
  );

  for (const result of results) {
    console.log(`${result.subjectType} #${result.number}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  }

  if (
    results.some(
      (result) =>
        result.status === "error" || result.status === "dispatch_failed" || result.status === "dispatch_marker_failed",
    )
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
