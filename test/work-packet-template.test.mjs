import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/work-packet.yml";

// A literal snapshot of the pre-DE-0003 template, which had no control at all
// for the schema-required max_remediation_cycles field. Used to prove the
// finding fails before the correction and passes afterward.
const LEGACY_TEMPLATE_TAIL = `
  - type: dropdown
    id: reviewer
    attributes:
      label: Independent reviewer
      options:
        - codex
        - claude
        - human
    validations:
      required: true
`;

function findFormItemById(yamlText, id) {
  const items = yamlText.split(/\n(?=  - type: )/);
  return items.find((item) => new RegExp(`^\\s*id:\\s*${id}\\s*$`, "m").test(item));
}

describe("work-packet issue template reconciliation", () => {
  it("the pre-correction template has no max_remediation_cycles control (regression baseline)", () => {
    expect(findFormItemById(LEGACY_TEMPLATE_TAIL, "max_remediation_cycles")).toBeUndefined();
  });

  it("the current template defines a deterministic max_remediation_cycles control matching the schema", async () => {
    const text = await readFile(TEMPLATE_PATH, "utf8");
    const item = findFormItemById(text, "max_remediation_cycles");
    expect(item, "work-packet.yml must define a max_remediation_cycles form field").toBeDefined();
    expect(item).toMatch(/^ {2}- type: dropdown/);
    expect(item).toMatch(/required:\s*true/);

    const options = [...item.matchAll(/^\s*-\s*"(\d+)"\s*$/gm)].map((match) => match[1]);
    expect(options.sort()).toEqual(["0", "1", "2", "3"]);
  });
});
