import { runAutonomySupervisor } from "./lib/supervisor-run.mjs";
import { isIndependentReviewerLogin } from "./lib/supervisor-policy.mjs";
import { parseDispatchMarker } from "./lib/supervisor-idempotency.mjs";
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

function summarizeCheckRuns(checkRuns, headSha) {
  if (checkRuns.length === 0) return null;
  const allCompleted = checkRuns.every((run) => run.status === "completed");
  if (!allCompleted) return { headSha, conclusion: "pending" };
  const anyFailed = checkRuns.some((run) => !["success", "neutral", "skipped"].includes(run.conclusion));
  return { headSha, conclusion: anyFailed ? "failure" : "success" };
}

function mapReviewState(state) {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes_requested";
  return "pending";
}

function latestIndependentReview(reviews, headSha) {
  const eligible = reviews.filter(
    (review) => review.commit_id === headSha && isIndependentReviewerLogin(review.user?.login),
  );
  if (eligible.length === 0) return null;
  const latest = eligible[eligible.length - 1];
  return { headSha, state: mapReviewState(latest.state) };
}

function makeDeps({ token, owner, repo, agentId, agentToken }) {
  return {
    now: new Date(),

    async listPullRequests() {
      const pulls = await githubRequest(token, `/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
      const snapshots = [];
      for (const pull of pulls) {
        const headSha = pull.head.sha;
        const [checkRuns, reviews] = await Promise.all([
          githubRequest(token, `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`),
          githubRequest(token, `/repos/${owner}/${repo}/pulls/${pull.number}/reviews?per_page=100`),
        ]);
        snapshots.push({
          number: pull.number,
          headSha,
          isDraft: pull.draft === true,
          labels: (pull.labels ?? []).map((label) => label.name),
          checks: summarizeCheckRuns(checkRuns.check_runs ?? [], headSha),
          review: latestIndependentReview(reviews ?? [], headSha),
        });
      }
      return snapshots;
    },

    async listIssues() {
      const issues = await githubRequest(
        token,
        `/repos/${owner}/${repo}/issues?state=open&labels=autonomy-ready&per_page=100`,
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
      const comments = await githubRequest(token, `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
      return comments.map((comment) => parseDispatchMarker(comment.body)).filter((marker) => marker !== null);
    },

    async postDispatchMarker(_subjectType, number, markerBody) {
      await githubRequest(token, `/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: markerBody }),
      });
    },

    async dispatchToWorkspaceAgent({ idempotencyKey, reason, subject }) {
      return dispatchToWorkspaceAgent({
        agentId,
        token: agentToken,
        idempotencyKey,
        reason,
        subject,
        fetchImpl: fetch,
      });
    },
  };
}

async function main() {
  const githubToken = requireEnv("GITHUB_TOKEN");
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/");
  const agentId = validateAgentId(requireEnv("CHATGPT_WORKSPACE_AGENT_ID"));
  const agentToken = requireWorkspaceAgentToken(requireEnv("CHATGPT_WORKSPACE_AGENT_TOKEN"));

  const results = await runAutonomySupervisor(
    makeDeps({ token: githubToken, owner, repo, agentId, agentToken }),
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
