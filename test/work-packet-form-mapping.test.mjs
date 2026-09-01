import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mapMaxRemediationCycles } from "../scripts/lib/work-packet-form-mapping.mjs";
import { assertValidAgainstSchema } from "../scripts/lib/schema-validate.mjs";

const workPacketSchema = JSON.parse(await readFile("docs/contracts/work-packet.schema.json", "utf8"));

const baseWorkPacket = {
  packet_id: "DE-0003",
  title: "Enforce governance schema and packet consistency",
  state: "ready_for_implementation",
  authorization_class: "code_only",
  baseline_sha: "baf7ab01418b7b0494509c4aecdf3ab8b547d3e2",
  objective: "Close both deterministic-governance gaps found in the PR #6 audit.",
  allowed_changes: ["scripts/validate-project-governance.mjs"],
  prohibited_changes: ["No application source or Worker route change."],
  required_checks: ["npm run check:governance"],
  required_evidence: ["Exact head SHA and changed-file list."],
  acceptance_criteria: ["Both retrospective findings are closed with regression tests."],
  implementer: "claude",
  reviewer: "codex",
};

describe("mapMaxRemediationCycles", () => {
  it("maps every allowed dropdown answer to the matching integer", () => {
    expect(mapMaxRemediationCycles("0")).toBe(0);
    expect(mapMaxRemediationCycles("1")).toBe(1);
    expect(mapMaxRemediationCycles("2")).toBe(2);
    expect(mapMaxRemediationCycles("3")).toBe(3);
  });

  it("rejects missing form input", () => {
    expect(() => mapMaxRemediationCycles(undefined)).toThrow(/max_remediation_cycles/);
    expect(() => mapMaxRemediationCycles("")).toThrow(/max_remediation_cycles/);
  });

  it("rejects invalid form input", () => {
    expect(() => mapMaxRemediationCycles("4")).toThrow(/max_remediation_cycles/);
    expect(() => mapMaxRemediationCycles("-1")).toThrow(/max_remediation_cycles/);
    expect(() => mapMaxRemediationCycles("abc")).toThrow(/max_remediation_cycles/);
  });

  it("produces a work packet that satisfies the schema-required max_remediation_cycles field", () => {
    const workPacket = { ...baseWorkPacket, max_remediation_cycles: mapMaxRemediationCycles("3") };
    expect(() => assertValidAgainstSchema(workPacketSchema, workPacket, "work packet")).not.toThrow();
  });

  it("a work packet built without max_remediation_cycles fails schema validation", () => {
    expect(() => assertValidAgainstSchema(workPacketSchema, baseWorkPacket, "work packet")).toThrow(
      /missing required property "max_remediation_cycles"/,
    );
  });
});
