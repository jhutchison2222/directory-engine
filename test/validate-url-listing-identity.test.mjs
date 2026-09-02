import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertValidAgainstSchema } from "../scripts/lib/json-schema-lite.mjs";
import {
  assertValidUrlListingIdentity,
  validateUrlListingIdentity,
} from "../scripts/lib/validate-url-listing-identity.mjs";

const schema = JSON.parse(
  await readFile(new URL("../docs/contracts/url-listing-identity.schema.json", import.meta.url), "utf8"),
);

async function loadFixture(name) {
  const raw = await readFile(new URL(`../project/fixtures/${name}`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

const INVALID_FIXTURES = [
  ["de-0006-invalid-ambiguous.json", "ambiguous"],
  ["de-0006-invalid-malformed.json", "malformed"],
  ["de-0006-invalid-country-prefixed.json", "country-prefixed"],
  ["de-0006-invalid-metro-parented.json", "metro-parented"],
  ["de-0006-invalid-metro-parented-url.json", "metro-parented"],
  ["de-0006-invalid-service-in-business-url.json", "service-in-business-url"],
  ["de-0006-invalid-duplicate-branch.json", "duplicate-branch"],
  ["de-0006-invalid-unsafe-indexation.json", "unsafe-indexation"],
  ["de-0006-invalid-unsafe-indexation-empty-intersection.json", "unsafe-indexation"],
  ["de-0006-invalid-duplicate-canonical-url.json", "duplicate-canonical-url"],
  ["de-0006-invalid-identity-mismatch.json", "identity-mismatch"],
  ["de-0006-invalid-identity-mismatch-orphan-url.json", "identity-mismatch"],
  ["de-0006-invalid-unknown-service.json", "unknown-service"],
  ["de-0006-invalid-unknown-service-url-leaf.json", "unknown-service"],
  ["de-0006-invalid-redirect-conflict.json", "redirect-conflict"],
  ["de-0006-invalid-redirect-unknown-target.json", "redirect-unknown-target"],
  ["de-0006-invalid-redirect-cycle.json", "redirect-cycle"],
  ["de-0006-invalid-malformed-redirect.json", "malformed"],
];

describe("de-0006-url-listing-identity.valid.json", () => {
  it("is valid JSON that satisfies the schema and the semantic validator", async () => {
    const fixture = await loadFixture("de-0006-url-listing-identity.valid.json");
    expect(() => assertValidAgainstSchema(schema, fixture, "de-0006-url-listing-identity.valid.json")).not.toThrow();
    expect(validateUrlListingIdentity(fixture)).toEqual([]);
  });
});

describe("validateUrlListingIdentity fails closed on each contract violation", () => {
  it.each(INVALID_FIXTURES)("%s reports a %s violation", async (fileName, category) => {
    const fixture = await loadFixture(fileName);
    expect(() => assertValidAgainstSchema(schema, fixture, fileName)).not.toThrow();
    const errors = validateUrlListingIdentity(fixture);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((message) => message.startsWith(`${category}:`))).toBe(true);
  });

  it("throws an aggregated error via assertValidUrlListingIdentity", async () => {
    const fixture = await loadFixture("de-0006-invalid-malformed.json");
    expect(() => assertValidUrlListingIdentity(fixture, "fixture")).toThrow(/malformed/);
  });

  it("does not throw for the valid fixture", async () => {
    const fixture = await loadFixture("de-0006-url-listing-identity.valid.json");
    expect(() => assertValidUrlListingIdentity(fixture, "fixture")).not.toThrow();
  });
});

describe("internal country identity", () => {
  it("requires country to be exactly \"US\" at the schema level", async () => {
    const fixture = await loadFixture("de-0006-invalid-country-not-us.json");
    expect(() => assertValidAgainstSchema(schema, fixture, "de-0006-invalid-country-not-us.json")).toThrow(/country/);
  });

  it("never allows the internal country onto a preferred public URL", async () => {
    const fixture = await loadFixture("de-0006-url-listing-identity.valid.json");
    for (const url of fixture.canonical_urls) {
      expect(url.path.split("/")).not.toContain("us");
    }
  });
});
