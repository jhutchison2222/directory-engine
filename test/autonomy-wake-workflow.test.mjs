import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * DE-0010 security redesign (owner-authorized): structural proof that the
 * unprivileged "Autonomy wake" workflow - which IS triggered directly by
 * pull_request/pull_request_review/issue_comment, and therefore has its own
 * *workflow definition* loaded from whatever ref produced the event - can
 * never hold or expose the Workspace Agent credential, and never executes
 * anything beyond this one trusted, reviewed script from a checkout of the
 * repository's default branch (never the PR head/merge ref, regardless of
 * what triggered it).
 *
 * DE-0010-R1: following the post-merge security findings that led to
 * disabling both autonomy workflow files pending review (see
 * docs/automation/autonomy-supervisor.md), this file is intentionally
 * absent from every code-only remediation branch - a maintainer applies the
 * exact reviewed YAML directly, as with every prior workflow-file change in
 * this packet. These structural tests are skipped (never silently deleted)
 * while the file is absent, and run again automatically once it is
 * reinstated.
 */
const WORKFLOW_PATH = fileURLToPath(new URL("../.github/workflows/autonomy-wake.yml", import.meta.url));
const workflowFileExists = existsSync(WORKFLOW_PATH);
const workflow = workflowFileExists ? readFileSync(WORKFLOW_PATH, "utf8") : "";

describe.skipIf(workflowFileExists)("autonomy-wake.yml: workflow file intentionally absent", () => {
  it("is pending maintainer-applied insertion of the reviewed YAML; structural tests below are skipped, not deleted", () => {
    expect(workflowFileExists).toBe(false);
  });
});

function extractTopLevelBlock(source, key) {
  const lines = source.split("\n");
  const startIndex = lines.findIndex((line) => line === `${key}:`);
  if (startIndex === -1) throw new Error(`top-level key "${key}:" not found in workflow file`);
  const blockLines = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) break;
    blockLines.push(line);
  }
  return blockLines.join("\n");
}

describe.skipIf(!workflowFileExists)("autonomy-wake.yml: no credential can ever enter this PR-controlled-trigger workflow", () => {
  it("never references the Workspace Agent id or token, in any form", () => {
    expect(workflow).not.toMatch(/CHATGPT_WORKSPACE_AGENT_ID/);
    expect(workflow).not.toMatch(/CHATGPT_WORKSPACE_AGENT_TOKEN/);
  });

  it("never references any repository secret at all", () => {
    expect(workflow).not.toMatch(/secrets\./);
  });

  it("references no repository variable at all; the trusted-bot-login allowlist is a fixed code constant, not a mutable setting", () => {
    expect(workflow).not.toMatch(/AUTONOMY_TRUSTED_BOT_LOGINS/);
    const varRefs = [...workflow.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(varRefs).toEqual([]);
  });
});

describe.skipIf(!workflowFileExists)("autonomy-wake.yml: least-privilege, read-only permissions", () => {
  it("grants only contents: read - no write permission of any kind", () => {
    const permissions = extractTopLevelBlock(workflow, "permissions");
    const scopeLines = permissions.split("\n").filter((line) => line.trim().length > 0);
    expect(scopeLines).toHaveLength(1);
    expect(permissions).toMatch(/^\s*contents: read\s*$/m);
    expect(permissions).not.toMatch(/write/);
  });
});

describe.skipIf(!workflowFileExists)("autonomy-wake.yml: trusted default-branch checkout, regardless of trigger", () => {
  it("checks out the repository's default branch with persisted credentials disabled", () => {
    const checkoutIndex = workflow.indexOf("uses: actions/checkout@");
    expect(checkoutIndex).toBeGreaterThan(-1);
    const checkoutBlock = workflow.slice(checkoutIndex, checkoutIndex + 300);
    expect(checkoutBlock).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(checkoutBlock).toContain("persist-credentials: false");
  });

  it("never checks out an untrusted pull-request head SHA or merge ref, and never uses pull_request_target", () => {
    expect(workflow).not.toContain("github.event.pull_request.head.sha");
    expect(workflow).not.toMatch(/refs\/pull\//);
    expect(workflow).not.toContain("github.event.pull_request.merge_commit_sha");
    expect(workflow).not.toMatch(/pull_request_target/);
  });

  it("invokes only the one reviewed guard script, exactly once in the job", () => {
    const runLines = workflow.split("\n").filter((line) => line.trim().startsWith("run:"));
    expect(runLines).toHaveLength(1);
    expect(runLines[0].trim()).toBe("run: node scripts/run-autonomy-wake.mjs");
  });
});

describe.skipIf(!workflowFileExists)("autonomy-wake.yml: trigger surface", () => {
  it("reacts to the guarded pull_request/pull_request_review/issue_comment events", () => {
    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
    expect(workflow).toMatch(/^\s*pull_request_review:\s*$/m);
    expect(workflow).toMatch(/^\s*issue_comment:\s*$/m);
  });

  it("reacts to workflow_run completion of exactly Project governance and Claude Code - the immediate check/implementation-completion handoff", () => {
    expect(workflow).toMatch(/^\s*workflow_run:\s*$/m);
    expect(workflow).toContain('workflows: ["Project governance", "Claude Code"]');
    expect(workflow).toMatch(/workflow_run:[\s\S]*?types: \[completed\]/);
  });

  it("never itself schedules or accepts workflow_dispatch - it is a trigger source, not the recovery backstop", () => {
    expect(workflow).not.toMatch(/^\s*schedule:\s*$/m);
    expect(workflow).not.toMatch(/^\s*workflow_dispatch:\s*$/m);
  });

  it("never lists itself or the secret-bearing supervisor as a workflow_run source, preventing a recursive wake chain", () => {
    expect(workflow).not.toMatch(/workflow_run:[\s\S]*?Autonomy wake/);
    expect(workflow).not.toMatch(/workflow_run:[\s\S]*?Autonomous supervisor/);
  });
});
