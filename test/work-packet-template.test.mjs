import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { findFieldById, parseIssueFormFields } from "../scripts/lib/work-packet-template.mjs";

const templateText = await readFile(
  new URL("../.github/ISSUE_TEMPLATE/work-packet.yml", import.meta.url),
  "utf8",
);

describe("work-packet issue template parsing", () => {
  it("extracts the max_remediation_cycles dropdown", () => {
    expect(findFieldById(templateText, "max_remediation_cycles")).toMatchObject({
      type: "dropdown",
      required: true,
      options: ["0", "1", "2", "3"],
    });
  });

  it("extracts the authorization_class dropdown", () => {
    expect(findFieldById(templateText, "authorization_class")).toMatchObject({
      type: "dropdown",
      required: true,
      options: ["code_only", "staging", "production_reversible", "high_risk"],
    });
  });

  it("extracts a required input field with no options", () => {
    expect(findFieldById(templateText, "packet_id")).toMatchObject({
      type: "input",
      required: true,
      options: [],
    });
  });

  it("returns null for an unknown field id", () => {
    expect(findFieldById(templateText, "does_not_exist")).toBeNull();
  });

  it("parses every top-level field with a type", () => {
    const fields = parseIssueFormFields(templateText);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => typeof field.type === "string")).toBe(true);
  });
});
