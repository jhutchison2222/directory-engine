const VALID_PROBE_VALUES = new Set(["NEEDS_REMEDIATION", "RESOLVED"]);

export function validateRemediationFixture(fixture, expectedPacketId) {
  if (typeof fixture !== "object" || fixture === null || Array.isArray(fixture)) {
    throw new Error("remediation fixture must be a JSON object");
  }
  if (fixture.packet_id !== expectedPacketId) {
    throw new Error(`remediation fixture packet_id must equal the active work packet "${expectedPacketId}"`);
  }
  if (typeof fixture.description !== "string" || fixture.description.trim().length === 0) {
    throw new Error("remediation fixture description must be a non-empty string");
  }
  if (!VALID_PROBE_VALUES.has(fixture.remediation_probe)) {
    throw new Error(`remediation fixture remediation_probe must be one of: ${[...VALID_PROBE_VALUES].join(", ")}`);
  }
  return true;
}
