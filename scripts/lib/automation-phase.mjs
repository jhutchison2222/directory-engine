const DE_PACKET_PATTERN = /^DE-[0-9]{4}$/;

/**
 * Enforces the phase <-> active-work-packet business rule that the
 * project-state schema's enum alone cannot express: which packet shape is
 * allowed to accompany each automation phase in this foundation automation
 * stage. Only "foundation", "fixture", and "code_only" are reachable here;
 * "staging" and "production" are rejected outright.
 */
export function assertAutomationPhaseInvariants(state) {
  const phase = state.automation_phase;
  const packet = state.active_work_packet;

  if (phase === "foundation") {
    if (packet !== null) {
      throw new Error("foundation must not claim an active automated work packet");
    }
    return;
  }

  if (phase === "fixture") {
    if (packet !== "DE-0002") {
      throw new Error("fixture phase must record DE-0002 as the active work packet");
    }
    return;
  }

  if (phase === "code_only") {
    if (typeof packet !== "string" || !DE_PACKET_PATTERN.test(packet)) {
      throw new Error("code_only phase must record a schema-valid active work packet id");
    }
    return;
  }

  throw new Error(`automation phase "${phase}" is not permitted in this foundation automation stage`);
}
