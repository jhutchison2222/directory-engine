import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * DE-0010 security redesign (owner-authorized): these tests inspect the
 * actual `.github/workflows/autonomy-supervisor.yml` file text (there is no
 * YAML-parsing dependency in this repository, so structural assertions are
 * string/regex-based rather than parsed) and prove the properties that
 * matter for a workflow that ends up holding
 * `secrets.CHATGPT_WORKSPACE_AGENT_TOKEN`: it is triggered only by event
 * types whose *workflow definition* GitHub always loads from the default
 * branch (schedule, workflow_dispatch, workflow_run) - never a type whose
 * definition can be loaded from a pull request's own ref (pull_request,
 * pull_request_review) - it checks out the trusted default branch (never
 * an untrusted PR head or merge ref), grants only the authorized
 * least-privilege permissions, and invokes only the one reviewed runner
 * script from that trusted checkout.
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
const WORKFLOW_PATH = fileURLToPath(new URL("../.github/workflows/autonomy-supervisor.yml", import.meta.url));
const workflowFileExists = existsSync(WORKFLOW_PATH);
const workflow = workflowFileExists ? readFileSync(WORKFLOW_PATH, "utf8") : "";

describe.skipIf(workflowFileExists)("autonomy-supervisor.yml: workflow file intentionally absent", () => {
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

describe.skipIf(!workflowFileExists)("autonomy-supervisor.yml: trigger surface", () => {
  it("preserves the scheduled recovery backstop and manual dispatch", () => {
    expect(workflow).toMatch(/cron:\s*"\*\/5 \* \* \* \*"/);
    expect(workflow).toMatch(/workflow_dispatch:/);
  });

  it("is woken only via workflow_run of the unprivileged wake workflow, never directly by pull_request/pull_request_review/issue_comment", () => {
    expect(workflow).toMatch(/^\s*workflow_run:\s*$/m);
    expect(workflow).toContain('workflows: ["Autonomy wake"]');
    expect(workflow).not.toMatch(/^\s*pull_request:\s*$/m);
    expect(workflow).not.toMatch(/^\s*pull_request_review:\s*$/m);
    expect(workflow).not.toMatch(/^\s*issue_comment:\s*$/m);
  });

  it("never uses pull_request_target, which would run untrusted PR-head code with repository secrets", () => {
    expect(workflow).not.toMatch(/pull_request_target/);
  });
});

describe.skipIf(!workflowFileExists)("autonomy-supervisor.yml: least-privilege permissions", () => {
  const permissions = workflowFileExists ? extractTopLevelBlock(workflow, "permissions") : "";

  it("grants exactly the five authorized scopes", () => {
    expect(permissions).toMatch(/^\s*actions: read\s*$/m);
    expect(permissions).toMatch(/^\s*checks: read\s*$/m);
    expect(permissions).toMatch(/^\s*contents: read\s*$/m);
    expect(permissions).toMatch(/^\s*issues: write\s*$/m);
    expect(permissions).toMatch(/^\s*pull-requests: write\s*$/m);
  });

  it("never grants contents: write or any deployment/packages/administration/security-events permission", () => {
    expect(permissions).not.toMatch(/contents:\s*write/);
    expect(permissions).not.toMatch(/deployments?:/);
    expect(permissions).not.toMatch(/packages:/);
    expect(permissions).not.toMatch(/administration:/);
    expect(permissions).not.toMatch(/security-events:/);
    expect(permissions).not.toMatch(/environments?:/);
  });

  it("grants no permission scope beyond the five authorized ones", () => {
    const scopeLines = permissions.split("\n").filter((line) => line.trim().length > 0);
    expect(scopeLines).toHaveLength(5);
  });
});

describe.skipIf(!workflowFileExists)("autonomy-supervisor.yml: single non-overlapping concurrency group", () => {
  it("never runs two evaluations concurrently and never cancels an in-flight one", () => {
    const concurrency = extractTopLevelBlock(workflow, "concurrency");
    expect(concurrency).toMatch(/group:\s*\S+/);
    expect(concurrency).toMatch(/cancel-in-progress:\s*false/);
  });
});

describe.skipIf(!workflowFileExists)("autonomy-supervisor.yml: trusted default-branch checkout before secret-bearing execution", () => {
  it("checks out the repository's default branch with persisted credentials disabled", () => {
    const checkoutIndex = workflow.indexOf("uses: actions/checkout@");
    expect(checkoutIndex).toBeGreaterThan(-1);
    const checkoutBlock = workflow.slice(checkoutIndex, checkoutIndex + 300);
    expect(checkoutBlock).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(checkoutBlock).toContain("persist-credentials: false");
  });

  it("never checks out an untrusted pull-request head SHA or merge ref", () => {
    expect(workflow).not.toContain("github.event.pull_request.head.sha");
    expect(workflow).not.toMatch(/refs\/pull\//);
    expect(workflow).not.toContain("github.event.pull_request.merge_commit_sha");
  });

  it("invokes only the one reviewed runner script, exactly once in the job", () => {
    const runLines = workflow.split("\n").filter((line) => line.trim().startsWith("run:"));
    expect(runLines).toHaveLength(1);
    expect(runLines[0].trim()).toBe("run: node scripts/run-autonomy-supervisor.mjs");
  });

  it("the secret-bearing step is wired after the trusted checkout step, never before it", () => {
    const checkoutIndex = workflow.indexOf("uses: actions/checkout@");
    const secretIndex = workflow.indexOf("secrets.CHATGPT_WORKSPACE_AGENT_TOKEN");
    expect(checkoutIndex).toBeGreaterThan(-1);
    expect(secretIndex).toBeGreaterThan(checkoutIndex);
  });
});

describe.skipIf(!workflowFileExists)("autonomy-supervisor.yml: credentials referenced by name only", () => {
  it("reads the agent id and token only from vars/secrets by name, never a literal value", () => {
    expect(workflow).toContain("${{ vars.CHATGPT_WORKSPACE_AGENT_ID }}");
    expect(workflow).toContain("${{ secrets.CHATGPT_WORKSPACE_AGENT_TOKEN }}");
  });

  it("never sources the trusted-bot-login allowlist from a repository variable; that trust anchor is fixed in reviewed code, not a mutable setting", () => {
    expect(workflow).not.toMatch(/AUTONOMY_TRUSTED_BOT_LOGINS/);
  });

  it("references no repository variable other than the Workspace Agent id", () => {
    const varRefs = [...workflow.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(new Set(varRefs)).toEqual(new Set(["CHATGPT_WORKSPACE_AGENT_ID"]));
  });

  it("never references a repository/environment secret other than the one authorized Workspace Agent token", () => {
    const secretRefs = [...workflow.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(new Set(secretRefs)).toEqual(new Set(["CHATGPT_WORKSPACE_AGENT_TOKEN"]));
  });
});
