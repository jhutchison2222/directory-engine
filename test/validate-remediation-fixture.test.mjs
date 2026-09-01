import { describe, expect, it } from "vitest";
import { validateRemediationFixture } from "../scripts/lib/validate-remediation-fixture.mjs";

describe("validateRemediationFixture", () => {
  const packetId = "DE-0002";

  it("accepts the inert NEEDS_REMEDIATION probe", () => {
    expect(
      validateRemediationFixture(
        { packet_id: packetId, description: "probe", remediation_probe: "NEEDS_REMEDIATION" },
        packetId,
      ),
    ).toBe(true);
  });

  it("accepts the RESOLVED probe", () => {
    expect(
      validateRemediationFixture(
        { packet_id: packetId, description: "probe", remediation_probe: "RESOLVED" },
        packetId,
      ),
    ).toBe(true);
  });

  it("rejects a packet_id mismatch", () => {
    expect(() =>
      validateRemediationFixture(
        { packet_id: "DE-0001", description: "probe", remediation_probe: "RESOLVED" },
        packetId,
      ),
    ).toThrow(/packet_id/);
  });

  it("rejects a missing description", () => {
    expect(() =>
      validateRemediationFixture(
        { packet_id: packetId, description: "", remediation_probe: "RESOLVED" },
        packetId,
      ),
    ).toThrow(/description/);
  });

  it("rejects an unrecognized probe value", () => {
    expect(() =>
      validateRemediationFixture(
        { packet_id: packetId, description: "probe", remediation_probe: "UNKNOWN" },
        packetId,
      ),
    ).toThrow(/remediation_probe/);
  });

  it("rejects a non-object fixture", () => {
    expect(() => validateRemediationFixture(null, packetId)).toThrow(/JSON object/);
    expect(() => validateRemediationFixture(["not", "an", "object"], packetId)).toThrow(/JSON object/);
  });
});
