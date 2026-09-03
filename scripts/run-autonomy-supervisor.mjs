import { readGithubEvent, parseTrustedBotLogins } from "./lib/read-github-event.mjs";
import { runAutonomySupervisor } from "./lib/supervisor-run.mjs";
import { summarizeGovernanceWorkflowRuns } from "./lib/supervisor-ci.mjs";
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
    body: review.body,
    state: review.state,
    headSha: review.commit_id,
    submittedAt: review.submitted_at,
    // GitHub's "list reviews" response has no separate edit-timestamp field
    // the way its comments API does (see buildCommentsForVerdicts below),
    // so there is no distinct value to detect an edit against. `updatedAt`
    // is set equal to `submittedAt` so isUneditedProvenance's equality
    // check still runs (and still fails closed on a missing/unparseable
    // value) rather than being silently skipped for reviews.
    updatedAt: review.submitted_at,
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

function makeDeps({ token, owner, repo, ownerLogin, agentId, agentToken }) {
  const repositoryFullName = `${owner}/${repo}`;

  return {
    now: new Date(),

    async listPullRequests() {
      const pulls = await githubPaginated(
        token,
        `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
        (page) => page,
      );
      const snapshots = [];
      for (const pull of pulls) {
        const headSha = pull.head.sha;
        const [workflowRuns, reviews, comments] = await Promise.all([
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
        ]);
        snapshots.push({
          number: pull.number,
          headSha,
          isDraft: pull.draft === true,
          labels: (pull.labels ?? []).map((label) => label.name),
          checks: summarizeGovernanceWorkflowRuns(workflowRuns.map(normalizeWorkflowRun), headSha),
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
    trustedBotLogins: parseTrustedBotLogins(process.env.AUTONOMY_TRUSTED_BOT_LOGINS),
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
