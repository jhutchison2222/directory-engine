import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertValidAgainstSchema, isValidDateTime, validateAgainstSchema } from "../scripts/lib/json-schema-lite.mjs";

const schema = JSON.parse(
  await readFile(new URL("../docs/contracts/project-state.schema.json", import.meta.url), "utf8"),
);

const validState = {
  schema_version: 1,
  updated_at: "2026-09-01T20:26:00Z",
  accepted_architecture: "ADR-001-national-niche-domains",
  repository_baseline: "8973c1ceef4c25fb19fab743ec85db65f7011b3f",
  repository_capability: "contains_write_paths",
  deployed_capability: "unverified",
  automation_phase: "fixture",
  auto_merge_enabled: false,
  production_mutations_authorized: false,
  active_work_packet: "DE-0002",
  next_step: "Do the thing.",
};

describe("validateAgainstSchema against the project-state schema", () => {
  it("accepts a valid state document", () => {
    expect(validateAgainstSchema(schema, validState)).toEqual([]);
  });

  it("accepts a null active_work_packet and an optional notes array", () => {
    expect(
      validateAgainstSchema(schema, { ...validState, active_work_packet: null, notes: ["a note"] }),
    ).toEqual([]);
  });

  it("rejects a wrong type for a boolean property", () => {
    const errors = validateAgainstSchema(schema, { ...validState, auto_merge_enabled: "false" });
    expect(errors.some((message) => message.includes("auto_merge_enabled"))).toBe(true);
  });

  it("rejects an invalid updated_at timestamp", () => {
    const errors = validateAgainstSchema(schema, { ...validState, updated_at: "2026-13-40T99:99:99Z" });
    expect(errors.some((message) => message.includes("updated_at"))).toBe(true);
  });

  it("rejects a non-string updated_at", () => {
    const errors = validateAgainstSchema(schema, { ...validState, updated_at: 12345 });
    expect(errors.some((message) => message.includes("updated_at"))).toBe(true);
  });

  it("rejects a missing required property", () => {
    const { next_step, ...withoutNextStep } = validState;
    const errors = validateAgainstSchema(schema, withoutNextStep);
    expect(errors.some((message) => message.includes('"next_step"'))).toBe(true);
  });

  it("rejects an unexpected additional property", () => {
    const errors = validateAgainstSchema(schema, { ...validState, unexpected_field: true });
    expect(errors.some((message) => message.includes("unexpected_field"))).toBe(true);
  });

  it("rejects a value outside the enum", () => {
    const errors = validateAgainstSchema(schema, { ...validState, automation_phase: "not_a_phase" });
    expect(errors.some((message) => message.includes("automation_phase"))).toBe(true);
  });

  it("throws an aggregated error via assertValidAgainstSchema", () => {
    expect(() =>
      assertValidAgainstSchema(schema, { ...validState, auto_merge_enabled: "false" }, "project/current-state.json"),
    ).toThrow(/auto_merge_enabled/);
  });

  it("does not throw for a valid document", () => {
    expect(() => assertValidAgainstSchema(schema, validState, "project/current-state.json")).not.toThrow();
  });
});

describe("isValidDateTime", () => {
  it("accepts a valid RFC 3339 timestamp", () => {
    expect(isValidDateTime("2026-09-01T20:26:00Z")).toBe(true);
  });

  it("accepts a leap-day timestamp", () => {
    expect(isValidDateTime("2024-02-29T00:00:00Z")).toBe(true);
  });

  it("rejects a non-existent leap day", () => {
    expect(isValidDateTime("2023-02-29T00:00:00Z")).toBe(false);
  });

  it("rejects an out-of-range month, hour, minute, and second", () => {
    expect(isValidDateTime("2026-13-40T99:99:99Z")).toBe(false);
  });

  it("rejects garbage input and non-string values", () => {
    expect(isValidDateTime("not-a-date")).toBe(false);
    expect(isValidDateTime(20260901)).toBe(false);
  });
});
