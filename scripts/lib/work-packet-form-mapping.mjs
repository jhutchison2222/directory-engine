// Deterministic mapping from the work-packet issue form's
// max_remediation_cycles dropdown answer to the integer value required by
// docs/contracts/work-packet.schema.json (minimum 0, maximum 3).
const ALLOWED_FORM_VALUES = new Set(["0", "1", "2", "3"]);

export function mapMaxRemediationCycles(rawFormValue) {
  if (typeof rawFormValue !== "string" || !ALLOWED_FORM_VALUES.has(rawFormValue)) {
    throw new Error(
      `max_remediation_cycles form value must be one of "0", "1", "2", "3"; received ${JSON.stringify(rawFormValue)}`,
    );
  }
  return Number.parseInt(rawFormValue, 10);
}
