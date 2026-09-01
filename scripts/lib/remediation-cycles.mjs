/**
 * Deterministic mapping between the work-packet issue form's
 * max_remediation_cycles dropdown (a string) and the integer the
 * work-packet.schema.json `max_remediation_cycles` property requires.
 * The option list is derived from the schema's minimum/maximum bounds so
 * the two contracts cannot silently drift apart.
 */
export function buildRemediationCycleOptions(schema) {
  const { minimum, maximum } = schema;
  if (typeof minimum !== "number" || typeof maximum !== "number" || minimum > maximum) {
    throw new Error("max_remediation_cycles schema must declare a valid minimum/maximum range");
  }
  const options = [];
  for (let value = minimum; value <= maximum; value += 1) {
    options.push(String(value));
  }
  return options;
}

export function mapRemediationCyclesInput(rawValue, schema) {
  const options = buildRemediationCycleOptions(schema);
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  if (typeof trimmed !== "string" || !options.includes(trimmed)) {
    throw new Error(
      `max_remediation_cycles input must be one of: ${options.join(", ")} (received ${JSON.stringify(rawValue)})`,
    );
  }
  return Number(trimmed);
}
