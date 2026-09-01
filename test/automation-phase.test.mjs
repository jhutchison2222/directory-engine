import { describe, expect, it } from "vitest";
import { assertAutomationPhaseInvariants } from "../scripts/lib/automation-phase.mjs";

describe("assertAutomationPhaseInvariants", () => {
  it("accepts foundation with a null active work packet", () => {
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "foundation", active_work_packet: null }),
    ).not.toThrow();
  });

  it("rejects foundation with a non-null active work packet", () => {
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "foundation", active_work_packet: "DE-0002" }),
    ).toThrow(/foundation must not claim/);
  });

  it("accepts fixture only with DE-0002 as the active work packet", () => {
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "fixture", active_work_packet: "DE-0002" }),
    ).not.toThrow();
  });

  it("rejects fixture with a different active work packet", () => {
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "fixture", active_work_packet: "DE-0003" }),
    ).toThrow(/fixture phase must record DE-0002/);
  });

  it("accepts code_only with any schema-valid DE packet id, without hard-coding a specific packet", () => {
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "code_only", active_work_packet: "DE-0003" }),
    ).not.toThrow();
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "code_only", active_work_packet: "DE-0007" }),
    ).not.toThrow();
  });

  it("rejects code_only with a null active work packet", () => {
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "code_only", active_work_packet: null }),
    ).toThrow(/code_only phase must record/);
  });

  it("rejects code_only with a malformed packet id", () => {
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "code_only", active_work_packet: "DE-3" }),
    ).toThrow(/code_only phase must record/);
  });

  it("rejects staging and production outright", () => {
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "staging", active_work_packet: "DE-0003" }),
    ).toThrow(/not permitted/);
    expect(() =>
      assertAutomationPhaseInvariants({ automation_phase: "production", active_work_packet: "DE-0003" }),
    ).toThrow(/not permitted/);
  });
});
