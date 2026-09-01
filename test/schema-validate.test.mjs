import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertValidAgainstSchema, validateAgainstSchema } from "../scripts/lib/schema-validate.mjs";

const projectStateSchema = JSON.parse(
  await readFile("docs/contracts/project-state.schema.json", "utf8"),
);

const validState = {
  schema_version: 1,
  updated_at: "2026-09-01T21:00:00Z",
  accepted_architecture: "ADR-001-national-niche-domains",
  repository_baseline: "baf7ab01418b7b0494509c4aecdf3ab8b547d3e2",
  repository_capability: "contains_write_paths",
  deployed_capability: "unverified",
  automation_phase: "fixture",
  auto_merge_enabled: false,
  production_mutations_authorized: false,
  active_work_packet: "DE-0002",
  next_step: "Do the next thing.",
};

describe("validateAgainstSchema against project-state.schema.json", () => {
  it("accepts a fully conformant project state", () => {
    expect(validateAgainstSchema(projectStateSchema, validState)).toEqual([]);
  });

  it("rejects a wrong type for a boolean field", () => {
    const errors = validateAgainstSchema(projectStateSchema, {
      ...validState,
      auto_merge_enabled: "false",
    });
    expect(errors.some((error) => error.includes("auto_merge_enabled"))).toBe(true);
  });

  it("rejects an invalid updated_at format (missing time component)", () => {
    const errors = validateAgainstSchema(projectStateSchema, {
      ...validState,
      updated_at: "2026-09-01",
    });
    expect(errors.some((error) => error.includes("updated_at"))).toBe(true);
  });

  it("rejects an invalid updated_at value (out-of-range month)", () => {
    const errors = validateAgainstSchema(projectStateSchema, {
      ...validState,
      updated_at: "2026-13-01T00:00:00Z",
    });
    expect(errors.some((error) => error.includes("updated_at"))).toBe(true);
  });

  it("rejects a missing required property", () => {
    const { next_step, ...withoutNextStep } = validState;
    const errors = validateAgainstSchema(projectStateSchema, withoutNextStep);
    expect(errors.some((error) => error.includes('missing required property "next_step"'))).toBe(true);
  });

  it("rejects an unexpected extra property", () => {
    const errors = validateAgainstSchema(projectStateSchema, {
      ...validState,
      unexpected_field: "not part of the contract",
    });
    expect(errors.some((error) => error.includes('unexpected additional property "unexpected_field"'))).toBe(true);
  });

  it("assertValidAgainstSchema throws with a labeled, fail-closed message", () => {
    expect(() =>
      assertValidAgainstSchema(projectStateSchema, { ...validState, schema_version: 2 }, "project/current-state.json"),
    ).toThrow(/project\/current-state\.json failed schema validation/);
  });
});
