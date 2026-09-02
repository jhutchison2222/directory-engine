import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_AGENT_TRIGGER_ENDPOINT,
  buildDispatchPayload,
  dispatchToWorkspaceAgent,
  requireWorkspaceAgentToken,
  validateAgentId,
} from "../scripts/lib/supervisor-dispatch.mjs";

// Obviously-fake fixture value, never a real credential.
const FIXTURE_TOKEN = "fixture-not-a-real-token";

describe("validateAgentId", () => {
  it("accepts a well-formed agent id", () => {
    expect(validateAgentId("directory-engine-workspace-agent")).toBe("directory-engine-workspace-agent");
  });

  it.each([undefined, null, "", "  ", "x", "has a space", "semi;colon"])(
    "fails closed for invalid agent id %j",
    (value) => {
      expect(() => validateAgentId(value)).toThrow(/CHATGPT_WORKSPACE_AGENT_ID/);
    },
  );
});

describe("requireWorkspaceAgentToken", () => {
  it("fails closed when the token is missing", () => {
    expect(() => requireWorkspaceAgentToken(undefined)).toThrow(/CHATGPT_WORKSPACE_AGENT_TOKEN/);
    expect(() => requireWorkspaceAgentToken("")).toThrow(/CHATGPT_WORKSPACE_AGENT_TOKEN/);
  });

  it("returns a present token unchanged", () => {
    expect(requireWorkspaceAgentToken(FIXTURE_TOKEN)).toBe(FIXTURE_TOKEN);
  });
});

describe("buildDispatchPayload", () => {
  it("builds a payload carrying only non-secret fields", () => {
    const payload = buildDispatchPayload({
      agentId: "directory-engine-workspace-agent",
      idempotencyKey: "pull_request:26:abc:ci_failed",
      reason: "ci_failed",
      subject: { type: "pull_request", number: 26 },
    });
    expect(payload).toEqual({
      agent_id: "directory-engine-workspace-agent",
      idempotency_key: "pull_request:26:abc:ci_failed",
      reason: "ci_failed",
      subject: { type: "pull_request", number: 26 },
    });
  });
});

describe("dispatchToWorkspaceAgent", () => {
  const baseArgs = {
    agentId: "directory-engine-workspace-agent",
    token: FIXTURE_TOKEN,
    idempotencyKey: "pull_request:26:abc:ci_failed",
    reason: "ci_failed",
    subject: { type: "pull_request", number: 26 },
  };

  it("posts to the fixed trigger endpoint with the token only in the Authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const result = await dispatchToWorkspaceAgent({ ...baseArgs, fetchImpl });

    expect(result).toEqual({ ok: true, status: 202 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(WORKSPACE_AGENT_TRIGGER_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(JSON.stringify(init)).not.toContain(FIXTURE_TOKEN.slice(0, 4) + FIXTURE_TOKEN.slice(4).toUpperCase());
    expect(JSON.parse(init.body)).not.toHaveProperty("token");
  });

  it("fails closed instead of following a redirect from the trigger endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 302 });
    await expect(dispatchToWorkspaceAgent({ ...baseArgs, fetchImpl })).rejects.toThrow(/redirect/);
  });

  it("reports a non-ok, non-redirect response as a failed dispatch rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await dispatchToWorkspaceAgent({ ...baseArgs, fetchImpl });
    expect(result).toEqual({ ok: false, status: 500 });
  });

  it("fails closed before any network call when the token is missing", async () => {
    const fetchImpl = vi.fn();
    await expect(dispatchToWorkspaceAgent({ ...baseArgs, token: undefined, fetchImpl })).rejects.toThrow(
      /CHATGPT_WORKSPACE_AGENT_TOKEN/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed before any network call when the agent id is invalid", async () => {
    const fetchImpl = vi.fn();
    await expect(dispatchToWorkspaceAgent({ ...baseArgs, agentId: "", fetchImpl })).rejects.toThrow(
      /CHATGPT_WORKSPACE_AGENT_ID/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
