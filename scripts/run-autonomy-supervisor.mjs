import { readFileSync } from "node:fs";
import { runAutonomySupervisor } from "./lib/supervisor-run.mjs";
import { summarizeGovernanceCheckRuns } from "./lib/supervisor-ci.mjs";
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

function normalizeCheckRun(run) {
  return { name: run.name, status: run.status, conclusion: run.conclusion, startedAt: run.started_at };
}

function buildReviewsForVerdicts(reviews) {
  return reviews.map((review) => ({
    authorLogin: review.user?.login,
    body: review.body,
    state: review.state,
    headSha: review.commit_id,
    submittedAt: review.submitted_at,
  }));
}

function buildCommentsForVerdicts(comments) {
  return comments.map((comment) => ({
    authorLogin: comment.user?.login,
    body: comment.body,
    createdAt: comment.created_at,
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
        const [checkRuns, reviews, comments] = await Promise.all([
          githubPaginated(
            token,
            `${GITHUB_API}/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
            (page) => page.check_runs ?? [],
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
          checks: summarizeGovernanceCheckRuns(checkRuns.map(normalizeCheckRun), headSha),
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
        comments.map((comment) => ({ body: comment.body, author: { login: comment.user?.login, type: comment.user?.type } })),
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
 * invocation should proceed to a full evaluation cycle at all. `schedule`
 * and `workflow_dispatch` always proceed (the recovery backstop and manual
 * path). Every other guarded event type requires a readable, parseable
 * event payload - a missing or unreadable payload fails closed (never
 * proceeds) rather than falling back to an unguarded scan - and is then
 * checked against shouldHandleEvent's actor/repository/label/workflow-name
 * guards, all before any credential is read.
 */
function decideWhetherToHandleThisEvent() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  if (eventName === "schedule" || eventName === "workflow_dispatch") {
    return { handle: true, reason: eventName };
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  let payload = null;
  let payloadAvailable = false;
  if (typeof eventPath === "string" && eventPath.trim().length > 0) {
    try {
      payload = JSON.parse(readFileSync(eventPath, "utf8"));
      payloadAvailable = true;
    } catch {
      payloadAvailable = false;
    }
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
    isPullRequestComment: Boolean(payload?.issue?.pull_request),
    labels: (payload?.issue?.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
    workflowName: payload?.workflow_run?.name,
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

  if (results.some((result) => result.status === "error" || result.status === "dispatch_failed")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
