import { readFile } from "node:fs/promises";
import { validateRemediationFixture } from "./lib/validate-remediation-fixture.mjs";
import { assertValidAgainstSchema } from "./lib/json-schema-lite.mjs";
import { assertValidUrlListingIdentity } from "./lib/validate-url-listing-identity.mjs";
import { assertValidNicheSiteRegistry } from "./lib/validate-niche-site-registry.mjs";
import { assertRecursiveFailClosed } from "./lib/schema-fail-closed.mjs";
import { readJsonFile } from "./lib/read-json-file.mjs";
import { findFieldById } from "./lib/work-packet-template.mjs";
import { buildRemediationCycleOptions } from "./lib/remediation-cycles.mjs";
import { assertAutomationPhaseInvariants } from "./lib/automation-phase.mjs";

const requiredFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/automation/collaboration-policy.md",
  "docs/decisions/ADR-001-national-niche-domains.md",
  "docs/contracts/work-packet.schema.json",
  "docs/contracts/project-state.schema.json",
  "docs/contracts/url-listing-identity.schema.json",
  "docs/contracts/niche-site-registry.schema.json",
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
const urlListingIdentitySchema = parse("docs/contracts/url-listing-identity.schema.json");
const nicheSiteRegistrySchema = parse("docs/contracts/niche-site-registry.schema.json");
const state = parse("project/current-state.json");

const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

assertRecursiveFailClosed(workPacketSchema, "work-packet schema");
assertRecursiveFailClosed(projectStateSchema, "project-state schema");
assertRecursiveFailClosed(urlListingIdentitySchema, "url-listing-identity schema");
requireCondition(
  urlListingIdentitySchema.properties?.country?.const === "US",
  'url-listing-identity schema must require country to be exactly "US"',
);
assertRecursiveFailClosed(nicheSiteRegistrySchema, "niche-site-registry schema");
requireCondition(
  nicheSiteRegistrySchema.properties?.country?.const === "US",
  'niche-site-registry schema must require country to be exactly "US"',
);

assertValidAgainstSchema(projectStateSchema, state, "project/current-state.json");

const urlListingIdentityFixturePath = "project/fixtures/de-0006-url-listing-identity.valid.json";
const urlListingIdentityFixture = await readJsonFile(urlListingIdentityFixturePath);
assertValidAgainstSchema(urlListingIdentitySchema, urlListingIdentityFixture, urlListingIdentityFixturePath);
assertValidUrlListingIdentity(urlListingIdentityFixture, urlListingIdentityFixturePath);

const nicheSiteRegistryFixturePath = "project/fixtures/de-0008-niche-site-registry.valid.json";
const nicheSiteRegistryFixture = await readJsonFile(nicheSiteRegistryFixturePath);
assertValidAgainstSchema(nicheSiteRegistrySchema, nicheSiteRegistryFixture, nicheSiteRegistryFixturePath);
assertValidNicheSiteRegistry(nicheSiteRegistryFixture, nicheSiteRegistryFixturePath);

requireCondition(
  workPacketSchema.required.includes("max_remediation_cycles"),
  "work-packet schema must require max_remediation_cycles",
);
const maxRemediationCyclesField = findFieldById(
  contents.get(".github/ISSUE_TEMPLATE/work-packet.yml"),
  "max_remediation_cycles",
);
requireCondition(
  maxRemediationCyclesField !== null,
  "work-packet issue template must define a max_remediation_cycles field",
);
requireCondition(
  maxRemediationCyclesField.type === "dropdown",
  "max_remediation_cycles field must be a dropdown for deterministic mapping",
);
requireCondition(maxRemediationCyclesField.required === true, "max_remediation_cycles field must be required");
const expectedRemediationCycleOptions = buildRemediationCycleOptions(workPacketSchema.properties.max_remediation_cycles);
requireCondition(
  JSON.stringify(maxRemediationCyclesField.options) === JSON.stringify(expectedRemediationCycleOptions),
  `max_remediation_cycles dropdown options must exactly match schema bounds: ${expectedRemediationCycleOptions.join(", ")}`,
);

requireCondition(state.repository_capability === "contains_write_paths", "repository capability must acknowledge current write paths");
requireCondition(state.deployed_capability === "unverified", "deployed capability must remain unverified in foundation phase");
requireCondition(
  ["foundation", "fixture", "code_only"].includes(state.automation_phase),
  "automation phase must remain foundation, fixture, or code_only until staging is authorized",
);
requireCondition(state.auto_merge_enabled === false, "auto-merge must remain disabled before staging is authorized");
requireCondition(state.production_mutations_authorized === false, "this automation stage must not authorize production mutations");

assertAutomationPhaseInvariants(state);

if (state.automation_phase === "fixture") {
  const fixturePath = "project/fixtures/de-0002-remediation-probe.json";
  const fixture = await readJsonFile(fixturePath);
  validateRemediationFixture(fixture, state.active_work_packet);
}

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
