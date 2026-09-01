import { readFile } from "node:fs/promises";

const requiredFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/automation/collaboration-policy.md",
  "docs/decisions/ADR-001-national-niche-domains.md",
  "docs/contracts/work-packet.schema.json",
  "docs/contracts/project-state.schema.json",
  "project/current-state.json",
  ".github/ISSUE_TEMPLATE/work-packet.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

const contents = new Map();
for (const file of requiredFiles) {
  contents.set(file, await readFile(file, "utf8"));
}

const parse = (file) => {
  try {
    return JSON.parse(contents.get(file));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
};

const workPacketSchema = parse("docs/contracts/work-packet.schema.json");
const projectStateSchema = parse("docs/contracts/project-state.schema.json");
const state = parse("project/current-state.json");

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

requireCondition(workPacketSchema.additionalProperties === false, "work-packet schema must fail closed on unknown properties");
requireCondition(projectStateSchema.additionalProperties === false, "project-state schema must fail closed on unknown properties");
requireCondition(state.accepted_architecture === "ADR-001-national-niche-domains", "accepted architecture must be ADR-001");
requireCondition(/^[0-9a-f]{40}$/.test(state.repository_baseline), "repository baseline must be a full commit SHA");
requireCondition(state.repository_capability === "contains_write_paths", "repository capability must acknowledge current write paths");
requireCondition(state.deployed_capability === "unverified", "deployed capability must remain unverified in foundation phase");
requireCondition(state.automation_phase === "foundation", "automation phase must remain foundation until the fixture is reviewed");
requireCondition(state.auto_merge_enabled === false, "auto-merge must remain disabled in foundation phase");
requireCondition(state.production_mutations_authorized === false, "foundation must not authorize production mutations");
requireCondition(state.active_work_packet === null, "foundation must not claim an active automated work packet");

for (const agentFile of ["AGENTS.md", "CLAUDE.md"]) {
  requireCondition(
    contents.get(agentFile).includes("docs/automation/collaboration-policy.md"),
    `${agentFile} must reference the canonical collaboration policy`,
  );
}

const normalizeWhitespace = (value) => value.replace(/\s+/g, " ");
const adr = normalizeWhitespace(contents.get("docs/decisions/ADR-001-national-niche-domains.md"));
for (const phrase of [
  "one authoritative United States public directory per approved industry",
  "Geography and service taxonomy remain independent dimensions",
  "one canonical listing page",
  "must not automatically index every location and category permutation",
]) {
  requireCondition(adr.includes(phrase), `ADR-001 is missing required decision text: ${phrase}`);
}

const policy = normalizeWhitespace(contents.get("docs/automation/collaboration-policy.md"));
for (const phrase of [
  "Auto-merge is disabled during the foundation phase",
  "maximum of three remediation cycles",
  "The implementer must not be the final reviewer",
]) {
  requireCondition(policy.includes(phrase), `collaboration policy is missing: ${phrase}`);
}

const readme = normalizeWhitespace(await readFile("README.md", "utf8"));
requireCondition(
  readme.includes("current `main` source also contains later write paths"),
  "README must disclose the difference between the historical read-only baseline and current source",
);
requireCondition(
  readme.includes("deployment state of those paths has not been independently verified"),
  "README must not imply that current source capability is deployed",
);

console.log("Project governance validation passed.");
