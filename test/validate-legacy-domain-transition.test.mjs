import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertValidAgainstSchema } from "../scripts/lib/json-schema-lite.mjs";
import {
  assertValidLegacyDomainTransition,
  validateLegacyDomainTransition,
} from "../scripts/lib/validate-legacy-domain-transition.mjs";

const schema = JSON.parse(
  await readFile(new URL("../docs/contracts/legacy-domain-transition.schema.json", import.meta.url), "utf8"),
);

async function loadFixture(name) {
  const raw = await readFile(new URL(`../project/fixtures/${name}`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

const registryFixture = await loadFixture("de-0008-niche-site-registry.valid.json");

const INVALID_FIXTURES = [
  ["de-0009-invalid-duplicate-id.json", "duplicate-id"],
  ["de-0009-invalid-duplicate-origin.json", "duplicate-origin"],
  ["de-0009-invalid-malformed-origin.json", "malformed-origin"],
  ["de-0009-invalid-origin-has-path.json", "origin-has-path"],
  ["de-0009-invalid-origin-has-query.json", "origin-has-query"],
  ["de-0009-invalid-origin-has-fragment.json", "origin-has-fragment"],
  ["de-0009-invalid-origin-has-credentials.json", "origin-has-credentials"],
  ["de-0009-invalid-origin-at-in-path.json", "origin-has-path"],
  ["de-0009-invalid-origin-at-in-query.json", "origin-has-query"],
  ["de-0009-invalid-origin-at-in-fragment.json", "origin-has-fragment"],
  ["de-0009-invalid-origin-has-port.json", "origin-has-port"],
  ["de-0009-invalid-origin-has-wildcard.json", "origin-has-wildcard"],
  ["de-0009-invalid-self-target.json", "self-target"],
  ["de-0009-invalid-conflicting-disposition-missing-target.json", "conflicting-disposition"],
  ["de-0009-invalid-conflicting-disposition-unexpected-target.json", "conflicting-disposition"],
  ["de-0009-invalid-non-us.json", "non-us"],
  ["de-0009-invalid-unsupported-evidence.json", "unsupported-evidence"],
  ["de-0009-invalid-future-dated-evidence.json", "future-dated-evidence"],
  ["de-0009-invalid-evidence-plan-conflation.json", "evidence-plan-conflation"],
  ["de-0009-invalid-target-mismatch.json", "target-mismatch"],
  ["de-0009-invalid-evidence-subject-mismatch.json", "evidence-subject-mismatch"],
  ["de-0009-invalid-evidence-reference-credential-url.json", "evidence-reference-credential"],
  ["de-0009-invalid-evidence-reference-credential-keyword.json", "evidence-reference-credential"],
  ["de-0009-invalid-evidence-reference-credential-token-url.json", "evidence-reference-credential"],
  ["de-0009-invalid-evidence-reference-credential-raw-token.json", "evidence-reference-credential"],
  ["de-0009-invalid-evidence-reference-credential-raw-token-citation.json", "evidence-reference-credential"],
  ["de-0009-invalid-evidence-reference-credential-token-assignment.json", "evidence-reference-credential"],
  ["de-0009-invalid-rationale-credential.json", "rationale-credential"],
  ["de-0009-invalid-missing-evidence-attribution.json", "missing-evidence-attribution"],
  ["de-0009-invalid-blank-citation.json", "missing-evidence-attribution"],
  ["de-0009-invalid-unsupported-reference-type.json", "unsupported-evidence"],
  ["de-0009-invalid-disposition-unrecognized.json", "conflicting-disposition"],
];

describe("de-0009-legacy-domain-transition.valid.json", () => {
  it("is valid JSON that satisfies the schema and the semantic validator", async () => {
    const fixture = await loadFixture("de-0009-legacy-domain-transition.valid.json");
    expect(() =>
      assertValidAgainstSchema(schema, fixture, "de-0009-legacy-domain-transition.valid.json"),
    ).not.toThrow();
    expect(validateLegacyDomainTransition(fixture, registryFixture)).toEqual([]);
  });
});

describe("validateLegacyDomainTransition fails closed on each contract violation", () => {
  it.each(INVALID_FIXTURES)("%s reports a %s violation", async (fileName, category) => {
    const fixture = await loadFixture(fileName);
    expect(() => assertValidAgainstSchema(schema, fixture, fileName)).not.toThrow();
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((message) => message.startsWith(`${category}:`))).toBe(true);
  });

  it("throws an aggregated error via assertValidLegacyDomainTransition", async () => {
    const fixture = await loadFixture("de-0009-invalid-malformed-origin.json");
    expect(() => assertValidLegacyDomainTransition(fixture, registryFixture, "fixture")).toThrow(/malformed-origin/);
  });

  it("does not throw for the valid fixture", async () => {
    const fixture = await loadFixture("de-0009-legacy-domain-transition.valid.json");
    expect(() => assertValidLegacyDomainTransition(fixture, registryFixture, "fixture")).not.toThrow();
  });
});

describe("internal country identity", () => {
  it("requires country to be exactly \"US\" at the schema level", async () => {
    const fixture = await loadFixture("de-0009-invalid-country-not-us.json");
    expect(() => assertValidAgainstSchema(schema, fixture, "de-0009-invalid-country-not-us.json")).toThrow(/country/);
  });
});

describe("cross-validation against the DE-0008 niche-site registry", () => {
  it("accepts a redirect_target that identifies exactly one canonical registry record", async () => {
    const fixture = await loadFixture("de-0009-legacy-domain-transition.valid.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("target-mismatch:"))).toBe(false);
  });

  it("rejects a redirect_target whose niche_id/site_id/origin do not agree on one registry record", async () => {
    const fixture = await loadFixture("de-0009-invalid-target-mismatch.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("target-mismatch:"))).toBe(true);
  });
});

describe("evidence and plan separation", () => {
  it("rejects observed_state values that assert an executed disposition outcome", async () => {
    const fixture = await loadFixture("de-0009-invalid-evidence-plan-conflation.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("evidence-plan-conflation:"))).toBe(true);
  });
});

describe("unsupported additional properties (recursive additionalProperties: false)", () => {
  it("rejects an undeclared property at the document root", async () => {
    const fixture = await loadFixture("de-0009-invalid-unsupported-root-property.json");
    expect(() =>
      assertValidAgainstSchema(schema, fixture, "de-0009-invalid-unsupported-root-property.json"),
    ).toThrow(/unexpected_root_field/);
  });

  it("rejects an undeclared property inside a nested object", async () => {
    const fixture = await loadFixture("de-0009-invalid-unsupported-nested-property.json");
    expect(() =>
      assertValidAgainstSchema(schema, fixture, "de-0009-invalid-unsupported-nested-property.json"),
    ).toThrow(/unexpected_nested_field/);
  });
});

describe("evidence-reference structure", () => {
  it("requires observed_subject at the schema level", async () => {
    const fixture = await loadFixture("de-0009-invalid-evidence-missing-subject.json");
    expect(() =>
      assertValidAgainstSchema(schema, fixture, "de-0009-invalid-evidence-missing-subject.json"),
    ).toThrow(/observed_subject/);
  });

  it("rejects an observed_subject that does not name the entry's own origin", async () => {
    const fixture = await loadFixture("de-0009-invalid-evidence-subject-mismatch.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("evidence-subject-mismatch:"))).toBe(true);
  });

  it("rejects a reference citation embedding URL credentials", async () => {
    const fixture = await loadFixture("de-0009-invalid-evidence-reference-credential-url.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("evidence-reference-credential:"))).toBe(true);
  });

  it("rejects a reference citation embedding a secret keyword", async () => {
    const fixture = await loadFixture("de-0009-invalid-evidence-reference-credential-keyword.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("evidence-reference-credential:"))).toBe(true);
  });

  it("rejects a reference citation embedding a bare, token-only URL userinfo (no colon)", async () => {
    const fixture = await loadFixture("de-0009-invalid-evidence-reference-credential-token-url.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("evidence-reference-credential:"))).toBe(true);
  });

  it("rejects a reference recorded_by embedding a raw vendor access-key token", async () => {
    const fixture = await loadFixture("de-0009-invalid-evidence-reference-credential-raw-token.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("evidence-reference-credential:"))).toBe(true);
  });

  it("rejects a reference citation embedding a raw vendor access-key token", async () => {
    const fixture = await loadFixture("de-0009-invalid-evidence-reference-credential-raw-token-citation.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("evidence-reference-credential:"))).toBe(true);
  });

  it("rejects a reference citation embedding a token=... assignment", async () => {
    const fixture = await loadFixture("de-0009-invalid-evidence-reference-credential-token-assignment.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("evidence-reference-credential:"))).toBe(true);
  });

  it("rejects an unsupported reference.reference_type", async () => {
    const fixture = await loadFixture("de-0009-invalid-unsupported-reference-type.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("unsupported-evidence:"))).toBe(true);
  });

  it("rejects a blank (whitespace-only) citation as missing attribution", async () => {
    const fixture = await loadFixture("de-0009-invalid-blank-citation.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("missing-evidence-attribution:"))).toBe(true);
  });

  it("rejects a transition_plan.rationale embedding a secret keyword", async () => {
    const fixture = await loadFixture("de-0009-invalid-rationale-credential.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("rationale-credential:"))).toBe(true);
  });

  it("rejects a blank recorded_by as missing attribution", async () => {
    const fixture = await loadFixture("de-0009-invalid-missing-evidence-attribution.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("missing-evidence-attribution:"))).toBe(true);
  });

  it("does not flag legitimate prose that merely contains a credential-adjacent word", async () => {
    const fixture = await loadFixture("de-0009-legacy-domain-transition.valid.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("evidence-reference-credential:"))).toBe(false);
    expect(errors.some((message) => message.startsWith("rationale-credential:"))).toBe(false);
    const citations = fixture.legacy_domains.map((entry) => entry.current_evidence.reference.citation);
    expect(citations.some((citation) => citation.includes("Colorado Secretary of State"))).toBe(true);
    expect(citations.some((citation) => citation.includes("Authorization: city clerk"))).toBe(true);
    const rationales = fixture.legacy_domains.map((entry) => entry.transition_plan.rationale);
    expect(rationales.some((rationale) => rationale.includes("the bearer of this deed"))).toBe(true);
  });

  it("does not flag a URL query string containing a colon and an @ outside any userinfo", async () => {
    const fixture = await loadFixture("de-0009-legacy-domain-transition.valid.json");
    const citation = fixture.legacy_domains
      .map((entry) => entry.current_evidence.reference.citation)
      .find((value) => value.includes("query string only, no userinfo"));
    expect(citation).toContain("https://internal.example?case:412@2026-08-20");
    expect(validateLegacyDomainTransition(fixture, registryFixture)).toEqual([]);
  });
});

describe("origin userinfo detection is bounded to the authority", () => {
  it("reports origin-has-path, not origin-has-credentials, for an @ inside the path", async () => {
    const fixture = await loadFixture("de-0009-invalid-origin-at-in-path.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("origin-has-path:"))).toBe(true);
    expect(errors.some((message) => message.startsWith("origin-has-credentials:"))).toBe(false);
  });

  it("reports origin-has-query, not origin-has-credentials, for an @ inside the query string", async () => {
    const fixture = await loadFixture("de-0009-invalid-origin-at-in-query.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("origin-has-query:"))).toBe(true);
    expect(errors.some((message) => message.startsWith("origin-has-credentials:"))).toBe(false);
  });

  it("reports origin-has-fragment, not origin-has-credentials, for an @ inside the fragment", async () => {
    const fixture = await loadFixture("de-0009-invalid-origin-at-in-fragment.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("origin-has-fragment:"))).toBe(true);
    expect(errors.some((message) => message.startsWith("origin-has-credentials:"))).toBe(false);
  });

  it("still reports origin-has-credentials for an @ inside the authority", async () => {
    const fixture = await loadFixture("de-0009-invalid-origin-has-credentials.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("origin-has-credentials:"))).toBe(true);
  });
});

describe("planned disposition enum", () => {
  it("accepts every recognized disposition value in the valid fixture", async () => {
    const fixture = await loadFixture("de-0009-legacy-domain-transition.valid.json");
    const dispositions = fixture.legacy_domains.map((entry) => entry.transition_plan.disposition);
    expect(new Set(dispositions)).toEqual(
      new Set(["undecided", "retain_temporarily", "redirect_planned", "park_planned", "retire_planned"]),
    );
    expect(validateLegacyDomainTransition(fixture, registryFixture)).toEqual([]);
  });

  it("rejects a disposition value outside the recognized enum", async () => {
    const fixture = await loadFixture("de-0009-invalid-disposition-unrecognized.json");
    const errors = validateLegacyDomainTransition(fixture, registryFixture);
    expect(errors.some((message) => message.startsWith("conflicting-disposition:"))).toBe(true);
  });
});
