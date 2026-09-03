import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
 */
const WORKFLOW_PATH = fileURLToPath(new URL("../.github/workflows/autonomy-wake.yml", import.meta.url));
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

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

describe("autonomy-wake.yml: no credential can ever enter this PR-controlled-trigger workflow", () => {
  it("never references the Workspace Agent id or token, in any form", () => {
    expect(workflow).not.toMatch(/CHATGPT_WORKSPACE_AGENT_ID/);
    expect(workflow).not.toMatch(/CHATGPT_WORKSPACE_AGENT_TOKEN/);
  });

  it("never references any repository secret at all", () => {
    expect(workflow).not.toMatch(/secrets\./);
  });

  it("references at most the one non-secret trusted-bot-login repository variable", () => {
    const varRefs = [...workflow.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(new Set(varRefs)).toEqual(new Set(["AUTONOMY_TRUSTED_BOT_LOGINS"]));
  });
});

describe("autonomy-wake.yml: least-privilege, read-only permissions", () => {
  it("grants only contents: read - no write permission of any kind", () => {
    const permissions = extractTopLevelBlock(workflow, "permissions");
    const scopeLines = permissions.split("\n").filter((line) => line.trim().length > 0);
    expect(scopeLines).toHaveLength(1);
    expect(permissions).toMatch(/^\s*contents: read\s*$/m);
    expect(permissions).not.toMatch(/write/);
  });
});

describe("autonomy-wake.yml: trusted default-branch checkout, regardless of trigger", () => {
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

describe("autonomy-wake.yml: trigger surface", () => {
  it("reacts to the guarded pull_request/pull_request_review/issue_comment events", () => {
    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
    expect(workflow).toMatch(/^\s*pull_request_review:\s*$/m);
    expect(workflow).toMatch(/^\s*issue_comment:\s*$/m);
  });

  it("never itself schedules or accepts workflow_run/workflow_dispatch - it is the trigger source, not the recovery backstop", () => {
    expect(workflow).not.toMatch(/^\s*schedule:\s*$/m);
    expect(workflow).not.toMatch(/^\s*workflow_run:\s*$/m);
    expect(workflow).not.toMatch(/^\s*workflow_dispatch:\s*$/m);
  });
});
