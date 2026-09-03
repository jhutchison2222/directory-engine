import { describe, expect, it } from "vitest";
import { WAKE_WORKFLOW_NAME, WAKE_WORKFLOW_PATH, shouldHandleEvent } from "../scripts/lib/supervisor-event-guard.mjs";
import { AUTONOMY_READY_LABEL } from "../scripts/lib/supervisor-policy.mjs";

const REPO = "jhutchison2222/directory-engine";

describe("shouldHandleEvent: schedule and manual dispatch always proceed", () => {
  it("always handles the scheduled recovery backstop tick", () => {
    expect(shouldHandleEvent({ eventName: "schedule" })).toEqual({ handle: true, reason: "schedule" });
  });

  it("always handles a manual workflow_dispatch", () => {
    expect(shouldHandleEvent({ eventName: "workflow_dispatch" })).toEqual({
      handle: true,
      reason: "workflow_dispatch",
    });
  });
});

describe("shouldHandleEvent: missing/unreadable event payload fails closed for event-driven invocations", () => {
  it("never proceeds for a guarded event type when the payload is unavailable", () => {
    const decision = shouldHandleEvent({
      eventName: "pull_request",
      payloadAvailable: false,
      action: "opened",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "a-human",
      senderType: "User",
    });
    expect(decision).toEqual({ handle: false, reason: "missing_or_unreadable_event_payload" });
  });

  it.each(["pull_request", "pull_request_review", "issue_comment", "workflow_run"])(
    "fails closed for %s when the payload is unavailable, regardless of any other field",
    (eventName) => {
      expect(shouldHandleEvent({ eventName, payloadAvailable: false })).toEqual({
        handle: false,
        reason: "missing_or_unreadable_event_payload",
      });
    },
  );

  it("does not require a payload for the scheduled recovery backstop or manual dispatch", () => {
    expect(shouldHandleEvent({ eventName: "schedule", payloadAvailable: false })).toEqual({
      handle: true,
      reason: "schedule",
    });
    expect(shouldHandleEvent({ eventName: "workflow_dispatch", payloadAvailable: false })).toEqual({
      handle: true,
      reason: "workflow_dispatch",
    });
  });

  it("proceeds normally once a payload is available (default assumption when the caller omits the flag)", () => {
    const decision = shouldHandleEvent({
      eventName: "pull_request",
      action: "opened",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "a-human",
      senderType: "User",
    });
    expect(decision).toEqual({ handle: true, reason: "pull_request_event" });
  });
});

describe("shouldHandleEvent: repository guard", () => {
  it("ignores an event from a different repository", () => {
    const decision = shouldHandleEvent({
      eventName: "pull_request",
      action: "opened",
      repositoryFullName: "someone-else/other-repo",
      expectedRepositoryFullName: REPO,
      senderLogin: "a-human",
      senderType: "User",
    });
    expect(decision).toEqual({ handle: false, reason: "wrong_repository" });
  });
});

describe("shouldHandleEvent: self/bot recursion prevention", () => {
  it("ignores an event triggered by a Claude-associated actor", () => {
    const decision = shouldHandleEvent({
      eventName: "issue_comment",
      action: "created",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "claude[bot]",
      senderType: "Bot",
      isPullRequestComment: true,
    });
    expect(decision).toEqual({ handle: false, reason: "self_or_recursive_actor" });
  });

  it("ignores a generic bot-authored issue_comment to avoid dispatch-marker recursion", () => {
    const decision = shouldHandleEvent({
      eventName: "issue_comment",
      action: "created",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "github-actions[bot]",
      senderType: "Bot",
      isPullRequestComment: true,
    });
    expect(decision).toEqual({ handle: false, reason: "bot_actor" });
  });

  it("does not apply the generic bot check to workflow_run, whose effective actor is GitHub itself", () => {
    const decision = shouldHandleEvent({
      eventName: "workflow_run",
      action: "completed",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "github-actions[bot]",
      senderType: "Bot",
      workflowName: WAKE_WORKFLOW_NAME,
      workflowPath: WAKE_WORKFLOW_PATH,
      workflowRunConclusion: "success",
    });
    expect(decision).toEqual({ handle: true, reason: "workflow_run_event" });
  });
});

describe("shouldHandleEvent: explicit trusted-bot-login allowance (DE-0010 item 2)", () => {
  it("handles a review submitted by a specifically trusted bot-type reviewer/agent identity", () => {
    const decision = shouldHandleEvent({
      eventName: "pull_request_review",
      action: "submitted",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "directory-engine-workspace-agent[bot]",
      senderType: "Bot",
      trustedBotLogins: ["directory-engine-workspace-agent[bot]"],
    });
    expect(decision).toEqual({ handle: true, reason: "pull_request_review_event" });
  });

  it("handles a comment on a pull request from a trusted bot login, matched case-insensitively", () => {
    const decision = shouldHandleEvent({
      eventName: "issue_comment",
      action: "created",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "Directory-Engine-Workspace-Agent[bot]",
      senderType: "Bot",
      isPullRequestComment: true,
      trustedBotLogins: ["directory-engine-workspace-agent[bot]"],
    });
    expect(decision).toEqual({ handle: true, reason: "issue_comment_event" });
  });

  it("still rejects github-actions[bot] even if a misconfigured trustedBotLogins list includes it", () => {
    const decision = shouldHandleEvent({
      eventName: "issue_comment",
      action: "created",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "github-actions[bot]",
      senderType: "Bot",
      isPullRequestComment: true,
      trustedBotLogins: ["github-actions[bot]"],
    });
    expect(decision).toEqual({ handle: false, reason: "bot_actor" });
  });

  it("still rejects an unrelated bot not on the trusted allowlist", () => {
    const decision = shouldHandleEvent({
      eventName: "issue_comment",
      action: "created",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "dependabot[bot]",
      senderType: "Bot",
      isPullRequestComment: true,
      trustedBotLogins: ["directory-engine-workspace-agent[bot]"],
    });
    expect(decision).toEqual({ handle: false, reason: "bot_actor" });
  });

  it("defaults to rejecting every bot actor when no trustedBotLogins is supplied (unchanged default behavior)", () => {
    const decision = shouldHandleEvent({
      eventName: "pull_request_review",
      action: "submitted",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "directory-engine-workspace-agent[bot]",
      senderType: "Bot",
    });
    expect(decision).toEqual({ handle: false, reason: "bot_actor" });
  });
});

describe("shouldHandleEvent: pull_request", () => {
  const base = {
    eventName: "pull_request",
    repositoryFullName: REPO,
    expectedRepositoryFullName: REPO,
    senderLogin: "a-human",
    senderType: "User",
  };

  it.each(["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft", "closed"])(
    "handles the relevant action %s",
    (action) => {
      expect(shouldHandleEvent({ ...base, action })).toEqual({ handle: true, reason: "pull_request_event" });
    },
  );

  it("skips an irrelevant pull_request action", () => {
    expect(shouldHandleEvent({ ...base, action: "labeled" })).toEqual({
      handle: false,
      reason: "irrelevant_pull_request_action",
    });
  });
});

describe("shouldHandleEvent: pull_request_review", () => {
  const base = {
    eventName: "pull_request_review",
    repositoryFullName: REPO,
    expectedRepositoryFullName: REPO,
    senderLogin: "codex",
    senderType: "User",
  };

  it.each(["submitted", "edited", "dismissed"])("handles the relevant action %s", (action) => {
    expect(shouldHandleEvent({ ...base, action })).toEqual({ handle: true, reason: "pull_request_review_event" });
  });

  it("skips an irrelevant pull_request_review action", () => {
    expect(shouldHandleEvent({ ...base, action: "commented" })).toEqual({
      handle: false,
      reason: "irrelevant_review_action",
    });
  });
});

describe("shouldHandleEvent: issue_comment", () => {
  const base = {
    eventName: "issue_comment",
    action: "created",
    repositoryFullName: REPO,
    expectedRepositoryFullName: REPO,
    senderLogin: "a-human",
    senderType: "User",
  };

  it("handles a comment on a pull request", () => {
    expect(shouldHandleEvent({ ...base, isPullRequestComment: true })).toEqual({
      handle: true,
      reason: "issue_comment_event",
    });
  });

  it("handles a comment on an autonomy-ready-labeled issue", () => {
    expect(shouldHandleEvent({ ...base, isPullRequestComment: false, labels: [AUTONOMY_READY_LABEL] })).toEqual({
      handle: true,
      reason: "issue_comment_event",
    });
  });

  it("skips a comment on an ordinary issue with no autonomy-ready label", () => {
    expect(shouldHandleEvent({ ...base, isPullRequestComment: false, labels: [] })).toEqual({
      handle: false,
      reason: "not_pull_request_or_autonomy_ready",
    });
  });

  it("skips an irrelevant issue_comment action", () => {
    expect(shouldHandleEvent({ ...base, action: "deleted", isPullRequestComment: true })).toEqual({
      handle: false,
      reason: "irrelevant_comment_action",
    });
  });
});

describe("shouldHandleEvent: workflow_run", () => {
  const base = {
    eventName: "workflow_run",
    repositoryFullName: REPO,
    expectedRepositoryFullName: REPO,
    senderLogin: "github-actions[bot]",
    senderType: "Bot",
  };
  const wake = { workflowName: WAKE_WORKFLOW_NAME, workflowPath: WAKE_WORKFLOW_PATH };

  it("handles a successful completion of the wake workflow", () => {
    expect(shouldHandleEvent({ ...base, ...wake, action: "completed", workflowRunConclusion: "success" })).toEqual({
      handle: true,
      reason: "workflow_run_event",
    });
  });

  it("skips an unsupervised workflow's completion", () => {
    expect(
      shouldHandleEvent({
        ...base,
        action: "completed",
        workflowName: "Some Unrelated Workflow",
        workflowPath: ".github/workflows/some-unrelated.yml",
        workflowRunConclusion: "success",
      }),
    ).toEqual({ handle: false, reason: "unsupervised_workflow" });
  });

  it("security redesign item 9 regression: skips a run with the wake workflow's name but a forged path", () => {
    expect(
      shouldHandleEvent({
        ...base,
        action: "completed",
        workflowName: WAKE_WORKFLOW_NAME,
        workflowPath: ".github/workflows/forged.yml",
        workflowRunConclusion: "success",
      }),
    ).toEqual({ handle: false, reason: "unsupervised_workflow" });
  });

  it("skips a non-completed workflow_run action", () => {
    expect(shouldHandleEvent({ ...base, ...wake, action: "requested", workflowRunConclusion: "success" })).toEqual({
      handle: false,
      reason: "irrelevant_workflow_run_action",
    });
  });

  it("skips a completed wake run whose conclusion was not success (e.g. an irrelevant event the wake guard correctly rejected)", () => {
    expect(shouldHandleEvent({ ...base, ...wake, action: "completed", workflowRunConclusion: "failure" })).toEqual({
      handle: false,
      reason: "workflow_run_not_successful",
    });
  });

  it("fails closed when the wake run's conclusion is missing entirely", () => {
    expect(shouldHandleEvent({ ...base, ...wake, action: "completed" })).toEqual({
      handle: false,
      reason: "workflow_run_not_successful",
    });
  });
});

describe("shouldHandleEvent: unrecognized event names fail closed", () => {
  it("skips an event type this supervisor does not understand", () => {
    expect(
      shouldHandleEvent({
        eventName: "push",
        repositoryFullName: REPO,
        expectedRepositoryFullName: REPO,
        senderLogin: "a-human",
        senderType: "User",
      }),
    ).toEqual({ handle: false, reason: "unrecognized_event" });
  });
});
