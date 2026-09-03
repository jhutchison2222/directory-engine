import { readGithubEvent } from "./lib/read-github-event.mjs";
import { shouldHandleEvent, shouldWakeForSourceWorkflowRun } from "./lib/supervisor-event-guard.mjs";

/**
 * Entry point for the unprivileged "Autonomy wake" workflow
 * (.github/workflows/autonomy-wake.yml). This script exists ONLY to decide
 * whether an incoming pull_request/pull_request_review/issue_comment/
 * workflow_run event is worth waking the secret-bearing "Autonomous
 * supervisor" workflow for - it never reads or holds
 * CHATGPT_WORKSPACE_AGENT_ID/TOKEN, never calls the GitHub API, and never
 * checks out or executes anything beyond this trusted default-branch script
 * itself.
 *
 * The event payload (GITHUB_EVENT_PATH) is repository-controlled data - a
 * PR's title, an issue comment's body, a sender login, a completed
 * workflow's name/path - but it is only ever parsed as JSON and inspected
 * as plain data by the guard functions' field comparisons; nothing here
 * interpolates any of it into a shell command, `eval`, or file path.
 *
 * `workflow_run` events (completion of `Project governance` or
 * `Claude Code` - the immediate check/implementation-completion handoff) go
 * through the dedicated `shouldWakeForSourceWorkflowRun` guard; every other
 * event type goes through the shared `shouldHandleEvent` gate. Success
 * (exit 0) is the sole signal that wakes the supervisor, via its
 * `workflow_run: types: [completed]` trigger on THIS workflow's own
 * completion, which additionally requires conclusion "success" (see
 * `shouldHandleEvent`'s workflow_run case, evaluated by the supervisor, not
 * here). Failure (exit 1) for an irrelevant/self/bot/out-of-repository event
 * is expected, routine behavior - not an operational problem to alert on.
 */
function main() {
  const { eventName, payload, payloadAvailable } = readGithubEvent();
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repository.split("/");
  const expectedRepositoryFullName = owner && repo ? `${owner}/${repo}` : undefined;

  const decision =
    eventName === "workflow_run"
      ? shouldWakeForSourceWorkflowRun({
          payloadAvailable,
          action: payload?.action,
          repositoryFullName: payload?.repository?.full_name,
          expectedRepositoryFullName,
          workflowName: payload?.workflow_run?.name,
          workflowPath: payload?.workflow_run?.path,
        })
      : shouldHandleEvent({
          eventName,
          payloadAvailable,
          action: payload?.action,
          repositoryFullName: payload?.repository?.full_name,
          expectedRepositoryFullName,
          senderLogin: payload?.sender?.login,
          senderType: payload?.sender?.type,
          isPullRequestComment: Boolean(payload?.issue?.pull_request),
          labels: (payload?.issue?.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
        });

  console.log(`autonomy wake: ${decision.handle ? "waking the supervisor" : "skipping"} (${decision.reason})`);
  process.exitCode = decision.handle ? 0 : 1;
}

main();
