import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertRecursiveFailClosed } from "../scripts/lib/schema-fail-closed.mjs";

const schema = JSON.parse(
  await readFile(new URL("../docs/contracts/url-listing-identity.schema.json", import.meta.url), "utf8"),
);

describe("assertRecursiveFailClosed", () => {
  it("passes for the url-listing-identity schema as authored", () => {
    expect(() => assertRecursiveFailClosed(schema, "url-listing-identity schema")).not.toThrow();
  });

  it("fails when a nested items schema is weakened to accept unknown properties", () => {
    const weakened = JSON.parse(JSON.stringify(schema));
    weakened.properties.listings.items.additionalProperties = true;
    expect(() => assertRecursiveFailClosed(weakened, "url-listing-identity schema")).toThrow(
      /listings\.items/,
    );
  });

  it("fails when a doubly-nested object schema (indexation_readiness) is weakened", () => {
    const weakened = JSON.parse(JSON.stringify(schema));
    delete weakened.properties.canonical_urls.items.properties.indexation_readiness.additionalProperties;
    expect(() => assertRecursiveFailClosed(weakened, "url-listing-identity schema")).toThrow(
      /indexation_readiness/,
    );
  });

  it("still fails closed when only the root additionalProperties is checked but a nested schema is relaxed", () => {
    const weakened = JSON.parse(JSON.stringify(schema));
    weakened.properties.redirects.items.additionalProperties = true;
    expect(weakened.additionalProperties).toBe(false);
    expect(() => assertRecursiveFailClosed(weakened, "url-listing-identity schema")).toThrow(
      /redirects\.items/,
    );
  });
});
