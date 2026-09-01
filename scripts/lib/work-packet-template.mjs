/**
 * Narrowly parses the GitHub issue-form fields (`body:` list items) used by
 * .github/ISSUE_TEMPLATE/work-packet.yml: each field's type, id, whether it
 * is required, and, for dropdowns, its options. This is intentionally not a
 * general YAML parser; it only understands the fixed 2-space-indented
 * issue-form structure this repository controls.
 */
export function parseIssueFormFields(yamlText) {
  const lines = yamlText.split("\n");
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^ {2}- type: /.test(line)) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);

  return blocks.map((blockLines) => {
    const typeMatch = /^ {2}- type: (\S+)/.exec(blockLines[0]);
    const idLine = blockLines.find((line) => /^ {4}id: /.test(line));
    const idMatch = idLine ? /^ {4}id: (\S+)/.exec(idLine) : null;
    const requiredLine = blockLines.find((line) => /^\s*required: (true|false)\s*$/.test(line));
    const requiredMatch = requiredLine ? /required: (true|false)/.exec(requiredLine) : null;

    const options = [];
    const optionsIndex = blockLines.findIndex((line) => /^\s*options:\s*$/.test(line));
    if (optionsIndex !== -1) {
      for (let i = optionsIndex + 1; i < blockLines.length; i += 1) {
        const optionMatch = /^\s*-\s*(.+?)\s*$/.exec(blockLines[i]);
        if (!optionMatch) break;
        options.push(optionMatch[1].replace(/^["']|["']$/g, ""));
      }
    }

    return {
      type: typeMatch ? typeMatch[1] : null,
      id: idMatch ? idMatch[1] : null,
      required: requiredMatch ? requiredMatch[1] === "true" : false,
      options,
    };
  });
}

export function findFieldById(yamlText, fieldId) {
  return parseIssueFormFields(yamlText).find((field) => field.id === fieldId) ?? null;
}
