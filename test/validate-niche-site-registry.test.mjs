import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertValidAgainstSchema } from "../scripts/lib/json-schema-lite.mjs";
import {
  assertValidNicheSiteRegistry,
  validateNicheSiteRegistry,
} from "../scripts/lib/validate-niche-site-registry.mjs";

const schema = JSON.parse(
  await readFile(new URL("../docs/contracts/niche-site-registry.schema.json", import.meta.url), "utf8"),
);

async function loadFixture(name) {
  const raw = await readFile(new URL(`../project/fixtures/${name}`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

const INVALID_FIXTURES = [
  ["de-0008-invalid-duplicate-niche.json", "duplicate-niche"],
  ["de-0008-invalid-duplicate-site-id.json", "duplicate-site-id"],
  ["de-0008-invalid-duplicate-origin.json", "duplicate-origin"],
  ["de-0008-invalid-non-us.json", "non-us"],
  ["de-0008-invalid-malformed-origin.json", "malformed-origin"],
  ["de-0008-invalid-origin-has-path.json", "origin-has-path"],
  ["de-0008-invalid-origin-has-query.json", "origin-has-query"],
  ["de-0008-invalid-origin-has-fragment.json", "origin-has-fragment"],
  ["de-0008-invalid-origin-has-credentials.json", "origin-has-credentials"],
  ["de-0008-invalid-origin-has-port.json", "origin-has-port"],
  ["de-0008-invalid-origin-has-wildcard.json", "origin-has-wildcard"],
  ["de-0008-invalid-metro-specific-origin.json", "metro-specific-origin"],
  ["de-0008-invalid-geography-embedded-niche.json", "geography-embedded-niche"],
  ["de-0008-invalid-site-identity-geography-conflation.json", "site-identity-geography-conflation"],
  ["de-0008-invalid-unsupported-ambiguity.json", "unsupported-ambiguity"],
];

describe("de-0008-niche-site-registry.valid.json", () => {
  it("is valid JSON that satisfies the schema and the semantic validator", async () => {
    const fixture = await loadFixture("de-0008-niche-site-registry.valid.json");
    expect(() => assertValidAgainstSchema(schema, fixture, "de-0008-niche-site-registry.valid.json")).not.toThrow();
    expect(validateNicheSiteRegistry(fixture)).toEqual([]);
  });
});

describe("validateNicheSiteRegistry fails closed on each contract violation", () => {
  it.each(INVALID_FIXTURES)("%s reports a %s violation", async (fileName, category) => {
    const fixture = await loadFixture(fileName);
    expect(() => assertValidAgainstSchema(schema, fixture, fileName)).not.toThrow();
    const errors = validateNicheSiteRegistry(fixture);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((message) => message.startsWith(`${category}:`))).toBe(true);
  });

  it("throws an aggregated error via assertValidNicheSiteRegistry", async () => {
    const fixture = await loadFixture("de-0008-invalid-malformed-origin.json");
    expect(() => assertValidNicheSiteRegistry(fixture, "fixture")).toThrow(/malformed-origin/);
  });

  it("does not throw for the valid fixture", async () => {
    const fixture = await loadFixture("de-0008-niche-site-registry.valid.json");
    expect(() => assertValidNicheSiteRegistry(fixture, "fixture")).not.toThrow();
  });
});

describe("internal country identity", () => {
  it("requires country to be exactly \"US\" at the schema level", async () => {
    const fixture = await loadFixture("de-0008-invalid-country-not-us.json");
    expect(() => assertValidAgainstSchema(schema, fixture, "de-0008-invalid-country-not-us.json")).toThrow(/country/);
  });
});

describe("geography and niche/site identity independence", () => {
  it("keeps niche_id and site_id free of geography terms in the valid fixture", async () => {
    const fixture = await loadFixture("de-0008-niche-site-registry.valid.json");
    for (const record of fixture.niche_sites) {
      expect(validateNicheSiteRegistry({ ...fixture, niche_sites: [record] })).toEqual([]);
    }
  });
});
