import { describe, expect, it } from "vitest";
import {
  TRUSTED_BOT_LOGINS,
  WAKE_SOURCE_WORKFLOWS,
  WAKE_WORKFLOW_NAME,
  WAKE_WORKFLOW_PATH,
  isExplicitlyTrustedBotLogin,
  isWakeSourceWorkflowRun,
  shouldHandleEvent,
  shouldWakeForSourceWorkflowRun,
} from "../scripts/lib/supervisor-event-guard.mjs";
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

describe("isExplicitlyTrustedBotLogin: pure matching predicate (DE-0010 item 2 mechanism)", () => {
  it("matches a login present on a supplied allowlist, case-insensitively", () => {
    expect(
      isExplicitlyTrustedBotLogin("Directory-Engine-Workspace-Agent[bot]", ["directory-engine-workspace-agent[bot]"]),
    ).toBe(true);
  });

  it("does not match a login absent from a supplied allowlist", () => {
    expect(isExplicitlyTrustedBotLogin("dependabot[bot]", ["directory-engine-workspace-agent[bot]"])).toBe(false);
  });

  it("never matches github-actions[bot], even if a caller-supplied list includes it", () => {
    expect(isExplicitlyTrustedBotLogin("github-actions[bot]", ["github-actions[bot]"])).toBe(false);
  });

  it("fails closed on a missing or empty sender login", () => {
    expect(isExplicitlyTrustedBotLogin(undefined, ["some-login"])).toBe(false);
    expect(isExplicitlyTrustedBotLogin("", ["some-login"])).toBe(false);
  });
});

describe("shouldHandleEvent: fixed trusted-bot allowlist, not a repository-variable trust anchor (DE-0010 remediation)", () => {
  it("TRUSTED_BOT_LOGINS is a frozen, empty code constant - no non-owner bot identity has been confirmed yet", () => {
    expect(Object.isFrozen(TRUSTED_BOT_LOGINS)).toBe(true);
    expect(TRUSTED_BOT_LOGINS).toEqual([]);
  });

  it("shouldHandleEvent accepts no trustedBotLogins option; an injected override has no effect", () => {
    const decision = shouldHandleEvent({
      eventName: "pull_request_review",
      action: "submitted",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "directory-engine-workspace-agent[bot]",
      senderType: "Bot",
      // Even if a caller tries to pass this, it must be silently ignored -
      // the trust boundary is compiled into the module, not runtime input.
      trustedBotLogins: ["directory-engine-workspace-agent[bot]"],
    });
    expect(decision).toEqual({ handle: false, reason: "bot_actor" });
  });

  it("rejects every bot-type sender today, since the fixed allowlist is empty until a literal login is confirmed and reviewed", () => {
    const decision = shouldHandleEvent({
      eventName: "issue_comment",
      action: "created",
      repositoryFullName: REPO,
      expectedRepositoryFullName: REPO,
      senderLogin: "directory-engine-workspace-agent[bot]",
      senderType: "Bot",
      isPullRequestComment: true,
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

describe("WAKE_SOURCE_WORKFLOWS / isWakeSourceWorkflowRun: fixed name+path identities for the immediate check/implementation-completion handoff", () => {
  it("lists exactly Project governance and Claude Code, matched by both name and path", () => {
    expect(WAKE_SOURCE_WORKFLOWS).toEqual([
      { name: "Project governance", path: ".github/workflows/project-governance.yml" },
      { name: "Claude Code", path: ".github/workflows/claude.yml" },
    ]);
    expect(Object.isFrozen(WAKE_SOURCE_WORKFLOWS)).toBe(true);
  });

  it("matches a fixed source workflow's exact name/path pair", () => {
    expect(isWakeSourceWorkflowRun("Project governance", ".github/workflows/project-governance.yml")).toBe(true);
    expect(isWakeSourceWorkflowRun("Claude Code", ".github/workflows/claude.yml")).toBe(true);
  });

  it("security regression: rejects a forged run with a trusted name but a different path", () => {
    expect(isWakeSourceWorkflowRun("Project governance", ".github/workflows/forged-governance.yml")).toBe(false);
    expect(isWakeSourceWorkflowRun("Claude Code", ".github/workflows/forged-claude.yml")).toBe(false);
  });

  it("rejects a trusted path with a mismatched name, and any unrelated workflow", () => {
    expect(isWakeSourceWorkflowRun("Some Other Name", ".github/workflows/project-governance.yml")).toBe(false);
    expect(isWakeSourceWorkflowRun("Unrelated Workflow", ".github/workflows/unrelated.yml")).toBe(false);
  });

  it("never lists the wake or supervisor workflows themselves as a source, precluding a recursive wake chain", () => {
    expect(isWakeSourceWorkflowRun(WAKE_WORKFLOW_NAME, WAKE_WORKFLOW_PATH)).toBe(false);
    expect(isWakeSourceWorkflowRun("Autonomous supervisor", ".github/workflows/autonomy-supervisor.yml")).toBe(false);
  });
});

describe("shouldWakeForSourceWorkflowRun: the unprivileged wake workflow's own workflow_run guard", () => {
  const base = {
    repositoryFullName: REPO,
    expectedRepositoryFullName: REPO,
  };
  const governance = { workflowName: "Project governance", workflowPath: ".github/workflows/project-governance.yml" };
  const claudeCode = { workflowName: "Claude Code", workflowPath: ".github/workflows/claude.yml" };

  it("wakes on a successful Project governance completion", () => {
    expect(shouldWakeForSourceWorkflowRun({ ...base, ...governance, action: "completed" })).toEqual({
      handle: true,
      reason: "source_workflow_run_event",
    });
  });

  it("wakes on a FAILED Project governance completion too - failed CI is itself actionable", () => {
    expect(
      shouldWakeForSourceWorkflowRun({ ...base, ...governance, action: "completed", conclusion: "failure" }),
    ).toEqual({ handle: true, reason: "source_workflow_run_event" });
  });

  it("wakes on a Claude Code completion regardless of its own conclusion - the supervisor re-reads fresh state rather than trusting it", () => {
    expect(
      shouldWakeForSourceWorkflowRun({ ...base, ...claudeCode, action: "completed", conclusion: "failure" }),
    ).toEqual({ handle: true, reason: "source_workflow_run_event" });
  });

  it("fails closed when the event payload is missing/unreadable", () => {
    expect(
      shouldWakeForSourceWorkflowRun({ ...base, ...governance, action: "completed", payloadAvailable: false }),
    ).toEqual({ handle: false, reason: "missing_or_unreadable_event_payload" });
  });

  it("skips a non-completed workflow_run action", () => {
    expect(shouldWakeForSourceWorkflowRun({ ...base, ...governance, action: "requested" })).toEqual({
      handle: false,
      reason: "irrelevant_workflow_run_action",
    });
  });

  it("skips a wrong-repository event", () => {
    expect(
      shouldWakeForSourceWorkflowRun({
        ...governance,
        action: "completed",
        repositoryFullName: "someone-else/other-repo",
        expectedRepositoryFullName: REPO,
      }),
    ).toEqual({ handle: false, reason: "wrong_repository" });
  });

  it("skips an unrelated workflow's completion", () => {
    expect(
      shouldWakeForSourceWorkflowRun({
        ...base,
        action: "completed",
        workflowName: "Some Unrelated Workflow",
        workflowPath: ".github/workflows/some-unrelated.yml",
      }),
    ).toEqual({ handle: false, reason: "unrelated_workflow" });
  });

  it("skips a same-name forged-path run", () => {
    expect(
      shouldWakeForSourceWorkflowRun({
        ...base,
        action: "completed",
        workflowName: "Project governance",
        workflowPath: ".github/workflows/forged.yml",
      }),
    ).toEqual({ handle: false, reason: "unrelated_workflow" });
  });

  it("never wakes on its own completion or the secret-bearing supervisor's completion, precluding a recursive chain", () => {
    expect(
      shouldWakeForSourceWorkflowRun({
        ...base,
        action: "completed",
        workflowName: WAKE_WORKFLOW_NAME,
        workflowPath: WAKE_WORKFLOW_PATH,
      }),
    ).toEqual({ handle: false, reason: "unrelated_workflow" });
    expect(
      shouldWakeForSourceWorkflowRun({
        ...base,
        action: "completed",
        workflowName: "Autonomous supervisor",
        workflowPath: ".github/workflows/autonomy-supervisor.yml",
      }),
    ).toEqual({ handle: false, reason: "unrelated_workflow" });
  });
});
