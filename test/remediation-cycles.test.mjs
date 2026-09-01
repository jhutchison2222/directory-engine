import { describe, expect, it } from "vitest";
import { buildRemediationCycleOptions, mapRemediationCyclesInput } from "../scripts/lib/remediation-cycles.mjs";

const schema = { minimum: 0, maximum: 3 };

describe("remediation cycle mapping", () => {
  it("builds the deterministic option list from schema bounds", () => {
    expect(buildRemediationCycleOptions(schema)).toEqual(["0", "1", "2", "3"]);
  });

  it.each(["0", "1", "2", "3"])("maps %s to its integer value", (value) => {
    expect(mapRemediationCyclesInput(value, schema)).toBe(Number(value));
  });

  it("rejects an out-of-range value", () => {
    expect(() => mapRemediationCyclesInput("4", schema)).toThrow(/max_remediation_cycles/);
  });

  it("rejects a non-numeric value", () => {
    expect(() => mapRemediationCyclesInput("three", schema)).toThrow(/max_remediation_cycles/);
  });

  it("rejects a missing value", () => {
    expect(() => mapRemediationCyclesInput(undefined, schema)).toThrow(/max_remediation_cycles/);
  });

  it("rejects a non-string numeric value", () => {
    expect(() => mapRemediationCyclesInput(2, schema)).toThrow(/max_remediation_cycles/);
  });
});
